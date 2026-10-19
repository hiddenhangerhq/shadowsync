import { getServices } from "@/lib/data";
import { devicePause, readJson } from "@/lib/ext/api";
import { respond } from "../../../../respond";

export const dynamic = "force-dynamic";

/** Dashboard kill switch for one browser: {"paused": true|false}. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const b = await readJson(req);
  if (!b.ok) return respond(b.result);
  return respond(await devicePause(await getServices(), (await ctx.params).id, b.value));
}
