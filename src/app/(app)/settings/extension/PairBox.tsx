"use client";
import { useEffect, useState } from "react";
import { startPairingAction } from "./actions";

type ChromeLike = { runtime?: { sendMessage?: (id: string, msg: unknown, cb: (r: unknown) => void) => void; lastError?: unknown } };
/** Pair this browser: shows a one-time code (5 minutes). If the extension opened this page (?ext=<id>), hand the code over directly. */
export default function PairBox({ extId }: { extId: string | null }) {
  const [code, setCode] = useState<string | null>(null);
  const [until, setUntil] = useState<number>(0);
  const [msg, setMsg] = useState<string>("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, Math.round((until - now) / 1000));

  async function pair() {
    setMsg("");
    const r = await startPairingAction();
    if ("error" in r) { setMsg(r.error); return; }
    setCode(r.code); setUntil(Date.parse(r.expiresAt));
    const c = (globalThis as { chrome?: ChromeLike }).chrome;
    if (extId && c?.runtime?.sendMessage) {
      c.runtime.sendMessage(extId, { type: "pair", code: r.code }, (res) => {
        const x = res as { ok?: boolean; label?: string; error?: string } | undefined;
        if (x?.ok) { setMsg(`Paired as "${x.label}". You can close this tab.`); setCode(null); setTimeout(() => location.reload(), 1500); }
        else setMsg("Type the code into the extension popup instead.");
      });
    }
  }
  return (
    <div>
      <button className="btn primary" onClick={pair}>Pair this browser</button>
      {code && left > 0 && (
        <div className="banner" style={{ marginTop: 10 }}>
          Your code: <b style={{ fontSize: "1.4rem", letterSpacing: 2 }}>{code}</b>
          <div className="small">Click the ShadowSync icon in your browser toolbar and type this code. It works once and expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}.</div>
        </div>
      )}
      {code && left === 0 && <p className="small muted">That code expired. Press the button again for a new one.</p>}
      {msg && <p className="small">{msg}</p>}
    </div>
  );
}
