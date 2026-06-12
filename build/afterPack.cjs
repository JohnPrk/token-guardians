"use strict";
// macOS 앱 번들 표시 이름을 한글 "토큰 지키미"로.
//
// 왜 이렇게 하나:
// - Launchpad/Finder 는 앱 라벨로 *.app 폴더명*을 쓴다. CFBundleDisplayName / ko.lproj
//   로컬라이즈는 Electron 앱에선 안 먹는 걸 실측으로 확인.
// - 그런데 productName 에 한글을 넣으면 helper 번들 이름(`<productName> Helper.app`)도
//   한글이 되고, Electron 의 helper.app 경로 해석에서 NFC/NFD 불일치로 SIGTRAP 크래시.
//   (Electron 33 에서도 재발 — 실측 확인, 종료코드 -5)
// - 그래서 productName/helper 는 ASCII("TokenGuardian") 로 두고, 빌드 후 *바깥 .app 폴더명만*
//   한글로 바꾼다. 한글이 부모 경로에만 있으면 helper 경로 해석은 정상(크래시 안 남 — 실측 확인).
//
// ⚠️ 서명/공증/DMG 파이프라인과의 상호작용은 실기 빌드(dist:mac)로 검증 필요.
const fs = require("fs");
const path = require("path");

const KOREAN_APP = "토큰 지키미.app";

exports.default = async function (context) {
  if (context.electronPlatformName !== "darwin") return;
  const product = context.packager.appInfo.productFilename; // "TokenGuardian"
  const from = path.join(context.appOutDir, `${product}.app`);
  const to = path.join(context.appOutDir, KOREAN_APP);
  if (from === to) return;
  if (!fs.existsSync(from)) {
    console.warn(`[afterPack] ${product}.app not found — skip rename`);
    return;
  }
  if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
  console.log(`[afterPack] bundle renamed: ${product}.app → ${KOREAN_APP}`);
};
