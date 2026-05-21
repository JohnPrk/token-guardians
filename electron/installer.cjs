// Auto-installer — 트레이 "🆕 v.. 설치" 클릭 시 백그라운드에서 기존 프로세스
// 종료 → 설치 파일 다운로드 → 사일런트 설치 → 새 앱 실행까지 전부 자동.
//
// 구 Tauri src-tauri/src/updater.rs 의 macOS dmg 자동설치 흐름을 JS 로 포팅 +
// Windows 새 구현 (NSIS /S 사일런트 설치 + PowerShell 래퍼). 두 OS 모두
// "자기 자신 quit → 외부 detached 스크립트가 설치+실행" 패턴.
//
// 순수 함수 (pickAssetForPlatform, parseReleaseAssets, buildMacInstallScript,
// buildWindowsInstallScript) 는 vitest 로 검증, IO (downloadToFile, spawn)
// 는 실기 검증.

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");

// CI 가 만들어내는 ASCII 정규화 이름과, 비-ASCII prefix 잘린 leftover 모두
// 잡도록 후보를 순서대로 둔다. 가장 specific 한 패턴이 먼저.
const MACOS_DMG_PATTERNS = [
  /^token-panda_.*aarch64\.dmg$/i,
  /aarch64\.dmg$/i,
  /\.dmg$/i,
];
const WINDOWS_EXE_PATTERNS = [
  /^token-panda_.*x64-setup\.exe$/i,
  /x64-setup\.exe$/i,
  /setup\.exe$/i,
  /\.exe$/i,
];

// 자산 배열 + 플랫폼 → 가장 적합한 자산 1개 (없으면 null).
// app.tar.gz 같은 tauri-updater 형식은 직접 설치할 수 없어서 제외.
function pickAssetForPlatform(assets, platform) {
  if (!Array.isArray(assets)) return null;
  const exclude = /\.app\.tar\.gz$|\.tar\.gz$|\.sig$|\.asc$/i;
  const patterns =
    platform === "darwin" ? MACOS_DMG_PATTERNS :
    platform === "win32" ? WINDOWS_EXE_PATTERNS :
    [];
  for (const re of patterns) {
    for (const a of assets) {
      if (!a || typeof a.name !== "string") continue;
      if (exclude.test(a.name)) continue;
      if (re.test(a.name)) {
        return { name: a.name, browser_download_url: a.browser_download_url || "" };
      }
    }
  }
  return null;
}

// GitHub release JSON → assets 정규화 배열 ({name, browser_download_url}).
function parseReleaseAssets(json) {
  let r;
  try { r = JSON.parse(json); } catch { return null; }
  if (!r || !Array.isArray(r.assets)) return null;
  return r.assets
    .map((a) => ({
      name: typeof a.name === "string" ? a.name : "",
      browser_download_url:
        typeof a.browser_download_url === "string" ? a.browser_download_url : "",
    }))
    .filter((a) => a.name && a.browser_download_url);
}

// macOS bash 스크립트: 옛 앱 종료 대기 → dmg 마운트 → .app 복사 → quarantine
// 제거 → unmount → 새 앱 실행. Tauri 원본 (`spawn_install_script`) 의 정확한
// 동등 구현 — 사용자가 이미 한 번 검증한 흐름.
function buildMacInstallScript(dmgPath, appPath) {
  return `#!/bin/bash
set -u
APP_PATH=${JSON.stringify(appPath)}
DMG_PATH=${JSON.stringify(dmgPath)}

# 1) 옛 앱 종료 대기 (최대 30초)
for i in $(seq 1 30); do
  pgrep -f "$APP_PATH/Contents/MacOS" >/dev/null 2>&1 || break
  sleep 1
done

# 2) dmg 마운트
MOUNT_DIR=$(mktemp -d)
hdiutil attach -nobrowse -quiet -mountpoint "$MOUNT_DIR" "$DMG_PATH" || exit 1

# 3) .app 복사 (기존 install 덮어쓰기)
APP_NAME=$(ls "$MOUNT_DIR" | grep '.app$' | head -n1)
if [ -n "$APP_NAME" ]; then
  rm -rf "$APP_PATH"
  cp -R "$MOUNT_DIR/$APP_NAME" "$APP_PATH"
  # 4) quarantine xattr 제거 ("손상됨" Gatekeeper 차단 회피)
  xattr -cr "$APP_PATH" 2>/dev/null || true
fi

# 5) unmount
hdiutil detach "$MOUNT_DIR" -quiet || true

# 6) 새 앱 실행
open "$APP_PATH"
`;
}

// Windows PowerShell 스크립트: 옛 프로세스 종료 대기 → NSIS /S 사일런트 설치
// → registry InstallLocation 으로 새 exe 경로 확인 → 백그라운드 실행.
// UTF-8 BOM 으로 저장해야 한글 파일명(`토큰 판다.exe`) 이 PS 5.1 에서 정상.
function buildWindowsInstallScript(installerPath, processName, bundleId) {
  return `$ErrorActionPreference = 'SilentlyContinue'
$proc = ${JSON.stringify(processName)}
$installerPath = ${JSON.stringify(installerPath)}
$bundleId = ${JSON.stringify(bundleId)}

# 1) 옛 프로세스 종료 대기 (최대 30초)
$procBase = [System.IO.Path]::GetFileNameWithoutExtension($proc)
for ($i = 0; $i -lt 30; $i++) {
  $p = Get-Process -Name $procBase -ErrorAction SilentlyContinue
  if (-not $p) { break }
  Start-Sleep -Milliseconds 1000
}
# 안 죽으면 강제 종료
Get-Process -Name $procBase -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 2) 사일런트 설치 (NSIS /S)
$proc2 = Start-Process -FilePath $installerPath -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
if ($proc2.ExitCode -ne 0) { exit $proc2.ExitCode }

# 3) registry 에서 InstallLocation 찾기 (Tauri NSIS 가 currentUser 모드로 박음)
$exe = $null
$keys = @(
  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$bundleId",
  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{$bundleId}"
)
foreach ($k in $keys) {
  $loc = (Get-ItemProperty -Path $k -Name InstallLocation -ErrorAction SilentlyContinue).InstallLocation
  if ($loc) {
    $candidate = Join-Path $loc $proc
    if (Test-Path -LiteralPath $candidate) { $exe = $candidate; break }
  }
}
# fallback: 일반적인 install 경로 (Tauri NSIS 가 productName 폴더 만듦)
if (-not $exe) {
  $fallback = Join-Path $env:LOCALAPPDATA ("Programs\\토큰 판다\\" + $proc)
  if (Test-Path -LiteralPath $fallback) { $exe = $fallback }
}

# 4) 백그라운드 실행
if ($exe) {
  Start-Process -FilePath $exe -WindowStyle Hidden
}
`;
}

// URL → 파일. https 만 (GitHub release CDN). 302 redirect 따라감.
function downloadToFile(url, destPath, userAgent) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const onErr = (e) => {
      file.destroy();
      try { fs.unlinkSync(destPath); } catch {}
      reject(e);
    };
    const ua = userAgent || "token-panda-installer";
    const get = (u, hops) => {
      if (hops > 5) return onErr(new Error("too many redirects"));
      https
        .get(u, { headers: { "User-Agent": ua } }, (res) => {
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume();
            return get(res.headers.location, hops + 1);
          }
          if (code !== 200) {
            return onErr(new Error("HTTP " + code));
          }
          res.pipe(file);
          file.on("finish", () => file.close(() => resolve(destPath)));
        })
        .on("error", onErr);
    };
    get(url, 0);
  });
}

// detached 로 외부 프로세스 spawn. main app 이 종료돼도 스크립트는 살아서
// 설치 + 새 앱 실행을 책임진다.
function spawnDetached(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", reject);
    try { child.unref(); } catch {}
    resolve();
  });
}

// caller (main.cjs) 가 호출하는 entry. 다운로드 + detached 스크립트 spawn
// 까지만 — 호출자가 즉시 app.quit() 해야 스크립트의 "옛 앱 종료 대기" 루프
// 가 곧장 통과한다.
async function downloadAndStartInstall(asset, opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  const tmpDir = opts.tmpDir || path.join(os.tmpdir(), "token-panda-update");
  fs.mkdirSync(tmpDir, { recursive: true });

  // 다운로드된 자산을 ASCII 임시 이름으로 (PS/bash 인수 처리 단순화)
  const localName = platform === "win32" ? "tp-installer.exe" : "tp-installer.dmg";
  const dest = path.join(tmpDir, localName);
  await downloadToFile(asset.browser_download_url, dest);

  if (platform === "darwin") {
    const appPath = opts.appPath || "/Applications/토큰 판다.app";
    const script = buildMacInstallScript(dest, appPath);
    const scriptPath = path.join(tmpDir, "tp-install.sh");
    fs.writeFileSync(scriptPath, script, "utf8");
    fs.chmodSync(scriptPath, 0o755);
    // nohup 효과는 detached + ignore stdio 로 충분 (부모 종료시 SIGHUP 안 받음)
    await spawnDetached("bash", [scriptPath]);
  } else if (platform === "win32") {
    const processName = opts.processName || "토큰 판다.exe";
    const bundleId = opts.bundleId || "com.tnew.clauddeskpet";
    const script = buildWindowsInstallScript(dest, processName, bundleId);
    const scriptPath = path.join(tmpDir, "tp-install.ps1");
    // UTF-8 BOM — PowerShell 5.1 이 .ps1 을 ANSI 로 읽지 않게.
    fs.writeFileSync(scriptPath, "﻿" + script, "utf8");
    await spawnDetached("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-WindowStyle", "Hidden",
      "-File", scriptPath,
    ]);
  } else {
    throw new Error("Unsupported platform: " + platform);
  }

  return { downloadedTo: dest };
}

module.exports = {
  pickAssetForPlatform,
  parseReleaseAssets,
  buildMacInstallScript,
  buildWindowsInstallScript,
  downloadAndStartInstall,
  // 테스트 보조
  MACOS_DMG_PATTERNS,
  WINDOWS_EXE_PATTERNS,
};
