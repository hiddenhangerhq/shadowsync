import { getServices } from "@/lib/data";
import { getNeedsAction } from "@/lib/jobs/api";
import { respond } from "../respond";

export const dynamic = "force-dynamic";

export async function GET() {
  return respond(await getNeedsAction(await getServices()));
}
