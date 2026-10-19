import { defineConfig } from "vitest/config";
import path from "node:path";
import fs from "node:fs";

// .env.local / .env.test.local (both gitignored) supply the Supabase URL/key and test accounts for the real-backend run.
for (const f of [".env.test.local", ".env.local"]) {
  const p = path.resolve(import.meta.dirname, f);
  if (fs.existsSync(p)) process.loadEnvFile(p); // does not override variables already set
}

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false, // the real-Supabase run shares two fixed test accounts
  },
});
