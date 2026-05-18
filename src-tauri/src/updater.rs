// GitHub Releases 기반 자동 업데이트.
//
// 흐름: lib.rs의 백그라운드 스레드가 1시간 주기로 fetch_latest_release를 호출 →
// 새 버전이 있으면 글로벌 UPDATE_INFO에 저장하고 트레이 메뉴 rebuild → 사용자가
// "🆕 새 버전 v.. 설치"를 클릭하면 메뉴 이벤트 핸들러가 download_dmg +
// spawn_install_script → 현재 앱은 self-quit, /tmp/panda-update.sh가 옛 앱 종료
// 대기 / 마운트 / cp / xattr / detach / 새 앱 실행을 수행.
//
// 순수 헬퍼(parse_release_tag, is_newer, parse_release_response, pick_dmg_asset)는
// cargo test로 검증. IO(reqwest, hdiutil, bash spawn)는 regression-checklist.md
// 카테고리 11로 검증.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const GITHUB_API: &str =
    "https://api.github.com/repos/JohnPrk/token-panda/releases/latest";
const USER_AGENT: &str = "token-panda-updater";
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const DMG_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub latest_version: String, // "1.24.0" (v prefix 제거됨)
    pub dmg_url: String,
    pub dmg_name: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize, Clone)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

// ============ 순수 헬퍼 (cargo test 대상) ============

/// `v1.24.0` 또는 `1.24.0` → Some((1, 24, 0)). 두 segment(`1.24`)는 patch=0 채움.
pub fn parse_release_tag(tag: &str) -> Option<(u32, u32, u32)> {
    let s = tag.strip_prefix('v').unwrap_or(tag);
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let major = parts[0].parse().ok()?;
    let minor = parts[1].parse().ok()?;
    let patch = if parts.len() == 3 {
        parts[2].parse().ok()?
    } else {
        0
    };
    Some((major, minor, patch))
}

/// latest가 current보다 엄격히 크면 true. 파싱 실패는 false(보수적).
pub fn is_newer(current: &str, latest: &str) -> bool {
    match (parse_release_tag(current), parse_release_tag(latest)) {
        (Some(c), Some(l)) => l > c,
        _ => false,
    }
}

/// `token-panda` + `_aarch64.dmg` 패턴의 첫 자산을 반환.
fn pick_dmg_asset(assets: &[GithubAsset]) -> Option<&GithubAsset> {
    assets
        .iter()
        .find(|a| a.name.contains("token-panda") && a.name.ends_with("_aarch64.dmg"))
}

/// GitHub API JSON → UpdateInfo. current_version보다 새 버전이 있고 dmg 자산이
/// 있을 때만 Some.
pub fn parse_release_response(json: &str, current_version: &str) -> Option<UpdateInfo> {
    let release: GithubRelease = serde_json::from_str(json).ok()?;
    if !is_newer(current_version, &release.tag_name) {
        return None;
    }
    let asset = pick_dmg_asset(&release.assets)?;
    let latest = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name)
        .to_string();
    Some(UpdateInfo {
        latest_version: latest,
        dmg_url: asset.browser_download_url.clone(),
        dmg_name: asset.name.clone(),
    })
}

// ============ IO (regression-checklist 11번으로 검증) ============

/// GitHub Releases API 호출 결과를 3-way로 구분한다.
/// - `Ok(Some(info))` : 응답 OK, 새 버전 있음
/// - `Ok(None)`       : 응답 OK, 이미 최신 (또는 매칭 자산 없음)
/// - `Err(msg)`       : HTTP/네트워크/파싱 실패 — 사용자에게 "확인 실패" 표시용
///
/// 이전 v1.51까지는 두 갈래를 모두 `Option<UpdateInfo>::None` 으로 묻었어서,
/// 트레이 메뉴가 "확인이 됐는지 안 됐는지" 자체를 구분하지 못했음. 사용자가
/// v1.70 클라이언트에서 "지금 새로고침" 눌러도 시각적 신호가 0이라 *동작
/// 자체*가 의심되는 케이스가 있어서 Result로 갈라냈다.
pub fn fetch_latest_release(current_version: &str) -> Result<Option<UpdateInfo>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client: {}", e))?;
    let res = client
        .get(GITHUB_API)
        .send()
        .map_err(|e| format!("HTTP send: {}", e))?;
    if !res.status().is_success() {
        let status = res.status();
        log::warn!("github releases api status: {}", status);
        return Err(format!("HTTP {}", status));
    }
    let body = res.text().map_err(|e| format!("HTTP body: {}", e))?;
    Ok(parse_release_response(&body, current_version))
}

/// dmg를 OS 캐시 디렉토리에 다운로드. 동일 파일명 있으면 덮어씀.
pub fn download_dmg(url: &str, dmg_name: &str) -> Result<PathBuf, String> {
    let cache_dir = dirs::cache_dir()
        .ok_or_else(|| "cache_dir 못 찾음".to_string())?
        .join("token-panda")
        .join("updates");
    fs::create_dir_all(&cache_dir).map_err(|e| format!("캐시 디렉토리 생성: {}", e))?;
    let dest = cache_dir.join(dmg_name);

    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(DMG_DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client: {}", e))?;
    let mut res = client
        .get(url)
        .send()
        .map_err(|e| format!("dmg GET: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("dmg HTTP {}", res.status()));
    }
    let mut file = fs::File::create(&dest).map_err(|e| format!("dmg 파일 생성: {}", e))?;
    res.copy_to(&mut file).map_err(|e| format!("dmg 쓰기: {}", e))?;
    Ok(dest)
}

/// /Applications 안의 설치된 .app 경로. productName이 한글이라 그대로 박는다.
pub fn applications_app_path() -> PathBuf {
    PathBuf::from("/Applications/토큰 판다.app")
}

/// 설치 bash 스크립트를 /tmp에 생성하고 nohup으로 띄운다. 호출한 프로세스는
/// 호출 직후 자기 자신을 종료해야 한다 (스크립트가 옛 앱 종료 대기 로직 포함).
pub fn spawn_install_script(dmg_path: &Path, app_path: &Path) -> Result<(), String> {
    let script_path = "/tmp/panda-update.sh";
    let script = build_install_script(dmg_path, app_path);
    fs::write(script_path, script).map_err(|e| format!("script write: {}", e))?;
    Command::new("chmod")
        .args(["+x", script_path])
        .status()
        .map_err(|e| format!("chmod: {}", e))?;
    Command::new("bash")
        .arg("-c")
        .arg(format!(
            "nohup {} > /tmp/panda-update.log 2>&1 & disown",
            script_path
        ))
        .spawn()
        .map_err(|e| format!("nohup spawn: {}", e))?;
    Ok(())
}

fn build_install_script(dmg_path: &Path, app_path: &Path) -> String {
    let dmg = dmg_path.display();
    let app = app_path.display();
    // 주의: APP_PATH 내부에 한글/공백("토큰 판다.app")이 들어가니 모든 사용에서
    // 무조건 큰따옴표로 감싼다. find의 -maxdepth 1로 dmg 안의 .app 1개만 집는다.
    format!(
        r#"#!/bin/bash
set -e
DMG_PATH="{dmg}"
APP_PATH="{app}"
APP_NAME=$(basename "$APP_PATH")
MOUNT_POINT="/tmp/panda-update-mount-$$"

log() {{ echo "[$(date +%H:%M:%S)] $*" >&2; }}

# 1. 옛 앱 종료 대기 (최대 5초). 호출자가 self-quit한 직후라 보통 1초 안에 빠짐.
sleep 1
for i in 1 2 3 4 5; do
  if ! pgrep -f "$APP_NAME/Contents/MacOS" > /dev/null; then break; fi
  log "옛 앱 종료 대기 ($i)"
  sleep 1
done

# 2. dmg 마운트
mkdir -p "$MOUNT_POINT"
hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -quiet

# 3. 백업 + 교체. 새 dmg에 .app이 없으면 백업으로 복구하고 실패 종료.
rm -rf "${{APP_PATH}}.bak"
if [ -d "$APP_PATH" ]; then mv "$APP_PATH" "${{APP_PATH}}.bak"; fi
NEW_APP=$(find "$MOUNT_POINT" -maxdepth 1 -name "*.app" | head -1)
if [ -z "$NEW_APP" ]; then
  log "dmg 안에 .app 없음, 백업 복구"
  if [ -d "${{APP_PATH}}.bak" ]; then mv "${{APP_PATH}}.bak" "$APP_PATH"; fi
  hdiutil detach "$MOUNT_POINT" -quiet || true
  exit 1
fi
cp -R "$NEW_APP" "$APP_PATH"

# 4. quarantine 풀고 unmount
xattr -cr "$APP_PATH" || true
hdiutil detach "$MOUNT_POINT" -quiet || true

# 5. 새 앱 실행
open "$APP_PATH"

# 6. 새 앱이 3초 안에 떴는지 확인. 떴으면 백업 삭제, 안 떴으면 백업 복구 후 재실행.
sleep 3
if pgrep -f "$APP_PATH/Contents/MacOS" > /dev/null; then
  rm -rf "${{APP_PATH}}.bak"
  log "업데이트 성공"
else
  log "새 앱 미기동, 백업 복구"
  rm -rf "$APP_PATH"
  if [ -d "${{APP_PATH}}.bak" ]; then
    mv "${{APP_PATH}}.bak" "$APP_PATH"
    open "$APP_PATH"
  fi
fi
"#
    )
}

// ============ cargo test ============

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tag_with_v_prefix() {
        assert_eq!(parse_release_tag("v1.24.0"), Some((1, 24, 0)));
    }

    #[test]
    fn parse_tag_without_v() {
        assert_eq!(parse_release_tag("0.99.0"), Some((0, 99, 0)));
    }

    #[test]
    fn parse_tag_two_segments_pads_patch() {
        assert_eq!(parse_release_tag("1.24"), Some((1, 24, 0)));
    }

    #[test]
    fn parse_tag_garbage_returns_none() {
        assert_eq!(parse_release_tag("nope"), None);
        assert_eq!(parse_release_tag(""), None);
        assert_eq!(parse_release_tag("1"), None);
        assert_eq!(parse_release_tag("1.2.3.4"), None);
        assert_eq!(parse_release_tag("v1.2.x"), None);
    }

    #[test]
    fn is_newer_minor_bump() {
        assert!(is_newer("1.23.0", "1.24.0"));
    }

    #[test]
    fn is_newer_patch_bump() {
        assert!(is_newer("1.23.0", "1.23.1"));
    }

    #[test]
    fn is_newer_major_bump() {
        assert!(is_newer("1.99.0", "2.0.0"));
    }

    #[test]
    fn is_newer_same_returns_false() {
        assert!(!is_newer("1.24.0", "1.24.0"));
    }

    #[test]
    fn is_newer_older_returns_false() {
        assert!(!is_newer("1.24.0", "1.23.5"));
    }

    #[test]
    fn is_newer_v_prefix_normalizes_both_sides() {
        assert!(is_newer("1.23.0", "v1.24.0"));
        assert!(is_newer("v1.23.0", "1.24.0"));
        assert!(is_newer("v1.23.0", "v1.24.0"));
    }

    #[test]
    fn is_newer_unparseable_returns_false() {
        assert!(!is_newer("garbage", "1.24.0"));
        assert!(!is_newer("1.23.0", "garbage"));
    }

    const FIXTURE_RELEASE_JSON: &str = r#"{
        "tag_name": "v1.24.0",
        "assets": [
            {
                "name": "token-panda_1.24.0_aarch64.dmg",
                "browser_download_url": "https://github.com/JohnPrk/token-panda/releases/download/v1.24.0/token-panda_1.24.0_aarch64.dmg"
            },
            {
                "name": "source.tar.gz",
                "browser_download_url": "https://example.invalid/source.tar.gz"
            }
        ]
    }"#;

    #[test]
    fn parse_response_finds_dmg_when_newer() {
        let info =
            parse_release_response(FIXTURE_RELEASE_JSON, "1.23.0").expect("newer ⇒ Some");
        assert_eq!(info.latest_version, "1.24.0");
        assert_eq!(info.dmg_name, "token-panda_1.24.0_aarch64.dmg");
        assert!(info.dmg_url.ends_with("_aarch64.dmg"));
    }

    #[test]
    fn parse_response_returns_none_when_same_version() {
        assert!(parse_release_response(FIXTURE_RELEASE_JSON, "1.24.0").is_none());
    }

    #[test]
    fn parse_response_returns_none_when_current_newer() {
        assert!(parse_release_response(FIXTURE_RELEASE_JSON, "1.25.0").is_none());
    }

    #[test]
    fn parse_response_returns_none_when_no_dmg_asset() {
        let json_no_dmg = r#"{
            "tag_name": "v1.24.0",
            "assets": [
                {"name": "foo.zip", "browser_download_url": "https://x.invalid/foo.zip"}
            ]
        }"#;
        assert!(parse_release_response(json_no_dmg, "1.23.0").is_none());
    }

    #[test]
    fn parse_response_returns_none_when_dmg_lacks_aarch64() {
        // 정책상 aarch64 자산만 받는다 (Apple Silicon 전용 빌드).
        let json_wrong_arch = r#"{
            "tag_name": "v1.24.0",
            "assets": [
                {"name": "token-panda_1.24.0_x64.dmg", "browser_download_url": "https://x.invalid/x.dmg"}
            ]
        }"#;
        assert!(parse_release_response(json_wrong_arch, "1.23.0").is_none());
    }

    #[test]
    fn parse_response_returns_none_on_garbage_json() {
        assert!(parse_release_response("not json", "1.23.0").is_none());
        assert!(parse_release_response("{}", "1.23.0").is_none());
    }
}
