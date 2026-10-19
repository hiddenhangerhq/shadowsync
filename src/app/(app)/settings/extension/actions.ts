"use server";
import { revalidatePath } from "next/cache";
import { getServices } from "@/lib/data";
import { newPairingCode, formatPairingCode } from "@/lib/ext/tokens";
import { isExtMarketplace } from "@/lib/ext/protocol";
import { DeviceAuthError, SchemaMissingError } from "@/lib/data/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH = "/settings/extension";

export async function startPairingAction(): Promise<{ code: string; expiresAt: string } | { error: string }> {
  const { store, auth } = await getServices();
  if (!(await auth.getUser())) return { error: "Please sign in again" };
  try {
    const code = newPairingCode();
    const { expiresAt } = await store.pairing.start(code);
    return { code: formatPairingCode(code), expiresAt };
  } catch (e) {
    if (e instanceof SchemaMissingError) return { error: "The extension needs a one-time database setup step (0006) first." };
    if ((e instanceof DeviceAuthError && e.code === "too_many_codes") || (e instanceof Error && /too_many_codes|too many/i.test(e.message))) return { error: "Too many open codes. Wait 5 minutes and try again." };
    throw e;
  }
}
export async function pauseDeviceAction(id: string, paused: boolean) {
  if (!UUID.test(id)) return;
  const { store } = await getServices();
  await store.devices.setPaused(id, paused);
  revalidatePath(PATH);
}
export async function revokeDeviceAction(id: string) {
  if (!UUID.test(id)) return;
  const { store } = await getServices();
  await store.devices.revoke(id);
  revalidatePath(PATH);
}
export async function pauseMarketplaceAction(id: string, marketplace: string, paused: boolean) {
  if (!UUID.test(id) || !isExtMarketplace(marketplace)) return;
  const { store } = await getServices();
  await store.devices.setMarketplacePaused(id, marketplace, paused);
  revalidatePath(PATH);
}
