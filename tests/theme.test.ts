import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { THEMES, THEME_IDS } from "../src/lib/data/types";
import { THEME_SCRIPT, isThemeId, resolveTheme } from "../src/lib/theme";
import { fitWithin } from "../src/lib/client/resize";

const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "src/app/globals.css"), "utf8");

function walk(dir: string, out: string[] = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

describe("themes", () => {
  it("lists system, light, dark, cyberpunk, retro and extras", () => {
    expect(THEME_IDS).toEqual(expect.arrayContaining(["system", "light", "dark", "cyberpunk", "retro", "midnight", "forest", "sunset"]));
    expect(THEMES[0].id).toBe("system");
  });
  it("system follows the OS; explicit choices win", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("cyberpunk", false)).toBe("cyberpunk");
    expect(isThemeId("retro")).toBe(true);
    expect(isThemeId("neon")).toBe(false);
  });
  it("inline script resolves the same way as resolveTheme (no flash)", () => {
    for (const pref of THEME_IDS) for (const dark of [true, false]) {
      const attrs: Record<string, string> = {};
      const doc = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v), getAttribute: (k: string) => attrs[k] } };
      const win = { matchMedia: () => ({ matches: dark }) };
      const ls = { getItem: () => pref };
      new Function("document", "window", "localStorage", THEME_SCRIPT)(doc, win, ls);
      expect(attrs["data-theme"]).toBe(resolveTheme(pref, dark));
      expect(attrs["data-theme-pref"]).toBe(pref);
    }
    const attrs: Record<string, string> = {};
    new Function("document", "window", "localStorage", THEME_SCRIPT)(
      { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v), getAttribute: () => "" } },
      { matchMedia: () => ({ matches: false }) }, { getItem: () => "garbage" });
    expect(attrs["data-theme"]).toBe("light"); // unknown value falls back to system
  });
  it("every selectable theme defines the full token set in CSS", () => {
    const tokens = ["--bg", "--surface", "--border", "--text", "--text-dim", "--accent", "--accent-contrast", "--gold", "--c1", "--c6", "--radius"];
    for (const id of THEME_IDS.filter((t) => t !== "system")) {
      const m = css.match(new RegExp(`\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`));
      expect(m, `block for ${id}`).toBeTruthy();
      if (id === "dark") continue; // dark inherits the :root defaults
      for (const t of tokens.filter((t) => t !== "--radius")) expect(m![1], `${id} ${t}`).toContain(t + ":");
    }
  });
  it("components and pages use tokens only (no hard-coded colors)", () => {
    const files = [...walk(path.join(root, "src/components")), ...walk(path.join(root, "src/app"))].filter((f) => /\.(tsx|ts)$/.test(f));
    const bad: string[] = [];
    for (const f of files) {
      const s = fs.readFileSync(f, "utf8");
      if (/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(s)) bad.push(path.relative(root, f));
    }
    // layout.tsx viewport themeColor is browser-chrome metadata, not UI styling.
    expect(bad.filter((f) => !f.endsWith("app/layout.tsx"))).toEqual([]);
    const globalsBody = css.slice(css.indexOf("*{box-sizing"));
    expect(globalsBody.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull(); // rules after the token blocks use var() only
  });
  it("only the supabase implementation imports @supabase/*", () => {
    const hits = walk(path.join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && /from\s+["']@supabase\//.test(fs.readFileSync(f, "utf8")));
    expect(hits.map((f) => path.basename(f))).toEqual(["supabase-impl.ts"]);
  });
});

describe("image resize math", () => {
  it("fits within max, keeps aspect, never upscales", () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });
});
