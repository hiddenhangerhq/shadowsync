import { getServices } from "@/lib/data";
import { cancelJob } from "@/lib/jobs/api";
import { respond } from "../../../respond";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return respond(await cancelJob(await getServices(), (await ctx.params).id));
}
