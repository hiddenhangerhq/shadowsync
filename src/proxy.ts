// Next 16 "proxy" (formerly middleware): redirects signed-out visitors to /login.
// Real authorization still happens in pages/routes via the data layer; this is the first gate.
import { NextResponse, type NextRequest } from "next/server";
import { proxySession } from "@/lib/data";

const PUBLIC = ["/login", "/signup"];

export async function proxy(req: NextRequest) {
  const { response, signedIn } = await proxySession(req);
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC.some((p) => pathname === p);
  if (!signedIn && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  if (signedIn && isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }
  return response ?? NextResponse.next();
}

export const config = {
  // Skip static assets, PWA files and Next internals.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|offline.html|icons/).*)"],
};
