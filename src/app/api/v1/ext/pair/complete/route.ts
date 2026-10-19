import { getServices } from "@/lib/data";
import { bearer, clientIp, readJson } from "@/lib/ext/api";
import { extPairComplete } from "@/lib/ext/api";
import { respond } from "../../../respond";

export const dynamic = "force-dynamic";

/** Extension: swap a pairing code for a device token (no session, no token yet). */
export async function POST(req: Request) {
  const b = await readJson(req);
  if (!b.ok) return respond(b.result);
  return respond(await extPairComplete(await getServices(), b.value, clientIp(req)));
}
