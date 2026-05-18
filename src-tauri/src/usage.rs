use chrono::{DateTime, Datelike, Duration, TimeZone, Timelike, Utc, Weekday};
use chrono_tz::Asia::Seoul;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const WEEKLY_LOOKBACK_DAYS: i64 = 7;
const CACHE_WINDOW_MS: i64 = 5 * 60 * 1000;
/// 활성 세션의 정의: 마지막 assistant 응답이 5분 이내. prompt cache TTL과 같음.
const SESSION_ACTIVE_SECS: i64 = 5 * 60;
/// 동시에 펫 위쪽에 쌓아 보여줄 세션 카드 최대 갯수.
const MAX_ACTIVE_SESSIONS: usize = 5;
/// 카드에 표시할 user prompt 요약 길이. 좁은 카드에 깔끔하게 들어가도록 10자로
/// 자르고, 초과분은 말줄임표. 한글이든 영문이든 char 단위 카운트.
const SESSION_PROMPT_PREVIEW_CHARS: usize = 10;

#[derive(Debug, Clone, Serialize)]
pub struct UsageSnapshot {
    pub five_hour_tokens: u64,
    pub weekly_tokens: u64,
    /// Most recent assistant message timestamp (used for the 5min cache TTL).
    pub last_request_at: Option<DateTime<Utc>>,
    /// Latest "real" user prompt (NOT a tool_result follow-up). Used to detect
    /// when the user has just re-prompted Claude.
    pub last_user_prompt_at: Option<DateTime<Utc>>,
    /// True when the latest real user prompt is newer than the latest
    /// assistant message — i.e. Claude is currently "thinking".
    pub is_thinking: bool,
    pub five_hour_window_start: Option<DateTime<Utc>>,
    pub five_hour_resets_at: Option<DateTime<Utc>>,
    pub weekly_window_start: Option<DateTime<Utc>>,
    pub weekly_resets_at: Option<DateTime<Utc>>,
    /// Cache hits (cache_read_input_tokens > 0) in the last 5 minutes.
    pub cache_hits_5min: u32,
    /// Cache misses (cache_read_input_tokens == 0) in the last 5 minutes.
    pub cache_misses_5min: u32,
    /// Consecutive cache hits ending at the most recent assistant message.
    /// Resets to 0 the moment a miss interrupts the streak.
    pub current_combo: u32,
    /// Whether the MOST RECENT assistant message was a cache hit.
    /// Combined with `last_request_at`, the UI fires the flash effect when
    /// this advances — independent of the sliding 5min window count, which
    /// can stay flat or even drop as old entries age out.
    pub last_cache_hit: Option<bool>,
    pub now: DateTime<Utc>,
    /// 활성 세션(=마지막 assistant 응답이 5분 이내)들. 펫 윈도우 위에 카드 stack
    /// 으로 그려진다. 최신순 desc 정렬, 최대 MAX_ACTIVE_SESSIONS개. 비어 있을 수도.
    pub active_sessions: Vec<SessionInfo>,
}

/// 펫 윈도우 위에 그릴 카드 1개에 들어갈 데이터. session_id는 jsonl 파일 basename
/// (uuid)로, 카드 색상 분배(hue 해시)에 사용된다.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SessionInfo {
    pub session_id: String,
    pub last_user_prompt: String,
    pub last_assistant_at: DateTime<Utc>,
    pub cache_hit: bool,
}

#[derive(Debug, Deserialize)]
struct RawLine {
    timestamp: Option<String>,
    message: Option<RawMessage>,
}

#[derive(Debug, Deserialize)]
struct RawMessage {
    role: Option<String>,
    content: Option<serde_json::Value>,
    usage: Option<RawUsage>,
}

#[derive(Debug, Deserialize)]
struct RawUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
}

#[derive(Debug, Clone)]
struct ParsedEntry {
    timestamp: DateTime<Utc>,
    role: Role,
    /// For assistant entries only: tokens (input + output + cache_creation).
    tokens: u64,
    /// For assistant entries only: was the prompt cache hit?
    cache_hit: bool,
    /// jsonl 파일 basename (UUID). 같은 파일에서 나온 entries는 같은 session_id.
    /// group_into_sessions가 이 값으로 묶어 카드별 SessionInfo를 만든다.
    session_id: String,
    /// UserPrompt role일 때만 채움. assistant 직전 prompt를 카드 라벨에 쓸 수 있게.
    user_prompt_text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Assistant,
    UserPrompt,
    UserToolResult,
}

/// Next instance of the given weekday at the given hour:minute in
/// Asia/Seoul timezone, returned as UTC. If `now` (in KST) is already past
/// today's hh:mm on the same weekday, jumps a week.
fn next_weekday_at(now_utc: DateTime<Utc>, day: Weekday, hour: u32, minute: u32) -> DateTime<Utc> {
    let now_kst = now_utc.with_timezone(&Seoul);
    let mut delta_days = (day.num_days_from_monday() as i64
        - now_kst.weekday().num_days_from_monday() as i64
        + 7)
        % 7;
    let candidate = Seoul
        .with_ymd_and_hms(
            now_kst.year(),
            now_kst.month(),
            now_kst.day(),
            hour,
            minute,
            0,
        )
        .single()
        .unwrap_or(now_kst)
        + Duration::days(delta_days);
    if candidate <= now_kst {
        // already past this week's reset on the same weekday
        if delta_days == 0 {
            delta_days = 7;
        }
    }
    let target = Seoul
        .with_ymd_and_hms(
            now_kst.year(),
            now_kst.month(),
            now_kst.day(),
            hour,
            minute,
            0,
        )
        .single()
        .unwrap_or(now_kst)
        + Duration::days(delta_days);
    let target = if target <= now_kst {
        target + Duration::days(7)
    } else {
        target
    };
    let _ = now_kst.hour(); // suppress unused warning if any
    target.with_timezone(&Utc)
}

pub fn claude_projects_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let p = home.join(".claude").join("projects");
    if p.exists() { Some(p) } else { None }
}

fn collect_parsed_since(since: DateTime<Utc>) -> Vec<ParsedEntry> {
    let Some(root) = claude_projects_dir() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl"))
    {
        if let Some(modified) = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .map(DateTime::<Utc>::from)
        {
            if modified < since - Duration::hours(1) {
                continue;
            }
        }
        scan_file(entry.path(), since, &mut out);
    }
    out.sort_by_key(|e| e.timestamp);
    out
}

fn scan_file(path: &Path, since: DateTime<Utc>, out: &mut Vec<ParsedEntry>) {
    let Ok(file) = File::open(path) else { return };
    let reader = BufReader::new(file);
    // jsonl 파일 basename (확장자 제외)을 session_id로 사용. 같은 파일에서 나온
    // 모든 entries는 같은 session_id를 가지므로 후처리에서 group_by_session_id 가능.
    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    for line in reader.lines().map_while(Result::ok) {
        // Cheap pre-filter
        if !line.contains("\"timestamp\"") {
            continue;
        }
        let Ok(raw) = serde_json::from_str::<RawLine>(&line) else {
            continue;
        };
        let Some(msg) = raw.message else { continue };
        let Some(ts_str) = raw.timestamp else { continue };
        let Ok(ts) = DateTime::parse_from_rfc3339(&ts_str) else {
            continue;
        };
        let ts = ts.with_timezone(&Utc);
        if ts < since {
            continue;
        }
        let role = match msg.role.as_deref() {
            Some("assistant") => Role::Assistant,
            Some("user") => {
                if has_tool_result(msg.content.as_ref()) {
                    Role::UserToolResult
                } else {
                    Role::UserPrompt
                }
            }
            _ => continue,
        };

        let (tokens, cache_hit) = if role == Role::Assistant {
            if let Some(ref u) = msg.usage {
                // Anthropic's billing weights: input/output/cache_creation
                // count at full rate; cache_read counts at ~0.1×. We mirror
                // the billing ratio as a quota approximation — empirically
                // this aligns the pet's % to the Claude UI's % within ~5%
                // for typical mixed sessions.
                let cache_read = u.cache_read_input_tokens.unwrap_or(0);
                let t = u.input_tokens.unwrap_or(0)
                    + u.output_tokens.unwrap_or(0)
                    + u.cache_creation_input_tokens.unwrap_or(0)
                    + cache_read / 10;
                let hit = cache_read > 0;
                (t, hit)
            } else {
                continue;
            }
        } else {
            (0, false)
        };

        let user_prompt_text = if role == Role::UserPrompt {
            extract_user_prompt_text(msg.content.as_ref())
        } else {
            None
        };

        out.push(ParsedEntry {
            timestamp: ts,
            role,
            tokens,
            cache_hit,
            session_id: session_id.clone(),
            user_prompt_text,
        });
    }
}

/// UserPrompt entries의 content에서 첫 텍스트를 뽑는다. Anthropic JSONL의 content는
/// `[{"type":"text","text":"..."}]` 형태가 일반적이고, 가끔 그냥 string.
fn extract_user_prompt_text(content: Option<&serde_json::Value>) -> Option<String> {
    let content = content?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = content.as_array() {
        for item in arr {
            if item.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(s) = item.get("text").and_then(|v| v.as_str()) {
                    return Some(s.to_string());
                }
            }
        }
    }
    None
}

/// 모든 ParsedEntry를 session_id별로 묶고, 활성(마지막 assistant 응답이 5분 이내)
/// 세션만 골라 SessionInfo Vec으로 반환. 최신순 정렬, 최대 MAX_ACTIVE_SESSIONS.
/// 카드 라벨용 prompt는 그 세션의 *마지막 assistant 직전* UserPrompt에서 잡는다
/// (그 prompt가 그 응답을 유발한 message). pure 함수라 cargo test로 검증한다.
fn group_into_sessions(entries: &[ParsedEntry], now: DateTime<Utc>) -> Vec<SessionInfo> {
    use std::collections::HashMap;
    let cutoff = now - Duration::seconds(SESSION_ACTIVE_SECS);

    let mut by_session: HashMap<String, Vec<&ParsedEntry>> = HashMap::new();
    for e in entries {
        by_session
            .entry(e.session_id.clone())
            .or_default()
            .push(e);
    }

    let mut sessions: Vec<SessionInfo> = Vec::new();
    for (session_id, mut group) in by_session {
        if session_id.is_empty() {
            continue;
        }
        group.sort_by_key(|e| e.timestamp);
        // 마지막 assistant 찾기. 없거나 cutoff 이전이면 inactive — 카드 안 띄움.
        let Some(asst_idx) = group.iter().rposition(|e| e.role == Role::Assistant)
        else {
            continue;
        };
        let asst = group[asst_idx];
        if asst.timestamp < cutoff {
            continue;
        }
        // 그 assistant 직전의 UserPrompt (tool_result follow-up은 UserPrompt가 아님).
        // 없으면 "(no prompt)"로 placeholder. 사용자에게 인지 가능한 라벨이 안 보이는
        // 케이스를 막기 위한 fallback이지 비정상 상황을 묵음 처리하는 건 아니다.
        let prompt_text = group[..asst_idx]
            .iter()
            .rev()
            .find(|e| e.role == Role::UserPrompt)
            .and_then(|e| e.user_prompt_text.clone())
            .unwrap_or_else(|| "(없음)".to_string());

        sessions.push(SessionInfo {
            session_id,
            last_user_prompt: truncate_prompt(&prompt_text, SESSION_PROMPT_PREVIEW_CHARS),
            last_assistant_at: asst.timestamp,
            cache_hit: asst.cache_hit,
        });
    }

    // 최신 응답 먼저. 최대 5개에서 잘라낸다.
    sessions.sort_by(|a, b| b.last_assistant_at.cmp(&a.last_assistant_at));
    sessions.truncate(MAX_ACTIVE_SESSIONS);
    sessions
}

/// 줄바꿈은 공백 1개로 압축하고 양끝 공백 trim, max_chars 초과면 말줄임표 부착.
/// char 단위 카운트라 한글도 안전.
fn truncate_prompt(s: &str, max_chars: usize) -> String {
    let cleaned: String = s
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.chars().count() <= max_chars {
        return cleaned;
    }
    let truncated: String = cleaned.chars().take(max_chars).collect();
    // 잘린 끝이 공백이면 ellipsis 직전이 어색 — trim_end로 정리.
    format!("{}…", truncated.trim_end())
}

fn has_tool_result(content: Option<&serde_json::Value>) -> bool {
    let Some(content) = content else { return false };
    let Some(arr) = content.as_array() else { return false };
    for item in arr {
        if let Some(t) = item.get("type").and_then(|v| v.as_str()) {
            if t == "tool_result" {
                return true;
            }
        }
    }
    false
}

/// Anthropic's 5-hour window is anchored at the FIRST message of a window.
/// When that window expires (5h after start), the very next message starts
/// a brand-new window — regardless of whether there was an idle gap.
///
/// Walk forward through assistants, anchoring a new window every time the
/// previous one has lapsed. Return the start of the window that contains
/// the latest assistant message (or None if all windows have expired and
/// no new request has come in since).
fn five_hour_window_start(
    assistant_entries: &[&ParsedEntry],
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    if assistant_entries.is_empty() {
        return None;
    }
    let mut start = assistant_entries[0].timestamp;
    let mut end = start + Duration::hours(5);
    for entry in assistant_entries.iter().skip(1) {
        if entry.timestamp >= end {
            start = entry.timestamp;
            end = start + Duration::hours(5);
        }
    }
    if now >= end {
        return None;
    }
    Some(start)
}

pub fn snapshot() -> UsageSnapshot {
    let now = Utc::now();
    let lookback = now - Duration::days(WEEKLY_LOOKBACK_DAYS);
    let parsed = collect_parsed_since(lookback);

    let assistants: Vec<&ParsedEntry> =
        parsed.iter().filter(|e| e.role == Role::Assistant).collect();

    let five_start = five_hour_window_start(&assistants, now);
    let five_reset = five_start.map(|s| s + Duration::hours(5));

    let mut five_hour: u64 = 0;
    let mut weekly: u64 = 0;
    let mut weekly_first: Option<DateTime<Utc>> = None;
    let mut last_assistant_at: Option<DateTime<Utc>> = None;
    let mut last_user_prompt_at: Option<DateTime<Utc>> = None;

    let cache_window_start = now - Duration::milliseconds(CACHE_WINDOW_MS);
    let mut hits_5min: u32 = 0;
    let mut misses_5min: u32 = 0;
    let mut last_cache_hit: Option<bool> = None;

    for e in &parsed {
        match e.role {
            Role::Assistant => {
                weekly = weekly.saturating_add(e.tokens);
                if weekly_first.is_none() {
                    weekly_first = Some(e.timestamp);
                }
                if let Some(start) = five_start {
                    if e.timestamp >= start && e.timestamp <= now {
                        five_hour = five_hour.saturating_add(e.tokens);
                    }
                }
                last_assistant_at = Some(e.timestamp);
                last_cache_hit = Some(e.cache_hit);
                if e.timestamp >= cache_window_start {
                    if e.cache_hit {
                        hits_5min = hits_5min.saturating_add(1);
                    } else {
                        misses_5min = misses_5min.saturating_add(1);
                    }
                }
            }
            Role::UserPrompt => {
                last_user_prompt_at = Some(e.timestamp);
            }
            Role::UserToolResult => {
                // ignored for thinking-state detection
            }
        }
    }

    // Combo: walk assistants backwards counting consecutive hits.
    let mut current_combo: u32 = 0;
    for a in assistants.iter().rev() {
        if a.cache_hit {
            current_combo += 1;
        } else {
            break;
        }
    }

    // Anthropic's weekly window resets on a fixed weekday for each account.
    // Until/unless we expose a setting, default to Friday 06:00 KST — that's
    // what shows up in Claude UI for accounts in this region.
    let weekly_reset = Some(next_weekday_at(now, Weekday::Fri, 6, 0));
    let _ = weekly_first; // kept for future use; reset is now anchor-based

    let is_thinking = match (last_user_prompt_at, last_assistant_at) {
        (Some(u), Some(a)) => u > a,
        (Some(_), None) => true,
        _ => false,
    };

    let active_sessions = group_into_sessions(&parsed, now);

    UsageSnapshot {
        five_hour_tokens: five_hour,
        weekly_tokens: weekly,
        last_request_at: last_assistant_at,
        last_user_prompt_at,
        is_thinking,
        five_hour_window_start: five_start,
        five_hour_resets_at: five_reset,
        weekly_window_start: weekly_first,
        weekly_resets_at: weekly_reset,
        cache_hits_5min: hits_5min,
        cache_misses_5min: misses_5min,
        current_combo,
        last_cache_hit,
        now,
        active_sessions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ts(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn assistant(ts_str: &str) -> ParsedEntry {
        ParsedEntry {
            timestamp: ts(ts_str),
            role: Role::Assistant,
            tokens: 0,
            cache_hit: false,
            session_id: String::new(),
            user_prompt_text: None,
        }
    }

    fn assistant_in(ts_str: &str, session: &str, cache_hit: bool) -> ParsedEntry {
        ParsedEntry {
            timestamp: ts(ts_str),
            role: Role::Assistant,
            tokens: 0,
            cache_hit,
            session_id: session.to_string(),
            user_prompt_text: None,
        }
    }

    fn user_prompt_in(ts_str: &str, session: &str, text: &str) -> ParsedEntry {
        ParsedEntry {
            timestamp: ts(ts_str),
            role: Role::UserPrompt,
            tokens: 0,
            cache_hit: false,
            session_id: session.to_string(),
            user_prompt_text: Some(text.to_string()),
        }
    }

    // ===== has_tool_result =====

    #[test]
    fn has_tool_result_false_when_content_none() {
        assert!(!has_tool_result(None));
    }

    #[test]
    fn has_tool_result_false_when_content_not_array() {
        let v = json!({"type": "tool_result"});
        assert!(!has_tool_result(Some(&v)));
    }

    #[test]
    fn has_tool_result_true_when_item_type_is_tool_result() {
        let v = json!([{"type": "text", "text": "hi"}, {"type": "tool_result"}]);
        assert!(has_tool_result(Some(&v)));
    }

    #[test]
    fn has_tool_result_false_when_no_tool_result_in_array() {
        let v = json!([{"type": "text"}, {"type": "image"}]);
        assert!(!has_tool_result(Some(&v)));
    }

    // ===== five_hour_window_start =====

    #[test]
    fn window_none_when_empty() {
        let now = ts("2026-05-16T12:00:00Z");
        assert_eq!(five_hour_window_start(&[], now), None);
    }

    #[test]
    fn window_anchored_at_first_message_within_5h() {
        let e1 = assistant("2026-05-16T10:00:00Z");
        let e2 = assistant("2026-05-16T11:30:00Z");
        let now = ts("2026-05-16T12:00:00Z");
        let start = five_hour_window_start(&[&e1, &e2], now);
        assert_eq!(start, Some(ts("2026-05-16T10:00:00Z")));
    }

    #[test]
    fn window_re_anchors_when_previous_5h_lapsed() {
        // 10:00 첫 메시지 → 15:00에 윈도우 만료. 15:30 메시지가 새 윈도우 시작.
        let e1 = assistant("2026-05-16T10:00:00Z");
        let e2 = assistant("2026-05-16T15:30:00Z");
        let now = ts("2026-05-16T17:00:00Z");
        let start = five_hour_window_start(&[&e1, &e2], now);
        assert_eq!(start, Some(ts("2026-05-16T15:30:00Z")));
    }

    #[test]
    fn window_none_when_latest_is_expired() {
        // 10:00 한 번 보내고 한참 idle. now=20:00이면 마지막 윈도우(10:00~15:00)도 만료.
        let e1 = assistant("2026-05-16T10:00:00Z");
        let now = ts("2026-05-16T20:00:00Z");
        assert_eq!(five_hour_window_start(&[&e1], now), None);
    }

    // ===== next_weekday_at (Seoul 기준) =====

    #[test]
    fn next_weekday_at_jumps_a_week_when_same_day_already_past() {
        // KST 월요일 14:00 → 같은 월요일 09:00 요청 → 다음 주 월요일 09:00 반환
        // 월요일 14:00 KST = 월요일 05:00 UTC
        let now_utc = ts("2026-05-18T05:00:00Z"); // 월요일
        let target = next_weekday_at(now_utc, Weekday::Mon, 9, 0);
        // 다음 월요일 09:00 KST = 다음 월요일 00:00 UTC
        assert_eq!(target, ts("2026-05-25T00:00:00Z"));
    }

    #[test]
    fn next_weekday_at_returns_today_when_future() {
        // KST 월요일 08:00 → 같은 월요일 09:00 요청 → 같은 날 09:00 반환
        // 월요일 08:00 KST = 일요일 23:00 UTC
        let now_utc = ts("2026-05-17T23:00:00Z");
        let target = next_weekday_at(now_utc, Weekday::Mon, 9, 0);
        // 같은 월요일 09:00 KST = 같은 월요일 00:00 UTC
        assert_eq!(target, ts("2026-05-18T00:00:00Z"));
    }

    // ===== group_into_sessions =====

    #[test]
    fn group_into_sessions_returns_empty_when_no_entries() {
        let now = ts("2026-05-16T13:00:00Z");
        assert!(group_into_sessions(&[], now).is_empty());
    }

    #[test]
    fn group_into_sessions_returns_one_for_single_session() {
        // 한 세션에 user → assistant. assistant가 cutoff 안.
        let entries = vec![
            user_prompt_in("2026-05-16T12:58:00Z", "sess-A", "안녕, 코드 리뷰 좀"),
            assistant_in("2026-05-16T12:58:30Z", "sess-A", true),
        ];
        let now = ts("2026-05-16T13:00:00Z");
        let sessions = group_into_sessions(&entries, now);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "sess-A");
        assert_eq!(sessions[0].last_user_prompt, "안녕, 코드 리뷰…");
        assert!(sessions[0].cache_hit);
        assert_eq!(sessions[0].last_assistant_at, ts("2026-05-16T12:58:30Z"));
    }

    #[test]
    fn group_into_sessions_drops_inactive_session_past_5min() {
        // 마지막 assistant가 7분 전이면 cutoff 밖이라 drop.
        let entries = vec![
            user_prompt_in("2026-05-16T12:52:00Z", "sess-old", "옛 질문"),
            assistant_in("2026-05-16T12:53:00Z", "sess-old", false),
        ];
        let now = ts("2026-05-16T13:00:00Z");
        assert!(group_into_sessions(&entries, now).is_empty());
    }

    #[test]
    fn group_into_sessions_separates_by_session_id() {
        // 두 세션 각각의 마지막 assistant.
        let entries = vec![
            user_prompt_in("2026-05-16T12:58:00Z", "A", "질문 A"),
            assistant_in("2026-05-16T12:58:30Z", "A", false),
            user_prompt_in("2026-05-16T12:59:00Z", "B", "질문 B"),
            assistant_in("2026-05-16T12:59:30Z", "B", true),
        ];
        let now = ts("2026-05-16T13:00:00Z");
        let sessions = group_into_sessions(&entries, now);
        assert_eq!(sessions.len(), 2);
        // 최신 응답 먼저: B
        assert_eq!(sessions[0].session_id, "B");
        assert_eq!(sessions[1].session_id, "A");
    }

    #[test]
    fn group_into_sessions_caps_at_five_most_recent() {
        // 7개 세션, 모두 cutoff 안(5분 이내). 최신 5개만 남아야 함.
        // 마지막 assistant 시각: 12:55:00 ~ 12:55:30 (5초 간격으로 7개).
        // now=12:59:00이면 cutoff=12:54:00 → 모두 active.
        let mut entries = Vec::new();
        for i in 0..7u32 {
            let session = format!("s{}", i);
            let user_sec = i * 5;
            let asst_sec = i * 5 + 1;
            entries.push(user_prompt_in(
                &format!("2026-05-16T12:55:{:02}Z", user_sec),
                &session,
                "q",
            ));
            entries.push(assistant_in(
                &format!("2026-05-16T12:55:{:02}Z", asst_sec),
                &session,
                false,
            ));
        }
        let now = ts("2026-05-16T12:59:00Z");
        let sessions = group_into_sessions(&entries, now);
        assert_eq!(sessions.len(), 5);
        // 최신 5개: s6, s5, s4, s3, s2
        assert_eq!(sessions[0].session_id, "s6");
        assert_eq!(sessions[4].session_id, "s2");
    }

    #[test]
    fn group_into_sessions_picks_prompt_just_before_last_assistant() {
        // 한 세션에 prompt → asst → prompt → asst 흐름. 마지막 asst 직전 prompt가 라벨.
        let entries = vec![
            user_prompt_in("2026-05-16T12:50:00Z", "X", "첫 질문"),
            assistant_in("2026-05-16T12:50:30Z", "X", false),
            user_prompt_in("2026-05-16T12:58:00Z", "X", "두 번째 질문"),
            assistant_in("2026-05-16T12:58:30Z", "X", true),
        ];
        let now = ts("2026-05-16T13:00:00Z");
        let sessions = group_into_sessions(&entries, now);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].last_user_prompt, "두 번째 질문");
    }

    #[test]
    fn group_into_sessions_fallbacks_to_placeholder_when_no_prompt() {
        // assistant만 있고 UserPrompt 없는 비정상 케이스. "(no prompt)" 라벨.
        let entries = vec![assistant_in("2026-05-16T12:59:00Z", "Y", false)];
        let now = ts("2026-05-16T13:00:00Z");
        let sessions = group_into_sessions(&entries, now);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].last_user_prompt, "(없음)");
    }

    #[test]
    fn group_into_sessions_skips_empty_session_id() {
        // session_id 비어있으면 (path basename 추출 실패) drop.
        let entries = vec![
            user_prompt_in("2026-05-16T12:59:00Z", "", "q"),
            assistant_in("2026-05-16T12:59:30Z", "", false),
        ];
        let now = ts("2026-05-16T13:00:00Z");
        assert!(group_into_sessions(&entries, now).is_empty());
    }

    // ===== truncate_prompt =====

    #[test]
    fn truncate_prompt_keeps_short_strings_intact() {
        assert_eq!(truncate_prompt("짧음", 40), "짧음");
    }

    #[test]
    fn truncate_prompt_collapses_whitespace() {
        assert_eq!(truncate_prompt("a\n\nb   c", 40), "a b c");
    }

    #[test]
    fn truncate_prompt_appends_ellipsis_on_overflow() {
        let s = "a".repeat(50);
        let out = truncate_prompt(&s, 10);
        assert_eq!(out.chars().count(), 11); // 10 chars + …
        assert!(out.ends_with('…'));
    }

    #[test]
    fn truncate_prompt_counts_chars_not_bytes_for_korean() {
        // 한글 한 글자 = 3 bytes, 그러나 count는 char 기준.
        let s = "한글한글한글한글";
        let out = truncate_prompt(s, 4);
        assert_eq!(out, "한글한글…");
    }

    // ===== extract_user_prompt_text =====

    #[test]
    fn extract_user_prompt_from_text_array() {
        let v = serde_json::json!([{"type": "text", "text": "hello"}]);
        assert_eq!(extract_user_prompt_text(Some(&v)), Some("hello".to_string()));
    }

    #[test]
    fn extract_user_prompt_from_bare_string() {
        let v = serde_json::json!("plain prompt");
        assert_eq!(
            extract_user_prompt_text(Some(&v)),
            Some("plain prompt".to_string())
        );
    }

    #[test]
    fn extract_user_prompt_returns_none_when_no_text() {
        let v = serde_json::json!([{"type": "tool_result", "content": "x"}]);
        assert_eq!(extract_user_prompt_text(Some(&v)), None);
    }

    #[test]
    fn extract_user_prompt_returns_none_when_content_missing() {
        assert_eq!(extract_user_prompt_text(None), None);
    }

    // ===== 추가 회귀 케이스 (v1.51 테스트 커버리지 보강) =====

    #[test]
    fn has_tool_result_false_when_array_is_empty() {
        let v = json!([]);
        assert!(!has_tool_result(Some(&v)));
    }

    #[test]
    fn has_tool_result_true_when_first_item_is_tool_result() {
        let v = json!([{"type": "tool_result"}, {"type": "text"}]);
        assert!(has_tool_result(Some(&v)));
    }

    #[test]
    fn has_tool_result_true_when_multiple_tool_results_present() {
        let v = json!([{"type": "tool_result"}, {"type": "tool_result"}]);
        assert!(has_tool_result(Some(&v)));
    }

    #[test]
    fn has_tool_result_ignores_item_without_type_field() {
        // 일부 entry가 type 필드 누락이어도 다른 항목이 tool_result면 true.
        let v = json!([{"foo": "bar"}, {"type": "tool_result"}]);
        assert!(has_tool_result(Some(&v)));
    }

    #[test]
    fn five_hour_window_returns_none_at_exact_5h_boundary() {
        // 윈도우는 [start, start+5h) 반열림. now == start+5h 면 만료 처리.
        let e1 = assistant("2026-05-16T10:00:00Z");
        let now = ts("2026-05-16T15:00:00Z"); // 정확히 +5h
        assert_eq!(five_hour_window_start(&[&e1], now), None);
    }

    #[test]
    fn five_hour_window_includes_message_exactly_at_5h_boundary_as_new_window() {
        // 10:00 첫 메시지 → [10:00, 15:00). 15:00 정확히 도착한 메시지는
        // 옛 윈도우 밖이므로 새 윈도우([15:00, 20:00))를 anchor 한다.
        let e1 = assistant("2026-05-16T10:00:00Z");
        let e2 = assistant("2026-05-16T15:00:00Z");
        let now = ts("2026-05-16T16:00:00Z");
        let start = five_hour_window_start(&[&e1, &e2], now);
        assert_eq!(start, Some(ts("2026-05-16T15:00:00Z")));
    }

    #[test]
    fn five_hour_window_chains_three_consecutive_windows() {
        // 윈도우 3개 연쇄: 10:00 → 15:30(2번째) → 21:00(3번째)
        let e1 = assistant("2026-05-16T10:00:00Z");
        let e2 = assistant("2026-05-16T15:30:00Z"); // 1번째 만료 → 새 윈도우
        let e3 = assistant("2026-05-16T21:00:00Z"); // 2번째 만료 → 새 윈도우
        let now = ts("2026-05-16T22:00:00Z");
        let start = five_hour_window_start(&[&e1, &e2, &e3], now);
        assert_eq!(start, Some(ts("2026-05-16T21:00:00Z")));
    }

    #[test]
    fn five_hour_window_single_entry_within_5h() {
        let e1 = assistant("2026-05-16T11:00:00Z");
        let now = ts("2026-05-16T13:00:00Z"); // +2h
        let start = five_hour_window_start(&[&e1], now);
        assert_eq!(start, Some(ts("2026-05-16T11:00:00Z")));
    }

    #[test]
    fn next_weekday_at_returns_next_friday_06_kst_from_thursday() {
        // 실제 사용 케이스: Anthropic weekly reset 은 금요일 06:00 KST.
        // KST 목요일 12:00 → 다음 금요일 06:00 KST 반환.
        // 목요일 12:00 KST = 목요일 03:00 UTC. 다음 금요일 06:00 KST = 금요일 -3:00 UTC = 금요일 새벽
        // (목요일 자정 KST = 목요일 15:00 UTC 의 다음날인 금요일 21:00 UTC).
        let now_utc = ts("2026-05-21T03:00:00Z"); // 목요일 12:00 KST
        let target = next_weekday_at(now_utc, Weekday::Fri, 6, 0);
        // 금요일 06:00 KST = 금요일 -3:00 UTC = 목요일 21:00 UTC
        assert_eq!(target, ts("2026-05-21T21:00:00Z"));
    }

    #[test]
    fn next_weekday_at_same_weekday_exact_time_jumps_to_next_week() {
        // KST 월요일 09:00 정각에 호출 + target 월요일 09:00 → candidate <= now 이므로
        // 다음 주로 점프해야 함. (정확히 같은 시각도 "이미 지나간 것"으로 본다.)
        let now_utc = ts("2026-05-18T00:00:00Z"); // 월요일 09:00 KST 정각
        let target = next_weekday_at(now_utc, Weekday::Mon, 9, 0);
        assert_eq!(target, ts("2026-05-25T00:00:00Z"));
    }

    #[test]
    fn group_into_sessions_keeps_session_with_assistant_at_exact_cutoff() {
        // assistant 가 정확히 cutoff(now - 5분) 시각이면 active 유지.
        // 코드 조건: `asst.timestamp < cutoff` 이면 drop 이므로, == 은 keep.
        let entries = vec![
            user_prompt_in("2026-05-16T12:54:00Z", "S", "경계"),
            assistant_in("2026-05-16T12:55:00Z", "S", false),
        ];
        let now = ts("2026-05-16T13:00:00Z"); // cutoff 정확히 12:55:00
        let sessions = group_into_sessions(&entries, now);
        assert_eq!(sessions.len(), 1);
    }

    #[test]
    fn group_into_sessions_orders_strictly_by_last_assistant_time_desc() {
        // 세 세션, 마지막 assistant 시각이 가까이 붙어 있어도 정확히 desc 정렬.
        let entries = vec![
            user_prompt_in("2026-05-16T12:58:00Z", "A", "qA"),
            assistant_in("2026-05-16T12:58:30Z", "A", false),
            user_prompt_in("2026-05-16T12:59:00Z", "B", "qB"),
            assistant_in("2026-05-16T12:59:30Z", "B", true),
            user_prompt_in("2026-05-16T12:59:15Z", "C", "qC"),
            assistant_in("2026-05-16T12:59:45Z", "C", false),
        ];
        let now = ts("2026-05-16T13:00:00Z");
        let sessions = group_into_sessions(&entries, now);
        assert_eq!(sessions[0].session_id, "C"); // 12:59:45 가장 최신
        assert_eq!(sessions[1].session_id, "B"); // 12:59:30
        assert_eq!(sessions[2].session_id, "A"); // 12:58:30
    }

    #[test]
    fn group_into_sessions_carries_cache_hit_flag_of_latest_assistant() {
        // 마지막 assistant 의 cache_hit 값이 SessionInfo.cache_hit 으로 전달된다.
        // 같은 세션 안에 hit 과 miss 가 섞여 있어도 *마지막* 응답만 반영.
        let entries = vec![
            user_prompt_in("2026-05-16T12:58:00Z", "X", "q1"),
            assistant_in("2026-05-16T12:58:30Z", "X", true), // miss 처럼 보이지만 다음 asst 가 결정
            user_prompt_in("2026-05-16T12:59:00Z", "X", "q2"),
            assistant_in("2026-05-16T12:59:30Z", "X", false),
        ];
        let now = ts("2026-05-16T13:00:00Z");
        let sessions = group_into_sessions(&entries, now);
        assert_eq!(sessions.len(), 1);
        assert!(!sessions[0].cache_hit); // 마지막 응답 cache_hit=false
    }

    #[test]
    fn truncate_prompt_empty_string_returns_empty() {
        assert_eq!(truncate_prompt("", 10), "");
    }

    #[test]
    fn truncate_prompt_only_whitespace_collapses_to_empty() {
        // split_whitespace + join(" ") 흐름에서 공백만 들어오면 빈 문자열.
        assert_eq!(truncate_prompt("   \n\t  ", 10), "");
    }

    #[test]
    fn truncate_prompt_with_zero_max_chars_returns_just_ellipsis_for_non_empty_input() {
        // max_chars=0 + 비어 있지 않은 입력 → 0자 + … = "…"
        // 빈 입력은 그대로 빈 문자열 (chars().count() == 0 == max).
        assert_eq!(truncate_prompt("a", 0), "…");
        assert_eq!(truncate_prompt("", 0), "");
    }

    #[test]
    fn truncate_prompt_exactly_at_max_chars_no_ellipsis() {
        // 정확히 max_chars면 ellipsis 안 붙음.
        assert_eq!(truncate_prompt("0123456789", 10), "0123456789");
    }

    #[test]
    fn extract_user_prompt_from_array_picks_first_text_block() {
        // text 블록이 여러 개면 첫 번째.
        let v = serde_json::json!([
            {"type": "text", "text": "first"},
            {"type": "text", "text": "second"},
        ]);
        assert_eq!(
            extract_user_prompt_text(Some(&v)),
            Some("first".to_string())
        );
    }

    #[test]
    fn extract_user_prompt_skips_non_text_items_before_text() {
        // tool_result 등 다른 타입이 먼저 와도 text 블록은 발견한다.
        let v = serde_json::json!([
            {"type": "tool_result", "content": "x"},
            {"type": "text", "text": "the prompt"},
        ]);
        assert_eq!(
            extract_user_prompt_text(Some(&v)),
            Some("the prompt".to_string())
        );
    }
}
