// Protects the worker endpoint. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the CRON_SECRET env var is set.
import { timingSafeEqual } from "node:crypto";

export type CronAuth = "ok" | "unconfigured" | "forbidden";
export function authorizeCron(authorizationHeader: string | null, secret: string | undefined): CronAuth {
  if (!secret || secret.length < 16) return "unconfigured"; // never run open: no secret (or a trivially short one) means the endpoint is off
  const given = Buffer.from(authorizationHeader ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want) ? "ok" : "forbidden";
}
