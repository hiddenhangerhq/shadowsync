// Best-effort in-memory limiter for the device API (per server instance). The real, shared limit is in the database (_ext_rate in 0006);
// this one just turns obvious floods away before they reach it.
const buckets = new Map<string, { start: number; n: number }>();
export function allow(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const b = buckets.get(key);
  if (!b || now - b.start >= windowMs) {
    buckets.set(key, { start: now, n: 1 });
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (now - v.start >= windowMs) buckets.delete(k);
    return true;
  }
  return ++b.n <= max;
}
export const resetRateLimits = () => buckets.clear();
