import { UnsignedInt } from "@marcbachmann/cel-js/evaluator";

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * JS → CEL: safe integers become CEL ints (BigInt) so int arithmetic and comparisons work;
 * larger whole numbers (ids, 1e21) stay doubles, since as ints they could never come back out.
 */
export function toCel(v: unknown): unknown {
  if (typeof v === "number") return Number.isSafeInteger(v) ? BigInt(v) : v;
  if (Array.isArray(v)) return v.map(toCel);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = toCel(val);
    return out;
  }
  return v;
}

export class IntRangeError extends Error {
  constructor(readonly value: bigint) {
    super(`整数结果 ${value} 超出 JS 安全整数范围（±${Number.MAX_SAFE_INTEGER}）`);
  }
}

function toNumber(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new IntRangeError(n);
  }
  return Number(n);
}

/** CEL → JS: ints/uints become JS numbers; throws IntRangeError beyond the safe integer range. */
export function fromCel(v: unknown): unknown {
  if (typeof v === "bigint") return toNumber(v);
  if (v instanceof UnsignedInt) return toNumber(v.value);
  if (Array.isArray(v)) return v.map(fromCel);
  if (v instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of v) out[String(k)] = fromCel(val);
    return out;
  }
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = fromCel(val);
    return out;
  }
  return v;
}

/** How a (converted) value is written into a mixed template. */
export function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v) || isPlainObject(v)) return JSON.stringify(v);
  return String(v);
}
