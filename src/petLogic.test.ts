import { describe, it, expect } from "vitest";
import {
  CACHE_TTL_MS,
  computeSessionTimer,
  derive,
  formatRemain,
  formatResetCountdown,
  formatTokens,
  formatTrayLabel,
  hashHue,
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
