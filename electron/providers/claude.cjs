// Claude provider — 기존 claudeApi.cjs 를 provider 인터페이스로 감싼 얇은
// 어댑터. claudeApi.cjs 자체는 frozen(테스트도 frozen) 이라 손대지 않고
// 호출 시그니처만 정렬해 준다.
//
// credentials 모양:
//   { orgId, cookie, platformOrgId?, platformCookie? }

const claudeApi = require("../claudeApi.cjs");
const claudeCosts = require("../claudeCosts.cjs");

const id = "claude";
const displayName = "Claude";
const capabilities = Object.freeze({
  prepaid: true,
  autoExtract: true,
  tier: false,
  // 키별 월 비용 조회 지원 (platform.claude.com usage_cost). prepaid 와 같은
  // platform 쿠키 인증을 쓰되, org 는 platformOrgId 가 없으면 공유 쿠키로
  // 자동 발견한다(fetchApiKeyCosts 참고).
  apiKeyCosts: true,
});

async function fetchUsage(credentials) {
  const c = credentials || {};
  if (!c.orgId || !c.cookie) {
    throw new Error("Claude provider 자격증명에 orgId / cookie 가 비어 있습니다.");
  }
  const u = await claudeApi.fetchUsage(c.orgId, c.cookie);
  return { ...u, provider: id };
}

async function fetchPrepaid(credentials) {
  const c = credentials || {};
  const orgId = c.platformOrgId || c.orgId;
  const cookie = c.platformCookie || c.cookie;
  if (!orgId || !cookie) {
    throw new Error("Claude provider prepaid 자격증명이 비어 있습니다.");
  }
  return claudeApi.fetchPrepaid(orgId, cookie);
}

// 키별 월 비용. 쿠키는 platform 우선(없으면 claude.ai 쿠키 재사용 — 두 도메인이
// sessionKey 공유). org 는 prepaid 와 달리 platformOrgId 가 *없어도* 공유 쿠키로
// platform `/api/organizations` 를 조회해 API(콘솔) 조직 uuid 를 자동 발견한다
// (claude.ai orgId 는 platform 엔드포인트에서 안 통하므로 폴백으로 쓰지 않는다).
async function fetchApiKeyCosts(credentials) {
  const c = credentials || {};
  const cookie = c.platformCookie || c.cookie;
  if (!cookie) {
    throw new Error("Claude provider 비용 조회 자격증명에 cookie 가 비어 있습니다.");
  }
  const orgId = c.platformOrgId || (await claudeCosts.fetchPlatformOrgId(cookie));
  if (!orgId) {
    throw new Error(
      "platform.claude.com 에서 API 조직을 찾지 못했어요. 이 계정에 개발자 콘솔(API) 조직이 없거나 쿠키가 만료됐을 수 있어요.",
    );
  }
  return claudeCosts.fetchApiKeyCosts(orgId, cookie);
}

async function autoExtract(rawCookie) {
  const r = await claudeApi.autoExtract(rawCookie);
  // claudeApi 는 { org_id, cookie } 모양으로 돌려준다 (snake_case 는 frontend
  // 와의 IPC 계약). provider 인터페이스 쪽은 credentials 묶음으로 정규화해서
  // 넘긴다.
  return {
    credentials: { orgId: r.org_id, cookie: r.cookie },
    legacy: r, // 기존 IPC 호출처가 그대로 r.org_id / r.cookie 읽을 수 있게 보존
  };
}

module.exports = {
  id,
  displayName,
  capabilities,
  fetchUsage,
  fetchPrepaid,
  fetchApiKeyCosts,
  autoExtract,
};
