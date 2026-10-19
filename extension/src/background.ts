/// <reference types="chrome" />
// MV3 service worker. Wakes on alarms (poll 5 min, sales scan 15 min, sign-in check 30 min) and on messages that pass the gatekeeper.
import { API_ORIGIN, EXT_VERSION } from "./env";
import { makeApi } from "./api";
import { chromeBrowser } from "./chrome-browser";
import { chromeStore } from "./chrome-store";
import { pairingPageUrl, parseExternal, parseInternal, type HandlerConfig } from "./handler";
import * as w from "./worker";

let token: string | null = null;
const deps: w.Deps = {
  api: makeApi(API_ORIGIN, () => token), browser: chromeBrowser, now: () => Date.now(), rand: () => Math.random(), version: EXT_VERSION,
  store: { load: async () => { const s = await chromeStore.load(); token = s.token; return s; }, save: async (s) => { token = s.token; await chromeStore.save(s); } },
};
const cfg: HandlerConfig = { apiOrigin: API_ORIGIN, extensionId: chrome.runtime.id };

// One task at a time: a poll, a scan and a sign-in check never overlap in this browser.
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn, fn); chain = p.catch(() => undefined); return p; };

function browserLabel() {
  const ua = navigator.userAgent;
  const name = /Edg\//.test(ua) ? "Edge" : "Chrome";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "computer";
  return `${name} on ${os}`;
}
function setupAlarms() {
  chrome.alarms.create("poll", { periodInMinutes: 5, delayInMinutes: 0.5 });
  chrome.alarms.create("scan", { periodInMinutes: 15, delayInMinutes: 2 });
  chrome.alarms.create("login", { periodInMinutes: 30, delayInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener((info) => {
  setupAlarms(); void serial(() => w.upgrade(deps));
  // One-click pairing: right after install, open our own site's Connect page; it hands this browser a one-time code by message.
  if (info.reason === "install") void chrome.tabs.create({ url: pairingPageUrl(API_ORIGIN, chrome.runtime.id) });
});
chrome.runtime.onStartup.addListener(setupAlarms);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "poll" || a.name === "pollSoon") void pollChain();
  else if (a.name === "scan") void serial(() => w.scan(deps));
  else if (a.name === "login") void serial(() => w.checkAllLogins(deps));
});

// Back-to-back queue: after a poll that ran jobs, poll again as soon as pacing allows (a timer for short waits keeps the worker awake;
// a one-off alarm for longer ones). An empty poll ends the chain; the 5-minute alarm picks up new work.
let soon: ReturnType<typeof setTimeout> | null = null;
async function pollChain(): Promise<Awaited<ReturnType<typeof w.poll>>> {
  const r = await serial(() => w.poll(deps));
  if ("ran" in r && r.ran > 0) {
    const ms = await w.nextWakeMs(deps);
    if (soon) { clearTimeout(soon); soon = null; }
    if (ms <= 25_000) soon = setTimeout(() => { soon = null; void pollChain(); }, Math.max(ms, 500) + 250);
    else if (Number.isFinite(ms)) chrome.alarms.create("pollSoon", { when: Date.now() + ms + 1000 });
  }
  return r;
}

async function status() {
  const s = await deps.store.load();
  return { ok: true, paired: !!s.token, deviceId: s.deviceId, version: EXT_VERSION, paused: s.pacing.devicePaused, speed: s.pacing.speed ?? {} };
}

// Our dashboard page (only API_ORIGIN is listed in externally_connectable, and parseExternal checks again).
chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  const p = parseExternal(msg, { id: sender.id, url: sender.url, origin: (sender as { origin?: string }).origin }, cfg);
  if (!p.ok) { reply({ ok: false, error: p.reason }); return false; }
  const r = p.req;
  const work = r.type === "status" ? status()
    : r.type === "speed" ? serial(() => w.setMarketplaceSpeed(deps, r.marketplace, r.speed)).then(() => ({ ok: true }))
    : r.type === "pair" ? serial(() => w.pair(deps, r.code, browserLabel())).then((x) => ({ ok: true, ...x }))
    : serial(() => w.checkLogin(deps, r.marketplace)).then((x) => (x.ok ? { ok: true, loggedIn: x.loggedIn ?? null } : { ok: false, error: x.message }));
  work.then(reply, (e: Error) => reply({ ok: false, error: e.message }));
  return true;
});

// The popup.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const p = parseInternal(msg, { id: sender.id, url: sender.url, origin: (sender as { origin?: string }).origin, tab: sender.tab }, cfg);
  if (!p.ok) { reply({ ok: false, error: p.reason }); return false; }
  const r = p.req;
  const run = async (): Promise<unknown> => {
    switch (r.type) {
      case "state": return { ok: true, state: redact(await deps.store.load()), connected: await w.connected(deps), apiOrigin: API_ORIGIN, version: EXT_VERSION };
      case "pollNow": return { ok: true, ...(await pollChain()) };
      case "scanNow": return { ok: true, ...(await serial(() => w.scan(deps, { salesOnly: true }))) };
      case "pair": if (!r.code) throw new Error("Enter the code"); return { ok: true, ...(await serial(() => w.pair(deps, r.code!, browserLabel()))) };
      case "unpair": await w.unpair(deps); return { ok: true };
      case "pauseDevice": await w.pauseDevice(deps, r.paused === true); return { ok: true };
      case "pauseMarketplace": if (!r.marketplace) throw new Error("marketplace?"); await w.pauseMarketplace(deps, r.marketplace, r.paused === true); return { ok: true };
      case "connected": case "checkLogin": {
        if (!r.marketplace) throw new Error("marketplace?");
        const x = await serial(() => w.checkLogin(deps, r.marketplace!));
        return x.ok ? { ok: true, loggedIn: x.loggedIn ?? null } : { ok: false, error: x.message };
      }
    }
  };
  run().then(reply, (e: Error) => reply({ ok: false, error: e.message }));
  return true;
});
/** The popup never sees the token. */
const redact = (s: w.ExtState) => ({ ...s, token: s.token ? "set" : null });
