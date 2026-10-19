// The extension manifest, built for the API origin chosen at build time. Permissions exactly as spec section 5:
// alarms, storage, scripting; host access to our own API only; marketplace sites are OPTIONAL and asked for one by one
// ("Connect" in the popup). No cookies, webRequest, declarativeNetRequest, tabs or <all_urls>; no remote code (CSP script-src 'self').
import { EXT_MARKETPLACES, HOST_TABLE } from "../../src/lib/ext/protocol";

export function apiOriginFrom(raw: string | undefined): string {
  const v = (raw ?? "").trim() || "https://shadowsync-ruby.vercel.app";
  let u: URL;
  try { u = new URL(v); } catch { throw new Error(`SHADOWSYNC_API_ORIGIN is not a URL: ${v}`); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("SHADOWSYNC_API_ORIGIN must be https (http only for localhost)");
  if (u.pathname !== "/" || u.search || u.hash || u.username) throw new Error("SHADOWSYNC_API_ORIGIN must be just an origin, like https://example.com");
  return u.origin;
}

export function buildManifest(apiOrigin: string, version: string) {
  return {
    manifest_version: 3,
    name: "ShadowSync",
    version,
    description: "Keeps your resale listings in sync: delists sold items on your other marketplaces, from your own browser.",
    minimum_chrome_version: "116",
    background: { service_worker: "background.js" },
    action: { default_popup: "popup.html", default_title: "ShadowSync" },
    permissions: ["alarms", "storage", "scripting"],
    host_permissions: [`${apiOrigin}/*`],
    optional_host_permissions: [...new Set(EXT_MARKETPLACES.flatMap((m) => HOST_TABLE[m].permissions))],
    externally_connectable: { matches: [`${apiOrigin}/*`] },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  };
}
