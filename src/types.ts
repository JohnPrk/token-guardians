export type ProviderId = "claude" | "gemini";

export type ApiUsage = {
  /** 어느 provider 가 만든 스냅샷인지. legacy(undefined) 면 claude 로 간주. */
  provider?: ProviderId;
  five_hour_pct: number;   // 0-100, utilization (NOT remaining)
  weekly_pct: number;
  five_hour_resets_at: string | null;
  weekly_resets_at: string | null;
  fetched_at: string;
  /** Gemini 가 채우는 요금제 라벨 (PRO / ULTRA / PLUS). 다른 provider 는 미사용. */
  tier?: string;
};

/** platform.claude.com 의 prepaid 잔액. dollars 단위(소수점 둘째자리). usage
 *  호출과 같은 poller cycle에서 별개 endpoint(/prepaid/credits)로 채워진다.
 *  usage가 살아있어도 prepaid가 비어 있을 수 있고(API 변경/권한 이슈 등),
 *  trayMode === "all" 일 때만 트레이/펫 카드에 표시된다. */
export type PrepaidCredits = {
  dollars: number;
  fetched_at: string;
};

/** platform.claude.com 콘솔의 API 키 1개에 대한 *이번 달* 누적 비용($).
 *  usage_cost(group_by=api_key_id)의 센트 합을 달러로 환산한 값. */
export type ApiKeyCost = {
  /** 콘솔 key id (apikey_…) 또는 의사키("console" 등). */
  id: string;
  /** api_keys 목록에서 조인한 표시 이름. 조인 실패 시 폴백 라벨. */
  name: string;
  /** sk-ant-api03-…XXXX 형태의 부분 힌트. 조인 실패/의사키면 null. */
  partial_key_hint: string | null;
  dollars: number;
};

/** "이번 달 API 사용량" 섹션이 IPC `fetch_api_key_costs`로 받는 결과.
 *  available=false면 reason/error로 UI가 안내 문구를 고른다. 폴링 없이
 *  설정 창이 열릴 때 1회만 채워진다. */
export type ApiKeyCostsResult = {
  available: boolean;
  /** available=false일 때 왜 못 보여주는지. */
  reason?: "no_account" | "unsupported" | "no_platform_org";
  /** 호출은 했으나 네트워크/API 오류로 실패한 경우의 메시지. */
  error?: string | null;
  /** "YYYY-MM" — 어느 달 기준인지. */
  month?: string;
  starting_on?: string;
  ending_before?: string;
  /** 모든 키 비용의 합($). */
  total_dollars?: number;
  /** 달러 내림차순 키 목록. */
  keys?: ApiKeyCost[];
  fetched_at?: string;
};

export type UsageSnapshot = {
  five_hour_tokens: number;
  weekly_tokens: number;
  last_request_at: string | null;
  last_user_prompt_at: string | null;
  is_thinking: boolean;
  five_hour_window_start: string | null;
  five_hour_resets_at: string | null;
  weekly_window_start: string | null;
  weekly_resets_at: string | null;
  cache_hits_5min: number;
  cache_misses_5min: number;
  current_combo: number;
  /** hit/miss flag of the MOST RECENT assistant message — null when no
   *  assistant entries exist yet. Drives the flash effect via change
   *  detection on `last_request_at` (not the sliding 5min counts, which
   *  can stay flat as old entries age out of the window). */
  last_cache_hit: boolean | null;
  now: string;
  /** Live data from claude.ai's internal /api/.../usage endpoint when
   *  the user has configured org_id + session cookie. Treated as truth
   *  when fresh (<2min); jsonl-derived numbers are used as fallback. */
  api: ApiUsage | null;
  /** Last error string from the API poller, surfaced in Settings. */
  api_error?: string | null;
  /** platform.claude.com prepaid 잔액. 같은 poller cycle에서 별 endpoint로
   *  가져옴. trayMode === "all" 일 때만 트레이/카드에 노출된다. */
  prepaid?: PrepaidCredits | null;
  prepaid_error?: string | null;
  /** 활성 세션 카드 stack. 마지막 assistant 응답이 5분 이내인 세션만, 최신순 정렬,
   *  Rust 쪽 MAX_ACTIVE_SESSIONS=5로 cap. 빈 배열일 수 있음. */
  active_sessions: SessionInfo[];
};

/** 펫 윈도우 위에 카드 1개로 렌더되는 세션 데이터. session_id는 jsonl 파일
 *  basename(uuid)라 카드 색상 분배(hue 해시)에 쓰인다. */
export type SessionInfo = {
  session_id: string;
  last_user_prompt: string;
  last_assistant_at: string; // ISO 8601
  cache_hit: boolean;
};

export type ApiConfig = {
  orgId: string;
  cookie: string;
};

// 계정 1개 = 라벨 + claude.ai 자격증명 + 그 계정에 묶인 캐릭터.
// 활성 계정의 자격증명만 폴링하고, 활성 계정의 skin이 메인 펫과 트레이
// 아이콘에 동시에 반영된다. PlanConfig.skin은 활성 계정의 skinId를
// 미러링하는 derived 값으로만 유지한다.
//
// platformOrgId는 *선택*. platform.claude.com의 org UUID는 claude.ai의
// orgId와 *완전히 다른 체계*라(같은 UUID로 두 도메인을 쏘면 엉뚱한
// 응답이 옴 — v1.50 회귀에서 학인됨), prepaid 잔액을 보려는 사용자가
// 별도로 채워야 한다. 비워두면 prepaid 호출 자체를 건너뛰고 트레이의
// "5h+주간+$" 모드도 자동으로 "5h+주간"으로 폴백한다.
//
// platformCookie도 *선택*. platform.claude.com 도메인은 claude.ai 와
// 별도 쿠키 컨텍스트라 claude.ai 세션 쿠키를 그대로 흘려보내면 403이
// 떨어지는 케이스가 있다(사용자 보고 2026-05-18). 비워두면 메인 cookie를
// 그대로 시도하고, 채워두면 그걸로 prepaid 호출만 분기한다 (usage 호출은
// 메인 cookie 유지).
// Account 는 provider 별 자격증명 모양이 달라 discriminated union 으로 둔다.
// 단, Claude 쪽 `provider` 는 *optional* 로 둬서 `provider` 필드 없이 저장된
// legacy 계정(클로드 단일 시절)이 자동으로 Claude 쪽 union 으로 매칭되도록
// 한다 (read-time 마이그레이션이 필요 없음 → store.ts 의 frozen 테스트 보존).
//
// 런타임 분기는 항상 `account.provider === "gemini"` 한 가지만 본다. 그 외
// (undefined / "claude") 는 모두 claude 경로. 새 provider 추가 시 여기에
// 한 종류 더 더하고, `provider: "<id>"` 필수로 둔다.
export type ClaudeAccount = {
  id: string;
  label: string;
  skinId: string;
  /** optional. 없으면 claude 로 간주 (legacy 호환). */
  provider?: "claude";
  orgId: string;
  cookie: string;
  platformOrgId?: string;
  platformCookie?: string;
};

export type GeminiAccount = {
  id: string;
  label: string;
  skinId: string;
  provider: "gemini";
  /** gemini.google.com 의 raw Cookie 헤더 한 줄. 최소 SID/__Secure-1PSID/
   *  __Secure-3PSID/SAPISID/__Secure-1PAPISID/__Secure-3PAPISID 가 들어 있어야
   *  WIZ_global_data scrape + batchexecute POST 가 통과한다. */
  cookie: string;
  /** 구조적 호환을 위한 phantom 필드 — ClaudeAccount 와 같은 키를 가진
   *  union 으로 만들어 `account.orgId` 같은 접근이 TS 에서 `string | undefined`
   *  로 떨어지게 한다 (frozen 테스트 호환). 런타임에선 항상 undefined. */
  orgId?: undefined;
  platformOrgId?: undefined;
  platformCookie?: undefined;
};

export type Account = ClaudeAccount | GeminiAccount;

/** Account 의 provider 를 정규화. legacy(undefined) → "claude". */
export function accountProvider(a: Account): ProviderId {
  return a.provider === "gemini" ? "gemini" : "claude";
}

export type AccountsConfig = {
  accounts: Account[];
  activeAccountId: string | null;
};

export type PlanId = "pro" | "max5x" | "max20x" | "custom";

export type PlanLimits = {
  fiveHour: number;
  weekly: number;
};

export type PlanConfig = {
  plan: PlanId;
  limits: PlanLimits;
  skin: string;
  /** 트레이 메뉴바 텍스트에 무엇을 표시할지. 기본은 v1.24까지의 동작인 "fivehour".
   *  v1.25부터 사용자가 트레이 메뉴 "표시 모드 ▸"에서 토글 가능. legacy store에는
   *  이 필드가 없을 수 있어 loadPlanConfig가 기본값을 채워준다. */
  trayMode?: TrayMode;
  /** 펫 윈도우 전체 zoom 배율 (v1.70+). 펫·UsageBubble·세션 stack 모두 같이 scale.
   *  사용자가 펫 우하단 그립을 드래그해서 조정. 범위는 PET_SCALE_MIN ~ PET_SCALE_MAX
   *  (petLogic.ts 의 clampScale 이 강제). 기본 1.0. legacy store에는 없을 수
   *  있어 loadPlanConfig가 1.0 으로 채운다. */
  petScale?: number;
};

export type TrayMode = "fivehour" | "both" | "all";

// Anthropic does not publish exact 5h/weekly token limits per plan.
// Used only as fallback when the API path isn't configured.
export const PLAN_PRESETS: Record<Exclude<PlanId, "custom">, PlanLimits> = {
  pro: { fiveHour: 5_000_000, weekly: 35_000_000 },
  max5x: { fiveHour: 25_000_000, weekly: 175_000_000 },
  max20x: { fiveHour: 100_000_000, weekly: 700_000_000 },
};

/// Visual tier of the pet, derived from the LOWEST remaining %
/// (min of 5h-remaining and weekly-remaining). Filenames in
/// `src/skins/<skin>/` mirror these names 1:1.
///   full          90-100%
///   high          77-90%
///   good          63-77%
///   mid           49-63%
///   low           33-49%
///   tired         15-33%
///   sleepy        0-15%   (also when 5h = 0%)
///   dead          weekly = 0%
///   disconnected  API 끊김(쿠키 만료/Cloudflare 차단 등) — quota와 별개로 우선 표시
export type PetState =
  | "full"
  | "high"
  | "good"
  | "mid"
  | "low"
  | "tired"
  | "sleepy"
  | "dead"
  | "disconnected";
