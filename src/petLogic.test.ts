import { describe, it, expect } from "vitest";
import { derive } from "./petLogic";
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
});
