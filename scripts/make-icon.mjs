#!/usr/bin/env node
// Build the app icon: the existing panda character (src/skins/panda/good.png)
// cropped to just the head, placed on a soft gray rounded-square background.
// Renders 1024×1024 PNG → build/icon.png. electron-builder picks this up
// at package time and auto-generates icon.icns (mac) / icon.ico (windows)
// from the single PNG, so we no longer need the `tauri icon` CLI.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const srcPng = resolve(root, "src/skins/panda/good.png");
const outPng = resolve(root, "build/icon.png");

const ICON_SIZE = 1024;
const RADIUS = 232;

// 1) Crop the head from good.png (256×256). The head occupies roughly
//    the top 60% of the canvas, near-full width.
const meta = await sharp(srcPng).metadata();
const W = meta.width;
const H = meta.height;
const cropLeft = Math.round(W * 0.05);
const cropTop = 0;
const cropWidth = W - cropLeft * 2;
const cropHeight = Math.round(H * 0.6);

const headBuf = await sharp(srcPng)
  .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
  .png()
  .toBuffer();

// 2) Resize the head into a square box that fits the icon canvas.
const HEAD_BOX = ICON_SIZE - 220;
const headResized = await sharp(headBuf)
  .resize(HEAD_BOX, HEAD_BOX, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .toBuffer();

// 3) Soft gray rounded-square background, mild radial highlight at top.
const bgSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}" width="${ICON_SIZE}" height="${ICON_SIZE}">
  <defs>
    <radialGradient id="bg" cx="0.5" cy="0.32" r="0.85">
      <stop offset="0" stop-color="#dadce2"/>
      <stop offset="1" stop-color="#a3a6ad"/>
    </radialGradient>
  </defs>
  <rect width="${ICON_SIZE}" height="${ICON_SIZE}" rx="${RADIUS}" fill="url(#bg)"/>
</svg>
`;

mkdirSync(dirname(outPng), { recursive: true });

// 4) Composite the head onto the background, slightly down-shifted so
//    the visual mass sits at the optical center.
const HEAD_OFFSET_Y = 20;
const top = Math.round((ICON_SIZE - HEAD_BOX) / 2 + HEAD_OFFSET_Y);
const left = Math.round((ICON_SIZE - HEAD_BOX) / 2);

await sharp(Buffer.from(bgSvg))
  .composite([{ input: headResized, top, left }])
  .png()
  .toFile(outPng);

console.log(`generated ${outPng}`);
