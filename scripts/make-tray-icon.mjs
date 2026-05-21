#!/usr/bin/env node
// Generate a small bamboo silhouette PNG for the menu bar tray icon.
// macOS template images expect black-on-transparent — the OS auto-
// tints based on light/dark menu bar. Output at 44×44 (retina @2x);
// macOS renders it at the standard 22pt menu-bar height.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = resolve(root, "build/tray.png");

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="44" height="44">
  <g fill="black" stroke="black" stroke-linecap="round" stroke-linejoin="round">
    <!-- main bamboo stalk -->
    <rect x="19.5" y="5"  width="5" height="9"  rx="1.2"/>
    <rect x="19.5" y="16" width="5" height="9"  rx="1.2"/>
    <rect x="19.5" y="27" width="5" height="12" rx="1.2"/>

    <!-- leaves -->
    <path d="M 22 14
             C 14 12, 10 6, 11 4
             C 13 5, 18 9, 22 14 Z"/>
    <path d="M 22 25
             C 30 23, 35 18, 34 16
             C 32 17, 26 21, 22 25 Z"/>
    <path d="M 22 25
             C 14 26, 11 22, 12 20
             C 14 21, 19 23, 22 25 Z"/>
  </g>
</svg>
`;

await sharp(Buffer.from(svg))
  .resize(44, 44)
  .png()
  .toFile(out);

console.log(`generated ${out}`);
