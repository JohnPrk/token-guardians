// GitHub Releases 기반 자동 업데이트 — 구 Tauri src-tauri/src/updater.rs 의 JS 포팅.
// 메인 프로세스가 1시간 주기로 fetchLatestRelease() 호출 → 새 버전 있으면
// 트레이 메뉴 빌더가 "🆕 v.. 설치" 항목을 끼워넣고, 사용자가 클릭하면
// 브라우저에서 Releases 페이지를 연다 (Electron 측 MVP — Tauri 가 하던
// 자동 dmg 다운로드 + 설치 스크립트는 cross-platform 으로 다시 만들어야
// 해서 일단 수동 다운로드 흐름으로 단순화).
//
// 순수 헬퍼(parseReleaseTag, isNewer, parseReleaseResponse)는 한 줄 문법으로
// 동일 케이스를 cargo test 와 1:1 매칭.

const RELEASES_URL =
  "https://api.github.com/repos/JohnPrk/token-panda/releases/latest";
const HTTP_TIMEOUT_MS = 10000;

// "v1.24.0" / "1.24" / "1.74.8" → [major, minor, patch]. 두 segment 는 patch=0.
function parseReleaseTag(tag) {
  if (typeof tag !== "string") return null;
  const s = tag.startsWith("v") ? tag.slice(1) : tag;
  const parts = s.split(".");
  if (parts.length < 2 || parts.length > 3) return null;
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = parts.length === 3 ? Number(parts[2]) : 0;
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) return null;
  return [major, minor, patch];
}

// latest > current 면 true. 파싱 실패는 false(보수적).
function isNewer(current, latest) {
  const c = parseReleaseTag(current);
  const l = parseReleaseTag(latest);
  if (!c || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i] > c[i]) return true;
    if (l[i] < c[i]) return false;
  }
  return false;
}

// GitHub API 응답 → UpdateInfo. current 보다 새 버전이면 latest_version + html_url
// (사용자가 클릭할 release 페이지). 동일/오래된 버전이면 null.
function parseReleaseResponse(json, currentVersion) {
  let release;
  try {
    release = JSON.parse(json);
  } catch {
    return null;
  }
  if (!release || typeof release.tag_name !== "string") return null;
  if (!isNewer(currentVersion, release.tag_name)) return null;
  const stripped = release.tag_name.startsWith("v")
    ? release.tag_name.slice(1)
    : release.tag_name;
  return {
    latest_version: stripped,
    html_url: typeof release.html_url === "string" ? release.html_url : null,
  };
}

// GitHub release JSON → assets 정규화 배열. parseReleaseResponse 와 분리:
// auto-installer (electron/installer.cjs) 가 picked asset 의 download URL 을
// 필요로 하는데, parseReleaseResponse 는 frozen contract (v1.74.8 시점 시그
// 니처) 라 확장 안 함.
function parseReleaseAssets(json) {
  let r;
  try { r = JSON.parse(json); } catch { return null; }
  if (!r || !Array.isArray(r.assets)) return null;
  return r.assets
    .map((a) => ({
      name: typeof a.name === "string" ? a.name : "",
      browser_download_url:
        typeof a.browser_download_url === "string" ? a.browser_download_url : "",
    }))
    .filter((a) => a.name && a.browser_download_url);
}

async function fetchWithTimeout(url, headers, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// 3-way 반환. {ok:true, info: UpdateInfo|null} = 응답 성공 (info=null 이면 이미 최신),
// {ok:false, error} = HTTP/네트워크 실패 (트레이 헤더에 "확인 실패" 표시용).
async function fetchLatestRelease(currentVersion) {
  let resp;
  try {
    resp = await fetchWithTimeout(
      RELEASES_URL,
      {
        Accept: "application/vnd.github+json",
        "User-Agent": "token-panda-updater",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      HTTP_TIMEOUT_MS,
    );
  } catch (e) {
    return { ok: false, error: "HTTP send: " + (e && e.message ? e.message : String(e)) };
  }
  if (!resp.ok) {
    return { ok: false, error: `HTTP ${resp.status}` };
  }
  const body = await resp.text();
  // assets 도 같이 반환 — installer 가 picked asset URL 필요. info=null 일 때
  // (이미 최신) 도 assets 는 정상 데이터를 줄 수 있지만 caller 가 안 씀.
  return {
    ok: true,
    info: parseReleaseResponse(body, currentVersion),
    assets: parseReleaseAssets(body) || [],
  };
}

module.exports = {
  fetchLatestRelease,
  parseReleaseTag,
  isNewer,
  parseReleaseResponse,
  parseReleaseAssets,
  RELEASES_URL,
};
