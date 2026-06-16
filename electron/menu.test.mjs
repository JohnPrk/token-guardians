// menu.cjs 단일 레지스트리의 순수 선택 로직 안전망. 트레이 출력이 종전 항목
// 집합/순서를 유지하는지 + 우클릭 메뉴(pet)의 토글·조건부·구분선 collapse·빈
// 메뉴 폴백을 검증한다. (Electron 비의존 순수 모듈이라 IO 없이 단위 검증)

import { describe, it, expect } from "vitest";
import menu from "./menu.cjs";

const { selectMenuItems, listToggleableItems, collapseSeparators } = menu;

const ids = (items) => items.map((it) => it.id);
const kinds = (items) => items.map((it) => it.kind);

describe("selectMenuItems — tray surface", () => {
  it("업데이트/계정 없을 때: 헤더+기본 항목 (install·switchAccount 제외)", () => {
    const r = selectMenuItems({ surface: "tray", ctx: {} });
    expect(ids(r)).toEqual([
      "header", "sep1", "showHide", "refresh", "trayMode",
      "monthlyUsage", "sep2", "settings", "changelog", "quit",
    ]);
  });

  it("업데이트+계정 있을 때: install·switchAccount 포함한 전체", () => {
    const r = selectMenuItems({
      surface: "tray",
      ctx: { hasUpdate: true, hasAccounts: true },
    });
    expect(ids(r)).toEqual([
      "header", "install", "sep1", "showHide", "refresh", "trayMode",
      "switchAccount", "monthlyUsage", "sep2", "settings", "changelog", "quit",
    ]);
  });

  it("트레이는 토글을 무시한다 (off 여도 전부 노출)", () => {
    const r = selectMenuItems({
      surface: "tray",
      toggles: { refresh: false, settings: false },
      ctx: {},
    });
    expect(ids(r)).toContain("refresh");
    expect(ids(r)).toContain("settings");
  });
});

describe("selectMenuItems — pet surface", () => {
  it("기본(토글 없음): 헤더 제외 + 선행 구분선 collapse", () => {
    const r = selectMenuItems({ surface: "pet", ctx: {} });
    expect(ids(r)).toEqual([
      "showHide", "refresh", "trayMode",
      "monthlyUsage", "sep2", "settings", "changelog", "quit",
    ]);
    expect(ids(r)).not.toContain("header");
  });

  it("업데이트+계정 있을 때: switchAccount 는 기본 노출, install 은 기본 off", () => {
    const r = selectMenuItems({
      surface: "pet",
      ctx: { hasUpdate: true, hasAccounts: true },
    });
    expect(ids(r)).toContain("switchAccount"); // defaultOn 기본 true
    expect(ids(r)).not.toContain("install"); // install 은 defaultOn:false
  });

  it("install 은 토글 on + 업데이트 있을 때만 등장 (기본 off)", () => {
    // 토글을 켜도 업데이트 없으면 안 뜸(조건부)
    const noUpd = selectMenuItems({ surface: "pet", toggles: { install: true }, ctx: { hasUpdate: false } });
    expect(ids(noUpd)).not.toContain("install");
    // 토글 on + 업데이트 있으면 등장
    const on = selectMenuItems({ surface: "pet", toggles: { install: true }, ctx: { hasUpdate: true } });
    expect(ids(on)).toContain("install");
  });

  it("토글 off 항목은 빠진다 (트레이엔 영향 없음)", () => {
    const toggles = { showHide: false, refresh: false, trayMode: false, monthlyUsage: false };
    const r = selectMenuItems({ surface: "pet", toggles, ctx: {} });
    expect(ids(r)).toEqual(["settings", "changelog", "quit"]);
    // 같은 토글이어도 트레이는 그대로
    const tray = selectMenuItems({ surface: "tray", toggles, ctx: {} });
    expect(ids(tray)).toContain("refresh");
  });

  it("모든 항목 off → 빈 메뉴 대신 settings 폴백", () => {
    const allOff = {};
    for (const it of listToggleableItems()) allOff[it.id] = false;
    const r = selectMenuItems({ surface: "pet", toggles: allOff, ctx: {} });
    expect(ids(r)).toEqual(["settings"]);
  });

  it("연속/후행 구분선이 남지 않는다", () => {
    const r = selectMenuItems({ surface: "pet", ctx: {} });
    // 끝이 separator 가 아니고, separator 가 연달아 오지 않음
    expect(r[r.length - 1].kind).not.toBe("separator");
    for (let i = 1; i < r.length; i++) {
      expect(r[i].kind === "separator" && r[i - 1].kind === "separator").toBe(false);
    }
  });
});

describe("collapseSeparators", () => {
  it("선행·후행·연속 separator 제거", () => {
    const input = [
      { kind: "separator", id: "s0" },
      { kind: "item", id: "a" },
      { kind: "separator", id: "s1" },
      { kind: "separator", id: "s2" },
      { kind: "item", id: "b" },
      { kind: "separator", id: "s3" },
    ];
    const r = collapseSeparators(input);
    expect(kinds(r)).toEqual(["item", "separator", "item"]);
    expect(ids(r)).toEqual(["a", "s1", "b"]);
  });

  it("전부 separator 면 빈 배열", () => {
    const r = collapseSeparators([{ kind: "separator" }, { kind: "separator" }]);
    expect(r).toEqual([]);
  });
});

describe("listToggleableItems — 설정 아코디언 메타데이터", () => {
  it("toggleable 항목만, 메뉴 순서대로", () => {
    const items = listToggleableItems();
    expect(ids(items)).toEqual([
      "install", "showHide", "refresh", "trayMode", "switchAccount",
      "monthlyUsage", "settings", "changelog", "quit",
    ]);
  });

  it("조건부 항목엔 힌트, 일반 항목엔 null", () => {
    const byId = Object.fromEntries(listToggleableItems().map((i) => [i.id, i]));
    expect(byId.install.conditionalHint).toBe("업데이트가 있을 때만");
    expect(byId.switchAccount.conditionalHint).toBe("계정이 2개 이상일 때만");
    expect(byId.showHide.conditionalHint).toBeNull();
  });

  it("모든 항목에 settingsLabel 이 있다", () => {
    for (const it of listToggleableItems()) {
      expect(typeof it.settingsLabel).toBe("string");
      expect(it.settingsLabel.length).toBeGreaterThan(0);
    }
  });

  it("install 만 defaultOn:false, 나머지는 true", () => {
    const byId = Object.fromEntries(listToggleableItems().map((i) => [i.id, i]));
    expect(byId.install.defaultOn).toBe(false);
    for (const it of listToggleableItems()) {
      if (it.id !== "install") expect(it.defaultOn).toBe(true);
    }
  });
});
