import Link from "next/link";
import { getServices } from "@/lib/data";
import { SchemaMissingError, type AlertPrefs } from "@/lib/data/types";
import AlertsForm from "./AlertsForm";

export const dynamic = "force-dynamic";

export default async function AlertSettings() {
  const { store } = await getServices();
  let prefs: AlertPrefs | null = null;
  try { prefs = await store.alerts.get(); } catch (e) { if (!(e instanceof SchemaMissingError)) throw e; }
  return (
    <>
      <p className="small"><Link href="/settings">Settings</Link> / Alerts</p>
      <h1>Alerts</h1>
      <div className="card">
        <h2>Text alerts (SMS)</h2>
        <div className="banner" style={{ marginBottom: 12 }}>
          <b>Provider not set up yet.</b> You can save your choice now, but no texts are sent until a text-message provider is connected
          (none is, to keep this free). Until then, check the dashboard banner and Needs action list.
        </div>
        {prefs ? <AlertsForm smsEnabled={prefs.smsEnabled} phone={prefs.phone} /> : <p className="muted small">Alerts turn on after the one-time database setup step (0006).</p>}
      </div>
    </>
  );
}
