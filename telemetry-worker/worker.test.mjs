// 대시보드 파생 지표의 순수 부분 단위 테스트.
// SQL(집계)·DOM(렌더)은 실 D1 + 대시보드 렌더로 검증하고, 여기선 날짜 산술 /
// 빈틈 채움 / 구간화 / 리텐션 적격성 같은 off-by-one 나기 쉬운 로직만 고정한다.
import { describe, it, expect } from "vitest";
import {
  dateAdd,
  pct,
  fillDays,
  bucketActiveDays,
  markCohorts,
  overallRetention,
  publicStatsFromAggregates,
  rollupVersionByDay,
} from "./src/worker.js";

describe("dateAdd", () => {
  it("더하고 뺀다", () => {
    expect(dateAdd("2026-06-16", 7)).toBe("2026-06-23");
    expect(dateAdd("2026-06-16", -1)).toBe("2026-06-15");
    expect(dateAdd("2026-06-16", 0)).toBe("2026-06-16");
  });
  it("월/년 경계를 넘는다", () => {
    expect(dateAdd("2026-06-30", 1)).toBe("2026-07-01");
    expect(dateAdd("2026-07-01", -1)).toBe("2026-06-30");
    expect(dateAdd("2026-12-31", 1)).toBe("2027-01-01");
    expect(dateAdd("2024-02-28", 1)).toBe("2024-02-29"); // 윤년
  });
});

describe("pct", () => {
  it("백분율 소수 1자리", () => {
    expect(pct(1, 4)).toBe(25);
    expect(pct(3, 3)).toBe(100);
    expect(pct(1, 3)).toBe(33.3);
  });
  it("분모 0 은 null", () => {
    expect(pct(0, 0)).toBeNull();
    expect(pct(5, 0)).toBeNull();
  });
});

describe("fillDays", () => {
  it("빈 날을 0 으로 채우고 순서를 유지한다", () => {
    const out = fillDays(
      [{ day: "2026-06-15", n: 1 }, { day: "2026-06-16", n: 3 }],
      "2026-06-14",
      "2026-06-16",
    );
    expect(out).toEqual([
      { day: "2026-06-14", n: 0 },
      { day: "2026-06-15", n: 1 },
      { day: "2026-06-16", n: 3 },
    ]);
  });
  it("입력이 없으면 전부 0", () => {
    const out = fillDays([], "2026-06-15", "2026-06-17");
    expect(out.map((x) => x.n)).toEqual([0, 0, 0]);
    expect(out).toHaveLength(3);
  });
  it("범위 밖 행은 무시(맵에 있어도 채움축에 없으면 안 들어감)", () => {
    const out = fillDays([{ day: "2026-01-01", n: 9 }], "2026-06-15", "2026-06-15");
    expect(out).toEqual([{ day: "2026-06-15", n: 0 }]);
  });
});

describe("bucketActiveDays", () => {
  it("활성일수를 구간으로 합산", () => {
    const out = bucketActiveDays([
      { active_days: 1, n: 3 },
      { active_days: 2, n: 1 },
      { active_days: 3, n: 1 },
      { active_days: 5, n: 2 },
      { active_days: 40, n: 1 },
    ]);
    const m = Object.fromEntries(out.map((r) => [r.label, r.n]));
    expect(m["1일"]).toBe(3);
    expect(m["2–3일"]).toBe(2);
    expect(m["4–7일"]).toBe(2);
    expect(m["8–14일"]).toBe(0);
    expect(m["31일+"]).toBe(1);
  });
  it("항상 6 구간을 반환(빈 입력도)", () => {
    expect(bucketActiveDays([])).toHaveLength(6);
    expect(bucketActiveDays(null)).toHaveLength(6);
  });
});

describe("markCohorts", () => {
  it("적격 플래그 + 코호트별 % 를 붙인다", () => {
    const out = markCohorts(
      [
        { cohort: "2026-06-01", size: 10, d1: 6, d7: 4 },
        { cohort: "2026-06-16", size: 5, d1: 0, d7: 0 },
      ],
      "2026-06-16",
    );
    expect(out[0]).toMatchObject({
      day: "2026-06-01", size: 10, d1_pct: 60, d7_pct: 40, eligible1: true, eligible7: true,
    });
    // 당일 코호트는 D1/D7 둘 다 아직 측정 불가
    expect(out[1].eligible1).toBe(false);
    expect(out[1].eligible7).toBe(false);
  });
});

describe("overallRetention", () => {
  const cohorts = [
    { cohort: "2026-06-01", size: 10, d1: 6, d7: 4 }, // 충분히 오래됨
    { cohort: "2026-06-14", size: 5, d1: 2, d7: 0 },  // D1 적격, D7 비적격
    { cohort: "2026-06-16", size: 3, d1: 0, d7: 0 },  // 당일, 둘 다 비적격
  ];
  it("D7 은 7일 지난 코호트만 합산", () => {
    // today-7 = 2026-06-09 → 06-01 코호트만 적격
    expect(overallRetention(cohorts, "2026-06-16", 7, "d7")).toBe(pct(4, 10));
  });
  it("D1 은 1일 지난 코호트만 합산", () => {
    // today-1 = 2026-06-15 → 06-01 + 06-14 적격, 06-16 제외
    expect(overallRetention(cohorts, "2026-06-16", 1, "d1")).toBe(pct(6 + 2, 10 + 5));
  });
  it("적격 코호트가 없으면 null", () => {
    expect(overallRetention([{ cohort: "2026-06-16", size: 3, d7: 0 }], "2026-06-16", 7, "d7")).toBeNull();
    expect(overallRetention([], "2026-06-16", 7, "d7")).toBeNull();
  });
});

describe("publicStatsFromAggregates", () => {
  it("랜딩 공개용 최소 필드만 만든다", () => {
    const out = publicStatsFromAggregates({
      generatedAt: "2026-06-17T06:00:00.000Z",
      todayStr: "2026-06-17",
      totalInstalls: 9,
      dau: 6,
      wau: 9,
      mau: 9,
      cohorts: [
        { cohort: "2026-06-15", size: 1, d1: 1, d7: 0 },
        { cohort: "2026-06-16", size: 8, d1: 5, d7: 0 },
      ],
    });

    expect(out).toEqual({
      generated_at: "2026-06-17T06:00:00.000Z",
      total_downloads: 9,
      total_installs: 9,
      active: { dau: 6, wau: 9, mau: 9 },
      retention: { d1_overall: 66.7, d7_overall: null },
    });
    expect(out).not.toHaveProperty("by_country");
    expect(out).not.toHaveProperty("by_version");
    expect(out).not.toHaveProperty("retention.cohorts");
  });
});

describe("rollupVersionByDay", () => {
  it("일별로 묶고 total 을 합산하며 날짜순 정렬", () => {
    const out = rollupVersionByDay([
      { day: "2026-06-16", version: "2.25.0", n: 2 },
      { day: "2026-06-15", version: "2.25.0", n: 1 },
      { day: "2026-06-16", version: "2.24.0", n: 1 },
    ]);
    expect(out.map((d) => d.day)).toEqual(["2026-06-15", "2026-06-16"]);
    const d16 = out.find((d) => d.day === "2026-06-16");
    expect(d16.total).toBe(3);
    expect(d16.segments).toHaveLength(2);
  });
  it("version 누락은 (미상) 으로", () => {
    const out = rollupVersionByDay([{ day: "2026-06-16", version: null, n: 1 }]);
    expect(out[0].segments[0].version).toBe("(미상)");
  });
});
