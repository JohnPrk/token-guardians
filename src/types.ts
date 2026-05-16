export type ApiUsage = {
  five_hour_pct: number;   // 0-100, utilization (NOT remaining)
  weekly_pct: number;
  five_hour_resets_at: string | null;
  weekly_resets_at: string | null;
  fetched_at: string;
};

/** platform.claude.com 의 prepaid 잔액. dollars 단위(소수점 둘째자리). usage
 *  호출과 같은 poller cycle에서 별개 endpoint(/prepaid/credits)로 채워진다.
 *  usage가 살아있어도 prepaid가 비어 있을 수 있고(API 변경/권한 이슈 등),
 *  trayMode === "all" 일 때만 트레이/펫 카드에 표시된다. */
export type PrepaidCredits = {
  dollars: number;
  fetched_at: string;
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
export type Account = {
  id: string;
  label: string;
  orgId: string;
  cookie: string;
  skinId: string;
};

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
