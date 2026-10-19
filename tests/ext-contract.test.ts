// Device API contract (migration 0006): pairing, token auth, poll + claim, job lifecycle, kill switch, auto-pause, sales scan, alerts.
// Runs against the mock ALWAYS, and against Supabase only with RUN_SUPABASE=1 AND migration 0006 applied (skips cleanly otherwise).
// Outcomes go through outcomeFromError exactly like the /api/v1/ext route, so both stores see the same input.
import { describe, expect, it } from "vitest";
import { backends, extTablesExist, supabaseEnabled } from "./helpers";
import { DeviceAuthError, type JobOutcome } from "../src/lib/data/types";
import type { Services } from "../src/lib/data/interfaces";
import { IllegalTransitionError, outcomeFromError } from "../src/lib/jobs/state-machine";
import { newDeviceToken, newPairingCode } from "../src/lib/ext/tokens";
import { AUTO_PAUSE_REASON } from "../src/lib/ext/limits";

const ready = !supabaseEnabled || (await extTablesExist());
if (supabaseEnabled && !ready) console.warn("[ext-contract] Supabase run skipped: migration 0006 is not on the project yet");
const targets = backends.filter((b) => b.name === "mock" || ready);
const MIN = 60_000;
const past = () => new Date(Date.now() - 10 * MIN).toISOString(); // due already, whatever the clock skew to the database
const V = "0.1.0";
const err = (code: string, message = code): JobOutcome => outcomeFromError(code, message);
const deviceErr = (code: string) => expect.objectContaining({ name: "DeviceAuthError", code });

describe.each(targets)("device API contract: $name", (b) => {
  const pair = async (s: Services, label = "Chrome on Windows") => {
    const code = newPairingCode();
    await s.store.pairing.start(code);
    const token = newDeviceToken();
    const r = await s.device.pairComplete({ code, token, label, extensionVersion: V });
    return { token, deviceId: r.deviceId };
  };
  const setup = async (idx: 0 | 1 = 0) => {
    const s = await b.make().user(idx);
    const item = await s.store.items.create({ title: "Polo", sku: `X${idx}`, status: "listed", askingPrice: 25, brand: "Nike", size: "L" });
    const posh = await s.store.listings.upsert({ itemId: item.id, marketplace: "poshmark", externalId: "a".repeat(24), url: "https://poshmark.com/listing/x", price: 25, status: "active", listedAt: null, endedAt: null, source: "manual" });
    const ebay = await s.store.listings.upsert({ itemId: item.id, marketplace: "ebay", externalId: "123", url: null, price: 25, status: "active", listedAt: null, endedAt: null, source: "manual" });
    const { token, deviceId } = await pair(s);
    const job = async (o: { marketplace?: "poshmark" | "depop"; type?: "delist" | "mark_sold" | "update_listing" | "sync_status"; key?: string } = {}) =>
      (await s.store.jobs.enqueue({
        marketplace: o.marketplace ?? "poshmark", jobType: o.type ?? "mark_sold", executor: "extension", itemId: item.id,
        listingId: (o.marketplace ?? "poshmark") === "poshmark" && o.type !== "sync_status" ? posh.id : null, idempotencyKey: o.key, nextRunAt: past(),
      })).job;
    const poll = (ready: ("poshmark" | "depop")[] = ["poshmark"], signedIn: Partial<Record<"poshmark" | "depop", boolean>> = { poshmark: true }) =>
      s.device.poll(token, { extensionVersion: V, marketplaces: signedIn, ready });
    return { s, item, posh, ebay, token, deviceId, job, poll };
  };

  it("pairing: one-time 5-minute code becomes a device; wrong or reused code is refused; the token hash is never shown", async () => {
    const s = await b.make().user(0);
    const code = newPairingCode();
    const { expiresAt } = await s.store.pairing.start(code);
    const ttl = new Date(expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(4 * MIN);
    expect(ttl).toBeLessThanOrEqual(5 * MIN + 5_000);
    await expect(s.device.pairComplete({ code: newPairingCode(), token: newDeviceToken(), label: "x", extensionVersion: V })).rejects.toEqual(deviceErr("pairing_invalid"));
    const r = await s.device.pairComplete({ code, token: newDeviceToken(), label: "  Edge on Mac  ", extensionVersion: V });
    await expect(s.device.pairComplete({ code, token: newDeviceToken(), label: "again", extensionVersion: V })).rejects.toEqual(deviceErr("pairing_invalid"));
    const devs = await s.store.devices.list();
    expect(devs).toHaveLength(1);
    expect(devs[0]).toMatchObject({ id: r.deviceId, label: "Edge on Mac", extensionVersion: V, paused: false, revokedAt: null });
    expect(JSON.stringify(devs)).not.toMatch(/token_hash|tokenHash/);
    const { client } = b.make();
    await expect(client().store.pairing.start(newPairingCode())).rejects.toThrow(); // signed out
  });

  it.runIf(b.name === "mock")("pairing: an expired code is refused and at most 5 codes can be open", async () => {
    const s = await b.make().user(0);
    const code = newPairingCode();
    const t0 = new Date();
    await s.store.pairing.start(code, t0);
    await expect(s.device.pairComplete({ code, token: newDeviceToken(), label: "x", extensionVersion: V, now: new Date(t0.getTime() + 5 * MIN + 1) }))
      .rejects.toEqual(deviceErr("pairing_invalid"));
    for (let i = 0; i < 4; i++) await s.store.pairing.start(newPairingCode(), t0);
    await expect(s.store.pairing.start(newPairingCode(), t0)).rejects.toEqual(deviceErr("too_many_codes"));
  });

  it("token auth: unknown token, revoked device, paused device (poll still records the heartbeat)", async () => {
    const { s, token, deviceId, job, poll } = await setup();
    await expect(s.device.poll(newDeviceToken(), { extensionVersion: V })).rejects.toEqual(deviceErr("invalid_token"));
    await expect(s.device.poll("not-a-token", { extensionVersion: V })).rejects.toBeInstanceOf(DeviceAuthError);
    await job();
    await s.store.devices.setPaused(deviceId, true);
    const p = await poll();
    expect(p).toMatchObject({ device: { id: deviceId, paused: true }, jobs: [] });
    expect((await s.store.devices.list())[0].lastPollAt).not.toBeNull();
    await expect(s.device.scanNext(token, "poshmark")).rejects.toEqual(deviceErr("device_paused"));
    await s.store.devices.setPaused(deviceId, false);
    expect((await poll()).jobs).toHaveLength(1);
    await s.store.devices.revoke(deviceId);
    await expect(poll()).rejects.toEqual(deviceErr("device_revoked"));
  });

  it("poll: heartbeat + states; one job per READY signed-in marketplace, delist / mark_sold first, with our listing and item data", async () => {
    const { s, token, deviceId, item, job, poll } = await setup();
    const sync = await job({ type: "sync_status" });
    const sold = await job({ type: "mark_sold", key: "m1" });
    await job({ marketplace: "depop", type: "sync_status" });
    await s.store.jobs.enqueue({ marketplace: "ebay", jobType: "delist", executor: "api", itemId: item.id, nextRunAt: past() }); // never for the extension
    expect((await poll([], { poshmark: true })).jobs).toEqual([]);            // nothing ready
    expect((await poll(["depop"], { poshmark: true, depop: false })).jobs).toEqual([]); // depop signed out
    const p = await poll(["poshmark", "depop"], { poshmark: true, depop: true });
    expect(p.jobs.map((j) => j.job.id).sort()).toHaveLength(2);
    const posh = p.jobs.find((j) => j.job.marketplace === "poshmark")!;
    expect(posh.job).toMatchObject({ id: sold.id, status: "claimed", attempts: 1, claimedByDevice: deviceId });
    expect(posh.listing).toEqual({ externalId: "a".repeat(24), url: "https://poshmark.com/listing/x" });
    expect(posh.item).toMatchObject({ title: "Polo", askingPrice: 25, brand: "Nike", size: "L" });
    expect(p.marketplaces).toEqual(expect.arrayContaining([expect.objectContaining({ marketplace: "poshmark", loggedIn: true, paused: false })]));
    // Poshmark is busy with the claimed job: the sync job waits even though it is due.
    expect((await poll(["poshmark"])).jobs).toEqual([]);
    expect((await s.store.jobs.get(sync.id))?.status).toBe("queued");
    const dev = (await s.store.devices.list())[0];
    expect(dev.extensionVersion).toBe(V);
    expect(new Date(dev.lastSeenAt!).getTime()).toBeGreaterThan(Date.now() - MIN);
    const st = await s.store.devices.marketplaceState();
    expect(st.find((x) => x.marketplace === "depop")?.loggedIn).toBe(true);
    void token;
  });

  it("job lifecycle: start, progress, extend, success ends the listing and is logged; illegal moves and foreign jobs are refused", async () => {
    const { s, token, job, poll, posh } = await setup();
    const j = await job();
    await poll();
    await expect(s.device.jobResult(token, j.id, { kind: "success" })).rejects.toBeInstanceOf(IllegalTransitionError); // claimed -> succeeded is illegal
    expect((await s.device.jobStart(token, j.id)).status).toBe("running");
    await expect(s.device.jobStart(token, j.id)).rejects.toBeInstanceOf(IllegalTransitionError);
    await s.device.jobProgress(token, j.id, "Opened the listing");
    const ext = await s.device.jobExtend(token, j.id);
    expect(new Date(ext.leaseExpiresAt!).getTime()).toBeGreaterThan(Date.now() + 9 * MIN);
    const done = await s.device.jobResult(token, j.id, { kind: "success", result: { alreadyDone: false } });
    expect(done).toMatchObject({ status: "succeeded", claimedByDevice: null, leaseExpiresAt: null, result: { alreadyDone: false } });
    expect((await s.store.listings.listForItem(posh.itemId)).find((l) => l.id === posh.id)?.status).toBe("sold");
    expect((await s.store.itemSyncLog.list({ itemId: posh.itemId })).map((e) => e.event)).toContain("marked_sold");
    const msgs = (await s.store.jobs.events([j.id])).map((e) => e.message);
    expect(msgs).toEqual(expect.arrayContaining(["Started", "Opened the listing", "Lease extended", "Succeeded"]));
    await expect(s.device.jobResult(token, j.id, { kind: "success" })).rejects.toEqual(deviceErr("not_your_job")); // already reported
    await expect(s.device.jobStart(token, "00000000-0000-4000-8000-000000000000")).rejects.toEqual(deviceErr("not_your_job"));
  });

  it("results: the CODE decides retry / fail / needs-you; a failed delist is logged; signing in again requeues signed-out jobs", async () => {
    const { s, token, job, poll } = await setup();
    const a = await job({ key: "a" });
    await poll();
    await s.device.jobStart(token, a.id);
    expect(await s.device.jobResult(token, a.id, err("timeout", "Page took too long"))).toMatchObject({ status: "retry_wait", lastErrorCode: "timeout" });
    const b2 = await job({ key: "b" });
    await poll();
    expect(await s.device.jobResult(token, b2.id, err("something_odd", "Weird"))).toMatchObject({ status: "failed", lastError: "Weird" });
    expect((await s.store.itemSyncLog.list({ event: "delist_failed" })).map((e) => e.jobId)).toContain(b2.id);
    const c = await job({ key: "c" });
    await poll();
    expect(await s.device.jobResult(token, c.id, err("signed_out", "Signed out of Poshmark"))).toMatchObject({ status: "needs_user" });
    expect((await s.store.devices.marketplaceState()).find((x) => x.marketplace === "poshmark")?.loggedIn).toBe(false);
    const p = await poll(["poshmark"], { poshmark: true });
    expect(p.requeued).toBe(1);
    expect(p.jobs.map((x) => x.job.id)).toEqual([c.id]);
    expect(p.jobs[0].job.attempts).toBe(1); // fresh round
  });

  it("kill switch per marketplace, and automatic pause after 2 security checks in a row (a success resets the streak)", async () => {
    const { s, token, deviceId, job, poll } = await setup();
    await s.store.devices.setMarketplacePaused(deviceId, "poshmark", true);
    const j1 = await job({ key: "1" });
    expect((await poll()).marketplaces.find((m) => m.marketplace === "poshmark")).toMatchObject({ paused: true, pausedReason: "Paused by you" });
    expect((await poll()).jobs).toEqual([]);
    await s.store.devices.setMarketplacePaused(deviceId, "poshmark", false);
    expect((await poll()).jobs.map((x) => x.job.id)).toEqual([j1.id]);
    await s.device.jobResult(token, j1.id, err("captcha", "Captcha shown"));
    const j2 = await job({ key: "2" });
    await poll();
    await s.device.jobStart(token, j2.id);
    await s.device.jobResult(token, j2.id, { kind: "success" });             // streak back to 0
    const j3 = await job({ key: "3", type: "sync_status" });
    await poll();
    await s.device.jobResult(token, j3.id, err("challenge", "Verify it's you"));
    expect((await s.store.devices.marketplaceState()).find((x) => x.marketplace === "poshmark")).toMatchObject({ paused: false, challengeStreak: 1 });
    const j4 = await job({ key: "4", type: "update_listing" });
    await poll();
    await s.device.jobResult(token, j4.id, err("captcha", "Captcha again"));
    expect((await s.store.devices.marketplaceState()).find((x) => x.marketplace === "poshmark")).toMatchObject({ paused: true, pausedReason: AUTO_PAUSE_REASON, challengeStreak: 2 });
    await job({ key: "5" });
    expect((await poll()).jobs).toEqual([]);
  });

  it("sales scan: server cursor starts at now; a report stores sales, queues delists for the OTHER listings, then moves the cursor; replay adds nothing", async () => {
    const { s, token, deviceId, item } = await setup();
    const first = await s.device.scanNext(token, "poshmark");
    expect(first).toMatchObject({ marketplace: "poshmark", scopeKey: `device:${deviceId}`, limit: 50, overlapHours: 24 });
    expect(new Date(first.cursor!).getTime()).toBeGreaterThan(Date.now() - 5 * MIN);
    expect((await s.device.scanNext(token, "poshmark")).cursor).toBe(first.cursor); // stable
    const sales = [
      { orderId: "P-1", soldAt: "2026-10-18", price: 25, externalListingId: "a".repeat(24), title: "Polo" },
      { orderId: "P-2", soldAt: "2026-10-18", price: 9, sku: "nope" },
      { orderId: "P-3", soldAt: "2026-10-17", price: 5, cancelled: true },
    ];
    const r = await s.device.scanReport(token, { marketplace: "poshmark", sales, nextCursor: "2026-10-18T10:00:00.000Z" });
    expect(r).toMatchObject({ ok: true, stored: 2, duplicates: 0, jobsCreated: 1, unmatched: 1, cancelled: 1, cursorAdvanced: true });
    const jobs = await s.store.jobs.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ marketplace: "ebay", jobType: "delist", executor: "api", status: "queued", itemId: item.id });
    expect((await s.store.items.get(item.id))?.status).toBe("sold");
    expect((await s.device.scanNext(token, "poshmark")).cursor).toBe("2026-10-18T10:00:00.000Z");
    const again = await s.device.scanReport(token, { marketplace: "poshmark", sales, nextCursor: null });
    expect(again).toMatchObject({ ok: true, stored: 0, duplicates: 2, jobsCreated: 0, unmatched: 0, cancelled: 0 });
    expect(await s.store.jobs.list()).toHaveLength(1);
    expect((await s.device.scanNext(token, "poshmark")).cursor).toBe("2026-10-18T10:00:00.000Z"); // null = keep
    const sale = (await s.store.sales.list()).find((x) => x.orderId === "P-1");
    expect(sale).toMatchObject({ source: "extension", itemId: item.id, price: 25 });
  });

  it("isolation: a device only ever reaches its own user's data", async () => {
    const env = b.make();
    const a = await env.user(0), bb = await env.user(1);
    const tokA = (await pair(a)).token;
    const it = await bb.store.items.create({ title: "B's" });
    const jb = (await bb.store.jobs.enqueue({ marketplace: "poshmark", jobType: "sync_status", executor: "extension", itemId: it.id, nextRunAt: past() })).job;
    const p = await a.device.poll(tokA, { extensionVersion: V, marketplaces: { poshmark: true }, ready: ["poshmark"] });
    expect(p.jobs).toEqual([]);
    await expect(a.device.jobResult(tokA, jb.id, { kind: "success" })).rejects.toEqual(deviceErr("not_your_job"));
    expect(await bb.store.devices.list()).toEqual([]);
    expect((await bb.store.jobs.get(jb.id))?.status).toBe("queued");
  });

  it("alerts: SMS is off by default; the preference and phone are stored", async () => {
    const s = await b.make().user(0);
    expect(await s.store.alerts.get()).toEqual({ smsEnabled: false, phone: null, updatedAt: null });
    const u = await s.store.alerts.update({ smsEnabled: true, phone: "+15551234567" });
    expect(u).toMatchObject({ smsEnabled: true, phone: "+15551234567" });
    expect(await s.store.alerts.get()).toMatchObject({ smsEnabled: true, phone: "+15551234567" });
    expect((await s.store.alerts.update({ smsEnabled: false })).phone).toBe("+15551234567");
  });
});
