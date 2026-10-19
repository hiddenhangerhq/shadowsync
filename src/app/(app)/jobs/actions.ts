"use server";
import { revalidatePath } from "next/cache";
import { getServices } from "@/lib/data";

// Buttons on a page that may be a minute old: a job that already moved on (illegal transition) is not an error worth a crash page.
async function safely(fn: () => Promise<unknown>) {
  try { await fn(); } catch (e) { if (!(e instanceof Error) || !/illegal job transition|not found|changed by another/i.test(e.message)) throw e; }
  revalidatePath("/"); revalidatePath("/jobs");
}

export async function retryJobAction(id: string) {
  const { store } = await getServices();
  await safely(() => store.jobs.retry(id));
}
export async function cancelJobAction(id: string) {
  const { store } = await getServices();
  await safely(() => store.jobs.cancel(id));
}
export async function ignoreNeedsActionAction(key: string) {
  const { store } = await getServices();
  await safely(() => store.needsAction.ignore(key));
}
export async function markDelistedAction(listingId: string) {
  const { store } = await getServices();
  await safely(() => store.needsAction.markDelisted(listingId));
}
