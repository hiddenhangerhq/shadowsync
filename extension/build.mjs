// Build the unpacked extension (extension/dist) and the zip (/workspace/shadowsync-extension.zip by default).
//   SHADOWSYNC_API_ORIGIN=https://your-app.vercel.app npm run build:extension
import * as esbuild from "esbuild";
import { zipSync } from "fflate";
import { mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const zipPath = process.env.SHADOWSYNC_EXTENSION_ZIP || "/workspace/shadowsync-extension.zip";
const version = JSON.parse(readFileSync(join(here, "version.json"), "utf8")).version;

// Load manifest.ts (bundled to a temp ESM file) so the build and the tests use the same manifest code.
const tmp = join(here, ".manifest.tmp.mjs");
await esbuild.build({ entryPoints: [join(here, "src/manifest.ts")], bundle: true, format: "esm", platform: "node", outfile: tmp, logLevel: "silent" });
const { buildManifest, apiOriginFrom, BRAND, EXT_NAME } = await import(pathToFileURL(tmp).href + `?t=${Date.now()}`);
rmSync(tmp);
const origin = apiOriginFrom(process.env.SHADOWSYNC_API_ORIGIN);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await esbuild.build({
  entryPoints: { background: join(here, "src/background.ts"), popup: join(here, "src/popup.ts"), content: join(here, "src/content/entry.ts") },
  bundle: true, format: "iife", target: ["chrome116", "edge116"], outdir: dist, minify: false, legalComments: "none", logLevel: "warning",
  define: { __API_ORIGIN__: JSON.stringify(origin), __EXT_VERSION__: JSON.stringify(version) },
});
// Brand name from src/brand.ts: fill the popup, and keep the README's marked spans in step.
const fill = (t) => t.replaceAll("{{EXT_NAME}}", EXT_NAME).replaceAll("{{BRAND}}", BRAND);
for (const f of readdirSync(join(here, "static"))) {
  if (f.endsWith(".html")) writeFileSync(join(dist, f), fill(readFileSync(join(here, "static", f), "utf8")));
  else copyFileSync(join(here, "static", f), join(dist, f));
}
const readme = join(here, "..", "README.md");
const rd = readFileSync(readme, "utf8");
const rd2 = rd.replace(/<!--brand-->.*?<!--\/brand-->/g, `<!--brand-->${BRAND}<!--/brand-->`).replace(/<!--extname-->.*?<!--\/extname-->/g, `<!--extname-->${EXT_NAME}<!--/extname-->`);
if (rd2 !== rd) writeFileSync(readme, rd2);
writeFileSync(join(dist, "manifest.json"), JSON.stringify(buildManifest(origin, version), null, 2));

// No eval / new Function / remote scripts in what we ship.
for (const f of readdirSync(dist).filter((x) => x.endsWith(".js"))) {
  const src = readFileSync(join(dist, f), "utf8");
  if (/\beval\s*\(|new Function\s*\(|importScripts\s*\(/.test(src)) throw new Error(`${f} contains dynamic code`);
}
const files = Object.fromEntries(readdirSync(dist).map((f) => [f, readFileSync(join(dist, f))]));
writeFileSync(zipPath, zipSync(files, { level: 9 }));
console.log(`Built ${EXT_NAME} v${version} for ${origin}\n  unpacked: ${dist}\n  zip: ${zipPath} (${Object.keys(files).length} files)`);
