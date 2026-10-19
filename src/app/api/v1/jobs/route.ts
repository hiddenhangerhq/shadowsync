import type { NextRequest } from "next/server";
import { getServices } from "@/lib/data";
import { createJob, listJobs } from "@/lib/jobs/api";
import { respond } from "../respond";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  return respond(await listJobs(await getServices(), { status: q.get("status"), limit: q.get("limit"), itemId: q.get("itemId") }));
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return respond({ status: 400, body: { error: "Body must be JSON" } }); }
  return respond(await createJob(await getServices(), body));
}
