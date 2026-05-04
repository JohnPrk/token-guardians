use chrono::{DateTime, Datelike, Duration, TimeZone, Timelike, Utc, Weekday};
use chrono_tz::Asia::Seoul;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const WEEKLY_LOOKBACK_DAYS: i64 = 7;
const CACHE_WINDOW_MS: i64 = 5 * 60 * 1000;

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
            if let Some(u) = msg.usage {
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

        out.push(ParsedEntry {
            timestamp: ts,
            role,
            tokens,
            cache_hit,
        });
    }
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
    }
}
