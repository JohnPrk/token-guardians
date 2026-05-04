export type ApiUsage = {
  five_hour_pct: number;   // 0-100, utilization (NOT remaining)
  weekly_pct: number;
  five_hour_resets_at: string | null;
  weekly_resets_at: string | null;
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
};

export type ApiConfig = {
  orgId: string;
  cookie: string;
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
};

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
