"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getServices, ITEM_STATUSES, type ItemStatus } from "@/lib/data";

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
