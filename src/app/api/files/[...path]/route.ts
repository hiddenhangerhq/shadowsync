// Mock backend only: serves uploaded photos from the local folder, owner-checked.
// With Supabase, photos are loaded through short-lived signed URLs and this route is unused.
import { NextResponse } from "next/server";
import { backend, getServices } from "@/lib/data";
import { mockRead } from "@/lib/data/mock";

export async function GET(_: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (backend() !== "mock") return new NextResponse("Not found", { status: 404 });
  const { path } = await params;
  const services = await getServices();
  const user = await services.auth.getUser();
  const rel = path.join("/");
  if (!user || path[0] !== user.id || rel.includes("..")) return new NextResponse("Forbidden", { status: 403 });
  const data = await mockRead(services, rel);
  if (!data) return new NextResponse("Not found", { status: 404 });
  const type = rel.endsWith(".png") ? "image/png" : rel.endsWith(".webp") ? "image/webp" : "image/jpeg";
  return new NextResponse(Buffer.from(data), { headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600" } });
}
