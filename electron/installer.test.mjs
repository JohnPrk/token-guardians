// ============================================================================
// 🔒 FROZEN CONTRACT — DO NOT MODIFY FOR NEW FEATURES
// ----------------------------------------------------------------------------
// 이 파일의 케이스들은 v1.75.0 시점의 동작을 묶어둔 회귀 안전망이다. 새 기능을
// 추가하다 깨지면 *기능을 고쳐서* 통과시켜야지, 테스트를 손봐선 안 된다.
// 정당하게 기존 동작을 바꿔야 할 때만 PROGRESS.md 의 "테스트 정책" 항목 절차를
// 따라 명시적으로 업데이트한다. 새 분기/필드가 추가됐을 때 *추가* 케이스를
// 덧붙이는 건 자유.
// ============================================================================

import { describe, it, expect } from "vitest";
import installer from "./installer.cjs";
const {
  pickAssetForPlatform,
  buildMacInstallScript,
  buildWindowsInstallScript,
  buildWindowsInstallScriptEB,
} = installer;

describe("pickAssetForPlatform — macOS", () => {
  it("prefers the ASCII-normalized aarch64 dmg name", () => {
    const assets = [
      { name: "_1.75.0_aarch64.dmg", browser_download_url: "https://x/stripped" },
      { name: "token-panda_1.75.0_aarch64.dmg", browser_download_url: "https://x/ascii" },
    ];
    expect(pickAssetForPlatform(assets, "darwin").browser_download_url).toBe("https://x/ascii");
  });

  it("falls back to any aarch64.dmg when ASCII name not present (GitHub stripped Korean prefix)", () => {
    const assets = [
      { name: "_1.74.8_aarch64.dmg", browser_download_url: "https://x/stripped" },
    ];
    expect(pickAssetForPlatform(assets, "darwin").name).toBe("_1.74.8_aarch64.dmg");
  });

  it("falls back to any .dmg as last resort", () => {
    const assets = [{ name: "something.dmg", browser_download_url: "https://x" }];
    expect(pickAssetForPlatform(assets, "darwin").name).toBe("something.dmg");
  });

  it("excludes .app.tar.gz (tauri-updater format, not directly installable)", () => {
    const assets = [
      { name: "_aarch64.app.tar.gz", browser_download_url: "https://x/tar" },
      { name: "_1.74.8_aarch64.dmg", browser_download_url: "https://x/dmg" },
    ];
    expect(pickAssetForPlatform(assets, "darwin").name).toBe("_1.74.8_aarch64.dmg");
  });

  it("returns null when only excluded formats present", () => {
    const assets = [{ name: "release.app.tar.gz", browser_download_url: "https://x" }];
    expect(pickAssetForPlatform(assets, "darwin")).toBeNull();
  });
});

describe("pickAssetForPlatform — Windows", () => {
  it("prefers the ASCII-normalized x64-setup.exe", () => {
    const assets = [
      { name: "_1.75.0_x64-setup.exe", browser_download_url: "https://x/stripped" },
      { name: "token-panda_1.75.0_x64-setup.exe", browser_download_url: "https://x/ascii" },
    ];
    expect(pickAssetForPlatform(assets, "win32").browser_download_url).toBe("https://x/ascii");
  });

  it("falls back to any x64-setup.exe", () => {
    const assets = [
      { name: "_1.74.8_x64-setup.exe", browser_download_url: "https://x/stripped" },
    ];
    expect(pickAssetForPlatform(assets, "win32").name).toBe("_1.74.8_x64-setup.exe");
  });

  it("falls back to any *setup*.exe then any .exe", () => {
    const assets = [{ name: "weird-installer.exe", browser_download_url: "https://x" }];
    expect(pickAssetForPlatform(assets, "win32").name).toBe("weird-installer.exe");
  });

  it("does not pick dmg for Windows even if no exe present", () => {
    const assets = [{ name: "foo.dmg", browser_download_url: "https://x" }];
    expect(pickAssetForPlatform(assets, "win32")).toBeNull();
  });
});

describe("pickAssetForPlatform — edge cases", () => {
  it("returns null for empty / non-array assets", () => {
    expect(pickAssetForPlatform([], "darwin")).toBeNull();
    expect(pickAssetForPlatform(null, "darwin")).toBeNull();
    expect(pickAssetForPlatform(undefined, "win32")).toBeNull();
  });

  it("returns null for unsupported platforms (linux, etc.)", () => {
    const assets = [{ name: "any.dmg", browser_download_url: "https://x" }];
    expect(pickAssetForPlatform(assets, "linux")).toBeNull();
    expect(pickAssetForPlatform(assets, "freebsd")).toBeNull();
  });

  it("skips entries with non-string name", () => {
    const assets = [
      { name: 123, browser_download_url: "https://x" },
      { name: "real.dmg", browser_download_url: "https://y" },
    ];
    expect(pickAssetForPlatform(assets, "darwin").name).toBe("real.dmg");
  });
});

describe("buildMacInstallScript", () => {
  it("includes the exact dmg path passed in (JSON-quoted, handles spaces)", () => {
    const s = buildMacInstallScript("/tmp/with space.dmg", "/Applications/토큰 판다.app");
    // JSON.stringify 형태로 박혀야 공백/한글 인용이 안전
    expect(s).toContain('"/tmp/with space.dmg"');
    expect(s).toContain('"/Applications/토큰 판다.app"');
  });

  it("contains the key install steps (mount, copy, xattr, detach, open)", () => {
    const s = buildMacInstallScript("/tmp/a.dmg", "/Applications/Foo.app");
    expect(s).toContain("hdiutil attach");
    expect(s).toContain("cp -R");
    expect(s).toContain("xattr -cr");
    expect(s).toContain("hdiutil detach");
    expect(s).toContain("open");
  });

  it("starts with bash shebang (spawnDetached uses bash directly but shebang preserves intent)", () => {
    expect(buildMacInstallScript("/a", "/b")).toMatch(/^#!\/bin\/bash/);
  });

  it("waits for old process to exit before installing (max 30 iterations)", () => {
    const s = buildMacInstallScript("/a", "/Applications/X.app");
    expect(s).toContain("pgrep");
    expect(s).toMatch(/seq 1 30|for .* 30/);
  });
});

// BEHAVIOR CHANGE (v1.75.0 패치): buildWindowsInstallScript 3번째 인자가
// `bundleId` (`com.tnew.clauddeskpet`) → `regKey` (`토큰 판다`) 로 바뀜.
// 사유: Tauri NSIS 가 HKCU Uninstall 하위 sub-key 를 productName 으로 박지,
// bundleId 로 안 박음 (v1.74.8 을 실제 설치해서 확인 — 키는 `토큰 판다`).
// 기존 테스트가 `com.tnew.clauddeskpet` 가 스크립트에 박혀있다고 단언했던
// 가정이 사실과 달랐어서 정정. 디폴트 process 이름도 `토큰 판다.exe` → `app.exe`
// (실제 install 산출물).
describe("buildWindowsInstallScript", () => {
  it("includes the exact installer path (JSON-quoted, handles spaces)", () => {
    const s = buildWindowsInstallScript("C:\\Temp\\with space.exe", "app.exe", "토큰 판다");
    // Windows backslash 가 JSON 인코딩으로 들어가야 함
    expect(s).toContain('"C:\\\\Temp\\\\with space.exe"');
  });

  it("includes process name and productName regKey (Tauri NSIS uses productName as Uninstall sub-key)", () => {
    const s = buildWindowsInstallScript("C:\\a.exe", "app.exe", "토큰 판다");
    expect(s).toContain("app.exe");
    expect(s).toContain("토큰 판다");
  });

  it("waits for old process by base name (without .exe), then force-kills if needed", () => {
    const s = buildWindowsInstallScript("C:\\a.exe", "app.exe", "토큰 판다");
    // GetFileNameWithoutExtension → "app" 로 Get-Process 호출
    expect(s).toContain("GetFileNameWithoutExtension");
    expect(s).toContain("Get-Process");
    expect(s).toContain("Stop-Process -Force");
  });

  it("runs installer silently (NSIS /S) and waits for exit", () => {
    const s = buildWindowsInstallScript("C:\\a.exe", "app.exe", "토큰 판다");
    expect(s).toContain("/S");
    expect(s).toMatch(/Start-Process.*-Wait/);
  });

  it("reads InstallLocation from HKCU Uninstall\\<productName> registry key", () => {
    const s = buildWindowsInstallScript("C:\\a.exe", "app.exe", "토큰 판다");
    expect(s).toContain("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\");
    expect(s).toContain("InstallLocation");
  });

  it("strips quotes from InstallLocation value (NSIS writes it quoted)", () => {
    // 실측: registry 값이 `"C:\Users\...\토큰 판다"` 처럼 따옴표 포함.
    // Join-Path 가 그 따옴표를 path 에 끼워넣지 않게 .Trim('"') 필수.
    const s = buildWindowsInstallScript("C:\\a.exe", "app.exe", "토큰 판다");
    expect(s).toMatch(/\.Trim\('"'\)/);
  });

  it("fallback path uses %LOCALAPPDATA%\\<productName>\\app.exe (no Programs subfolder)", () => {
    // Tauri NSIS currentUser 모드는 %LOCALAPPDATA% 바로 아래 productName 폴더
    // 를 만든다. Programs\\ 가 끼지 않음 — 그래서 fallback 도 그대로.
    const s = buildWindowsInstallScript("C:\\a.exe", "app.exe", "토큰 판다");
    expect(s).toContain('Join-Path $env:LOCALAPPDATA');
    expect(s).not.toContain("Programs\\\\");
  });

  it("launches new app hidden (background) after install", () => {
    const s = buildWindowsInstallScript("C:\\a.exe", "app.exe", "토큰 판다");
    expect(s).toMatch(/Start-Process -FilePath \$exe -WindowStyle Hidden/);
  });
});

// v1.85 부터 빌드가 electron-builder NSIS (productName=TokenPanda, oneClick +
// perMachine:false) 라 옛 Tauri NSIS 가정(exe=app.exe, fallback=%LOCALAPPDATA%\
// <productName>\..)이 더는 사실이 아니다. 새 함수는 Programs\TokenPanda\
// TokenPanda.exe 를 primary 로 보고, 없으면 HKCU Uninstall sub-key 전체를 스캔
// 해 DisplayName 으로 매칭 (NSIS GUID 키라 직접 lookup 불가).
describe("buildWindowsInstallScriptEB (electron-builder NSIS)", () => {
  it("targets TokenGuardians.exe (electron-builder productName), not legacy app.exe", () => {
    const s = buildWindowsInstallScriptEB("C:\\Temp\\tp.exe");
    expect(s).toContain("'TokenGuardians.exe'");
    expect(s).not.toMatch(/\$proc = 'app\.exe'/);
  });

  it("includes the exact installer path (JSON-quoted, handles spaces and backslash)", () => {
    const s = buildWindowsInstallScriptEB("C:\\Temp\\with space.exe");
    expect(s).toContain('"C:\\\\Temp\\\\with space.exe"');
  });

  it("primary install root is %LOCALAPPDATA%\\Programs\\TokenGuardians (electron-builder default for perMachine:false)", () => {
    const s = buildWindowsInstallScriptEB("C:\\a.exe");
    expect(s).toContain("$env:LOCALAPPDATA");
    expect(s).toContain("Programs\\TokenGuardians");
  });

  it("falls back to scanning HKCU Uninstall sub-keys by DisplayName when primary path missing", () => {
    const s = buildWindowsInstallScriptEB("C:\\a.exe");
    expect(s).toContain("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall");
    expect(s).toMatch(/Get-ChildItem/);
    expect(s).toContain("DisplayName");
    expect(s).toContain("TokenPanda");
    expect(s).toContain("토큰 판다");
  });

  it("strips quotes from InstallLocation value (NSIS may write it quoted)", () => {
    const s = buildWindowsInstallScriptEB("C:\\a.exe");
    expect(s).toMatch(/\.Trim\('"'\)/);
  });

  it("waits for old process by 'TokenPanda' base name (max 30s) then force-kills", () => {
    const s = buildWindowsInstallScriptEB("C:\\a.exe");
    expect(s).toContain("GetFileNameWithoutExtension");
    expect(s).toContain("Get-Process");
    expect(s).toContain("Stop-Process -Force");
  });

  it("runs installer silently (NSIS /S) and waits for exit", () => {
    const s = buildWindowsInstallScriptEB("C:\\a.exe");
    expect(s).toContain("/S");
    expect(s).toMatch(/Start-Process.*-Wait/);
  });

  it("launches new app hidden after install", () => {
    const s = buildWindowsInstallScriptEB("C:\\a.exe");
    expect(s).toMatch(/Start-Process -FilePath \$exe -WindowStyle Hidden/);
  });
});
