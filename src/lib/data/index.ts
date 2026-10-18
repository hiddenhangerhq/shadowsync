// Single entry point for the app. Pages/actions/routes call getServices() and nothing else.
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";
import type { AuthUser } from "./types";
import type { CookieJar, Services } from "./interfaces";
import { createMockServices, MockDb, MOCK_COOKIE } from "./mock";

export type { Services, DataStore, AuthService, StorageService, CookieJar } from "./interfaces";
export * from "./types";

export const backend = () => (process.env.DATA_BACKEND === "supabase" ? "supabase" : "mock");

const g = globalThis as unknown as { __ssMockDb?: MockDb };
function mockDb() {
  return (g.__ssMockDb ??= new MockDb(process.env.MOCK_DATA_DIR || ".data"));
}

/** Adapter over Next's cookie store (read-only in Server Components; set() is swallowed there). */
async function nextJar(): Promise<CookieJar> {
  const store = await cookies();
  return {
    get: (n) => store.get(n)?.value,
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (n, v, o) => { try { store.set(n, v, o); } catch { /* read-only context */ } },
    delete: (n) => { try { store.delete(n); } catch { /* read-only context */ } },
  };
}

export async function getServices(): Promise<Services> {
  const jar = await nextJar();
  if (backend() === "supabase") {
    const { createSupabaseServices } = await import("./supabase-impl");
    return createSupabaseServices(jar);
  }
  return createMockServices(jar, mockDb(), { seed: process.env.MOCK_SEED !== "0" });
}

/** For server components/actions that need a signed-in user. */
export async function currentUser(): Promise<AuthUser | null> {
  return (await getServices()).auth.getUser();
}

/** Proxy hook: returns the response to continue with and whether a session exists. */
export async function proxySession(req: NextRequest): Promise<{ response: NextResponse | null; signedIn: boolean }> {
  if (backend() === "supabase") {
    const { updateSupabaseSession } = await import("./supabase-impl");
    const { response, user } = await updateSupabaseSession(req);
    return { response, signedIn: !!user };
  }
  return { response: null, signedIn: !!req.cookies.get(MOCK_COOKIE)?.value };
}
