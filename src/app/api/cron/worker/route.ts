// Server worker, for Vercel Cron (or any scheduler). Protected by CRON_SECRET: send `Authorization: Bearer <CRON_SECRET>`.
// Expires leases, moves due retry_wait jobs back to queued and records the heartbeat. No marketplace calls in this step.
// NOTE: Vercel's Hobby plan only allows cron jobs that run once a day, so vercel.json deliberately has NO schedule yet
// (a sub-daily schedule would fail the deploy). Until a scheduler is chosen, trigger this URL from a free external pinger.
import { NextResponse } from "next/server";
import { getServices } from "@/lib/data";
import { authorizeCron } from "@/lib/jobs/cron";

export const dynamic = "force-dynamic";

async function run(req: Request) {
  const auth = authorizeCron(req.headers.get("authorization"), process.env.CRON_SECRET);
  if (auth === "unconfigured") return NextResponse.json({ error: "CRON_SECRET is not configured (16+ characters required)" }, { status: 503 });
  if (auth === "forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 401 });
  try {
    const { store } = await getServices();
    return NextResponse.json({ ok: true, ...(await store.worker.run()) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const missing = e instanceof Error && e.name === "SchemaMissingError";
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "worker failed", code: missing ? "schema_missing" : "error" }, { status: missing ? 503 : 500 });
  }
}
export const GET = run;
export const POST = run;
