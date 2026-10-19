import { getServices } from "@/lib/data";
import { bearer, clientIp, readJson } from "@/lib/ext/api";
import { extJob } from "@/lib/ext/api";
import { respond } from "../../../../respond";

export const dynamic = "force-dynamic";

/** Extension (device token only): start for a job this device claimed. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const b = await readJson(req);
  if (!b.ok) return respond(b.result);
  return respond(await extJob(await getServices(), "start", bearer(req), (await ctx.params).id, b.value, clientIp(req)));
}
