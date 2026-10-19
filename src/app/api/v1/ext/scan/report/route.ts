import { getServices } from "@/lib/data";
import { bearer, clientIp, readJson } from "@/lib/ext/api";
import { extScanReport } from "@/lib/ext/api";
import { respond } from "../../../respond";

export const dynamic = "force-dynamic";

/** Extension (device token only, never a user session). */
export async function POST(req: Request) {
  const b = await readJson(req);
  if (!b.ok) return respond(b.result);
  return respond(await extScanReport(await getServices(), bearer(req), b.value, clientIp(req)));
}
