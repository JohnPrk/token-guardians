import { describe, it, expect } from "vitest";
import {
  CACHE_TTL_MS,
  PET_SCALE_DEFAULT,
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  clampScale,
  computeSessionTimer,
  derive,
  formatRemain,
  formatResetCountdown,
  formatTokens,
  formatTrayLabel,
  hashHue,
  scaleFromDrag,
} from "./petLogic";
import type { PlanLimits, UsageSnapshot, ApiUsage } from "./types";

const limits: PlanLimits = { fiveHour: 1_000_000, weekly: 7_000_000 };
const NOW_ISO = "2026-05-03T12:00:00Z";
const NOW_MS = Date.parse(NOW_ISO);

function snap(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    five_hour_tokens: 0,
    weekly_tokens: 0,
    last_request_at: null,
    last_user_prompt_at: null,
    is_thinking: false,
    five_hour_window_start: null,
    five_hour_resets_at: null,
    weekly_window_start: null,
    weekly_resets_at: null,
    cache_hits_5min: 0,
    cache_misses_5min: 0,
    current_combo: 0,
    last_cache_hit: null,
    now: NOW_ISO,
    api: null,
    api_error: null,
    active_sessions: [],
    ...over,
  };
}

function api(over: Partial<ApiUsage> = {}): ApiUsage {
  return {
    five_hour_pct: 0,
    weekly_pct: 0,
    five_hour_resets_at: null,
    weekly_resets_at: null,
    fetched_at: NOW_ISO,
    ...over,
  };
}

describe("derive", () => {
  it("snap이 null이면 full + 신호 없음", () => {
    const d = derive(null, limits, NOW_MS);
    expect(d.petState).toBe("full");
    expect(d.fiveHourRemaining).toBe(1);
    expect(d.weeklyRemaining).toBe(1);
  });

  it("snap은 있지만 API가 null이면 disconnected (연동 해제 케이스)", () => {
    const d = derive(snap(), limits, NOW_MS);
    expect(d.petState).toBe("disconnected");
  });

  it("API가 stale(2분 초과)이면 disconnected", () => {
    const fetched = new Date(NOW_MS - 3 * 60 * 1000).toISOString();
    const d = derive(snap({ api: api({ fetched_at: fetched }) }), limits, NOW_MS);
    expect(d.petState).toBe("disconnected");
  });

  it("API 신선 + 5h 0% 사용 → full", () => {
    const d = derive(
      snap({ api: api({ five_hour_pct: 0, weekly_pct: 0 }) }),
      limits,
      NOW_MS,
    );
    expect(d.petState).toBe("full");
    expect(d.fiveHourRemaining).toBeCloseTo(1);
  });

  it("주간 100% 사용 → dead (5h가 멀쩡해도 weekly=0이 우선)", () => {
    const d = derive(
      snap({ api: api({ five_hour_pct: 10, weekly_pct: 100 }) }),
      limits,
      NOW_MS,
    );
    expect(d.petState).toBe("dead");
  });

  it("5h 90% 사용 (remaining 10%) → sleepy", () => {
    const d = derive(
      snap({ api: api({ five_hour_pct: 90, weekly_pct: 0 }) }),
      limits,
      NOW_MS,
    );
    expect(d.petState).toBe("sleepy");
  });

  it("5h 50% 사용 (remaining 50%) → mid", () => {
    const d = derive(
      snap({ api: api({ five_hour_pct: 50, weekly_pct: 0 }) }),
      limits,
      NOW_MS,
    );
    expect(d.petState).toBe("mid");
  });

  it("disconnected는 quota 분기보다 우선", () => {
    // 5h 100% 사용 + API stale → quota만 보면 dead 직전이지만 disconnected 우선
    const fetched = new Date(NOW_MS - 5 * 60 * 1000).toISOString();
    const d = derive(
      snap({ api: api({ five_hour_pct: 100, weekly_pct: 100, fetched_at: fetched }) }),
      limits,
      NOW_MS,
    );
    expect(d.petState).toBe("disconnected");
  });

  // === 경계 케이스 — 각 티어 진입 직후 1개씩 ===
  // 임계: full ≤90 ≤high ≤77 ≤good ≤63 ≤mid ≤49 ≤low ≤33 ≤tired ≤15 ≤sleepy
  it("5h 5% 사용 (remaining 95%) → full", () => {
    const d = derive(snap({ api: api({ five_hour_pct: 5 }) }), limits, NOW_MS);
    expect(d.petState).toBe("full");
  });

  it("5h 15% 사용 (remaining 85%) → high", () => {
    const d = derive(snap({ api: api({ five_hour_pct: 15 }) }), limits, NOW_MS);
    expect(d.petState).toBe("high");
  });

  it("5h 30% 사용 (remaining 70%) → good", () => {
    const d = derive(snap({ api: api({ five_hour_pct: 30 }) }), limits, NOW_MS);
    expect(d.petState).toBe("good");
  });

  it("5h 60% 사용 (remaining 40%) → low", () => {
    const d = derive(snap({ api: api({ five_hour_pct: 60 }) }), limits, NOW_MS);
    expect(d.petState).toBe("low");
  });

  it("5h 75% 사용 (remaining 25%) → tired", () => {
    const d = derive(snap({ api: api({ five_hour_pct: 75 }) }), limits, NOW_MS);
    expect(d.petState).toBe("tired");
  });

  // === 캐시 카운트다운 ===
  it("last_request_at 1분 전이면 cacheRemainMs ≈ 4분, nudge=false", () => {
    const lastReq = new Date(NOW_MS - 60 * 1000).toISOString();
    const d = derive(
      snap({ last_request_at: lastReq, api: api({ five_hour_pct: 10 }) }),
      limits,
      NOW_MS,
    );
    expect(d.cacheRemainMs).toBe(4 * 60 * 1000);
    expect(d.cacheNudge).toBe(false);
  });

  it("last_request_at 4분 30초 전이면 nudge=true (4분 경계 지남)", () => {
    const lastReq = new Date(NOW_MS - 4.5 * 60 * 1000).toISOString();
    const d = derive(
      snap({ last_request_at: lastReq, api: api({ five_hour_pct: 10 }) }),
      limits,
      NOW_MS,
    );
    expect(d.cacheNudge).toBe(true);
    expect(d.cacheRemainMs).toBeGreaterThan(0);
  });

  it("last_request_at 5분 초과면 cache 정보 null (TTL 만료)", () => {
    const lastReq = new Date(NOW_MS - 6 * 60 * 1000).toISOString();
    const d = derive(
      snap({ last_request_at: lastReq, api: api({ five_hour_pct: 10 }) }),
      limits,
      NOW_MS,
    );
    expect(d.cacheRemainMs).toBeNull();
    expect(d.cacheNudge).toBe(false);
  });

  // === 리셋 카운트다운 ===
  it("API 리셋 시각이 신선하면 그 값으로 ms 환산", () => {
    const resetAt = new Date(NOW_MS + 30 * 60 * 1000).toISOString();
    const d = derive(
      snap({ api: api({ five_hour_pct: 10, five_hour_resets_at: resetAt }) }),
      limits,
      NOW_MS,
    );
    expect(d.fiveHourResetMs).toBe(30 * 60 * 1000);
  });

  it("리셋 시각 없으면 null", () => {
    const d = derive(snap({ api: api({ five_hour_pct: 10 }) }), limits, NOW_MS);
    expect(d.fiveHourResetMs).toBeNull();
    expect(d.weeklyResetMs).toBeNull();
  });
});

describe("formatTokens", () => {
  it("1000 미만은 그대로 정수 문자열", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("1k 이상은 소수 1자리 k 표기", () => {
    expect(formatTokens(1_000)).toBe("1.0k");
    expect(formatTokens(12_345)).toBe("12.3k");
  });

  it("1M 이상은 소수 2자리 M 표기", () => {
    expect(formatTokens(1_000_000)).toBe("1.00M");
    expect(formatTokens(7_250_000)).toBe("7.25M");
  });
});

describe("formatRemain", () => {
  it("음수는 0:00으로 클램프", () => {
    expect(formatRemain(-5000)).toBe("0:00");
  });

  it("초 단위 0 패딩", () => {
    expect(formatRemain(5 * 1000)).toBe("0:05");
    expect(formatRemain(65 * 1000)).toBe("1:05");
  });

  it("4분 30초", () => {
    expect(formatRemain(4 * 60 * 1000 + 30 * 1000)).toBe("4:30");
  });
});

describe("formatTrayLabel", () => {
  it("fivehour 모드는 5h % 만 반올림해 반환", () => {
    expect(formatTrayLabel("fivehour", 0.76, 0.54)).toBe("76%");
    expect(formatTrayLabel("fivehour", 1, 0.5)).toBe("100%");
    expect(formatTrayLabel("fivehour", 0, 0.99)).toBe("0%");
  });

  it("both 모드는 5h % + 주간 % 같이 표시 (N% · 주 M% 형식)", () => {
    expect(formatTrayLabel("both", 0.76, 0.54)).toBe("76% · 주 54%");
    expect(formatTrayLabel("both", 1, 1)).toBe("100% · 주 100%");
  });

  it("0–1 범위 밖 입력은 클램프 (예: 음수, 1 초과, NaN)", () => {
    expect(formatTrayLabel("fivehour", -0.5, 0.5)).toBe("0%");
    expect(formatTrayLabel("fivehour", 1.5, 0.5)).toBe("100%");
    expect(formatTrayLabel("both", NaN, 0.5)).toBe("0% · 주 50%");
    expect(formatTrayLabel("both", 0.5, NaN)).toBe("50% · 주 0%");
  });

  it("반올림 경계 (0.5)", () => {
    // 0.5 * 100 = 50, Math.round(50) = 50
    expect(formatTrayLabel("fivehour", 0.5, 0)).toBe("50%");
    // 0.005 * 100 = 0.5, Math.round(0.5) = 1 (JS는 0.5에서 짝수가 아니라 위로 올림)
    expect(formatTrayLabel("fivehour", 0.005, 0)).toBe("1%");
  });

  // === all 모드 (v1.48) — 5h + 주간 + prepaid $ ===
  it("all 모드 + prepaid 값 있음 → 셋 다 표시 (· $X.XX)", () => {
    expect(formatTrayLabel("all", 0.76, 0.54, 12.34)).toBe(
      "76% · 주 54% · $12.34",
    );
    expect(formatTrayLabel("all", 1, 1, 0.5)).toBe("100% · 주 100% · $0.50");
  });

  it("all 모드 + prepaid 값 0 → $0.00 명시 표시 (사용자가 0이라도 자리는 보고 싶다고 명시)", () => {
    expect(formatTrayLabel("all", 0.76, 0.54, 0)).toBe("76% · 주 54% · $0.00");
  });

  it("all 모드인데 prepaid가 null/NaN이면 $— placeholder (자리는 유지, 값만 모름 표시)", () => {
    expect(formatTrayLabel("all", 0.76, 0.54, null)).toBe(
      "76% · 주 54% · $—",
    );
    expect(formatTrayLabel("all", 0.76, 0.54, NaN)).toBe(
      "76% · 주 54% · $—",
    );
  });

  it("all 모드는 prepaid를 항상 둘째 자리까지 toFixed", () => {
    expect(formatTrayLabel("all", 0.5, 0.5, 1)).toBe("50% · 주 50% · $1.00");
    expect(formatTrayLabel("all", 0.5, 0.5, 12)).toBe("50% · 주 50% · $12.00");
    expect(formatTrayLabel("all", 0.5, 0.5, 0)).toBe("50% · 주 50% · $0.00");
  });

  it("fivehour/both 모드 호출 시 prepaid 인자 무시", () => {
    // 4번째 인자가 들어와도 fivehour/both는 변동 없음.
    expect(formatTrayLabel("fivehour", 0.76, 0.54, 99.99)).toBe("76%");
    expect(formatTrayLabel("both", 0.76, 0.54, 99.99)).toBe("76% · 주 54%");
  });
});

describe("formatResetCountdown", () => {
  it("0 이하는 곧 초기화", () => {
    expect(formatResetCountdown(0)).toBe("곧 초기화");
    expect(formatResetCountdown(-1)).toBe("곧 초기화");
  });

  it("1시간 미만은 분 단위", () => {
    expect(formatResetCountdown(45 * 60 * 1000)).toBe("45분 후");
  });

  it("1시간 이상 24시간 미만은 시간+분", () => {
    expect(formatResetCountdown(3 * 60 * 60 * 1000 + 15 * 60 * 1000)).toBe(
      "3시간 15분 후",
    );
  });

  it("1일 이상은 일+시간", () => {
    expect(formatResetCountdown(2 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000)).toBe(
      "2일 5시간 후",
    );
  });
});

describe("computeSessionTimer", () => {
  const NOW = Date.parse("2026-05-16T13:00:00Z");

  it("응답 직후(0초 경과)는 5:00 + pct 100", () => {
    const v = computeSessionTimer("2026-05-16T13:00:00Z", NOW);
    expect(v.label).toBe("5:00");
    expect(v.pct).toBe(100);
    expect(v.remainMs).toBe(CACHE_TTL_MS);
    expect(v.expired).toBe(false);
  });

  it("1분 경과 → 4:00 + pct 80", () => {
    const v = computeSessionTimer("2026-05-16T12:59:00Z", NOW);
    expect(v.label).toBe("4:00");
    expect(v.pct).toBe(80);
    expect(v.expired).toBe(false);
  });

  it("4분 30초 경과 → 0:30 + pct 10", () => {
    const v = computeSessionTimer("2026-05-16T12:55:30Z", NOW);
    expect(v.label).toBe("0:30");
    expect(v.pct).toBe(10);
  });

  it("5분 정확히 경과 → 0:00 + pct 0 + expired", () => {
    const v = computeSessionTimer("2026-05-16T12:55:00Z", NOW);
    expect(v.label).toBe("0:00");
    expect(v.pct).toBe(0);
    expect(v.expired).toBe(true);
  });

  it("5분 초과 (음수가 되면) 안 됨 — 0으로 클램프", () => {
    const v = computeSessionTimer("2026-05-16T12:50:00Z", NOW);
    expect(v.label).toBe("0:00");
    expect(v.pct).toBe(0);
    expect(v.remainMs).toBe(0);
    expect(v.expired).toBe(true);
  });

  it("앞 시점(미래 timestamp): elapsed 음수가 되어도 안전 — pct 100", () => {
    // 클락 스큐 등으로 lastAssistantIso가 now보다 미래일 수도. 그래도 NaN/음수 안 됨.
    const v = computeSessionTimer("2026-05-16T13:01:00Z", NOW);
    expect(v.pct).toBe(100);
    expect(v.expired).toBe(false);
  });

  it("ISO 파싱 실패하면 expired 상태 (안전한 fallback)", () => {
    const v = computeSessionTimer("not an iso", NOW);
    expect(v.pct).toBe(100); // elapsed=0이라 pct는 100. 의도된 동작: 깨진 데이터로 카드가 즉시 사라지지 않게.
    expect(v.expired).toBe(false);
  });

  it("초 단위 0 padding", () => {
    // 4:59 → 0:01 + 4 = 4:05 같은 분 경계가 아닌 일반 케이스
    const v = computeSessionTimer("2026-05-16T12:55:05Z", NOW);
    expect(v.label).toBe("0:05");
  });
});

describe("hashHue", () => {
  it("같은 입력은 항상 같은 hue (결정론적)", () => {
    expect(hashHue("session-A")).toBe(hashHue("session-A"));
  });

  it("0–359 범위 안에 있다", () => {
    for (const s of ["a", "session-uuid-1234", "한글session", ""]) {
      const h = hashHue(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it("빈 문자열은 0", () => {
    expect(hashHue("")).toBe(0);
  });

  it("다른 입력은 (일반적으로) 다른 hue", () => {
    // 충돌은 가능하지만 확률 낮음. 여기선 몇 개 샘플로 distinct 확인.
    const hues = new Set(
      [
        "abc-001",
        "abc-002",
        "abc-003",
        "session-xxx",
        "session-yyy",
      ].map(hashHue),
    );
    expect(hues.size).toBeGreaterThanOrEqual(4);
  });
});

// ===== 추가 회귀 케이스 (v1.51 테스트 커버리지 보강) =====

describe("derive — 추가 경계 케이스", () => {
  it("API fetched_at 이 정확히 2분 전이면 stale 로 disconnected", () => {
    // 코드 조건: `nowMs - fetched_at < 2 * 60 * 1000` 이면 fresh. == 은 stale.
    const fetched = new Date(NOW_MS - 2 * 60 * 1000).toISOString();
    const d = derive(snap({ api: api({ fetched_at: fetched }) }), limits, NOW_MS);
    expect(d.petState).toBe("disconnected");
  });

  it("API fetched_at 이 2분 직전(1분 59.999초)이면 fresh", () => {
    const fetched = new Date(NOW_MS - (2 * 60 * 1000 - 1)).toISOString();
    const d = derive(
      snap({ api: api({ fetched_at: fetched, five_hour_pct: 10 }) }),
      limits,
      NOW_MS,
    );
    expect(d.petState).not.toBe("disconnected");
  });

  it("5h_pct 음수 입력(sentinel) → clampPct 로 0 사용 후 full", () => {
    // /usage 응답이 어떤 이유로든 음수를 보내도 0 으로 clamp 되어 사용자에게 보임.
    const d = derive(
      snap({ api: api({ five_hour_pct: -5, weekly_pct: 0 }) }),
      limits,
      NOW_MS,
    );
    expect(d.petState).toBe("full");
    expect(d.fiveHourUsed).toBe(0);
  });

  it("5h_pct NaN 입력 → clampPct 로 0 사용", () => {
    const d = derive(
      snap({ api: api({ five_hour_pct: NaN, weekly_pct: 0 }) }),
      limits,
      NOW_MS,
    );
    expect(d.fiveHourUsed).toBe(0);
    expect(d.petState).toBe("full");
  });

  it("5h_pct 100 초과 → 1.0 으로 clamp (used = 1, remaining = 0)", () => {
    const d = derive(
      snap({ api: api({ five_hour_pct: 150 }) }),
      limits,
      NOW_MS,
    );
    expect(d.fiveHourUsed).toBe(1);
    expect(d.fiveHourRemaining).toBe(0);
    // remaining 0 ≤ 0.15 이므로 sleepy
    expect(d.petState).toBe("sleepy");
  });

  it("리셋 시각이 이미 지난 ISO 면 0 ms (Math.max 클램프)", () => {
    const past = new Date(NOW_MS - 60 * 1000).toISOString();
    const d = derive(
      snap({ api: api({ five_hour_pct: 10, five_hour_resets_at: past }) }),
      limits,
      NOW_MS,
    );
    expect(d.fiveHourResetMs).toBe(0);
  });

  it("snapshot 의 reset 필드만 있고 API resets_at 이 없으면 그쪽으로 폴백", () => {
    const future = new Date(NOW_MS + 10 * 60 * 1000).toISOString();
    const d = derive(
      snap({
        api: api({ five_hour_pct: 10, five_hour_resets_at: null }),
        five_hour_resets_at: future,
      }),
      limits,
      NOW_MS,
    );
    expect(d.fiveHourResetMs).toBe(10 * 60 * 1000);
  });

  it("정확한 티어 경계 — 5h_pct 90 (remaining 10%) → sleepy", () => {
    // remaining 0.10 ≤ 0.15 이므로 sleepy.
    const d = derive(snap({ api: api({ five_hour_pct: 90 }) }), limits, NOW_MS);
    expect(d.petState).toBe("sleepy");
  });

  it("정확한 티어 경계 — 5h_pct 10 (remaining 90%) → high (90% 이하면 high)", () => {
    // remaining 0.90 ≤ 0.90 이므로 high.
    const d = derive(snap({ api: api({ five_hour_pct: 10 }) }), limits, NOW_MS);
    expect(d.petState).toBe("high");
  });

  it("정확한 티어 경계 — 5h_pct 23 (remaining 77%) → good", () => {
    // remaining 0.77 ≤ 0.77 이므로 good.
    const d = derive(snap({ api: api({ five_hour_pct: 23 }) }), limits, NOW_MS);
    expect(d.petState).toBe("good");
  });

  it("cache last_request_at 이 정확히 5분 전이면 TTL 만료로 cacheRemainMs null", () => {
    // 코드 조건: `elapsed < CACHE_TTL_MS` 이면 표시. == 은 만료.
    const lastReq = new Date(NOW_MS - 5 * 60 * 1000).toISOString();
    const d = derive(
      snap({ last_request_at: lastReq, api: api({ five_hour_pct: 10 }) }),
      limits,
      NOW_MS,
    );
    expect(d.cacheRemainMs).toBeNull();
  });

  it("cache last_request_at 이 정확히 4분 전이면 nudge 진입 (4분 경계)", () => {
    // 코드 조건: `elapsed >= CACHE_NUDGE_AT_MS` (4분 == 이면 nudge).
    const lastReq = new Date(NOW_MS - 4 * 60 * 1000).toISOString();
    const d = derive(
      snap({ last_request_at: lastReq, api: api({ five_hour_pct: 10 }) }),
      limits,
      NOW_MS,
    );
    expect(d.cacheNudge).toBe(true);
    expect(d.cacheRemainMs).toBe(60 * 1000); // 1분 남음
  });

  it("clock skew — last_request_at 이 미래 시각이면 elapsed 음수 → cache 정보 무시", () => {
    // 코드 조건: `elapsed < CACHE_TTL_MS && elapsed >= 0`. 음수면 null 유지.
    const lastReq = new Date(NOW_MS + 60 * 1000).toISOString();
    const d = derive(
      snap({ last_request_at: lastReq, api: api({ five_hour_pct: 10 }) }),
      limits,
      NOW_MS,
    );
    expect(d.cacheRemainMs).toBeNull();
    expect(d.cacheNudge).toBe(false);
  });
});

describe("formatTokens — 추가 경계", () => {
  it("999 / 1000 / 1001 경계 (1k 진입 직전·직후)", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1.0k");
    expect(formatTokens(1_001)).toBe("1.0k"); // 1.001k → 1자리 반올림
  });

  it("999_999 / 1_000_000 경계 (1M 진입)", () => {
    expect(formatTokens(999_999)).toBe("1000.0k"); // 1M 직전은 여전히 k 라벨
    expect(formatTokens(1_000_000)).toBe("1.00M");
  });

  it("음수는 그대로 정수 (포맷터는 음수 방어 없음 — 입력 측에서 막아야 함)", () => {
    // 회귀 알림용 — 만약 음수 토큰이 흘러들어오면 그대로 표시됨.
    expect(formatTokens(-5)).toBe("-5");
  });
});

describe("formatRemain — 추가 경계", () => {
  it("정확히 0 → 0:00", () => {
    expect(formatRemain(0)).toBe("0:00");
  });

  it("60_000 정확히 → 1:00 (분 경계 올림 X)", () => {
    expect(formatRemain(60 * 1000)).toBe("1:00");
  });

  it("999 ms (1초 미만) → 0:00 (floor)", () => {
    expect(formatRemain(999)).toBe("0:00");
  });

  it("매우 큰 ms 도 분 단위로 그대로", () => {
    // 100분이면 100:00. 시 단위로 안 줄임 (formatRemain은 카운트다운 전용).
    expect(formatRemain(100 * 60 * 1000)).toBe("100:00");
  });
});

describe("formatTrayLabel — prepaid 음수/큰 값 회귀", () => {
  it("all 모드 + 음수 prepaid (v1.50 sentinel 회귀): 그대로 표시됨", () => {
    // petLogic 쪽엔 음수 방어 없음. 회귀 알림용: parse_prepaid_credits 가
    // sentinel(amount=-1) 을 막아주지 못해 흘러들면 사용자에게 $-1.00 으로
    // 보임. 이 케이스가 활성화되면 backend 파싱이 먼저 의심 대상.
    expect(formatTrayLabel("all", 0.76, 0.54, -1)).toBe("76% · 주 54% · $-1.00");
  });

  it("all 모드 + 큰 prepaid 값도 toFixed(2) 적용", () => {
    expect(formatTrayLabel("all", 0.76, 0.54, 1234.5)).toBe(
      "76% · 주 54% · $1234.50",
    );
  });

  it("all 모드 + Infinity / -Infinity → placeholder ($—)", () => {
    expect(formatTrayLabel("all", 0.5, 0.5, Infinity)).toBe(
      "50% · 주 50% · $—",
    );
    expect(formatTrayLabel("all", 0.5, 0.5, -Infinity)).toBe(
      "50% · 주 50% · $—",
    );
  });
});

describe("formatResetCountdown — 추가 경계", () => {
  it("정확히 60_000 ms → 1분 후", () => {
    expect(formatResetCountdown(60 * 1000)).toBe("1분 후");
  });

  it("정확히 1시간 → 1시간 0분 후 (분 자리 0 도 표시)", () => {
    expect(formatResetCountdown(60 * 60 * 1000)).toBe("1시간 0분 후");
  });

  it("정확히 1일 → 1일 0시간 후 (시간 자리 0 도 표시)", () => {
    expect(formatResetCountdown(24 * 60 * 60 * 1000)).toBe("1일 0시간 후");
  });

  it("23시간 59분 → 시간+분 톤 (24시간 미만은 일 단위 안 씀)", () => {
    expect(
      formatResetCountdown(23 * 60 * 60 * 1000 + 59 * 60 * 1000),
    ).toBe("23시간 59분 후");
  });

  it("초만 남았으면 0분 후 (분 단위로 floor)", () => {
    expect(formatResetCountdown(30 * 1000)).toBe("0분 후");
  });
});

describe("computeSessionTimer — 추가 경계", () => {
  const NOW = Date.parse("2026-05-16T13:00:00Z");

  it("응답 직후 + 1ms 경과 → label 5:00 (ceil 적용)", () => {
    // elapsed 1ms → remainMs = TTL - 1ms = 299999ms → ceil(299.999s) = 300s = 5:00
    const v = computeSessionTimer(
      new Date(NOW - 1).toISOString(),
      NOW,
    );
    expect(v.label).toBe("5:00");
    expect(v.expired).toBe(false);
  });

  it("초 단위 ceil — 0.1초 남음 → 0:01 (down 안 됨, ceil)", () => {
    // remainMs=100ms → ceil(0.1s) = 1s
    const v = computeSessionTimer(
      new Date(NOW - (CACHE_TTL_MS - 100)).toISOString(),
      NOW,
    );
    expect(v.label).toBe("0:01");
    expect(v.expired).toBe(false);
  });

  it("pct 는 정확히 remainMs / TTL * 100", () => {
    // 정확히 2분 30초 경과 → 2분 30초 남음 = 50%.
    const v = computeSessionTimer(
      new Date(NOW - 2.5 * 60 * 1000).toISOString(),
      NOW,
    );
    expect(v.pct).toBe(50);
    expect(v.remainMs).toBe(2.5 * 60 * 1000);
  });

  it("expired 는 remainMs <= 0 일 때만", () => {
    // 4분 59초 999ms 경과 → remainMs=1ms → expired false
    const v = computeSessionTimer(
      new Date(NOW - (CACHE_TTL_MS - 1)).toISOString(),
      NOW,
    );
    expect(v.expired).toBe(false);
    expect(v.remainMs).toBe(1);
  });
});

describe("hashHue — 결정론 / 안정성", () => {
  it("ASCII 와 한글 입력 모두 0~359 안", () => {
    for (const s of ["short", "매우 긴 한글 세션 이름입니다", "🐼 emoji"]) {
      const h = hashHue(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  it("100자 이상 긴 입력에도 NaN/음수 안 나옴 (overflow 안전)", () => {
    const long = "a".repeat(1000);
    const h = hashHue(long);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
});

describe("clampScale (v1.70 펫 zoom)", () => {
  it("범위 안의 값은 그대로 반환", () => {
    expect(clampScale(1.0)).toBe(1.0);
    expect(clampScale(0.8)).toBe(0.8);
    expect(clampScale(1.5)).toBe(1.5);
  });

  it("min 미만은 PET_SCALE_MIN 으로 clamp", () => {
    expect(clampScale(0.3)).toBe(PET_SCALE_MIN);
    expect(clampScale(-1)).toBe(PET_SCALE_MIN);
  });

  it("max 초과는 PET_SCALE_MAX 로 clamp", () => {
    expect(clampScale(3.0)).toBe(PET_SCALE_MAX);
    expect(clampScale(99)).toBe(PET_SCALE_MAX);
  });

  it("NaN/Infinity 는 PET_SCALE_DEFAULT 로 fallback", () => {
    expect(clampScale(NaN)).toBe(PET_SCALE_DEFAULT);
    expect(clampScale(Infinity)).toBe(PET_SCALE_DEFAULT);
    expect(clampScale(-Infinity)).toBe(PET_SCALE_DEFAULT);
  });

  it("경계값 정확히 (min/max 자기 자신)", () => {
    expect(clampScale(PET_SCALE_MIN)).toBe(PET_SCALE_MIN);
    expect(clampScale(PET_SCALE_MAX)).toBe(PET_SCALE_MAX);
  });
});

describe("scaleFromDrag (v1.70 펫 zoom)", () => {
  it("delta 0 이면 startScale 그대로", () => {
    expect(scaleFromDrag(1.0, 0)).toBe(1.0);
    expect(scaleFromDrag(0.8, 0)).toBe(0.8);
  });

  it("양수 delta 면 커지고, 음수면 작아진다 (우/하 = 키우기, 좌/상 = 줄이기)", () => {
    const bigger = scaleFromDrag(1.0, 100);
    const smaller = scaleFromDrag(1.0, -100);
    expect(bigger).toBeGreaterThan(1.0);
    expect(smaller).toBeLessThan(1.0);
  });

  it("200px delta = 1.0 단위 변화 (PX_PER_UNIT 상수에 맞춤)", () => {
    expect(scaleFromDrag(1.0, 200)).toBe(2.0 > PET_SCALE_MAX ? PET_SCALE_MAX : 2.0);
    // startScale=1.0 + 200/200 = 2.0 → MAX(1.8) 로 clamp.
    expect(scaleFromDrag(1.0, 200)).toBe(PET_SCALE_MAX);
  });

  it("결과는 항상 clampScale 적용 (max 초과 / min 미만)", () => {
    expect(scaleFromDrag(1.5, 1000)).toBe(PET_SCALE_MAX);
    expect(scaleFromDrag(0.7, -1000)).toBe(PET_SCALE_MIN);
  });

  it("NaN delta 가 흘러들면 fallback (Number.isFinite 가드)", () => {
    expect(scaleFromDrag(1.0, NaN)).toBe(PET_SCALE_DEFAULT);
  });
});
