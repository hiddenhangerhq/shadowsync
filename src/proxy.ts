// Next 16 "proxy" (formerly middleware): redirects signed-out visitors to /login.
// Real authorization still happens in pages/routes via the data layer; this is the first gate.
import { NextResponse, type NextRequest } from "next/server";
import { proxySession } from "@/lib/data";

const PUBLIC = ["/login", "/signup"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // The extension's endpoints never use a user session (device token only), so the session is not even read for them.
  if (pathname.startsWith("/api/v1/ext/")) return NextResponse.next();
  const { response, signedIn } = await proxySession(req);
  const isPublic = PUBLIC.some((p) => pathname === p);
  // The worker endpoint has no user: it is protected by CRON_SECRET inside the route instead.
  if (pathname.startsWith("/api/cron/")) return response ?? NextResponse.next();
  // The JSON API answers 401 instead of redirecting to the login page.
  if (!signedIn && pathname.startsWith("/api/v1/")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
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
