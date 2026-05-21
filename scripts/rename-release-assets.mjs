#!/usr/bin/env node
// 빌드 후 tauri-action 이 GitHub Release 에 업로드한 자산 이름이 비-ASCII 잘림
// 회귀 (예: `토큰 판다_1.74.8_aarch64.dmg` → GitHub 가 `_1.74.8_aarch64.dmg`
// 로 prefix 만 잘라서 저장) 를 정정한다. tauri-action 이 끝난 *뒤* CI 의 별도
// job 에서 실행 (rename-assets) — 디스크 rename 으론 이미 업로드된 자산을
// 못 바꿔서 release API 의 PATCH endpoint 로 이름만 갱신.
//
// 사용 env:
//   GITHUB_TOKEN       (필수, contents:write)
//   GITHUB_REPOSITORY  (필수, "owner/repo")
//   RELEASE_TAG        (필수, "v1.75.0")

import { asciiTargetName } from "./rename-dmg.mjs";

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const TAG = process.env.RELEASE_TAG;

if (!TOKEN || !REPO || !TAG) {
  console.log("[rename-release-assets] missing env (GITHUB_TOKEN / GITHUB_REPOSITORY / RELEASE_TAG), skip");
  process.exit(0);
}

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "token-panda-rename",
};

async function fetchJson(url, init) {
  const res = await fetch(url, { ...(init || {}), headers: { ...HEADERS, ...(init?.headers || {}) } });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}: ${body.slice(0, 200)}`);
  }
  return body ? JSON.parse(body) : null;
}

const release = await fetchJson(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`);
console.log(`[rename-release-assets] release ${release.tag_name}: ${release.assets.length} assets`);

let renamed = 0;
let skipped = 0;
for (const a of release.assets) {
  const lower = a.name.toLowerCase();
  let kind = null;
  if (lower.endsWith(".dmg")) kind = "dmg";
  else if (lower.endsWith(".exe")) kind = "exe";
  if (!kind) {
    console.log(`[rename-release-assets] skip ${a.name} (not dmg/exe)`);
    skipped++;
    continue;
  }
  const target = asciiTargetName(a.name, kind);
  if (!target) {
    console.log(`[rename-release-assets] skip ${a.name} (pattern mismatch — leaving as-is)`);
    skipped++;
    continue;
  }
  if (target === a.name) {
    console.log(`[rename-release-assets] ok ${a.name} (already ASCII)`);
    continue;
  }
  try {
    await fetchJson(`https://api.github.com/repos/${REPO}/releases/assets/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: target }),
    });
    console.log(`[rename-release-assets] ${a.name} → ${target}`);
    renamed++;
  } catch (e) {
    console.error(`[rename-release-assets] PATCH ${a.name} failed: ${e.message}`);
  }
}
console.log(`[rename-release-assets] renamed=${renamed} skipped=${skipped}`);
