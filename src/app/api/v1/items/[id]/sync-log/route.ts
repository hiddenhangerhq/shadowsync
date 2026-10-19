import { getServices } from "@/lib/data";
import { getItemSyncLog } from "@/lib/jobs/api";
import { respond } from "../../../respond";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return respond(await getItemSyncLog(await getServices(), (await ctx.params).id));
}
