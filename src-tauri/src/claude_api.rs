use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiUsage {
    /// 0.0 ~ 100.0 (utilization %, NOT remaining)
    pub five_hour_pct: f64,
    pub weekly_pct: f64,
    pub five_hour_resets_at: Option<DateTime<Utc>>,
    pub weekly_resets_at: Option<DateTime<Utc>>,
    pub fetched_at: DateTime<Utc>,
}

/// platform.claude.com 의 prepaid 잔액. dollars 단위(소수점 둘째자리까지)로 들고
/// 있는다. 응답 스키마를 정확히 알 수 없는 키들이 섞여 있어
/// parse_prepaid_credits가 여러 후보 키 + cents↔dollars 휴리스틱으로 최대한
/// 끌어낸다. 실패하면 None.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrepaidCredits {
    pub dollars: f64,
    pub fetched_at: DateTime<Utc>,
}

/// claude.ai sometimes nests its usage payload under different field
/// names ("five_hour" vs "five_hour_limit", "seven_day" vs
/// "seven_day_limit", "weekly", etc.) and "utilization" can be either
/// a percentage (0–100) or a fraction (0–1) depending on shape. Walk
/// the JSON loosely so we don't silently turn schema drift into 0%.
fn extract_window(
    root: &serde_json::Value,
    keys: &[&str],
) -> (Option<f64>, Option<DateTime<Utc>>) {
    for k in keys {
        if let Some(w) = root.get(k) {
            let util = pick_utilization(w);
            let reset = pick_reset(w);
            if util.is_some() || reset.is_some() {
                return (util, reset);
            }
        }
    }
    (None, None)
}

fn pick_utilization(w: &serde_json::Value) -> Option<f64> {
    // Try a few common field names, AND accept either pct (0–100) or
    // fraction (0–1). Heuristic: if value <= 1.5 treat as fraction.
    let candidates = [
        "utilization",
        "utilization_pct",
        "utilization_percentage",
        "percent_used",
        "pct_used",
        "used_pct",
    ];
    for c in candidates {
        if let Some(v) = w.get(c).and_then(|v| v.as_f64()) {
            return Some(if v <= 1.5 { v * 100.0 } else { v });
        }
    }
    // Sometimes there's a sub-array of buckets keyed by model name —
    // take the max utilization across them as the "overall" weekly.
    if let Some(arr) = w.get("buckets").and_then(|v| v.as_array()) {
        let mut best: Option<f64> = None;
        for item in arr {
            if let Some(v) = pick_utilization(item) {
                best = Some(best.map_or(v, |b| b.max(v)));
            }
        }
        if best.is_some() {
            return best;
        }
    }
    None
}

fn pick_reset(w: &serde_json::Value) -> Option<DateTime<Utc>> {
    let candidates = ["resets_at", "reset_at", "expires_at", "ends_at"];
    for c in candidates {
        if let Some(s) = w.get(c).and_then(|v| v.as_str()) {
            if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
                return Some(dt.with_timezone(&Utc));
            }
        }
    }
    None
}

/// Strip Markdown autolink artifacts that get inserted when the user
/// copies a cookie blob from Slack / Discord / Notion / Telegram / a
/// rendered Markdown view. Two common shapes:
///   `[text](http://url-text)`   — explicit autolink
///   the URL part repeats the value, so we can drop the `(...)` chunk
///   AND the surrounding brackets without losing data.
fn sanitize_cookie(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        // Detect "[" ... "](http..." ... ")" — flatten to the inner text.
        if bytes[i] == b'[' {
            // Find matching ']' (no nested brackets in cookies).
            if let Some(rel_close) = raw[i + 1..].find(']') {
                let close = i + 1 + rel_close;
                // Look for "](" right after the close bracket.
                if close + 1 < bytes.len() && bytes[close + 1] == b'(' {
                    if let Some(rel_paren) = raw[close + 2..].find(')') {
                        let paren_close = close + 2 + rel_paren;
                        let inner = &raw[i + 1..close];
                        out.push_str(inner);
                        i = paren_close + 1;
                        continue;
                    }
                }
                // Lonely [ ... ] without (url) — keep contents only.
                let inner = &raw[i + 1..close];
                out.push_str(inner);
                i = close + 1;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    // Collapse whitespace inside the cookie line (newlines, etc.) into
    // single spaces. The HTTP client rejects raw newlines in headers.
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Hit claude.ai's internal usage endpoint with the user's session cookie.
/// Returns the parsed % + reset timestamps, or an error string suitable for
/// displaying in the UI.
pub fn fetch_usage(org_id: &str, cookie: &str) -> Result<ApiUsage, String> {
    let cookie = sanitize_cookie(cookie);
    let cookie = cookie.as_str();
    let url = format!("https://claude.ai/api/organizations/{}/usage", org_id);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client build: {}", e))?;

    // Mimic a real Chrome request to claude.ai/settings/usage. Without
    // the anthropic-client-* headers and a modern UA, Cloudflare and
    // the API gateway are happy to return 403 / empty / wrong shape.
    let resp = client
        .get(&url)
        .header("Cookie", cookie)
        .header("Accept", "*/*")
        .header("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")
        .header("Referer", "https://claude.ai/settings/usage")
        .header("anthropic-client-platform", "web_claude_ai")
        .header("anthropic-client-version", "1.0.0")
        .header("sec-ch-ua-platform", "\"macOS\"")
        .header("sec-fetch-dest", "empty")
        .header("sec-fetch-mode", "cors")
        .header("sec-fetch-site", "same-origin")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        )
        .send()
        .map_err(|e| format!("request: {}", e))?;

    let status = resp.status();
    let body = resp.text().unwrap_or_default();

    if !status.is_success() {
        // Surface the first 200 chars of the response so the user can
        // see whether it's a Cloudflare challenge HTML, an auth error,
        // or something else entirely.
        let preview: String = body.chars().take(200).collect();
        return Err(format!(
            "HTTP {} — {}",
            status.as_u16(),
            preview.trim()
        ));
    }

    let root: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        let preview: String = body.chars().take(200).collect();
        format!("응답 파싱 실패: {} ({})", e, preview.trim())
    })?;

    let (five_pct, five_reset) = extract_window(
        &root,
        &["five_hour", "five_hour_limit", "five_hour_window", "five_hour_usage"],
    );
    let (weekly_pct, weekly_reset) = extract_window(
        &root,
        &[
            "seven_day",
            "seven_day_limit",
            "seven_day_window",
            "weekly",
            "weekly_limit",
            "weekly_overall",
        ],
    );

    if five_pct.is_none() && weekly_pct.is_none() {
        let preview: String = body.chars().take(300).collect();
        return Err(format!(
            "응답에서 five_hour/seven_day 필드를 못 찾음: {}",
            preview.trim()
        ));
    }

    Ok(ApiUsage {
        five_hour_pct: five_pct.unwrap_or(0.0),
        weekly_pct: weekly_pct.unwrap_or(0.0),
        five_hour_resets_at: five_reset,
        weekly_resets_at: weekly_reset,
        fetched_at: Utc::now(),
    })
}

/// platform.claude.com 의 prepaid 잔액(달러) 호출. 사용자가 console DevTools로
/// 잡아준 엔드포인트: GET /api/organizations/{org}/prepaid/credits.
/// claude.ai/api/.../usage 와는 *호스트가 다름* (platform 콘솔), 그래서 Referer/
/// anthropic-client-platform도 web_console 톤으로 송신해야 게이트웨이 통과한다.
pub fn fetch_prepaid_credits(org_id: &str, cookie: &str) -> Result<f64, String> {
    let cookie = sanitize_cookie(cookie);
    let cookie = cookie.as_str();
    let url = format!(
        "https://platform.claude.com/api/organizations/{}/prepaid/credits",
        org_id
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client build: {}", e))?;

    let resp = client
        .get(&url)
        .header("Cookie", cookie)
        .header("Accept", "*/*")
        .header("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")
        .header("Referer", "https://platform.claude.com/settings/billing")
        .header("anthropic-client-platform", "web_console")
        .header("anthropic-client-version", "unknown")
        .header("sec-ch-ua-platform", "\"macOS\"")
        .header("sec-fetch-dest", "empty")
        .header("sec-fetch-mode", "cors")
        .header("sec-fetch-site", "same-origin")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        )
        .send()
        .map_err(|e| format!("prepaid request: {}", e))?;

    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if !status.is_success() {
        let preview: String = body.chars().take(200).collect();
        return Err(format!("prepaid HTTP {} — {}", status.as_u16(), preview.trim()));
    }

    let root: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        let preview: String = body.chars().take(200).collect();
        format!("prepaid 응답 파싱 실패: {} ({})", e, preview.trim())
    })?;

    parse_prepaid_credits(&root).ok_or_else(|| {
        let preview: String = body.chars().take(300).collect();
        format!("prepaid 응답에서 잔액 필드를 못 찾음: {}", preview.trim())
    })
}

/// prepaid/credits 응답을 dollars로 변환. 콘솔에서 안 보이는 정확한 필드명을
/// 모르는 상태라 여러 후보를 시도한다. cents 단위가 의심되는 큰 정수(>=1000)는
/// 100으로 나눠 dollars로 본다. credits[] 배열은 모두 합산한다.
///
/// 음수 후보는 잔액으로 해석 불가(prepaid는 0 이상)이므로 건너뛴다. 실제
/// 응답이 `{amount: -1, ...}` 형태로 auto_reload threshold 같은 sentinel을
/// 흘려보낼 때 펫에 "$-1.00"이 박히는 회귀를 막는다.
pub fn parse_prepaid_credits(root: &serde_json::Value) -> Option<f64> {
    // 1) 단일 필드 후보들 (dollars 가정).
    let direct_dollar_keys = [
        "available_dollars",
        "balance_dollars",
        "remaining_dollars",
        "credit_dollars",
        "balance",          // 흔히 dollars
        "available_balance",
        "remaining",
        "credit",
        "amount",
    ];
    for k in direct_dollar_keys {
        if let Some(v) = root.get(k).and_then(|v| v.as_f64()) {
            let dollars = round2(coerce_dollars(v));
            if dollars >= 0.0 {
                return Some(dollars);
            }
        }
    }

    // 2) 명시적 cents 키 — 100으로 나눔.
    let cents_keys = [
        "available_cents",
        "balance_cents",
        "remaining_cents",
        "credit_cents",
        "amount_cents",
    ];
    for k in cents_keys {
        if let Some(v) = root.get(k).and_then(|v| v.as_f64()) {
            let dollars = round2(v / 100.0);
            if dollars >= 0.0 {
                return Some(dollars);
            }
        }
    }

    // 3) credits 배열 — 각 항목에서 dollars/cents 끌어내 합산.
    if let Some(arr) = root.get("credits").and_then(|v| v.as_array()) {
        let mut sum_dollars = 0.0f64;
        let mut hit = false;
        for item in arr {
            if let Some(d) = parse_prepaid_credits(item) {
                sum_dollars += d;
                hit = true;
            }
        }
        if hit {
            return Some(round2(sum_dollars));
        }
    }

    // 4) 중첩된 단일 객체 후보.
    for k in ["data", "credits_balance", "summary", "prepaid"] {
        if let Some(sub) = root.get(k) {
            if let Some(d) = parse_prepaid_credits(sub) {
                return Some(d);
            }
        }
    }

    None
}

fn coerce_dollars(v: f64) -> f64 {
    // 정수이고 1000 이상이면 cents일 가능성이 매우 높음. dollars로 그렇게 큰
    // prepaid 잔액(>= $1,000)은 일반 개인 계정에선 드물고, 반대로 $12.34를
    // cents(1234)로 줄 때 정수로 떨어진다.
    if v.fract() == 0.0 && v.abs() >= 1000.0 {
        return v / 100.0;
    }
    v
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ===== sanitize_cookie — Slack/Notion/Discord 마크다운 autolink 제거 =====

    #[test]
    fn sanitize_passes_through_plain_cookie() {
        let raw = "sessionKey=abc; foo=bar";
        assert_eq!(sanitize_cookie(raw), "sessionKey=abc; foo=bar");
    }

    #[test]
    fn sanitize_strips_markdown_autolink() {
        // [sessionKey=abc](http://sessionKey=abc) → sessionKey=abc
        let raw = "[sessionKey=abc](http://sessionKey=abc); foo=bar";
        assert_eq!(sanitize_cookie(raw), "sessionKey=abc; foo=bar");
    }

    #[test]
    fn sanitize_keeps_inner_text_when_lone_brackets() {
        let raw = "[abc]; foo";
        assert_eq!(sanitize_cookie(raw), "abc; foo");
    }

    #[test]
    fn sanitize_collapses_whitespace_and_newlines() {
        let raw = "a=1\n\nb=2   c=3";
        assert_eq!(sanitize_cookie(raw), "a=1 b=2 c=3");
    }

    // ===== pick_utilization — 0-100 / 0-1 / buckets =====

    #[test]
    fn pick_utilization_returns_pct_when_value_is_large() {
        let w = json!({"utilization": 76.0});
        assert_eq!(pick_utilization(&w), Some(76.0));
    }

    #[test]
    fn pick_utilization_scales_fraction_to_pct() {
        // value <= 1.5 → 분수로 해석, * 100
        let w = json!({"utilization": 0.76});
        assert_eq!(pick_utilization(&w), Some(76.0));
    }

    #[test]
    fn pick_utilization_tries_alternate_keys() {
        let w = json!({"percent_used": 42.0});
        assert_eq!(pick_utilization(&w), Some(42.0));
    }

    #[test]
    fn pick_utilization_takes_max_across_buckets() {
        let w = json!({
            "buckets": [
                {"utilization": 30.0},
                {"utilization": 80.0},
                {"utilization": 50.0}
            ]
        });
        assert_eq!(pick_utilization(&w), Some(80.0));
    }

    #[test]
    fn pick_utilization_returns_none_when_no_field() {
        let w = json!({"unrelated": 1});
        assert_eq!(pick_utilization(&w), None);
    }

    // ===== pick_reset — RFC3339 파싱 =====

    #[test]
    fn pick_reset_parses_resets_at_rfc3339() {
        let w = json!({"resets_at": "2026-05-16T13:00:00Z"});
        let r = pick_reset(&w).expect("should parse");
        assert_eq!(r.to_rfc3339(), "2026-05-16T13:00:00+00:00");
    }

    #[test]
    fn pick_reset_tries_alternate_keys() {
        let w = json!({"ends_at": "2026-05-16T13:00:00+09:00"});
        assert!(pick_reset(&w).is_some());
    }

    #[test]
    fn pick_reset_returns_none_on_garbage_or_missing() {
        assert_eq!(pick_reset(&json!({"resets_at": "not a date"})), None);
        assert_eq!(pick_reset(&json!({})), None);
    }

    // ===== extract_window — 키 우선순위 =====

    #[test]
    fn extract_window_uses_first_matching_key() {
        let root = json!({
            "five_hour": {"utilization": 76.0},
            "five_hour_limit": {"utilization": 99.0}
        });
        let (util, _) = extract_window(&root, &["five_hour", "five_hour_limit"]);
        assert_eq!(util, Some(76.0));
    }

    #[test]
    fn extract_window_falls_through_to_later_keys() {
        let root = json!({"seven_day": {"utilization": 0.42}});
        let (util, _) = extract_window(
            &root,
            &["weekly", "weekly_limit", "seven_day"],
        );
        assert_eq!(util, Some(42.0));
    }

    #[test]
    fn extract_window_returns_none_pair_when_no_keys_match() {
        let root = json!({"foo": 1});
        let (util, reset) = extract_window(&root, &["bar", "baz"]);
        assert_eq!(util, None);
        assert!(reset.is_none());
    }

    // ===== parse_prepaid_credits =====

    #[test]
    fn prepaid_picks_direct_dollar_key() {
        let r = json!({"balance": 12.34});
        assert_eq!(parse_prepaid_credits(&r), Some(12.34));
    }

    #[test]
    fn prepaid_picks_explicit_cents_key() {
        let r = json!({"balance_cents": 1234});
        assert_eq!(parse_prepaid_credits(&r), Some(12.34));
    }

    #[test]
    fn prepaid_coerces_large_integer_to_dollars_via_cents_heuristic() {
        // 1500은 정수 + 1000 이상 → cents로 해석 → $15.00
        let r = json!({"balance": 1500});
        assert_eq!(parse_prepaid_credits(&r), Some(15.0));
    }

    #[test]
    fn prepaid_keeps_small_dollar_number_intact() {
        // 12.0은 정수이지만 1000 미만 → dollars 그대로 $12.00
        let r = json!({"balance": 12});
        assert_eq!(parse_prepaid_credits(&r), Some(12.0));
    }

    #[test]
    fn prepaid_sums_credits_array() {
        let r = json!({
            "credits": [
                {"balance": 5.0},
                {"amount_cents": 750},
                {"balance": 2.25}
            ]
        });
        // 5.0 + 7.5 + 2.25 = 14.75
        assert_eq!(parse_prepaid_credits(&r), Some(14.75));
    }

    #[test]
    fn prepaid_descends_into_nested_data_wrapper() {
        let r = json!({"data": {"available_cents": 999}});
        // 999는 cents → $9.99
        assert_eq!(parse_prepaid_credits(&r), Some(9.99));
    }

    #[test]
    fn prepaid_returns_none_when_no_matching_key() {
        let r = json!({"foo": "bar", "items": []});
        assert_eq!(parse_prepaid_credits(&r), None);
    }

    #[test]
    fn prepaid_returns_none_for_empty_credits_array() {
        let r = json!({"credits": []});
        assert_eq!(parse_prepaid_credits(&r), None);
    }

    #[test]
    fn prepaid_rounds_to_two_decimals() {
        let r = json!({"balance": 12.3456});
        assert_eq!(parse_prepaid_credits(&r), Some(12.35));
    }

    #[test]
    fn prepaid_real_response_amount_in_cents() {
        // 실제 platform.claude.com /prepaid/credits 응답 형태.
        // amount: 1290 (cents) → $12.90.
        let r = json!({
            "amount": 1290,
            "currency": "USD",
            "auto_reload_settings": null,
            "pending_invoice_amount_cents": null,
            "last_paid_purchase_cents": 1500
        });
        assert_eq!(parse_prepaid_credits(&r), Some(12.90));
    }

    #[test]
    fn prepaid_skips_negative_amount_sentinel() {
        // API가 auto_reload threshold flag로 amount=-1을 흘려보내는 경우
        // 잔액으로 잘못 표시되면 안 됨. 음수면 후보 건너뛰고 None 반환.
        let r = json!({"amount": -1});
        assert_eq!(parse_prepaid_credits(&r), None);
    }

    #[test]
    fn prepaid_skips_negative_amount_and_picks_next_positive() {
        // amount가 -1 sentinel이어도 다른 후보(balance_cents 등)가 있으면
        // 그걸 골라서 잔액을 살린다.
        let r = json!({
            "amount": -1,
            "balance_cents": 1290
        });
        assert_eq!(parse_prepaid_credits(&r), Some(12.90));
    }

    #[test]
    fn prepaid_negative_cents_value_is_skipped() {
        let r = json!({"amount_cents": -100});
        assert_eq!(parse_prepaid_credits(&r), None);
    }

    // ===== 추가 회귀 케이스 (v1.51 테스트 커버리지 보강) =====

    #[test]
    fn sanitize_empty_string() {
        assert_eq!(sanitize_cookie(""), "");
    }

    #[test]
    fn sanitize_whitespace_only_collapses_to_empty() {
        assert_eq!(sanitize_cookie("   \n\t  "), "");
    }

    #[test]
    fn sanitize_handles_open_bracket_without_close() {
        // "[" 만 있고 "]" 가 없으면 그대로 통과 (sanitize 는 robustness 가
        // 잘못해서 데이터를 더 망가뜨리지 않는 게 더 중요).
        let raw = "sessionKey=abc[def";
        assert_eq!(sanitize_cookie(raw), "sessionKey=abc[def");
    }

    #[test]
    fn sanitize_handles_bracket_paren_without_closing_paren() {
        // "[text](http..." 인데 ")" 없는 깨진 마크다운. lonely [ ... ] 분기로
        // 떨어져서 안쪽 텍스트만 보존, 뒤의 "(http..." 는 그대로 남는다.
        let raw = "[abc](http://no-close";
        // close=4, then close+1='(' 있는데 ')' 못 찾음 → lonely [ abc ] 처리 →
        // i jump to close+1=5 → 남은 "(http://no-close" 그대로.
        let out = sanitize_cookie(raw);
        assert!(out.contains("abc"));
        assert!(out.contains("http://no-close"));
        // ']' 자체는 안 들어감.
        assert!(!out.contains("]"));
    }

    #[test]
    fn sanitize_collapses_tabs_in_value() {
        let raw = "a\t=\t1";
        assert_eq!(sanitize_cookie(raw), "a = 1");
    }

    #[test]
    fn pick_utilization_at_exactly_one_point_five_treated_as_fraction() {
        // 코드 조건: `v <= 1.5` 이면 fraction. 정확히 1.5 → 분수로 → 150.
        // (현실엔 1.5 라는 fraction 자체가 없지만 경계값.)
        let w = json!({"utilization": 1.5});
        assert_eq!(pick_utilization(&w), Some(150.0));
    }

    #[test]
    fn pick_utilization_just_above_one_point_five_treated_as_pct() {
        // 1.51 → pct 그대로.
        let w = json!({"utilization": 1.51});
        assert_eq!(pick_utilization(&w), Some(1.51));
    }

    #[test]
    fn pick_utilization_zero_returns_zero_not_none() {
        // 0% 사용 == 만 가입 상태. None 으로 떨어지면 fresh 데이터인지 stale 인지
        // 구분 못 함. 0.0 으로 명시 반환.
        let w = json!({"utilization": 0.0});
        assert_eq!(pick_utilization(&w), Some(0.0));
    }

    #[test]
    fn pick_utilization_buckets_returns_none_when_all_buckets_empty() {
        let w = json!({"buckets": []});
        assert_eq!(pick_utilization(&w), None);
    }

    #[test]
    fn pick_utilization_buckets_skips_invalid_items() {
        // 잡 객체 + 정상 utilization 섞여 있어도 정상 값만 집계.
        let w = json!({
            "buckets": [
                {"unrelated": 99},
                {"utilization": 42.0},
                {"name": "claude-3"}
            ]
        });
        assert_eq!(pick_utilization(&w), Some(42.0));
    }

    #[test]
    fn pick_reset_returns_none_when_field_is_not_string() {
        // 숫자 timestamp 만 흘러오면 RFC3339 가 아니라 None.
        let w = json!({"resets_at": 1715856000});
        assert_eq!(pick_reset(&w), None);
    }

    #[test]
    fn pick_reset_returns_none_for_empty_string() {
        let w = json!({"resets_at": ""});
        assert_eq!(pick_reset(&w), None);
    }

    #[test]
    fn extract_window_handles_value_with_only_reset_field() {
        // utilization 없고 resets_at 만 있어도 (None, Some(...)) 반환.
        let root = json!({"five_hour": {"resets_at": "2026-05-16T13:00:00Z"}});
        let (util, reset) = extract_window(&root, &["five_hour"]);
        assert!(util.is_none());
        assert!(reset.is_some());
    }

    #[test]
    fn extract_window_skips_key_whose_value_has_neither_util_nor_reset() {
        // 첫 키 매치되지만 util/reset 둘 다 None → 다음 키 시도.
        let root = json!({
            "five_hour": {"unrelated": 1},
            "five_hour_limit": {"utilization": 50.0}
        });
        let (util, _) = extract_window(&root, &["five_hour", "five_hour_limit"]);
        assert_eq!(util, Some(50.0));
    }

    // ===== parse_prepaid_credits 추가 케이스 =====

    #[test]
    fn prepaid_zero_balance_returns_zero_dollars() {
        // 충전 안 한 사용자라도 0 은 명시적 0 (None 으로 떨어지면 안 됨).
        // 단, 코드의 `dollars >= 0.0` 조건이 0 도 통과시켜야 함.
        let r = json!({"balance": 0});
        assert_eq!(parse_prepaid_credits(&r), Some(0.0));
    }

    #[test]
    fn prepaid_negative_then_negative_falls_to_next_strategy() {
        // 모든 direct dollar 키가 음수면 cents 키로 넘어감. cents도 음수면 None.
        let r = json!({
            "balance": -1,
            "available_dollars": -5,
            "amount_cents": 1290
        });
        // direct 들 전부 음수 → cents 키로 → amount_cents 1290 → $12.90.
        assert_eq!(parse_prepaid_credits(&r), Some(12.90));
    }

    #[test]
    fn prepaid_credits_array_skips_nested_negative_items() {
        // 배열 안에 음수 item 이 있어도 양수 합산은 살아야 함.
        // 각 item 은 재귀적으로 parse_prepaid_credits 를 거치므로 음수는 None 으로 떨어져 skip.
        let r = json!({
            "credits": [
                {"balance": -1},
                {"balance": 5.0},
                {"amount_cents": 250}
            ]
        });
        // 음수 1번은 None → 합산 안 됨. 5.0 + 2.50 = 7.50.
        assert_eq!(parse_prepaid_credits(&r), Some(7.50));
    }

    #[test]
    fn prepaid_returns_none_when_all_credits_negative() {
        let r = json!({
            "credits": [
                {"balance": -1},
                {"balance": -2}
            ]
        });
        assert_eq!(parse_prepaid_credits(&r), None);
    }

    // ===== coerce_dollars heuristic 경계 =====

    #[test]
    fn coerce_dollars_at_exact_thousand_treated_as_cents() {
        // 1000 정확히 + fract=0 → cents 로 해석 → $10.00.
        assert_eq!(coerce_dollars(1000.0), 10.0);
    }

    #[test]
    fn coerce_dollars_just_below_thousand_kept_as_dollars() {
        // 999 + fract=0 → dollars 그대로 (1000 미만은 $999 일 수도 있음).
        assert_eq!(coerce_dollars(999.0), 999.0);
    }

    #[test]
    fn coerce_dollars_with_decimals_kept_as_dollars_even_if_large() {
        // fract != 0 이면 cents 해석 안 함. $1234.56 dollars 가능성.
        assert_eq!(coerce_dollars(1234.56), 1234.56);
    }

    #[test]
    fn coerce_dollars_negative_large_integer_treated_as_cents() {
        // abs() >= 1000 + fract=0 분기. (음수가 흘러들면 직접 호출 시점에서는 cents 로 보지만
        // 호출자가 parse_prepaid_credits 의 `dollars >= 0.0` 가드로 걸러냄.)
        assert_eq!(coerce_dollars(-2000.0), -20.0);
    }

    #[test]
    fn round2_basic_cases() {
        // 1.235 같은 정확히 .5 케이스는 IEEE 754 표현 때문에 환경에 따라 갈리므로 회피.
        assert_eq!(round2(0.0), 0.0);
        assert_eq!(round2(1.234), 1.23);
        assert_eq!(round2(1.236), 1.24);
        assert_eq!(round2(1.999), 2.0);
        assert_eq!(round2(-1.234), -1.23);
    }
}
