import { getServices } from "@/lib/data";
import { getExtensionStatus } from "@/lib/jobs/api";
import { respond } from "../../respond";

export const dynamic = "force-dynamic";

export async function GET() {
  return respond(await getExtensionStatus(await getServices(), Number(process.env.WORKER_STALE_MINUTES) || undefined));
}
