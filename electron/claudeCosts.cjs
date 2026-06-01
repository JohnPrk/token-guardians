// Claude API 키별 월 비용 — platform.claude.com 의 console "비용" 컬럼을
// 토큰 판다에서 보기 위한 모듈. claude.ai/usage 와 달리 콘솔은 두 요청을
// *별개로* 던지고 프론트가 key_id 로 조인해 비용 컬럼을 그린다(사용자가
// network 에서 "바로 response 로 안 온다"고 관찰한 그 구조):
//
//   1) 키 목록 : GET /api/console/organizations/{orgId}/api_keys
//                → [{ id, name, partial_key_hint, status, ... }]
//   2) 비  용  : GET /api/organizations/{orgId}/usage_cost
//                      ?starting_on=YYYY-MM-01&ending_before=다음달-01&group_by=api_key_id
//                → { costs, web_search_costs, code_execution_costs,
//                    session_usage_costs, claude_code_savings }
//                  각 카테고리 = { "YYYY-MM-DD": [{ key_id, total, ... }] }
//
// `total` 은 **센트**(USD). 키별로 다섯 카테고리의 total 을 모두 합쳐 ÷100 하면
// 콘솔 비용 컬럼과 1:1 로 맞는다(실측 검증: _01EDa→$1.78 / _012N2→$0.53 /
// _01GoX→$0.02). 인증은 prepaid 와 동일한 web_console 쿠키 톤이라
// claudeApi.cjs 는 frozen 그대로 두고 여기서 별도로 fetch 한다.

const { sanitizeCookie } = require("./claudeApi.cjs");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

// usage_cost 응답의 비용 카테고리. claude_code_savings 는 *절감액*(차감)이 아니라
// 별도 라인이라 콘솔 비용 컬럼엔 안 들어간다 — 합산에서 제외해 콘솔과 정확히 일치.
const COST_CATEGORIES = Object.freeze([
  "costs",
  "web_search_costs",
  "code_execution_costs",
  "session_usage_costs",
]);

// ─── pure helpers (테스트 대상) ────────────────────────────────────────────

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

// 주어진 시점이 속한 "이번 달" 범위를 콘솔과 같은 형태로 만든다.
//   starting_on   = 그 달 1일 (YYYY-MM-01)
//   ending_before = 다음 달 1일 (12월이면 다음 해 1월로 롤오버)
// 로컬 연/월 기준 (콘솔도 사용자 현재 달을 그대로 썼다).
function currentMonthRange(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based
  const starting_on = `${y}-${pad2(m + 1)}-01`;
  const ny = m === 11 ? y + 1 : y;
  const nm = m === 11 ? 0 : m + 1;
  const ending_before = `${ny}-${pad2(nm + 1)}-01`;
  return { starting_on, ending_before, month: `${y}-${pad2(m + 1)}` };
}

// usage_cost 응답 → { key_id: centsSum } 객체. 다섯 카테고리를 가로질러
// 같은 key_id 의 total 을 모두 더한다. 모양이 어긋난 항목은 방어적으로 skip.
function aggregateCostsByKey(usageCost) {
  const out = {};
  if (!usageCost || typeof usageCost !== "object") return out;
  for (const cat of COST_CATEGORIES) {
    const byDate = usageCost[cat];
    if (!byDate || typeof byDate !== "object") continue;
    for (const date of Object.keys(byDate)) {
      const items = byDate[date];
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        if (!it || typeof it !== "object") continue;
        const key = typeof it.key_id === "string" && it.key_id ? it.key_id : "(unknown)";
        const cents = Number(it.total);
        if (!Number.isFinite(cents)) continue;
        out[key] = (out[key] || 0) + cents;
      }
    }
  }
  return out;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// platform.claude.com `/api/organizations` 응답(배열) → 콘솔/API 조직의 uuid.
// 사용자 계정엔 보통 두 조직이 섞여 온다: claude.ai 구독(capabilities 에 "chat"/
// "claude_max")과 개발자 콘솔(capabilities 에 "api"/"api_individual"). 비용/키는
// *API 조직* 의 uuid 로만 조회되므로(claude.ai orgId 와 다름 — prepaid 가
// platformOrgId 를 따로 받는 이유) capability 에 api 가 있는 조직을 고른다.
// path 에 쓰이는 식별자는 `uuid` 필드(없으면 id 폴백). 못 찾으면 null.
function extractApiOrgId(orgs) {
  if (!Array.isArray(orgs)) return null;
  const hasApi = (o) => {
    const caps = o && o.capabilities;
    const list = Array.isArray(caps)
      ? caps
      : caps && typeof caps === "object"
        ? Object.keys(caps)
        : [];
    return list.some((c) => c === "api" || c === "api_individual");
  };
  const apiOrg = orgs.find(hasApi);
  const pick = apiOrg || null;
  if (!pick) return null;
  const idVal = pick.uuid || pick.id;
  return typeof idVal === "string" && idVal ? idVal : null;
}

// 센트(소수 가능) → 달러 둘째자리.
function centsToDollars(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return 0;
  return round2(n / 100);
}

// 콘솔에서 key_id 가 아닌 의사키로 나오는 값들의 표시 이름.
function fallbackKeyName(keyId) {
  if (keyId === "console") return "콘솔 직접 사용";
  if (keyId === "(unknown)") return "(키 미상)";
  return keyId;
}

// 집계된 { key_id: cents } + api_keys 목록 → 표시용 rows + 총합.
//   rows : [{ id, name, partial_key_hint, dollars }] — 달러 내림차순
//   total_dollars : 모든 키 센트 합 ÷100 (개별 반올림 누적이 아닌 합산 후 반올림)
function buildKeyCostRows(aggregatedCents, apiKeys) {
  const byId = new Map();
  if (Array.isArray(apiKeys)) {
    for (const k of apiKeys) {
      if (k && typeof k.id === "string") byId.set(k.id, k);
    }
  }
  let totalCents = 0;
  const keys = Object.keys(aggregatedCents).map((keyId) => {
    const cents = aggregatedCents[keyId] || 0;
    totalCents += cents;
    const meta = byId.get(keyId);
    return {
      id: keyId,
      name: meta && meta.name ? meta.name : fallbackKeyName(keyId),
      partial_key_hint: meta && meta.partial_key_hint ? meta.partial_key_hint : null,
      dollars: centsToDollars(cents),
    };
  });
  keys.sort((a, b) => b.dollars - a.dollars || a.name.localeCompare(b.name));
  return { total_dollars: round2(totalCents / 100), keys };
}

// ─── IO (테스트 안 함 — fetch 모킹 어렵고 핵심 로직은 위의 pure 들) ───────────

async function fetchWithTimeout(url, headers, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// platform.claude.com 공통 헤더. prepaid(fetchPrepaid)와 같은 web_console 톤이라야
// 게이트웨이를 통과한다. Referer 만 페이지별로 다르게.
function consoleHeaders(cookie, referer) {
  return {
    Cookie: cookie,
    Accept: "*/*",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: referer,
    "anthropic-client-platform": "web_console",
    "anthropic-client-version": "unknown",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "User-Agent": UA,
  };
}

async function getJson(url, headers, label) {
  let resp;
  try {
    resp = await fetchWithTimeout(url, headers, 12000);
  } catch (e) {
    throw new Error(`${label} 요청 실패: ` + (e && e.message ? e.message : String(e)));
  }
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error(`${label} HTTP ${resp.status} — ${body.slice(0, 200).trim()}`);
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`${label} 응답 파싱 실패: ${e.message} (${body.slice(0, 200).trim()})`);
  }
}

// 공유 쿠키로 platform.claude.com 의 API(콘솔) 조직 uuid 를 발견. claude.ai 와
// platform.claude.com 은 같은 sessionKey 를 공유하므로 claude.ai 쿠키 한 줄로
// 충분하다. 성공 시 uuid 문자열, 못 찾으면 null. (네트워크 오류는 throw)
async function fetchPlatformOrgId(cookie) {
  const ck = sanitizeCookie(cookie);
  const orgs = await getJson(
    "https://platform.claude.com/api/organizations",
    consoleHeaders(ck, "https://platform.claude.com/settings/keys"),
    "organizations",
  );
  return extractApiOrgId(orgs);
}

// 활성 Claude 계정의 org 기준 "이번 달" 키별 비용 조회. 성공 시
//   { month, starting_on, ending_before, total_dollars, keys[], fetched_at }
// 실패 시 throw. (orgId/cookie 는 호출처가 platformOrgId||orgId 로 미리 풀어 넘김)
async function fetchApiKeyCosts(orgId, cookie) {
  const ck = sanitizeCookie(cookie);
  const range = currentMonthRange();
  const base = `https://platform.claude.com/api`;

  const costUrl =
    `${base}/organizations/${orgId}/usage_cost` +
    `?starting_on=${range.starting_on}&ending_before=${range.ending_before}` +
    `&group_by=api_key_id`;
  const keysUrl = `${base}/console/organizations/${orgId}/api_keys`;

  // 두 요청을 병렬로 — 콘솔도 둘을 따로 던진다. 비용은 필수, 키 목록은 이름
  // 조인용이라 실패해도 비용은 보여줄 수 있게 분리 처리.
  const [usageCost, apiKeys] = await Promise.all([
    getJson(costUrl, consoleHeaders(ck, "https://platform.claude.com/settings/usage"), "usage_cost"),
    getJson(keysUrl, consoleHeaders(ck, "https://platform.claude.com/settings/keys"), "api_keys").catch(
      () => null,
    ),
  ]);

  const aggregated = aggregateCostsByKey(usageCost);
  const { total_dollars, keys } = buildKeyCostRows(aggregated, apiKeys);

  return {
    month: range.month,
    starting_on: range.starting_on,
    ending_before: range.ending_before,
    total_dollars,
    keys,
    fetched_at: new Date().toISOString(),
  };
}

module.exports = {
  fetchApiKeyCosts,
  fetchPlatformOrgId,
  // pure helpers — 테스트에서 직접 검증. 외부 호출처는 fetchApiKeyCosts /
  // fetchPlatformOrgId 만 쓴다.
  currentMonthRange,
  aggregateCostsByKey,
  centsToDollars,
  buildKeyCostRows,
  extractApiOrgId,
  COST_CATEGORIES,
};
