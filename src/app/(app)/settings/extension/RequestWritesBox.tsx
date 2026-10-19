"use client";
// Who gets Poshmark listing changes over background requests (unconfirmed write shapes). Default: TEST items only.
import { useEffect, useState } from "react";
import { ask, ID_RE, KEY } from "./PairBox";

type Mode = "test" | "all";
export default function RequestWritesBox({ extId: fromUrl }: { extId: string | null }) {
  const [extId, setExtId] = useState<string | null>(fromUrl);
  const [mode, setMode] = useState<Mode | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    const id = fromUrl ?? window.localStorage.getItem(KEY);
    if (!id || !ID_RE.test(id)) { setMsg("Open this page from the extension (or connect it above) to change this."); return; }
    setExtId(id);
    void ask<{ ok?: boolean; requestWrites?: Mode }>(id, { type: "status" }).then((r) => {
      if (r?.ok) setMode(r.requestWrites ?? "test"); else setMsg("The extension is not reachable in this browser.");
    });
  }, [fromUrl]);
  async function change(m: Mode) {
    if (!extId) return;
    const r = await ask<{ ok?: boolean; error?: string }>(extId, { type: "requestWrites", mode: m });
    if (r?.ok) { setMode(m); setMsg(m === "all" ? "Saved. Every Poshmark listing change now uses background requests — watch the first few." : "Saved. Only TEST items use background request writes."); }
    else setMsg(r?.error === "invalid: requestWrites needs mode test / all" || !r ? "Update the extension to 1.0.7 to change this." : (r.error ?? "Could not save"));
  }
  return (
    <div>
      {mode && (
        <div className="row between small" style={{ padding: "4px 0" }}>
          <span>Poshmark request writes</span>
          <select value={mode} onChange={(e) => void change(e.target.value as Mode)} aria-label="Poshmark request writes">
            <option value="test">TEST items only (SKU starts with TEST)</option>
            <option value="all">Every listing (unconfirmed shapes — watch the first few)</option>
          </select>
        </div>
      )}
      <p className="muted small">Sign-in check, sales scan and closet always use background requests. Price, title, Not For Sale, quantity and delete use them only for the items above, until a second recording confirms the save shape.</p>
      {msg && <p className="muted small">{msg}</p>}
    </div>
  );
}
