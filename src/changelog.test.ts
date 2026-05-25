import { describe, it, expect } from "vitest";
import {
  CHANGELOG,
  parseVer,
  isNewerVer,
  entriesNewerThan,
  type ChangelogEntry,
} from "./changelog";

describe("parseVer", () => {
  it("3 segment", () => expect(parseVer("1.2.3")).toEqual([1, 2, 3]));
  it("2 segment → patch 0", () => expect(parseVer("2.15")).toEqual([2, 15, 0]));
  it("leading v 제거", () => expect(parseVer("v2.16.0")).toEqual([2, 16, 0]));
  it("1 segment 거부", () => expect(parseVer("3")).toBeNull());
  it("4 segment 거부", () => expect(parseVer("1.2.3.4")).toBeNull());
  it("비숫자 거부", () => expect(parseVer("1.x.0")).toBeNull());
  it("null 입력", () => expect(parseVer(null)).toBeNull());
  it("undefined 입력", () => expect(parseVer(undefined)).toBeNull());
});

describe("isNewerVer (candidate > base)", () => {
  it("major 상승", () => expect(isNewerVer("1.99.0", "2.0.0")).toBe(true));
  it("minor 상승", () => expect(isNewerVer("2.15.0", "2.16.0")).toBe(true));
  it("patch 상승", () => expect(isNewerVer("2.16.0", "2.16.1")).toBe(true));
  it("동일 버전은 false", () => expect(isNewerVer("2.16.0", "2.16.0")).toBe(false));
  it("더 낮은 버전은 false", () => expect(isNewerVer("2.16.0", "2.15.0")).toBe(false));
  it("2-seg vs 3-seg 비교", () => expect(isNewerVer("2.16", "2.16.0")).toBe(false));
  it("파싱 실패는 false", () => expect(isNewerVer("bad", "2.16.0")).toBe(false));
  it("null base 는 false", () => expect(isNewerVer(null, "2.16.0")).toBe(false));
});

describe("entriesNewerThan", () => {
  const entries: ChangelogEntry[] = [
    { version: "2.15.0", date: "d", title: "t", body: "b" },
    { version: "2.12.0", date: "d", title: "t", body: "b" },
    { version: "1.85.0", date: "d", title: "t", body: "b" },
  ];

  it("since 이후 항목만, 최신순 보존", () => {
    const r = entriesNewerThan(entries, "2.00.0");
    expect(r.map((e) => e.version)).toEqual(["2.15.0", "2.12.0"]);
  });

  it("since 가 최신과 같으면 빈 배열", () => {
    expect(entriesNewerThan(entries, "2.15.0")).toEqual([]);
  });

  it("since 가 가장 오래된 것보다 낮으면 전체", () => {
    expect(entriesNewerThan(entries, "1.00.0")).toHaveLength(3);
  });

  it("since null 이면 전체", () => {
    expect(entriesNewerThan(entries, null)).toHaveLength(3);
  });

  it("since 빈 문자열이면 전체", () => {
    expect(entriesNewerThan(entries, "")).toHaveLength(3);
  });
});

describe("CHANGELOG 데이터 무결성", () => {
  it("모든 항목의 version 이 파싱 가능", () => {
    for (const e of CHANGELOG) expect(parseVer(e.version)).not.toBeNull();
  });

  it("최신순으로 정렬되어 있음(맨 앞이 가장 최신)", () => {
    for (let i = 1; i < CHANGELOG.length; i++) {
      expect(isNewerVer(CHANGELOG[i].version, CHANGELOG[i - 1].version)).toBe(true);
    }
  });

  it("모든 항목에 제목과 본문이 있음", () => {
    for (const e of CHANGELOG) {
      expect(e.title.trim().length).toBeGreaterThan(0);
      expect(e.body.trim().length).toBeGreaterThan(0);
    }
  });
});
