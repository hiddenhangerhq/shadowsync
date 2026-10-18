import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getServices } from "@/lib/data";

const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { auth, store, storage } = await getServices();
  const user = await auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const item = await store.items.get(id);
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  const fd = await req.formData();
  const file = fd.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (!TYPES.has(file.type)) return NextResponse.json({ error: "Only JPEG, PNG or WebP images" }, { status: 415 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "Image too large (8 MB max)" }, { status: 413 });

  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const path = `${user.id}/${id}/${randomUUID()}.${ext}`;
  await storage.upload(path, new Uint8Array(await file.arrayBuffer()), file.type);
  const position = (await store.photos.listForItem(id)).length;
  const num = (k: string) => { const n = parseInt(String(fd.get(k) ?? ""), 10); return Number.isFinite(n) ? n : null; };
  const photo = await store.photos.add({ itemId: id, path, position, width: num("width"), height: num("height"), bytes: file.size });
  return NextResponse.json({ photo });
}
