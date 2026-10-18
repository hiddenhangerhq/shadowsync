import { THEME_IDS, type ThemeId } from "./data/types";

export const THEME_STORAGE_KEY = "ss-theme";

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && (THEME_IDS as string[]).includes(v);
}

/** What data-theme should be on <html> for a given preference. */
export function resolveTheme(pref: ThemeId, prefersDark: boolean): Exclude<ThemeId, "system"> {
  return pref === "system" ? (prefersDark ? "dark" : "light") : pref;
}

/**
 * Inline script, runs in <head> before first paint (no flash). Keep it dependency-free.
 * Mirrors resolveTheme(); tests check both agree.
 */
export const THEME_SCRIPT = `(function(){try{
var ids=${JSON.stringify(THEME_IDS)};var p=localStorage.getItem("${THEME_STORAGE_KEY}");
if(ids.indexOf(p)<0)p="system";
var mq=window.matchMedia("(prefers-color-scheme: dark)");
var d=document.documentElement;
function a(){d.setAttribute("data-theme",p==="system"?(mq.matches?"dark":"light"):p);d.setAttribute("data-theme-pref",p);}
a();if(mq.addEventListener)mq.addEventListener("change",function(){if(d.getAttribute("data-theme-pref")==="system")a();});
}catch(e){}})();`;

/** Client-side apply + persist (used by the picker and by ThemeSync). */
export function applyTheme(pref: ThemeId) {
  try { localStorage.setItem(THEME_STORAGE_KEY, pref); } catch { /* private mode */ }
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const d = document.documentElement;
  d.setAttribute("data-theme", resolveTheme(pref, dark));
  d.setAttribute("data-theme-pref", pref);
}
