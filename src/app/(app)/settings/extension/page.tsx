import Link from "next/link";
import { getServices } from "@/lib/data";
import { SchemaMissingError, type ExtensionDevice, type MarketplaceLoginState, type MarketplaceSetting } from "@/lib/data/types";
import { EXT_MARKETPLACES, HOST_TABLE } from "@/lib/ext/protocol";
import PairBox from "./PairBox";
import { pauseDeviceAction, pauseMarketplaceAction, revokeDeviceAction, setSoldActionAction } from "./actions";

export const dynamic = "force-dynamic";
const when = (t: string | null) => (t ? new Date(t).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" }) + " PT" : "never");

export default async function ExtensionSettings({ searchParams }: { searchParams: Promise<{ ext?: string }> }) {
  const sp = await searchParams;
  const extId = sp.ext && /^[a-p]{32}$/.test(sp.ext) ? sp.ext : null;
  const { store } = await getServices();
  let devices: ExtensionDevice[] = [], states: MarketplaceLoginState[] = [], settings: MarketplaceSetting[] = [], missing = false;
  try { [devices, states, settings] = await Promise.all([store.devices.list(), store.devices.marketplaceState(), store.marketplaceSettings.list()]); }
  catch (e) { if (e instanceof SchemaMissingError) missing = true; else throw e; }
  const live = devices.filter((d) => !d.revokedAt);
  return (
    <>
      <p className="small"><Link href="/settings">Settings</Link> / Extension</p>
      <h1>Browser extension</h1>
      <div className="card">
        <h2>Pair a browser</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          The extension works inside your own signed-in browser (Chrome or Edge) for marketplaces without an official API.
          It only does the fixed jobs ShadowSync queues (delist, mark sold, quantity, edits, new-listing drafts, reading your sales),
          paces itself, and stops to ask you on anything unexpected. It never sees your marketplace passwords.
        </p>
        {missing ? <div className="banner">Pairing turns on after the one-time database setup step (<b>0006</b>).</div> : <PairBox extId={extId} />}
      </div>
      <div className="card">
        <h2>Your browsers</h2>
        {!missing && live.length === 0 && <p className="muted small">No browser paired yet.</p>}
        {live.map((d) => (
          <div key={d.id} style={{ borderTop: "1px solid var(--border)", padding: "10px 0" }}>
            <div className="row between">
              <div><b>{d.label}</b> {d.paused && <span className="pill">paused</span>}
                <div className="muted small">v{d.extensionVersion ?? "?"} · last seen {when(d.lastSeenAt)}</div></div>
              <div className="row">
                <form action={pauseDeviceAction.bind(null, d.id, !d.paused)}><button className="btn sm">{d.paused ? "Resume" : "Pause"}</button></form>
                <form action={revokeDeviceAction.bind(null, d.id)}><button className="btn sm danger">Remove</button></form>
              </div>
            </div>
            {EXT_MARKETPLACES.filter((m) => HOST_TABLE[m].supported || states.some((s) => s.deviceId === d.id && s.marketplace === m)).map((m) => {
              const s = states.find((x) => x.deviceId === d.id && x.marketplace === m);
              return (
                <div key={m} className="row between small" style={{ padding: "4px 0 0 12px" }}>
                  <span>{HOST_TABLE[m].label}: {s ? (s.loggedIn ? "signed in" : "signed out") : "not connected"}{s?.paused ? ` · paused${s.pausedReason ? ` (${s.pausedReason})` : ""}` : ""}</span>
                  {s && <form action={pauseMarketplaceAction.bind(null, d.id, m, !s.paused)}><button className="btn sm">{s.paused ? "Resume" : "Pause"}</button></form>}
                </div>
              );
            })}
          </div>
        ))}
        <p className="muted small">Pause stops new jobs on that browser (waiting jobs stay in the queue). Remove signs the extension out for good.</p>
      </div>
      <div className="card">
        <h2>When an item sells</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Once a sale is confirmed (stored and matched to your item), its other listings are <b>deleted</b> on those marketplaces. If a delete
          is blocked (for example an active offer), the listing is set to <b>Not For Sale</b> instead and the item shows in <b>Sold but still active</b>.
          Unmatched sales never delete anything. Deleting on a marketplace never deletes anything in Shadow Sync: photos, price, SKU, the sale and
          the listing history stay. A Sold item can&apos;t be listed again until you undo the sale on the item.
        </p>
        {missing ? <p className="muted small">This setting turns on after setup step 0006 (until then: delete, with the Not For Sale fallback).</p> :
          EXT_MARKETPLACES.map((m) => {
            const cur = settings.find((x) => x.marketplace === m)?.soldAction ?? "delete";
            return (
              <form key={m} action={setSoldActionAction.bind(null, m)} className="row between small" style={{ padding: "4px 0" }}>
                <span>{HOST_TABLE[m].label}{HOST_TABLE[m].supported ? "" : " (later)"}</span>
                <span className="row">
                  <select name="soldAction" defaultValue={cur} className="input" style={{ minHeight: 34, width: "auto" }} aria-label={`${HOST_TABLE[m].label}: when an item sells`}>
                    <option value="delete">Delete (fallback: Not For Sale)</option>
                    <option value="not_for_sale">Set to Not For Sale</option>
                  </select>
                  <button className="btn sm">Save</button>
                </span>
              </form>
            );
          })}
      </div>
    </>
  );
}
