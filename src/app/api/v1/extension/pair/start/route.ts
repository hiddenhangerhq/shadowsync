import { getServices } from "@/lib/data";
import { pairStart } from "@/lib/ext/api";
import { respond } from "../../../respond";

export const dynamic = "force-dynamic";

/** Dashboard (signed in): make a one-time pairing code, valid 5 minutes. */
export async function POST() {
  return respond(await pairStart(await getServices()));
}
