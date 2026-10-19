import { getServices } from "@/lib/data";
import { marketplacePause, readJson } from "@/lib/ext/api";
import { respond } from "../../../../../../respond";

export const dynamic = "force-dynamic";

/** Dashboard kill switch for one marketplace on one browser: {"paused": true|false}. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; marketplace: string }> }) {
  const b = await readJson(req);
  if (!b.ok) return respond(b.result);
  const p = await ctx.params;
  return respond(await marketplacePause(await getServices(), p.id, p.marketplace, b.value));
}
