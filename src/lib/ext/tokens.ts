// Device tokens and pairing codes (server only). Only SHA-256 hashes are stored; the raw values exist once, in transit.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { DEVICE_TOKEN, PAIR_CODE } from "./protocol";

/** sha256 hex of the UTF-8 text. Same as encode(sha256(convert_to(t, 'UTF8')), 'hex') in Postgres (migration 0006). */
export const sha256Hex = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

/** 32 random bytes, base64url, with a prefix so a leaked token is recognisable. */
export const newDeviceToken = () => `ssd_${randomBytes(32).toString("base64url")}`;
export const isDeviceToken = (t: unknown): t is string => typeof t === "string" && DEVICE_TOKEN.test(t);

/** 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L, U). About 40 bits; valid 5 minutes, single use. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_TTL_MS = 5 * 60_000;
export function newPairingCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}
/** What the user typed -> canonical code ("k7m2-9qxd " -> "K7M29QXD"), or null if it can't be one. */
export function normalizePairingCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.toUpperCase().replace(/[\s-]/g, "");
  return PAIR_CODE.test(c) ? c : null;
}
export const formatPairingCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;
