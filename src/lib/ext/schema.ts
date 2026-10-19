// Tiny strict schema validator, shared by the web app (/api/v1/ext/*) and the extension. No dependencies, no eval.
// Objects are STRICT: an unknown field is an error, never passed through. Strings have a max length.
export type Check<T> = (v: unknown, path: string) => T;
export class SchemaError extends Error {
  constructor(public path: string, msg: string) { super(`${path || "payload"}: ${msg}`); this.name = "SchemaError"; }
}
const fail = (path: string, msg: string): never => { throw new SchemaError(path, msg); };

export const str = (o: { max?: number; min?: number; pattern?: RegExp } = {}): Check<string> => (v, p) => {
  if (typeof v !== "string") return fail(p, "must be text");
  if (v.length < (o.min ?? 0)) return fail(p, "is too short");
  if (v.length > (o.max ?? 500)) return fail(p, "is too long");
  if (o.pattern && !o.pattern.test(v)) return fail(p, "has an invalid format");
  return v;
};
export const num = (o: { min?: number; max?: number; int?: boolean } = {}): Check<number> => (v, p) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return fail(p, "must be a number");
  if (o.int && !Number.isInteger(v)) return fail(p, "must be a whole number");
  if (o.min !== undefined && v < o.min) return fail(p, `must be at least ${o.min}`);
  if (o.max !== undefined && v > o.max) return fail(p, `must be at most ${o.max}`);
  return v;
};
export const bool: Check<boolean> = (v, p) => (typeof v === "boolean" ? v : fail(p, "must be true or false"));
export const oneOf = <T extends string>(vals: readonly T[]): Check<T> => (v, p) =>
  (typeof v === "string" && (vals as readonly string[]).includes(v) ? (v as T) : fail(p, `must be one of ${vals.join(", ")}`));
export const nullable = <T>(c: Check<T>): Check<T | null> => (v, p) => (v === null ? null : c(v, p));
export const arr = <T>(c: Check<T>, o: { max?: number } = {}): Check<T[]> => (v, p) => {
  if (!Array.isArray(v)) return fail(p, "must be a list");
  if (v.length > (o.max ?? 100)) return fail(p, `has more than ${o.max ?? 100} entries`);
  return v.map((x, i) => c(x, `${p}[${i}]`));
};
/** Record with keys from a fixed set (e.g. marketplaces). Unknown keys are errors. */
export const keyed = <K extends string, T>(keys: readonly K[], c: Check<T>): Check<Partial<Record<K, T>>> => (v, p) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail(p, "must be an object");
  const out: Partial<Record<K, T>> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!(keys as readonly string[]).includes(k)) return fail(`${p}.${k}`, "is not allowed");
    out[k as K] = c(x, `${p}.${k}`);
  }
  return out;
};

type Shape = Record<string, Check<unknown>>;
type Out<S extends Shape, O extends keyof S> = { [K in Exclude<keyof S, O>]: ReturnType<S[K]> } & { [K in O]?: ReturnType<S[K]> };
/** Strict object. `optional` fields may be missing (or undefined). Any other field is rejected. */
export function obj<S extends Shape, O extends keyof S = never>(shape: S, optional: readonly O[] = []): Check<Out<S, O>> {
  return (v, p) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return fail(p, "must be an object");
    const src = v as Record<string, unknown>;
    for (const k of Object.keys(src)) if (!(k in shape)) fail(p ? `${p}.${k}` : k, "is not allowed");
    const out: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(shape)) {
      const val = src[k];
      if (val === undefined) {
        if ((optional as readonly string[]).includes(k)) continue;
        fail(p ? `${p}.${k}` : k, "is required");
      }
      out[k] = c(val, p ? `${p}.${k}` : k);
    }
    return out as Out<S, O>;
  };
}
/** Like obj, but other fields are ignored (for reading a third-party answer: we check only what we use, and keep only that). */
export function pick<S extends Shape, O extends keyof S = never>(shape: S, optional: readonly O[] = []): Check<Out<S, O>> {
  const strict = obj(shape, optional);
  return (v, p) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return fail(p, "must be an object");
    const src = v as Record<string, unknown>;
    return strict(Object.fromEntries(Object.keys(shape).filter((k) => k in src).map((k) => [k, src[k]])), p);
  };
}
export const parse = <T>(c: Check<T>, v: unknown): T => c(v, "");
