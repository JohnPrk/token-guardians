import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  currentMonthRange,
  aggregateCostsByKey,
  centsToDollars,
  buildKeyCostRows,
  extractApiOrgId,
} = require("./claudeCosts.cjs");

describe("currentMonthRange", () => {
  it("그 달 1일과 다음 달 1일을 반환한다", () => {
    const r = currentMonthRange(new Date(2026, 5, 14)); // 2026-06-14 (로컬)
    expect(r.starting_on).toBe("2026-06-01");
    expect(r.ending_before).toBe("2026-07-01");
    expect(r.month).toBe("2026-06");
  });

  it("12월은 다음 해 1월로 롤오버한다", () => {
    const r = currentMonthRange(new Date(2026, 11, 31)); // 2026-12-31
    expect(r.starting_on).toBe("2026-12-01");
    expect(r.ending_before).toBe("2027-01-01");
    expect(r.month).toBe("2026-12");
  });

  it("한 자리 월을 0으로 패딩한다", () => {
    const r = currentMonthRange(new Date(2026, 0, 5)); // 2026-01-05
    expect(r.starting_on).toBe("2026-01-01");
    expect(r.ending_before).toBe("2026-02-01");
  });
});

describe("aggregateCostsByKey", () => {
  it("같은 키의 여러 라인아이템 total 을 합산한다", () => {
    const usageCost = {
      costs: {
        "2026-06-01": [
          { key_id: "apikey_A", total: 34.773 },
          { key_id: "apikey_A", total: 18.315 },
          { key_id: "apikey_B", total: 6.011 },
        ],
      },
    };
    const agg = aggregateCostsByKey(usageCost);
    expect(agg.apikey_A).toBeCloseTo(53.088, 3);
    expect(agg.apikey_B).toBeCloseTo(6.011, 3);
  });

  it("여러 날짜와 여러 카테고리를 가로질러 합산한다", () => {
    const usageCost = {
      costs: {
        "2026-06-01": [{ key_id: "apikey_A", total: 10 }],
        "2026-06-02": [{ key_id: "apikey_A", total: 5 }],
      },
      web_search_costs: {
        "2026-06-01": [{ key_id: "apikey_A", total: 2 }],
      },
      code_execution_costs: {
        "2026-06-01": [{ key_id: "apikey_A", total: 3 }],
      },
    };
    const agg = aggregateCostsByKey(usageCost);
    expect(agg.apikey_A).toBeCloseTo(20, 6);
  });

  it("claude_code_savings 는 합산에서 제외한다(콘솔 비용 컬럼과 일치)", () => {
    const usageCost = {
      costs: { "2026-06-01": [{ key_id: "apikey_A", total: 10 }] },
      claude_code_savings: { "2026-06-01": [{ key_id: "apikey_A", total: 999 }] },
    };
    const agg = aggregateCostsByKey(usageCost);
    expect(agg.apikey_A).toBeCloseTo(10, 6);
  });

  it("key_id 가 없으면 (unknown) 버킷으로 모은다", () => {
    const usageCost = { costs: { "2026-06-01": [{ total: 7 }] } };
    const agg = aggregateCostsByKey(usageCost);
    expect(agg["(unknown)"]).toBeCloseTo(7, 6);
  });

  it("total 이 숫자가 아니거나 모양이 어긋나면 무시한다", () => {
    const usageCost = {
      costs: {
        "2026-06-01": [
          { key_id: "apikey_A", total: "oops" },
          null,
          { key_id: "apikey_A", total: 4 },
        ],
        "2026-06-02": "not-an-array",
      },
      bogus_category: { "2026-06-01": [{ key_id: "apikey_A", total: 100 }] },
    };
    const agg = aggregateCostsByKey(usageCost);
    expect(agg.apikey_A).toBeCloseTo(4, 6); // bogus_category 는 카테고리 화이트리스트 밖
  });

  it("null/비객체 입력은 빈 객체를 반환한다", () => {
    expect(aggregateCostsByKey(null)).toEqual({});
    expect(aggregateCostsByKey(undefined)).toEqual({});
    expect(aggregateCostsByKey(42)).toEqual({});
  });
});

describe("centsToDollars", () => {
  it("센트를 달러 둘째자리로 변환한다", () => {
    expect(centsToDollars(178.268)).toBe(1.78);
    expect(centsToDollars(53.088)).toBe(0.53);
    expect(centsToDollars(2.438)).toBe(0.02);
    expect(centsToDollars(0)).toBe(0);
  });

  it("숫자가 아니면 0", () => {
    expect(centsToDollars("x")).toBe(0);
    expect(centsToDollars(NaN)).toBe(0);
  });
});

describe("buildKeyCostRows", () => {
  const apiKeys = [
    { id: "apikey_A", name: "IQ 피노", partial_key_hint: "sk-ant-api03-aaa...AAA" },
    { id: "apikey_B", name: "IQ 토리", partial_key_hint: "sk-ant-api03-bbb...BBB" },
  ];

  it("키 이름을 조인하고 달러 내림차순으로 정렬한다", () => {
    const agg = { apikey_B: 6.011, apikey_A: 178.268 };
    const { keys, total_dollars } = buildKeyCostRows(agg, apiKeys);
    expect(keys.map((k) => k.id)).toEqual(["apikey_A", "apikey_B"]);
    expect(keys[0]).toMatchObject({ name: "IQ 피노", dollars: 1.78 });
    expect(keys[1]).toMatchObject({ name: "IQ 토리", dollars: 0.06 });
    expect(total_dollars).toBe(1.84); // (178.268+6.011)/100 = 1.84279 → 1.84
  });

  it("총합은 개별 반올림이 아닌 센트 합산 후 반올림이다", () => {
    // 0.4 + 0.4 = 0.8센트 → 개별 반올림이면 0.00+0.00=0.00, 합산 후면 0.008→0.01
    const agg = { apikey_A: 0.4, apikey_B: 0.4 };
    const { total_dollars } = buildKeyCostRows(agg, apiKeys);
    expect(total_dollars).toBe(0.01);
  });

  it("목록에 없는 key_id 는 폴백 이름과 null 힌트로 표시한다", () => {
    const agg = { console: 0.205, apikey_A: 10 };
    const { keys } = buildKeyCostRows(agg, apiKeys);
    const consoleRow = keys.find((k) => k.id === "console");
    expect(consoleRow.name).toBe("콘솔 직접 사용");
    expect(consoleRow.partial_key_hint).toBeNull();
  });

  it("api_keys 가 null 이어도 동작한다(이름 조인 실패 허용)", () => {
    const agg = { apikey_A: 100 };
    const { keys, total_dollars } = buildKeyCostRows(agg, null);
    expect(keys[0]).toMatchObject({ id: "apikey_A", name: "apikey_A", dollars: 1 });
    expect(total_dollars).toBe(1);
  });

  it("빈 집계는 빈 rows + 0 총합", () => {
    const { keys, total_dollars } = buildKeyCostRows({}, apiKeys);
    expect(keys).toEqual([]);
    expect(total_dollars).toBe(0);
  });
});

describe("extractApiOrgId", () => {
  // 실제 응답 모양: 구독 org(chat/claude_max) + 콘솔 org(api/api_individual) 혼재.
  const orgs = [
    {
      id: "id-sub",
      uuid: "uuid-subscription-212435",
      capabilities: ["claude_max", "chat"],
    },
    {
      id: "id-api",
      uuid: "3894e93b-0937-4a05-8f8c-fdbdeff95079",
      capabilities: ["api", "api_individual"],
    },
  ];

  it("capability 에 api 가 있는 조직의 uuid 를 고른다", () => {
    expect(extractApiOrgId(orgs)).toBe("3894e93b-0937-4a05-8f8c-fdbdeff95079");
  });

  it("순서가 바뀌어도 api 조직을 고른다", () => {
    expect(extractApiOrgId([orgs[1], orgs[0]])).toBe(
      "3894e93b-0937-4a05-8f8c-fdbdeff95079",
    );
  });

  it("capabilities 가 객체 형태여도 키로 판단한다", () => {
    const objCaps = [{ uuid: "u-api", capabilities: { api: true, claude_code: true } }];
    expect(extractApiOrgId(objCaps)).toBe("u-api");
  });

  it("uuid 가 없으면 id 로 폴백한다", () => {
    const noUuid = [{ id: "id-only", capabilities: ["api"] }];
    expect(extractApiOrgId(noUuid)).toBe("id-only");
  });

  it("api 조직이 없으면 null", () => {
    const noApi = [{ uuid: "u1", capabilities: ["chat"] }];
    expect(extractApiOrgId(noApi)).toBeNull();
  });

  it("배열이 아니면 null", () => {
    expect(extractApiOrgId(null)).toBeNull();
    expect(extractApiOrgId({})).toBeNull();
  });
});
