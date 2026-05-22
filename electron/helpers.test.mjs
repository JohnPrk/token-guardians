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
const {
  isAuthFailure,
  formatUpdateCheckLabel,
  formatHeaderLabel,
  bambooTierForRemaining,
  pickTrayTierForState,
  clampPetPosition,
  MIN_VISIBLE_PX,
} = helpers;

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

describe("pickTrayTierForState", () => {
  it("macOS fivehour mode: tier follows remaining", () => {
    expect(pickTrayTierForState("darwin", "fivehour", 1)).toBe("100");
    expect(pickTrayTierForState("darwin", "fivehour", 0.6)).toBe("75");
    expect(pickTrayTierForState("darwin", "fivehour", 0.3)).toBe("50");
    expect(pickTrayTierForState("darwin", "fivehour", 0.1)).toBe("25");
  });

  it("macOS non-fivehour modes: null (icon empty, text-only label)", () => {
    expect(pickTrayTierForState("darwin", "both", 0.5)).toBe(null);
    expect(pickTrayTierForState("darwin", "all", 0.5)).toBe(null);
  });

  it("Windows always returns 100 regardless of mode or remaining", () => {
    // 작업표시줄은 setTitle 노출 안 됨 → 아이콘 비우면 앱 자체가 안 보임.
    // 모드/잔량 무관 가장 풀 대나무 (4 줄기) 고정.
    expect(pickTrayTierForState("win32", "fivehour", 0)).toBe("100");
    expect(pickTrayTierForState("win32", "fivehour", 1)).toBe("100");
    expect(pickTrayTierForState("win32", "both", 0.3)).toBe("100");
    expect(pickTrayTierForState("win32", "all", 0.1)).toBe("100");
  });
});

describe("clampPetPosition", () => {
  // 단일 디스플레이 (0,0)~(1440,900). MacBook 메뉴바/Dock 제외 영역 가정.
  const primary = { workArea: { x: 0, y: 25, width: 1440, height: 875 } };
  // 듀얼 셋업: 메인 모니터가 오른쪽, 보조가 왼쪽으로 확장된 환경 (음수 x).
  const leftSecondary = { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } };
  const w = 220;
  const h = 460;

  it("returns input rounded when displays is empty", () => {
    expect(clampPetPosition(123.7, -45.2, w, h, [])).toEqual({ x: 124, y: -45 });
  });

  it("returns input rounded when displays argument is missing/invalid", () => {
    expect(clampPetPosition(50, 50, w, h, null)).toEqual({ x: 50, y: 50 });
    expect(clampPetPosition(50, 50, w, h, [{}])).toEqual({ x: 50, y: 50 });
  });

  it("keeps in-bounds position unchanged (single display)", () => {
    expect(clampPetPosition(500, 200, w, h, [primary])).toEqual({ x: 500, y: 200 });
  });

  it("clamps to left edge with MIN_VISIBLE_PX of window remaining onscreen", () => {
    // 윈도우 좌측이 -w 보다 더 왼쪽이면 우측 끝이 화면 밖 → 우측 끝 = MIN_VISIBLE 만큼 보임
    const r = clampPetPosition(-9999, 200, w, h, [primary]);
    // xMin = 0 + 32 - 220 = -188
    expect(r.x).toBe(MIN_VISIBLE_PX - w); // -188
    expect(r.y).toBe(200);
  });

  it("clamps to right edge with MIN_VISIBLE_PX of window remaining onscreen", () => {
    const r = clampPetPosition(9999, 200, w, h, [primary]);
    // xMax = 1440 - 32 = 1408
    expect(r.x).toBe(1440 - MIN_VISIBLE_PX);
    expect(r.y).toBe(200);
  });

  it("clamps to top edge — window bottom must stay MIN_VISIBLE below workArea top", () => {
    // 위로 한참 끌어올려도 윈도우의 아래 32px 은 화면 안에 남아야 함
    const r = clampPetPosition(500, -9999, w, h, [primary]);
    // yMin = 25 + 32 - 460 = -403
    expect(r.x).toBe(500);
    expect(r.y).toBe(primary.workArea.y + MIN_VISIBLE_PX - h);
  });

  it("clamps to bottom edge", () => {
    const r = clampPetPosition(500, 9999, w, h, [primary]);
    // yMax = 25 + 875 - 32 = 868
    expect(r.x).toBe(500);
    expect(r.y).toBe(primary.workArea.y + primary.workArea.height - MIN_VISIBLE_PX);
  });

  it("supports dual display with secondary at negative x (left-extended setup)", () => {
    // 보조 모니터가 (-1920, 0) 부터 1920×1080. 메인은 (0, 25)~(1440, 900).
    // 펫을 -800 으로 끌고 가도 정상 — union 의 minX 가 -1920 이라 OK.
    const r = clampPetPosition(-800, 400, w, h, [primary, leftSecondary]);
    expect(r).toEqual({ x: -800, y: 400 });
  });

  it("clamps to union left when going past secondary display's left edge", () => {
    const r = clampPetPosition(-9999, 400, w, h, [primary, leftSecondary]);
    // union minX = -1920, xMin = -1920 + 32 - 220 = -2108
    expect(r.x).toBe(-1920 + MIN_VISIBLE_PX - w);
    expect(r.y).toBe(400);
  });

  it("clamps to union top when secondary display extends higher than primary", () => {
    // leftSecondary 의 y=0 가 primary 의 y=25 보다 위 → union minY = 0
    const r = clampPetPosition(500, -9999, w, h, [primary, leftSecondary]);
    expect(r.y).toBe(0 + MIN_VISIBLE_PX - h);
  });

  it("rounds fractional coordinates", () => {
    expect(clampPetPosition(100.6, 200.4, w, h, [primary])).toEqual({ x: 101, y: 200 });
  });
});
