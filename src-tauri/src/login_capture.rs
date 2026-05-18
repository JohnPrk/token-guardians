use serde_json::Value;

pub const REQUIRED_COOKIE_NAMES: &[&str] = &[
    "sessionKey",
    "cf_clearance",
    "__cf_bm",
    "_cfuvid",
    "routingHint",
];

pub fn build_cookie_header(cookies: &[(String, String)]) -> String {
    let mut picked: Vec<(String, String)> = Vec::new();
    for name in REQUIRED_COOKIE_NAMES {
        if let Some((_, v)) = cookies.iter().find(|(n, _)| n == name) {
            picked.push(((*name).to_string(), v.clone()));
        }
    }
    picked
        .into_iter()
        .map(|(n, v)| format!("{}={}", n, v))
        .collect::<Vec<_>>()
        .join("; ")
}

pub fn has_required_cookies(cookies: &[(String, String)]) -> bool {
    cookies.iter().any(|(n, _)| n == "sessionKey")
}

/// Parse a raw "Cookie:" header line like `name1=v1; name2=v2; name3=v3` into
/// (name, value) pairs. Whitespace around names and between pairs is trimmed.
/// Values may contain `=` (since we split on the first `=` only) which matters
/// for cookies like `routingHint=[sk-ant-rh-...]` whose value has its own `=`
/// inside the bracket payload sometimes.
pub fn parse_raw_cookie_header(raw: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for pair in raw.split(';') {
        let trimmed = pair.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(eq_idx) = trimmed.find('=') {
            let name = trimmed[..eq_idx].trim();
            let value = trimmed[eq_idx + 1..].trim();
            if !name.is_empty() {
                out.push((name.to_string(), value.to_string()));
            }
        }
    }
    out
}

pub fn extract_org_id_from_orgs_json(json: &str) -> Option<String> {
    let v: Value = serde_json::from_str(json).ok()?;
    let arr = v.as_array()?;
    for org in arr {
        let uuid = org.get("uuid").and_then(|x| x.as_str());
        if let Some(id) = uuid {
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_cookie_header_picks_only_required_names_in_canonical_order() {
        let cookies = vec![
            ("foo".into(), "bar".into()),
            ("cf_clearance".into(), "abc".into()),
            ("sessionKey".into(), "sk-ant-sid02-xxx".into()),
            ("ignored".into(), "zzz".into()),
            ("__cf_bm".into(), "bm-value".into()),
        ];
        let out = build_cookie_header(&cookies);
        assert_eq!(
            out,
            "sessionKey=sk-ant-sid02-xxx; cf_clearance=abc; __cf_bm=bm-value"
        );
    }

    #[test]
    fn build_cookie_header_handles_all_five() {
        let cookies = vec![
            ("sessionKey".into(), "s".into()),
            ("cf_clearance".into(), "c".into()),
            ("__cf_bm".into(), "b".into()),
            ("_cfuvid".into(), "u".into()),
            ("routingHint".into(), "[sk-ant-rh-abc]".into()),
        ];
        let out = build_cookie_header(&cookies);
        assert_eq!(
            out,
            "sessionKey=s; cf_clearance=c; __cf_bm=b; _cfuvid=u; routingHint=[sk-ant-rh-abc]"
        );
    }

    #[test]
    fn build_cookie_header_empty_when_no_match() {
        let cookies = vec![("foo".into(), "bar".into())];
        assert_eq!(build_cookie_header(&cookies), "");
    }

    #[test]
    fn has_required_cookies_session_key_only() {
        assert!(has_required_cookies(&[
            ("sessionKey".into(), "x".into()),
        ]));
        assert!(!has_required_cookies(&[
            ("cf_clearance".into(), "x".into()),
        ]));
        assert!(!has_required_cookies(&[]));
    }

    #[test]
    fn extract_org_id_picks_first_uuid() {
        let json = r#"[
            {"uuid":"63e058d5-142c-4368-bca3-39d64d78b4f5","name":"Main"},
            {"uuid":"another-uuid","name":"Other"}
        ]"#;
        assert_eq!(
            extract_org_id_from_orgs_json(json).as_deref(),
            Some("63e058d5-142c-4368-bca3-39d64d78b4f5")
        );
    }

    #[test]
    fn extract_org_id_returns_none_on_empty_array() {
        assert_eq!(extract_org_id_from_orgs_json("[]"), None);
    }

    #[test]
    fn extract_org_id_returns_none_on_invalid_json() {
        assert_eq!(extract_org_id_from_orgs_json("not json"), None);
        assert_eq!(extract_org_id_from_orgs_json(""), None);
        assert_eq!(extract_org_id_from_orgs_json("{}"), None);
    }

    #[test]
    fn parse_raw_cookie_header_basic() {
        let raw = "sessionKey=sk-ant-sid02-xxx; cf_clearance=abc; __cf_bm=bm";
        let parsed = parse_raw_cookie_header(raw);
        assert_eq!(
            parsed,
            vec![
                ("sessionKey".to_string(), "sk-ant-sid02-xxx".to_string()),
                ("cf_clearance".to_string(), "abc".to_string()),
                ("__cf_bm".to_string(), "bm".to_string()),
            ]
        );
    }

    #[test]
    fn parse_raw_cookie_header_trims_whitespace() {
        let raw = "  name1 = value1 ;  name2=value2  ; ";
        let parsed = parse_raw_cookie_header(raw);
        assert_eq!(
            parsed,
            vec![
                ("name1".to_string(), "value1".to_string()),
                ("name2".to_string(), "value2".to_string()),
            ]
        );
    }

    #[test]
    fn parse_raw_cookie_header_keeps_equals_in_value() {
        // routingHint 값 안에 = 가 들어있는 케이스. 첫 번째 = 에서만 분리.
        let raw = "routingHint=[sk-ant-rh-abc=def]; foo=bar";
        let parsed = parse_raw_cookie_header(raw);
        assert_eq!(
            parsed,
            vec![
                ("routingHint".to_string(), "[sk-ant-rh-abc=def]".to_string()),
                ("foo".to_string(), "bar".to_string()),
            ]
        );
    }

    #[test]
    fn parse_raw_cookie_header_skips_malformed_pairs() {
        let raw = "good=1; bad-no-equals; alsogood=2; =empty-name";
        let parsed = parse_raw_cookie_header(raw);
        assert_eq!(
            parsed,
            vec![
                ("good".to_string(), "1".to_string()),
                ("alsogood".to_string(), "2".to_string()),
            ]
        );
    }

    #[test]
    fn parse_raw_cookie_header_empty_input() {
        assert_eq!(parse_raw_cookie_header(""), vec![]);
        assert_eq!(parse_raw_cookie_header("   ;  ;"), vec![]);
    }

    #[test]
    fn parse_then_build_round_trip_picks_only_required() {
        let raw = "sessionKey=s; cf_clearance=c; ignored=x; __cf_bm=b; routingHint=[rh]; _cfuvid=u; foo=bar";
        let parsed = parse_raw_cookie_header(raw);
        let header = build_cookie_header(&parsed);
        assert_eq!(
            header,
            "sessionKey=s; cf_clearance=c; __cf_bm=b; _cfuvid=u; routingHint=[rh]"
        );
    }

    #[test]
    fn extract_org_id_skips_empty_uuid() {
        let json = r#"[{"uuid":"","name":"Empty"},{"uuid":"real-uuid","name":"R"}]"#;
        assert_eq!(
            extract_org_id_from_orgs_json(json).as_deref(),
            Some("real-uuid")
        );
    }

    // ===== 추가 회귀 케이스 (v1.51 테스트 커버리지 보강) =====

    #[test]
    fn parse_raw_cookie_header_value_can_be_empty_string() {
        // name= (값 비어있음) 도 paste 시 실재. 그대로 보존.
        let raw = "empty=; name=value";
        let parsed = parse_raw_cookie_header(raw);
        assert_eq!(
            parsed,
            vec![
                ("empty".to_string(), "".to_string()),
                ("name".to_string(), "value".to_string()),
            ]
        );
    }

    #[test]
    fn parse_raw_cookie_header_handles_trailing_semicolon() {
        let raw = "name=value;";
        let parsed = parse_raw_cookie_header(raw);
        assert_eq!(parsed, vec![("name".to_string(), "value".to_string())]);
    }

    #[test]
    fn parse_raw_cookie_header_handles_leading_semicolons() {
        let raw = ";;sessionKey=abc";
        let parsed = parse_raw_cookie_header(raw);
        assert_eq!(parsed, vec![("sessionKey".to_string(), "abc".to_string())]);
    }

    #[test]
    fn parse_raw_cookie_header_value_with_special_chars_preserved() {
        // 실제 sessionKey 는 base64-ish 문자 + . + - 등을 포함.
        let raw = "sessionKey=sk-ant-sid02-AbC123.xy_z-9; foo=bar";
        let parsed = parse_raw_cookie_header(raw);
        assert_eq!(parsed[0].1, "sk-ant-sid02-AbC123.xy_z-9");
    }

    #[test]
    fn parse_raw_cookie_header_duplicates_keep_both() {
        // 같은 이름이 두 번 들어오면 둘 다 보존 (parsing 단계는 dedupe 안 함).
        // 이후 build_cookie_header 의 find() 가 첫 매치만 골라서 자연 dedupe.
        let raw = "sessionKey=first; sessionKey=second";
        let parsed = parse_raw_cookie_header(raw);
        assert_eq!(parsed.len(), 2);
    }

    #[test]
    fn build_cookie_header_picks_first_when_duplicate_required_name() {
        // parse 가 중복 보존했어도 build 가 첫 매치만 사용.
        let cookies = vec![
            ("sessionKey".into(), "first".into()),
            ("sessionKey".into(), "second".into()),
        ];
        assert_eq!(build_cookie_header(&cookies), "sessionKey=first");
    }

    #[test]
    fn build_cookie_header_partial_subset_preserves_order() {
        // 5개 중 일부만 있어도 REQUIRED_COOKIE_NAMES 순서를 유지.
        let cookies = vec![
            ("routingHint".into(), "rh".into()),
            ("sessionKey".into(), "sk".into()),
            ("_cfuvid".into(), "u".into()),
        ];
        let out = build_cookie_header(&cookies);
        // 순서: sessionKey → _cfuvid → routingHint (REQUIRED_COOKIE_NAMES 순)
        assert_eq!(out, "sessionKey=sk; _cfuvid=u; routingHint=rh");
    }

    #[test]
    fn has_required_cookies_ignores_other_required_names_alone() {
        // sessionKey 가 핵심. 나머지 4개만 있으면 false.
        let cookies = vec![
            ("cf_clearance".into(), "c".into()),
            ("__cf_bm".into(), "b".into()),
            ("_cfuvid".into(), "u".into()),
            ("routingHint".into(), "rh".into()),
        ];
        assert!(!has_required_cookies(&cookies));
    }

    #[test]
    fn extract_org_id_returns_none_when_not_an_array() {
        // 단일 객체 형태가 흘러오면 (다른 endpoint 응답 혼동 등) None.
        let json = r#"{"uuid": "xxx", "name": "single"}"#;
        assert_eq!(extract_org_id_from_orgs_json(json), None);
    }

    #[test]
    fn extract_org_id_skips_items_without_uuid_field() {
        let json = r#"[{"name":"NoUuid"},{"uuid":"good-uuid"}]"#;
        assert_eq!(
            extract_org_id_from_orgs_json(json).as_deref(),
            Some("good-uuid")
        );
    }

    #[test]
    fn extract_org_id_skips_non_string_uuid_field() {
        // uuid 가 숫자나 객체로 흘러오면 string 변환 실패 → 다음 item.
        let json = r#"[{"uuid":12345},{"uuid":"real-one"}]"#;
        assert_eq!(
            extract_org_id_from_orgs_json(json).as_deref(),
            Some("real-one")
        );
    }

    #[test]
    fn parse_then_build_picks_only_required_even_with_garbage_extras() {
        // _ga, _pendo_* 같은 잡쿠키 섞여 있어도 5종만.
        let raw = "_ga=GA1.1.xxx; sessionKey=sk; _pendo_visitorId.tenant-abc=v; cf_clearance=c; \
                   _gid=GA1.1.yyy; __cf_bm=b; _cfuvid=u; routingHint=[rh]; intercom-id=foo";
        let parsed = parse_raw_cookie_header(raw);
        let header = build_cookie_header(&parsed);
        assert_eq!(
            header,
            "sessionKey=sk; cf_clearance=c; __cf_bm=b; _cfuvid=u; routingHint=[rh]"
        );
    }
}
