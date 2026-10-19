import { getServices } from "@/lib/data";
import { retryJob } from "@/lib/jobs/api";
import { respond } from "../../../respond";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return respond(await retryJob(await getServices(), (await ctx.params).id));
}
