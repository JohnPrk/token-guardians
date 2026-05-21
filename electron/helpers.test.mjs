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
import helpers from "./helpers.cjs";
const { isAuthFailure, formatUpdateCheckLabel, formatHeaderLabel, bambooTierForRemaining } = helpers;

describe("isAuthFailure", () => {
  it("matches HTTP 401 anywhere in message", () => {
    expect(isAuthFailure("HTTP 401 — Unauthorized")).toBe(true);
    expect(isAuthFailure("usage: HTTP 401 (stale session)")).toBe(true);
  });

  it("matches HTTP 403 (Cloudflare block) and HTTP 404 (wrong org)", () => {
    expect(isAuthFailure("HTTP 403 — challenge")).toBe(true);
    expect(isAuthFailure("HTTP 404 — not found")).toBe(true);
  });

  it("does not match other HTTP errors", () => {
    expect(isAuthFailure("HTTP 500 — server error")).toBe(false);
    expect(isAuthFailure("HTTP 503")).toBe(false);
    expect(isAuthFailure("HTTP 429 — rate limit")).toBe(false);
  });

  it("does not match network / timeout errors", () => {
    expect(isAuthFailure("request: AbortError")).toBe(false);
    expect(isAuthFailure("request: ECONNREFUSED")).toBe(false);
  });

  it("returns false for empty/null/undefined input", () => {
    expect(isAuthFailure("")).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
  });

  it("does not false-positive on '401' as substring of unrelated text", () => {
    expect(isAuthFailure("token4012345 expired")).toBe(false);
  });
});

describe("formatUpdateCheckLabel", () => {
  it("returns waiting label when no check has run", () => {
    expect(formatUpdateCheckLabel(null, null)).toBe("업데이트 확인 대기 중…");
  });

  it("formats successful 'latest' state (no new version)", () => {
    const at = new Date(2026, 4, 21, 14, 23, 0);
    expect(formatUpdateCheckLabel({ at, ok: true }, null)).toBe("최신 · 14:23 확인");
  });

  it("formats successful state with a new version available", () => {
    const at = new Date(2026, 4, 21, 14, 23, 0);
    const info = { latest_version: "1.75.0", html_url: "https://example" };
    expect(formatUpdateCheckLabel({ at, ok: true }, info)).toBe(
      "🆕 v1.75.0 있음 · 14:23 확인",
    );
  });

  it("formats failure state distinctly so user can tell polling failed", () => {
    const at = new Date(2026, 4, 21, 9, 5, 0);
    expect(formatUpdateCheckLabel({ at, ok: false }, null)).toBe(
      "확인 실패 · 09:05 시도",
    );
  });

  it("pads hours and minutes to two digits", () => {
    const at = new Date(2026, 0, 1, 3, 7, 0);
    expect(formatUpdateCheckLabel({ at, ok: true }, null)).toBe("최신 · 03:07 확인");
  });
});

describe("formatHeaderLabel", () => {
  it("returns version-only label when no check has run yet", () => {
    expect(formatHeaderLabel("1.97.0", null)).toBe("토큰 판다 v1.97.0");
  });

  it("appends HH:MM 확인 suffix when lastUpdateCheck has a timestamp", () => {
    const at = new Date(2026, 4, 21, 3, 18, 0);
    expect(formatHeaderLabel("1.97.0", { at, ok: true })).toBe(
      "토큰 판다 v1.97.0 (03:18 확인)",
    );
  });

  it("uses the same suffix regardless of poll ok/fail (only timestamp matters)", () => {
    const at = new Date(2026, 4, 21, 14, 23, 0);
    expect(formatHeaderLabel("1.97.0", { at, ok: false })).toBe(
      "토큰 판다 v1.97.0 (14:23 확인)",
    );
  });
});

describe("bambooTierForRemaining", () => {
  it("maps remaining fraction to bamboo tier (75%+ / 50%+ / 25%+ / <25%)", () => {
    expect(bambooTierForRemaining(1)).toBe("100");
    expect(bambooTierForRemaining(0.75)).toBe("100");
    expect(bambooTierForRemaining(0.74)).toBe("75");
    expect(bambooTierForRemaining(0.5)).toBe("75");
    expect(bambooTierForRemaining(0.49)).toBe("50");
    expect(bambooTierForRemaining(0.25)).toBe("50");
    expect(bambooTierForRemaining(0.24)).toBe("25");
    expect(bambooTierForRemaining(0)).toBe("25");
  });

  it("treats invalid input as empty (25)", () => {
    expect(bambooTierForRemaining(NaN)).toBe("25");
    expect(bambooTierForRemaining(undefined)).toBe("25");
    expect(bambooTierForRemaining(-0.5)).toBe("25");
  });
});
