/// <reference types="chrome" />
// The real Browser for the runner, using only APIs that Chrome and Edge (MV3) both have: tabs (without the "tabs" permission;
// the tab URL is readable because we hold that site's host permission), scripting and permissions.
import { HOST_TABLE, type ExtMarketplace } from "../../src/lib/ext/protocol";
import type { Browser } from "./runner";
import type { StepResult } from "./steps";

export const originsFor = (m: ExtMarketplace): string[] => [...HOST_TABLE[m].permissions];
// Chrome can swap a tab for another (prerender / instant navigation): follow the new id instead of failing "No tab with id".
const replaced = new Map<number, number>();
try { chrome.tabs.onReplaced.addListener((added, removed) => { replaced.set(removed, added); }); } catch { /* not in tests */ }
const live = (id: number) => { let t = id; for (let i = 0; i < 5 && replaced.has(t); i++) t = replaced.get(t)!; return t; };
export const chromeBrowser: Browser = {
  async open(url) { const t = await chrome.tabs.create({ url, active: false }); if (t.id === undefined) throw new Error("Could not open a tab"); return t.id; },
  async navigate(tabId, url) { await chrome.tabs.update(live(tabId), { url }); },
  async waitLoaded(tabId, timeoutMs) {
    const end = Date.now() + timeoutMs;
    await new Promise((r) => setTimeout(r, 400));
    while (Date.now() < end) {
      const t = await chrome.tabs.get(live(tabId));
      if (t.status === "complete") { await new Promise((r) => setTimeout(r, 1200)); return; } // let the page's scripts render
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("timeout");
  },
  async url(tabId) { return (await chrome.tabs.get(live(tabId))).url ?? ""; },
  async step(id, input) {
    const tabId = live(id);
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (i: unknown) => (globalThis as unknown as { __shadowsync: { step: (x: unknown) => unknown } }).__shadowsync.step(i),
      args: [input],
    });
    const v = r?.result as StepResult | undefined;
    if (!v || typeof v !== "object" || !("kind" in v)) return { kind: "stop", code: "unexpected_page", message: "The page did not answer" };
    return v;
  },
  async close(tabId) { await chrome.tabs.remove(live(tabId)).catch(() => undefined); replaced.delete(tabId); },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  hasPermission: (m) => chrome.permissions.contains({ origins: originsFor(m) }),
};
