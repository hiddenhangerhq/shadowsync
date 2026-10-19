"use client";
import { useEffect, useRef, useState } from "react";
import { startPairingAction } from "./actions";

type ChromeLike = { runtime?: { sendMessage?: (id: string, msg: unknown, cb: (r: unknown) => void) => void; lastError?: unknown } };
type Status = { ok?: boolean; paired?: boolean; deviceId?: string | null; version?: string };
export const KEY = "ss_ext_id";
export const ID_RE = /^[a-p]{32}$/;

/** Ask the extension (only our own site may talk to it: externally_connectable + the extension's origin check). null = not there. */
export function ask<T>(extId: string, msg: unknown): Promise<T | null> {
  const c = (globalThis as { chrome?: ChromeLike }).chrome;
  if (!c?.runtime?.sendMessage) return Promise.resolve(null);
  return new Promise((res) => {
    const t = setTimeout(() => res(null), 4000);
    try { c.runtime!.sendMessage!(extId, msg, (r) => { clearTimeout(t); void c.runtime?.lastError; res((r as T) ?? null); }); }
    catch { clearTimeout(t); res(null); }
  });
}

/**
 * One-click pairing (David, 2026-10-19): the extension opens this page right after install (?ext=<its id>). The page finds it, gets a
 * one-time 5-minute code for you and hands it to the extension by message; nothing is typed. The typed code stays as a hidden fallback.
 */
export default function PairBox({ extId: fromUrl, liveDeviceIds, auto }: { extId: string | null; liveDeviceIds: string[]; auto: boolean }) {
  const [extId, setExtId] = useState<string | null>(fromUrl);
  const [st, setSt] = useState<"looking" | "missing" | "unpaired" | "paired" | "busy">("looking");
  const [msg, setMsg] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const tried = useRef(false);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  async function connect() {
    if (!extId) return;
    setSt("busy"); setMsg("Connecting...");
    const r = await startPairingAction();
    if ("error" in r) { setSt("unpaired"); setMsg(r.error); return; }
    const x = await ask<{ ok?: boolean; label?: string; error?: string }>(extId, { type: "pair", code: r.code });
    if (x?.ok) { setSt("paired"); setMsg(`Connected as "${x.label}".`); setTimeout(() => location.replace("/settings/extension"), 1200); }
    else { setSt("unpaired"); setMsg(`Could not connect${x?.error ? `: ${x.error}` : ""}. Try again, or use a code below.`); }
  }

  useEffect(() => {
    const id = fromUrl ?? (() => { try { const v = localStorage.getItem(KEY); return v && ID_RE.test(v) ? v : null; } catch { return null; } })();
    if (fromUrl) { try { localStorage.setItem(KEY, fromUrl); } catch { /* private mode */ } }
    setExtId(id);
    if (!id) { setSt("missing"); return; }
    void ask<Status>(id, { type: "status" }).then((s) => {
      if (!s?.ok) { setSt("missing"); return; }
      const paired = !!s.paired && !!s.deviceId && liveDeviceIds.includes(s.deviceId);
      setSt(paired ? "paired" : "unpaired");
      // First visit after install (the extension opened this page): connect without a click, once.
      if (!paired && auto && !tried.current) { tried.current = true; void connectRef.current(); }
    });
  }, [fromUrl, auto, liveDeviceIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const connectRef = useRef(connect); connectRef.current = connect;

  async function showCode() {
    const r = await startPairingAction();
    if ("error" in r) { setMsg(r.error); return; }
    setCode(r.code); setUntil(Date.parse(r.expiresAt));
  }
  const left = Math.max(0, Math.round((until - now) / 1000));
  return (
    <div>
      {st === "looking" && <p className="muted small">Looking for the extension in this browser...</p>}
      {st === "paired" && <p className="okmsg">✓ This browser is connected.</p>}
      {(st === "unpaired" || st === "busy") && <button className="btn primary" onClick={connect} disabled={st === "busy"}>Connect this browser</button>}
      {st === "missing" && <p className="small">The extension was not found in this browser. Install it (see <b>Get the extension</b>), and this page opens by itself to connect.</p>}
      {msg && <p className="small">{msg}</p>}
      <details style={{ marginTop: 10 }}>
        <summary className="small muted">Pair with a code instead</summary>
        <button className="btn sm" onClick={showCode} style={{ marginTop: 6 }}>Show a code</button>
        {code && left > 0 && (
          <div className="banner" style={{ marginTop: 10 }}>
            Your code: <b style={{ fontSize: "1.4rem", letterSpacing: 2 }}>{code}</b>
            <div className="small">Open the extension, choose &quot;Have a code?&quot; and type it. It works once and expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}.</div>
          </div>
        )}
        {code && left === 0 && <p className="small muted">That code expired. Press the button again for a new one.</p>}
      </details>
    </div>
  );
}
