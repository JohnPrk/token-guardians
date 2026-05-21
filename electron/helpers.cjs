// main.cjs 에서 추출한 순수 함수들. require 만으로 side effect (app.setName,
// app.requestSingleInstanceLock) 가 실행되는 main.cjs 와 분리해서 node 환경에서
// 단위 테스트 가능하게 한다.

// claude.ai 의 usage 호출이 401/403/404 로 떨어지면 쿠키 만료(또는 wrong org)
// 로 보고 설정창을 한 번 띄우는 트리거. 본문 매칭 — fetchUsage 가 만들어주는
// "HTTP {status} — ..." 포맷에 의존. 다른 5xx/네트워크 에러는 일시적이므로
// false (재시도 사이클에 맡김).
function isAuthFailure(msg) {
  if (!msg) return false;
  return msg.indexOf("HTTP 401") >= 0 || msg.indexOf("HTTP 403") >= 0 || msg.indexOf("HTTP 404") >= 0;
}

// 트레이 헤더에 들어가는 업데이트 폴링 상태 라벨. lastUpdateCheck 가 null
// 이면 "대기 중", 성공이면 새 버전 유무에 따라 "🆕 v.. 있음" / "최신",
// 실패면 "확인 실패". 모든 경우 마지막 시도 HH:MM 을 끝에 붙여 사용자가
// 트레이 클릭 → 시각 갱신이 시각적 동작 확인 신호가 되게 한다.
function formatUpdateCheckLabel(lastUpdateCheck, updateInfo) {
  if (!lastUpdateCheck) return "업데이트 확인 대기 중…";
  const d = lastUpdateCheck.at;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (lastUpdateCheck.ok) {
    return updateInfo
      ? `🆕 v${updateInfo.latest_version} 있음 · ${hh}:${mm} 확인`
      : `최신 · ${hh}:${mm} 확인`;
  }
  return `확인 실패 · ${hh}:${mm} 시도`;
}

// 트레이 메뉴 헤더 한 줄: "토큰 판다 v1.97.0 (03:18 확인)". 마지막 폴링 시각이
// 있으면 괄호로 붙여 한 줄에 통합한다. 폴링 전(lastUpdateCheck=null)이면 시각
// 부분 생략. 폴링 성공/실패는 구분하지 않음 — 새 버전이 실제로 감지된 경우엔
// 별도 "🆕 v.. 설치" 버튼이 헤더 바로 아래에 붙는 게 더 강한 신호 (v1.98).
function formatHeaderLabel(appVersion, lastUpdateCheck) {
  const base = `토큰 판다 v${appVersion}`;
  if (!lastUpdateCheck || !lastUpdateCheck.at) return base;
  const d = lastUpdateCheck.at;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${base} (${hh}:${mm} 확인)`;
}

// 5h 잔량(0-1) → 대나무 트레이 아이콘 tier suffix (build/tray/tray-<tier>.png).
// 잔량이 많을수록 줄기 많은 아이콘. README: 75%+ 4줄기 / 50%+ 3줄기 / 25%+ 2줄기 /
// 25% 미만 1줄기. 비정상 입력(NaN 등)은 가장 비어있는 25 로.
function bambooTierForRemaining(remaining) {
  const r = typeof remaining === "number" && Number.isFinite(remaining) ? remaining : 0;
  if (r >= 0.75) return "100";
  if (r >= 0.5) return "75";
  if (r >= 0.25) return "50";
  return "25";
}

module.exports = { isAuthFailure, formatUpdateCheckLabel, formatHeaderLabel, bambooTierForRemaining };
