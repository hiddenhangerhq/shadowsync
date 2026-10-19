// Render extension/icon.svg to static/icon-{16,32,48,128}.png (committed; run again after changing the SVG): node extension/render-icons.mjs
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(here, "icon.svg"));
for (const s of [16, 32, 48, 128]) await sharp(svg, { density: 72 * (s / 128) * 4 }).resize(s, s).png().toFile(join(here, "static", `icon-${s}.png`));
console.log("icons written to extension/static");
