import { describe, it, expect } from "vitest";
import { buildAccountsConfigFromLegacy, cryptoRandomId } from "./store";
import type { AccountsConfig, ApiConfig, PlanConfig } from "./types";

const fixedId = () => "id-fixed-1";

describe("buildAccountsConfigFromLegacy", () => {
  it("이미 accounts_config가 있으면 그대로 반환 + needsWrite=false", () => {
    const existing: AccountsConfig = {
      accounts: [
        { id: "a1", label: "A", orgId: "o", cookie: "c", skinId: "panda" },
      ],
      activeAccountId: "a1",
    };
    const { config, needsWrite } = buildAccountsConfigFromLegacy(
      existing,
      null,
      null,
      fixedId,
    );
    expect(config).toBe(existing);
    expect(needsWrite).toBe(false);
  });

  it("existing 없고 legacy ApiConfig만 있으면 단일 계정으로 변환 + needsWrite=true", () => {
    const oldApi: ApiConfig = { orgId: "org-X", cookie: "cookie-Y" };
    const { config, needsWrite } = buildAccountsConfigFromLegacy(
      null,
      oldApi,
      null,
      fixedId,
    );
    expect(needsWrite).toBe(true);
    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0]).toEqual({
      id: "id-fixed-1",
      label: "메인 계정",
      orgId: "org-X",
      cookie: "cookie-Y",
      skinId: "panda",
    });
    expect(config.activeAccountId).toBe("id-fixed-1");
  });

  it("legacy ApiConfig + PlanConfig.skin 있으면 그 skin이 첫 계정에 적용", () => {
    const oldApi: ApiConfig = { orgId: "o", cookie: "c" };
    const oldPlan: PlanConfig = {
      plan: "pro",
      limits: { fiveHour: 1, weekly: 7 },
      skin: "cat",
    };
    const { config } = buildAccountsConfigFromLegacy(
      null,
      oldApi,
      oldPlan,
      fixedId,
    );
    expect(config.accounts[0].skinId).toBe("cat");
  });

  it("oldApi.orgId 또는 cookie가 비어 있으면 변환 안 함 (빈 묶음 반환)", () => {
    const partial: ApiConfig = { orgId: "", cookie: "c" };
    const { config, needsWrite } = buildAccountsConfigFromLegacy(
      null,
      partial,
      null,
      fixedId,
    );
    expect(needsWrite).toBe(false);
    expect(config).toEqual({ accounts: [], activeAccountId: null });
  });

  it("아무 데이터도 없으면 빈 묶음 + needsWrite=false (첫 실행 케이스)", () => {
    const { config, needsWrite } = buildAccountsConfigFromLegacy(
      null,
      null,
      null,
      fixedId,
    );
    expect(needsWrite).toBe(false);
    expect(config).toEqual({ accounts: [], activeAccountId: null });
  });

  it("existing.accounts가 배열이 아니면 (corrupt) legacy 경로로 fallthrough", () => {
    // Tauri store에 손상된 값이 들어 있을 때. legacy 경로로 빠진 다음 oldApi
    // 있으면 변환, 없으면 빈 묶음.
    const corrupt = { accounts: "not an array" } as unknown as AccountsConfig;
    const oldApi: ApiConfig = { orgId: "o", cookie: "c" };
    const { config, needsWrite } = buildAccountsConfigFromLegacy(
      corrupt,
      oldApi,
      null,
      fixedId,
    );
    expect(needsWrite).toBe(true);
    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0].orgId).toBe("o");
  });

  // ===== 추가 회귀 케이스 (v1.51 테스트 커버리지 보강) =====

  it("existing.accounts 가 빈 배열이어도 그대로 반환 (계정 0개 상태 보존)", () => {
    // 사용자가 모든 계정을 삭제한 상태. 빈 배열을 legacy 로 떠넘기지 말아야 함.
    const existing: AccountsConfig = { accounts: [], activeAccountId: null };
    const { config, needsWrite } = buildAccountsConfigFromLegacy(
      existing,
      { orgId: "o", cookie: "c" }, // legacy 가 있어도 existing 우선
      null,
      fixedId,
    );
    expect(config).toBe(existing);
    expect(needsWrite).toBe(false);
  });

  it("existing.accounts 가 1+ 인데 activeAccountId 가 null 이어도 보존", () => {
    // legacy 자동 변환 직후 activeAccountId 가 비어 있는 transient 상태도 있을 수 있음.
    // 그래도 existing.accounts 가 배열이면 그대로 반환.
    const existing: AccountsConfig = {
      accounts: [
        { id: "a1", label: "A", orgId: "o", cookie: "c", skinId: "panda" },
      ],
      activeAccountId: null,
    };
    const { config, needsWrite } = buildAccountsConfigFromLegacy(
      existing,
      null,
      null,
      fixedId,
    );
    expect(config).toBe(existing);
    expect(needsWrite).toBe(false);
  });

  it("oldApi.cookie 만 비어 있어도 변환 안 함", () => {
    const partial: ApiConfig = { orgId: "o", cookie: "" };
    const { config, needsWrite } = buildAccountsConfigFromLegacy(
      null,
      partial,
      null,
      fixedId,
    );
    expect(needsWrite).toBe(false);
    expect(config.accounts).toEqual([]);
  });

  it("oldPlan 만 있고 oldApi 없으면 변환 안 함 (자격증명 없으면 의미 없음)", () => {
    const oldPlan: PlanConfig = {
      plan: "pro",
      limits: { fiveHour: 1, weekly: 7 },
      skin: "cat",
    };
    const { config, needsWrite } = buildAccountsConfigFromLegacy(
      null,
      null,
      oldPlan,
      fixedId,
    );
    expect(needsWrite).toBe(false);
    expect(config.accounts).toEqual([]);
    expect(config.activeAccountId).toBeNull();
  });

  it("oldPlan.skin 이 없으면 첫 계정 skinId 는 'panda' 기본값", () => {
    const oldApi: ApiConfig = { orgId: "o", cookie: "c" };
    const oldPlan: PlanConfig = {
      plan: "pro",
      limits: { fiveHour: 1, weekly: 7 },
      // skin 필드 누락
    } as PlanConfig;
    const { config } = buildAccountsConfigFromLegacy(
      null,
      oldApi,
      oldPlan,
      fixedId,
    );
    expect(config.accounts[0].skinId).toBe("panda");
  });

  it("activeAccountId 는 첫 계정 id 와 일치 (idGen 한 번만 호출)", () => {
    let count = 0;
    const counter = () => {
      count += 1;
      return `id-${count}`;
    };
    const oldApi: ApiConfig = { orgId: "o", cookie: "c" };
    const { config } = buildAccountsConfigFromLegacy(null, oldApi, null, counter);
    expect(count).toBe(1);
    expect(config.activeAccountId).toBe("id-1");
    expect(config.accounts[0].id).toBe("id-1");
  });
});

describe("cryptoRandomId", () => {
  it("반환된 id 는 비어 있지 않은 문자열", () => {
    const id = cryptoRandomId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("연달아 호출해도 거의 항상 다른 id (충돌 확률 극히 낮음)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      ids.add(cryptoRandomId());
    }
    // 50개 모두 distinct 여야 함. (Math.random 폴백이라도 충분히 안전)
    expect(ids.size).toBe(50);
  });
});
