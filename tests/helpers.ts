import type { CookieJar, Services } from "../src/lib/data/interfaces";
import { createMockServices, MockDb } from "../src/lib/data/mock";

export function memoryJar(): CookieJar {
  const m = new Map<string, string>();
  return {
    get: (n) => m.get(n),
    set: (n, v) => void m.set(n, v),
    delete: (n) => void m.delete(n),
    getAll: () => [...m].map(([name, value]) => ({ name, value })),
  };
}

export interface Backend { name: string; make: () => { client: () => Services; db: unknown } }

/** Add new implementations here (e.g. Supabase against a test project) to run the same contract on them. */
export const backends: Backend[] = [
  {
    name: "mock",
    make: () => {
      const db = new MockDb(null);
      return { db, client: () => createMockServices(memoryJar(), db) };
    },
  },
];
