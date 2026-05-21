// ============================================================================
// 🔒 FROZEN CONTRACT — DO NOT MODIFY FOR NEW FEATURES
// ----------------------------------------------------------------------------
// 이 파일의 케이스들은 v1.74.8 시점의 동작을 묶어둔 회귀 안전망이다. 새 기능을
// 추가하다 깨지면 *기능을 고쳐서* 통과시켜야지, 테스트를 손봐선 안 된다.
// 정당하게 기존 동작을 바꿔야 할 때만 PROGRESS.md 의 "테스트 정책" 항목 절차를
// 따라 명시적으로 업데이트한다. 새 분기/필드가 추가됐을 때 *추가* 케이스를
// 덧붙이는 건 자유.
// ============================================================================

import { describe, it, expect } from "vitest";
import updater from "./updater.cjs";
const { parseReleaseTag, isNewer, parseReleaseResponse, parseReleaseAssets } = updater;

describe("parseReleaseTag", () => {
  it("parses 3-segment tags with optional v prefix", () => {
    expect(parseReleaseTag("v1.24.0")).toEqual([1, 24, 0]);
    expect(parseReleaseTag("1.74.8")).toEqual([1, 74, 8]);
  });

  it("fills patch=0 for 2-segment tags", () => {
    expect(parseReleaseTag("v1.24")).toEqual([1, 24, 0]);
    expect(parseReleaseTag("2.0")).toEqual([2, 0, 0]);
  });

  it("rejects 1-segment and 4+ segment tags", () => {
    expect(parseReleaseTag("v2")).toBeNull();
    expect(parseReleaseTag("1.2.3.4")).toBeNull();
  });

  it("rejects non-numeric segments", () => {
    expect(parseReleaseTag("v1.x.0")).toBeNull();
    expect(parseReleaseTag("v1.2.beta")).toBeNull();
    expect(parseReleaseTag("alpha")).toBeNull();
  });

  it("returns null for empty/null/non-string input", () => {
    expect(parseReleaseTag("")).toBeNull();
    expect(parseReleaseTag(null)).toBeNull();
    expect(parseReleaseTag(undefined)).toBeNull();
    expect(parseReleaseTag(123)).toBeNull();
  });
});

describe("isNewer", () => {
  it("returns true when patch is higher", () => {
    expect(isNewer("1.74.8", "1.74.9")).toBe(true);
  });

  it("returns true when minor is higher even if patch is lower", () => {
    expect(isNewer("1.74.8", "1.75.0")).toBe(true);
  });

  it("returns true when major is higher", () => {
    expect(isNewer("1.74.8", "2.0.0")).toBe(true);
  });

  it("returns false for same version", () => {
    expect(isNewer("1.74.8", "1.74.8")).toBe(false);
    expect(isNewer("1.74.8", "v1.74.8")).toBe(false);
  });

  it("returns false when latest is older", () => {
    expect(isNewer("1.74.8", "1.74.7")).toBe(false);
    expect(isNewer("1.74.8", "1.73.0")).toBe(false);
  });

  it("treats 1.74 as 1.74.0 (2-segment normalization)", () => {
    expect(isNewer("1.74", "1.74.1")).toBe(true);
    expect(isNewer("1.74.0", "1.74")).toBe(false);
  });

  it("returns false on parse failure (conservative — never spuriously prompt update)", () => {
    expect(isNewer("garbage", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "garbage")).toBe(false);
  });
});

describe("parseReleaseResponse", () => {
  it("returns UpdateInfo when latest tag is newer and html_url exists", () => {
    const json = JSON.stringify({
      tag_name: "v1.75.0",
      html_url: "https://github.com/x/y/releases/tag/v1.75.0",
    });
    expect(parseReleaseResponse(json, "1.74.8")).toEqual({
      latest_version: "1.75.0",
      html_url: "https://github.com/x/y/releases/tag/v1.75.0",
    });
  });

  it("strips leading v from tag_name", () => {
    const json = JSON.stringify({ tag_name: "v2.0.0", html_url: "https://x" });
    expect(parseReleaseResponse(json, "1.0.0").latest_version).toBe("2.0.0");
  });

  it("returns null when latest equals current", () => {
    const json = JSON.stringify({ tag_name: "v1.74.8", html_url: "https://x" });
    expect(parseReleaseResponse(json, "1.74.8")).toBeNull();
  });

  it("returns null when latest is older than current", () => {
    const json = JSON.stringify({ tag_name: "v1.0.0", html_url: "https://x" });
    expect(parseReleaseResponse(json, "1.74.8")).toBeNull();
  });

  it("returns null on malformed JSON or missing tag_name", () => {
    expect(parseReleaseResponse("not json", "1.0.0")).toBeNull();
    expect(parseReleaseResponse(JSON.stringify({ html_url: "x" }), "1.0.0")).toBeNull();
    expect(parseReleaseResponse(JSON.stringify({ tag_name: 123 }), "1.0.0")).toBeNull();
  });

  it("returns html_url as null when missing (still useful as 'latest version' marker)", () => {
    const json = JSON.stringify({ tag_name: "v2.0.0" });
    expect(parseReleaseResponse(json, "1.0.0")).toEqual({
      latest_version: "2.0.0",
      html_url: null,
    });
  });
});

// v1.75.0 추가 — auto-installer 가 asset URL 필요. parseReleaseResponse 의
// 시그니처는 frozen 이라 별도 함수로 분리.
describe("parseReleaseAssets", () => {
  it("extracts assets array with name + browser_download_url", () => {
    const json = JSON.stringify({
      tag_name: "v1.75.0",
      assets: [
        { name: "token-panda_1.75.0_aarch64.dmg", browser_download_url: "https://x/dmg" },
        { name: "token-panda_1.75.0_x64-setup.exe", browser_download_url: "https://x/exe" },
      ],
    });
    expect(parseReleaseAssets(json)).toEqual([
      { name: "token-panda_1.75.0_aarch64.dmg", browser_download_url: "https://x/dmg" },
      { name: "token-panda_1.75.0_x64-setup.exe", browser_download_url: "https://x/exe" },
    ]);
  });

  it("filters out entries missing name or url", () => {
    const json = JSON.stringify({
      assets: [
        { name: "good.dmg", browser_download_url: "https://x" },
        { name: "", browser_download_url: "https://x" }, // empty name
        { name: "bad.dmg" }, // missing url
        {},
      ],
    });
    expect(parseReleaseAssets(json)).toEqual([
      { name: "good.dmg", browser_download_url: "https://x" },
    ]);
  });

  it("returns null on malformed JSON", () => {
    expect(parseReleaseAssets("not json")).toBeNull();
  });

  it("returns null when assets field missing or not array", () => {
    expect(parseReleaseAssets(JSON.stringify({ tag_name: "v1.0.0" }))).toBeNull();
    expect(parseReleaseAssets(JSON.stringify({ assets: "string" }))).toBeNull();
  });

  it("returns empty array when assets[] is empty", () => {
    expect(parseReleaseAssets(JSON.stringify({ assets: [] }))).toEqual([]);
  });

  it("does not require tag_name (assets parsing is independent)", () => {
    const json = JSON.stringify({
      assets: [{ name: "x.exe", browser_download_url: "https://y" }],
    });
    expect(parseReleaseAssets(json)).toEqual([
      { name: "x.exe", browser_download_url: "https://y" },
    ]);
  });
});
