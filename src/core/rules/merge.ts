import { setOwn } from "./json";

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Applies `patch` on top of `base` (R2.5): objects merge level by level, arrays and other
 * values replace as a whole, and a `null` field deletes that field. Inputs are not mutated.
 */
export function applyPatch(base: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const out: Record<string, unknown> = isObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else setOwn(out, k, applyPatch(out[k], v));
  }
  return out;
}
