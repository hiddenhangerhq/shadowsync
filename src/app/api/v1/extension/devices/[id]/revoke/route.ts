import { getServices } from "@/lib/data";
import { deviceRevoke } from "@/lib/ext/api";
import { respond } from "../../../../respond";

export const dynamic = "force-dynamic";

/** Dashboard: disconnect a browser for good (its token stops working at once). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return respond(await deviceRevoke(await getServices(), (await ctx.params).id));
}
