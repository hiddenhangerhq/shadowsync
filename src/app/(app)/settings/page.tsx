import { getServices } from "@/lib/data";
import ThemePicker from "@/components/ThemePicker";
import { logoutAction } from "@/app/auth-actions";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const { store, auth } = await getServices();
  const [profile, user, balance, conns] = await Promise.all([store.profile.get(), auth.getUser(), store.creditLedger.balance(), store.connections.list()]);
  return (
    <>
      <h1>Settings</h1>
      <div className="card">
        <h2>Theme</h2>
        <p className="muted small" style={{ marginTop: 0 }}>System follows your device. Your choice is saved to your account and this device.</p>
        <ThemePicker initial={profile?.theme ?? "system"} />
      </div>
      <div className="card">
        <h2>Marketplace connections</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Two ways to connect, and nothing else: <b>Official API</b> (you approve access on the marketplace&apos;s own
          page; we never see or store your marketplace password) and <b>Chrome extension</b> (works inside your own
          logged-in browser, for sites without an API). Shadow Sync does not read your email.
        </p>
        {conns.length === 0 && <div className="banner">No marketplaces connected yet. Connecting arrives in a later build step.</div>}
        {conns.map((c) => (
          <div key={c.id} className="row between small" style={{ padding: "4px 0" }}>
            <span>{c.marketplace} · {c.connectionType === "oauth_api" ? "Official API" : "Chrome extension"}</span>
            <span className="pill">{c.status.replace("_", " ")}</span>
          </div>
        ))}
      </div>
      <div className="card">
        <h2>Account</h2>
        <div className="row between small"><span className="muted">Email</span><span>{user?.email}</span></div>
        <div className="row between small"><span className="muted">Plan</span><span>{profile?.plan}</span></div>
        <div className="row between small"><span className="muted">AI credits left</span><span>{balance}</span></div>
        <form action={logoutAction} style={{ marginTop: 12 }}><button className="btn">Sign out</button></form>
      </div>
    </>
  );
}
