/// <reference types="chrome" />
// Popup: pair, kill switch (this browser + per marketplace), connect a marketplace (grants only that site's permission), status.
import { EXT_MARKETPLACES, HOST_TABLE, type ExtMarketplace } from "../../src/lib/ext/protocol";
import { originsFor } from "./chrome-browser";
import { pairingPageUrl } from "./handler";
import type { ExtState } from "./worker";
import { nextActionText, readiness, speedOf, todayCounts } from "./pacing";

type StateReply = { ok: boolean; state: ExtState; connected: ExtMarketplace[]; version: string; apiOrigin: string; error?: string };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T = { ok: boolean; error?: string }>(msg: unknown) => chrome.runtime.sendMessage(msg) as Promise<T>;
const ago = (t: number | null) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 60000))} min ago` : "never");
const el = (tag: string, text = "", cls = "") => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; };
const say = (t: string) => { $("msg").textContent = t; };

async function render() {
  const r = await send<StateReply>({ type: "state" });
  if (!r?.ok) return say(r?.error ?? "Extension not ready");
  const s = r.state;
  $("version").textContent = `v${r.version}`;
  $("pair").hidden = !!s.token; $("main").hidden = !s.token;
  if (!s.token) return;
  const paused = s.pacing.devicePaused;
  $("device").textContent = s.deviceLabel ?? "This browser";
  $("pauseDevice").textContent = paused ? "Resume" : "Pause all";
  const note = paused ? "Paused here: nothing runs in this browser until you resume." : s.server?.devicePaused ? "Paused from the dashboard (Settings > Extension)." : "";
  $("pausedNote").textContent = note; $("pausedNote").hidden = !note;
  $("lastPoll").textContent = `Last check ${ago(s.lastPollAt)}`;
  $("err").textContent = s.lastError ?? ""; $("err").hidden = !s.lastError;
  const ul = $("mps"); ul.replaceChildren();
  for (const m of EXT_MARKETPLACES) {
    const h = HOST_TABLE[m], li = el("li"), top = el("div", "", "row");
    top.append(el("span", h.label));
    if (!h.supported) { top.append(el("span", "coming later", "badge")); li.append(top); ul.append(li); continue; }
    const isConn = r.connected.includes(m);
    if (!isConn) {
      const b = el("button", "Connect") as HTMLButtonElement;
      // Must run from this click (user gesture). Grants ONLY this marketplace's site.
      b.onclick = async () => { if (await chrome.permissions.request({ origins: originsFor(m) })) { say("Checking sign-in..."); const x = await send<{ ok: boolean; loggedIn?: boolean; error?: string }>({ type: "connected", marketplace: m }); say(x.ok ? (x.loggedIn === false ? `Sign in to ${h.label} in this browser` : x.loggedIn ? "Signed in" : "Connected (sign-in unknown; jobs will still run)") : (x.error ?? "")); } void render(); };
      top.append(b); li.append(top); ul.append(li); continue;
    }
    const login = s.logins[m];
    top.append(el("span", !login ? "not checked" : login.loggedIn === true ? "signed in" : login.loggedIn === false ? "signed out" : "sign-in unknown", `badge ${login?.loggedIn === false ? "bad" : login?.loggedIn ? "ok" : ""}`));
    li.append(top);
    const v = readiness(s.pacing, m, Date.now()), mpPaused = !!s.pacing.mp[m]?.paused;
    const srv = s.server?.paused[m];
    const counts = todayCounts(s.pacing, m, Date.now());
    const done = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
    li.append(el("div", `${v.ok ? "Ready" : v.reason}${srv ? ` · dashboard: ${srv}` : ""} · ${done} today`, "muted"));
    if (!v.ok && v.spacing && v.until) li.append(el("div", `${nextActionText(v.until, Date.now())} (spacing to stay safe)${v.urgentOk ? "; delists still go first" : ""}`, "muted"));
    if (speedOf(s.pacing, m) === "careful") li.append(el("div", "Speed: Careful (slower; change it in Settings > Extension)", "muted"));
    const row = el("div", "", "row");
    const autoUntil = s.pacing.mp[m]?.pausedUntil ?? 0;
    const autoPaused = !mpPaused && autoUntil > Date.now();
    if (autoPaused) {
      const at = new Date(autoUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const rowA = el("div", "", "row");
      const rb = el("button", "Resume now") as HTMLButtonElement;
      rb.onclick = async () => { if (!confirm(`${h.label} paused itself after several errors. Resume now anyway?`)) return; await send({ type: "pauseMarketplace", marketplace: m, paused: false }); void render(); };
      rowA.append(el("span", `Auto-paused until ${at}.`, "warn"), rb); li.append(rowA);
    }
    const p = el("button", mpPaused ? "Resume" : "Pause") as HTMLButtonElement;
    p.onclick = async () => {
      // Resume also clears an automatic pause (errors or security checks); confirm when it was not your own pause.
      const reason = s.pacing.mp[m]?.pausedReason ?? "";
      if (mpPaused && !/by you/i.test(reason) && !confirm(`${reason || "Paused automatically"}. Resume now?`)) return;
      await send({ type: "pauseMarketplace", marketplace: m, paused: !mpPaused }); void render();
    };
    const c = el("button", "Check sign-in") as HTMLButtonElement;
    c.onclick = async () => { say("Checking..."); const x = await send<{ ok: boolean; loggedIn?: boolean; error?: string }>({ type: "checkLogin", marketplace: m }); say(x.ok ? (x.loggedIn === true ? "Signed in" : x.loggedIn === false ? "Signed out" : "Could not tell; jobs will still run") : (x.error ?? "")); void render(); };
    const d = el("button", "Disconnect", "link") as HTMLButtonElement;
    d.onclick = async () => { await chrome.permissions.remove({ origins: originsFor(m) }); void render(); };
    row.append(p, c, d); li.append(row); ul.append(li);
  }
  const log = $("log"); log.replaceChildren(...s.log.slice(0, 10).map((l) => el("li", `${new Date(l.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} ${l.text}`)));
}

$("pairForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $<HTMLInputElement>("code").value.trim();
  say("Pairing...");
  const r = await send({ type: "pair", code });
  say(r.ok ? "Paired" : (r.error ?? "Pairing failed"));
  void render();
});
$("openPair").addEventListener("click", async () => {
  const r = await send<StateReply>({ type: "state" });
  // The page hands the code straight back to this extension (externally_connectable allows only our own site).
  await chrome.tabs.create({ url: pairingPageUrl(r.apiOrigin, chrome.runtime.id) });
});
$("pauseDevice").addEventListener("click", async () => {
  const r = await send<StateReply>({ type: "state" });
  await send({ type: "pauseDevice", paused: !r.state.pacing.devicePaused });
  void render();
});
$("pollNow").addEventListener("click", async () => { say("Checking..."); const r = await send<{ ok: boolean; ran?: number; notes?: string[]; skipped?: string; error?: string }>({ type: "pollNow" }); say(r.ok ? (r.skipped ? `Skipped: ${r.skipped}` : [`${r.ran ?? 0} job(s) run`, ...(r.notes ?? [])].join(" · ")) : (r.error ?? "")); void render(); });
$("scanNow").addEventListener("click", async () => { say("Scanning sales..."); const r = await send<{ ok: boolean; notes?: string[]; error?: string }>({ type: "scanNow" }); say(r.ok ? (r.notes?.join(" · ") || "Nothing connected to scan") : (r.error ?? "")); void render(); });
$("unpair").addEventListener("click", async () => { if (confirm("Unpair this browser? Also revoke it in Settings > Extension.")) { await send({ type: "unpair" }); void render(); } });
void render();
setInterval(() => void render(), 2000); // keeps "Next action in about N s" current
