import type { PetState, PlanLimits, UsageSnapshot } from "./types";

export const CACHE_TTL_MS = 5 * 60 * 1000;
export const CACHE_NUDGE_AT_MS = 4 * 60 * 1000;

// 펫 윈도우 zoom 배율 (v1.70+). 우하단 그립 드래그로 조정. 너무 작으면
// 텍스트 가독성·캐릭터 표정이 다 깨지고, 너무 크면 화면 점유가 부담스러워
// 사용자에게 의도된 폭만 허용한다.
export const PET_SCALE_MIN = 0.6;
// v1.70 초기엔 1.8 까지 허용했으나 max 근처에서 펫이 너무 커져 카드 stack
// 과 resize 핸들이 화면 상단 메뉴바 위로 잘리는 회귀가 확인됨(2026-05-18
// 사용자 보고). 일반 디스플레이에서 카드+핸들+펫 본체가 모두 가시 영역
// 안에 들어오는 안전한 상한이 약 1.5.
export const PET_SCALE_MAX = 1.5;
export const PET_SCALE_DEFAULT = 1.0;
// 드래그 dx + dy 합이 이 픽셀만큼 늘어나면 scale 이 1.0 만큼 증가. 100px ≈ 0.5
// 배율 변화라 한쪽 끝에서 끝까지 가는 데 ~250px 정도 필요. 손맛 무난.
export const PET_SCALE_DRAG_PX_PER_UNIT = 200;

export function clampScale(v: number): number {
  if (!Number.isFinite(v)) return PET_SCALE_DEFAULT;
  if (v < PET_SCALE_MIN) return PET_SCALE_MIN;
  if (v > PET_SCALE_MAX) return PET_SCALE_MAX;
  return v;
}

/** 드래그 시작 시점의 scale 과 mouse delta(dx + dy) 를 받아 새 scale 반환.
 *  우하단 그립이라 우/하로 끌수록 커지고 좌/상으로 끌수록 작아진다. clamp 적용. */
export function scaleFromDrag(startScale: number, deltaSumPx: number): number {
  const next = startScale + deltaSumPx / PET_SCALE_DRAG_PX_PER_UNIT;
  return clampScale(next);
}

export type DerivedState = {
  /** Battery-style remaining %: 1.0 = full, 0.0 = exhausted */
  fiveHourRemaining: number;
  weeklyRemaining: number;
  /** Used %, kept for notification logic */
  fiveHourUsed: number;
  weeklyUsed: number;
  petState: PetState;
  cacheRemainMs: number | null;
  cacheNudge: boolean;
  fiveHourResetMs: number | null;
  weeklyResetMs: number | null;
};

export function derive(
  snap: UsageSnapshot | null,
  limits: PlanLimits,
  nowMs: number,
): DerivedState {
  if (!snap) {
    return {
      fiveHourRemaining: 1,
      weeklyRemaining: 1,
      fiveHourUsed: 0,
      weeklyUsed: 0,
      petState: "full",
      cacheRemainMs: null,
      cacheNudge: false,
      fiveHourResetMs: null,
      weeklyResetMs: null,
    };
  }
  // Prefer the live API if it's fresh (<2 minutes old). Anthropic's own
  // utilization% is authoritative — no calibration needed.
  const apiFresh =
    snap.api &&
    nowMs - Date.parse(snap.api.fetched_at) < 2 * 60 * 1000;

  const fiveHourUsed = apiFresh
    ? clampPct(snap.api!.five_hour_pct / 100)
    : clampPct(snap.five_hour_tokens / Math.max(1, limits.fiveHour));
  const weeklyUsed = apiFresh
    ? clampPct(snap.api!.weekly_pct / 100)
    : clampPct(snap.weekly_tokens / Math.max(1, limits.weekly));
  const fiveHourRemaining = 1 - fiveHourUsed;
  const weeklyRemaining = 1 - weeklyUsed;

  // Pet state is driven by the 5h remaining %, matching the top-of-bubble
  // % readout that v0.8 unified to 5h. Weekly is intentionally NOT mixed
  // into the tier math so a high 5h doesn't get pulled down by a half-used
  // weekly. The single weekly hook is `weekly = 0 → dead`, which is rare
  // enough to justify its own escape hatch.
  // `disconnected` overrides everything else. 신선한 live API 응답이 없으면
  // (1) 쿠키 만료/네트워크 에러로 stale, (2) 사용자가 연동 해제해서
  // config 자체가 비어 polling이 멈춘 상태, (3) 첫 polling 직전 등
  // 어느 경우든 quota 수치를 신뢰할 수 없으므로 disconnected로 표시한다.
  let petState: PetState;
  const apiBroken = !apiFresh;
  if (apiBroken) petState = "disconnected";
  else if (weeklyRemaining <= 0) petState = "dead";
  else if (fiveHourRemaining <= 0.15) petState = "sleepy";
  else if (fiveHourRemaining <= 0.33) petState = "tired";
  else if (fiveHourRemaining <= 0.49) petState = "low";
  else if (fiveHourRemaining <= 0.63) petState = "mid";
  else if (fiveHourRemaining <= 0.77) petState = "good";
  else if (fiveHourRemaining <= 0.90) petState = "high";
  else petState = "full";

  let cacheRemainMs: number | null = null;
  let cacheNudge = false;
  if (snap.last_request_at) {
    const lastMs = Date.parse(snap.last_request_at);
    const elapsed = nowMs - lastMs;
    if (elapsed < CACHE_TTL_MS && elapsed >= 0) {
      cacheRemainMs = CACHE_TTL_MS - elapsed;
      if (elapsed >= CACHE_NUDGE_AT_MS) cacheNudge = true;
    }
  }

  const fiveResetSrc =
    apiFresh && snap.api!.five_hour_resets_at
      ? snap.api!.five_hour_resets_at
      : snap.five_hour_resets_at;
  const weeklyResetSrc =
    apiFresh && snap.api!.weekly_resets_at
      ? snap.api!.weekly_resets_at
      : snap.weekly_resets_at;
  const fiveHourResetMs = fiveResetSrc
    ? Math.max(0, Date.parse(fiveResetSrc) - nowMs)
    : null;
  const weeklyResetMs = weeklyResetSrc
    ? Math.max(0, Date.parse(weeklyResetSrc) - nowMs)
    : null;

  return {
    fiveHourRemaining,
    weeklyRemaining,
    fiveHourUsed,
    weeklyUsed,
    petState,
    cacheRemainMs,
    cacheNudge,
    fiveHourResetMs,
    weeklyResetMs,
  };
}

function clampPct(v: number) {
  if (!Number.isFinite(v) || v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatRemain(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

// 트레이 라벨에 어떤 정보를 박을지를 사용자가 메뉴에서 선택할 수 있도록 분기.
// "fivehour" → 현재처럼 5h 남은 % 만, "both" → 5h % + 주간 %, "all" → 둘 +
// platform prepaid 잔액(달러)까지. all 모드는 사용자가 "$ 자리를 보겠다"고
// 명시한 신호라서 prepaid가 아직 안 도착했거나(platform UUID 미설정·첫 폴링
// 전·API 실패) 0이거나 항상 자리를 둔다. null이면 `$—` placeholder, 0이면
// `$0.00`, 양수면 그대로. 자리 자체가 사라지면 사용자가 "왜 안 나오지" 의심하니까.
export type TrayMode = "fivehour" | "both" | "all";

export function formatTrayLabel(
  mode: TrayMode,
  fiveHourRemaining: number, // 0–1
  weeklyRemaining: number, // 0–1
  prepaidDollars: number | null = null,
): string {
  const five = Math.round(clampUnit(fiveHourRemaining) * 100);
  if (mode === "fivehour") return `${five}%`;
  const weekly = Math.round(clampUnit(weeklyRemaining) * 100);
  if (mode === "both") return `${five}% · 주 ${weekly}%`;
  // mode === "all" — $ 자리 무조건 유지
  const dollarPart =
    prepaidDollars !== null && Number.isFinite(prepaidDollars)
      ? `$${prepaidDollars.toFixed(2)}`
      : "$—";
  return `${five}% · 주 ${weekly}% · ${dollarPart}`;
}

function clampUnit(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/// 문자열(예: 세션 uuid)을 0~359 hue로 결정론적 매핑. 같은 입력은 항상 같은 hue.
/// 세션 카드 stack에서 카드마다 hsl hue만 다르게 줘서 거품 톤은 유지한 채로
/// 시각적으로 구분하는 용도. 빈 문자열은 0.
export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return ((h % 360) + 360) % 360;
}

export type SessionTimerView = {
  /** 남은 ms. 0~CACHE_TTL_MS 범위로 클램프됨. */
  remainMs: number;
  /** 게이지 width %. 0~100. remainMs / CACHE_TTL_MS * 100. */
  pct: number;
  /** "M:SS" 형식 라벨 (1자리 분도 그대로, 초만 0 padding). */
  label: string;
  /** 남은 시간 0이면 true. expired 카드를 fade 처리할 때 사용. */
  expired: boolean;
};

/// 세션 카드에 표시할 카운트다운(남은 ms / 게이지 width / "M:SS" 라벨)을 계산.
/// React 컴포넌트 안에 inline으로 박으면 단위 테스트 어려워서 헬퍼로 분리.
export function computeSessionTimer(
  lastAssistantIso: string,
  nowMs: number,
): SessionTimerView {
  const lastMs = Date.parse(lastAssistantIso);
  const elapsed = Math.max(0, nowMs - (Number.isFinite(lastMs) ? lastMs : nowMs));
  const remainMs = Math.max(0, Math.min(CACHE_TTL_MS, CACHE_TTL_MS - elapsed));
  const pct = (remainMs / CACHE_TTL_MS) * 100;
  const remainSec = Math.ceil(remainMs / 1000);
  const mins = Math.floor(remainSec / 60);
  const secs = remainSec % 60;
  return {
    remainMs,
    pct,
    label: `${mins}:${secs.toString().padStart(2, "0")}`,
    expired: remainMs <= 0,
  };
}

export function formatResetCountdown(ms: number): string {
  if (ms <= 0) return "곧 초기화";
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days >= 1) return `${days}일 ${hours}시간 후`;
  if (hours >= 1) return `${hours}시간 ${mins}분 후`;
  return `${mins}분 후`;
}
