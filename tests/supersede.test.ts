// Duplicate edit jobs (David's Jobs screen: two "Change price to $25.00" and two "Set quantity to 2" for one item): the newest wins.
import { describe, expect, it } from "vitest";
import { supersededJobs } from "../src/lib/jobs/supersede";
import { backends } from "./helpers";
import { createJob } from "../src/lib/jobs/api";
import type { Job } from "../src/lib/data/types";

const j = (id: string, at: string, payload: Record<string, unknown>, o: Partial<Job> = {}) =>
  ({ id, createdAt: `2026-10-19T0${at}:00.000Z`, listingId: "L1", jobType: "update_listing", status: "queued", payload, ...o }) as Job;

describe("supersededJobs (pure)", () => {
  it("older waiting edits of the same listing field are replaced by the newest; other fields, listings, running jobs and delists stay", () => {
    const jobs = [
      j("p1", "1", { price: 25, previous: { price: 20 } }), j("p2", "2", { price: 25, previous: { price: 20 } }),
      j("q1", "1", { quantity: 2 }), j("q2", "3", { quantity: 2 }),
      j("t1", "1", { title: "A" }),
      j("pOther", "1", { price: 30 }, { listingId: "L2" }),
      j("pRun", "0", { price: 22 }, { status: "running" }),
      j("pRetry", "0", { price: 24 }, { status: "retry_wait" }),
      j("d1", "0", {}, { jobType: "delist" }),
    ];
    const out = supersededJobs(jobs);
    expect(out.map((x) => [x.job.id, x.by.id]).sort()).toEqual([["p1", "p2"], ["pRetry", "p2"], ["q1", "q2"]]);
  });
  it("a narrower newer edit does not cancel a wider older one (price+title stays when only price is changed again)", () => {
    const out = supersededJobs([j("pt", "1", { price: 25, title: "B" }), j("p", "2", { price: 26 })]);
    expect(out).toEqual([]);
    expect(supersededJobs([j("p", "1", { price: 25 }), j("pt", "2", { price: 26, title: "B" })]).map((x) => x.job.id)).toEqual(["p"]);
  });
});

describe("createJob supersedes (mock store)", () => {
  it("a second 'change price' for the listing cancels the first; quantity likewise; the latest value is the one left", async () => {
    const env = backends.find((b) => b.name === "mock")!.make();
    const svc = await env.user(0);
    const item = await svc.store.items.create({ title: "x", sku: "TEST-1", status: "listed" });
    const l = await svc.store.listings.upsert({ itemId: item.id, marketplace: "poshmark", externalId: "a".repeat(24), url: null, price: 5, status: "active", listedAt: null, endedAt: null, source: "manual" });
    const mk = async (payload: Record<string, unknown>, k: string) => (await createJob(svc, { marketplace: "poshmark", jobType: "update_listing", itemId: item.id, listingId: l.id, payload, idempotencyKey: k })).body.job as Job;
    const a = await mk({ price: 25 }, "a");
    await new Promise((r) => setTimeout(r, 5));
    const q = await mk({ quantity: 2 }, "q");
    await new Promise((r) => setTimeout(r, 5));
    const b = await mk({ price: 27 }, "b");
    expect((await svc.store.jobs.get(a.id))?.status).toBe("canceled");
    expect((await svc.store.jobs.get(b.id))?.status).toBe("queued");
    expect((await svc.store.jobs.get(q.id))?.status).toBe("queued");
    await new Promise((r) => setTimeout(r, 5));
    const q2 = await mk({ quantity: 3 }, "q2");
    expect((await svc.store.jobs.get(q.id))?.status).toBe("canceled");
    expect((await svc.store.jobs.get(q2.id))?.status).toBe("queued");
  });
});
