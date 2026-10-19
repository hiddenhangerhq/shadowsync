"use client";
// Speed per marketplace, kept in this browser's extension (Normal = Vendoo-like 2-10 s between actions; Careful = the slower 1.0.3 pace).
import { useEffect, useState } from "react";
import { ask, ID_RE, KEY } from "./PairBox";

type Speed = "normal" | "careful";
export default function SpeedBox({ extId: fromUrl, marketplaces }: { extId: string | null; marketplaces: { id: string; label: string }[] }) {
  const [extId, setExtId] = useState<string | null>(fromUrl);
  const [speed, setSpeed] = useState<Record<string, Speed> | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    const id = fromUrl ?? window.localStorage.getItem(KEY);
    if (!id || !ID_RE.test(id)) { setMsg("Open this page from the extension (or connect it above) to change speed."); return; }
    setExtId(id);
    void ask<{ ok?: boolean; speed?: Record<string, Speed> }>(id, { type: "status" }).then((r) => {
      if (r?.ok) setSpeed(r.speed ?? {}); else setMsg("The extension is not reachable in this browser.");
    });
  }, [fromUrl]);
  async function change(m: string, s: Speed) {
    if (!extId) return;
    const r = await ask<{ ok?: boolean; error?: string }>(extId, { type: "speed", marketplace: m, speed: s });
    if (r?.ok) { setSpeed((x) => ({ ...(x ?? {}), [m]: s })); setMsg("Saved in this browser's extension."); }
    else setMsg(r?.error === "invalid: speed needs a marketplace and normal / careful" || !r ? "Update the extension to 1.0.4 to change speed." : (r.error ?? "Could not save"));
  }
  return (
    <div>
      {speed && marketplaces.map((m) => (
        <div key={m.id} className="row between small" style={{ padding: "4px 0" }}>
          <span>{m.label}</span>
          <select value={speed[m.id] ?? "normal"} onChange={(e) => void change(m.id, e.target.value as Speed)} aria-label={`${m.label} speed`}>
            <option value="normal">Normal (2-10 s between actions)</option>
            <option value="careful">Careful (20-90 s, longer breaks)</option>
          </select>
        </div>
      ))}
      {msg && <p className="muted small">{msg}</p>}
    </div>
  );
}
