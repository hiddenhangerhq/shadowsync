"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getServices, ITEM_STATUSES, type ItemStatus } from "@/lib/data";
import { linkListing, queueTestAction } from "@/lib/jobs/test-actions";

const num = (v: FormDataEntryValue | null) => { const n = parseFloat(String(v ?? "")); return Number.isFinite(n) ? n : null; };
const str = (v: FormDataEntryValue | null) => { const s = String(v ?? "").trim(); return s || null; };

export async function createItemAction(fd: FormData) {
  const title = String(fd.get("title") ?? "").trim();
  if (!title) redirect("/items/new?error=title");
  const { store } = await getServices();
  const item = await store.items.create({
    title, sku: str(fd.get("sku")), cogs: num(fd.get("cogs")), purchaseLocation: str(fd.get("purchaseLocation")),
    category: str(fd.get("category")), status: "draft",
  });
  redirect(`/items/${item.id}`);
}

export async function setStatusAction(id: string, status: ItemStatus) {
  if (!ITEM_STATUSES.includes(status)) return;
  const { store } = await getServices();
  await store.items.update(id, { status });
  revalidatePath("/items"); revalidatePath(`/items/${id}`); revalidatePath("/");
}

export async function deletePhotoAction(itemId: string, photoId: string) {
  const { store, storage } = await getServices();
  const p = await store.photos.remove(photoId);
  if (p) await storage.remove([p.path]);
  revalidatePath(`/items/${itemId}`);
}

export async function deleteItemAction(id: string) {
  const { store, storage } = await getServices();
  const photos = await store.photos.listForItem(id);
  await store.items.remove(id);
  await storage.remove(photos.map((p) => p.path));
  redirect("/items");
}

// Item page: link an existing marketplace listing, and the Test actions panel (test items only). Both go through lib/jobs/test-actions.
const back = (id: string, r: { status: number; body: Record<string, unknown> }, okMsg: string) => {
  revalidatePath(`/items/${id}`); revalidatePath("/jobs");
  const q = r.status < 300 ? `msg=${encodeURIComponent(okMsg)}` : `err=${encodeURIComponent(String(r.body.error ?? "Something went wrong"))}`;
  redirect(`/items/${id}?${q}#listings`);
};

export async function linkListingAction(itemId: string, fd: FormData) {
  const r = await linkListing(await getServices(), itemId, { marketplace: String(fd.get("marketplace") ?? ""), ref: String(fd.get("ref") ?? ""), price: num(fd.get("price")) });
  back(itemId, r, "Listing linked");
}

export async function testAction(itemId: string, listingId: string, action: string, fd: FormData) {
  const r = await queueTestAction(await getServices(), itemId, listingId, action, String(fd.get("value") ?? ""));
  const deduped = r.body.deduped === true;
  back(itemId, r, deduped ? "That job is already in the queue" : "Job queued. Open the extension and press Check now (or wait up to 5 minutes).");
}
