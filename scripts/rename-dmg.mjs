#!/usr/bin/env node
// Tauri 는 productName(`토큰 판다`)을 dmg/exe 파일명 prefix 로 그대로 박는다.
// 한글 + 공백이 들어간 파일명을 GitHub 릴리스에 업로드하면 GitHub 이 자산
// 이름을 잘라(한글이 통째로 사라져 `_1.0.x_aarch64.dmg`로 보이는 케이스가
// 있음) README 배지 링크가 깨진다. 그래서 빌드 후 dmg + NSIS exe 를 ASCII
// 통일 이름 (`token-panda_X.Y.Z_<arch>.dmg`, `token-panda_X.Y.Z_x64-setup.exe`)
// 으로 강제 rename 한다.
//
// CI 가 `--target aarch64-apple-darwin` 으로 빌드하면 산출물 경로가
// `src-tauri/target/aarch64-apple-darwin/release/bundle/...` 로 들어가서
// 이전 버전 스크립트가 `src-tauri/target/release/bundle/dmg` 만 봤었던
// 게 회귀였다(v1.74.8 의 dmg 가 `_1.74.8_aarch64.dmg`로 올라간 원인).
// 두 경로 다 + nsis 디렉토리까지 walking 으로 잡는다.

import { readdirSync, statSync, renameSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const targetRoot = resolve(here, "..", "src-tauri", "target");

if (!existsSync(targetRoot)) {
  console.log(`[rename-bundles] no target dir at ${targetRoot} — skipping`);
  process.exit(0);
}

// src-tauri/target/{any}/release/bundle/{dmg,nsis}/ 모두 탐색.
function findBundleDirs(root) {
  const out = [];
  function walk(dir, depth) {
    if (depth > 6) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      // 정확히 bundle/dmg 또는 bundle/nsis 디렉토리만.
      if ((name === "dmg" || name === "nsis") && dirname(full).endsWith("bundle")) {
        out.push(full);
      }
      walk(full, depth + 1);
    }
  }
  walk(root, 0);
  return out;
}

// 한 파일을 ASCII 이름으로 정규화. extKind: "dmg" | "exe".
// 기대 패턴: `<prefix>_<X.Y.Z>_<arch>.dmg` 또는 `<prefix>_<X.Y.Z>_<arch>-setup.exe`.
export function asciiTargetName(name, extKind) {
  if (extKind === "dmg") {
    const m = name.match(/_(\d+\.\d+\.\d+)_([^_/\\]+)\.dmg$/);
    if (!m) return null;
    return `token-panda_${m[1]}_${m[2]}.dmg`;
  }
  if (extKind === "exe") {
    // NSIS Tauri 산출물: `<productName>_<version>_<arch>-setup.exe`
    const m = name.match(/_(\d+\.\d+\.\d+)_([^_/\\]+)-setup\.exe$/);
    if (!m) return null;
    return `token-panda_${m[1]}_${m[2]}-setup.exe`;
  }
  return null;
}

const bundleDirs = findBundleDirs(targetRoot);
let renamed = 0;
for (const dir of bundleDirs) {
  const kind = dir.endsWith("dmg") ? "dmg" : "exe";
  const ext = kind === "dmg" ? ".dmg" : ".exe";
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith(ext)) continue;
    const target = asciiTargetName(name, kind);
    if (!target) {
      console.log(`[rename-bundles] skip (unexpected name): ${name}`);
      continue;
    }
    if (target === name) continue;
    renameSync(join(dir, name), join(dir, target));
    console.log(`[rename-bundles] ${name} → ${target}`);
    renamed += 1;
  }
}

if (bundleDirs.length === 0) {
  console.log("[rename-bundles] no bundle dirs found under target/");
} else if (renamed === 0) {
  console.log("[rename-bundles] no rename needed");
}
