/** The result cache (R6.4): successful `translate` outputs only, least recently used out first. */
import { md5 } from "js-md5";

export const CACHE_SIZE = 5000;

/** JSON with object keys sorted, so equal values give equal text. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Engine id + digest of the options in effect + input. */
export function cacheKey(engine: string, options: Readonly<Record<string, unknown>>, input: unknown): string {
  return `${engine}\n${md5(stableJson(options))}\n${stableJson(input)}`;
}

export interface CacheStats {
  entries: number;
  /** Rough memory use: UTF-16 size of the keys and the JSON of the values. */
  bytes: number;
}

export function createResultCache(max = CACHE_SIZE) {
  const entries = new Map<string, { value: unknown; bytes: number }>();
  let bytes = 0;
  const drop = (key: string) => {
    const e = entries.get(key);
    if (!e) return;
    bytes -= e.bytes;
    entries.delete(key);
  };
  return {
    get(key: string): { value: unknown } | undefined {
      const e = entries.get(key);
      if (!e) return undefined;
      entries.delete(key);
      entries.set(key, e);
      return { value: structuredClone(e.value) };
    },
    set(key: string, value: unknown) {
      drop(key);
      const e = { value: structuredClone(value), bytes: 2 * (key.length + (JSON.stringify(value)?.length ?? 0)) };
      entries.set(key, e);
      bytes += e.bytes;
      while (entries.size > max) drop(entries.keys().next().value!);
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
    stats: (): CacheStats => ({ entries: entries.size, bytes }),
  };
}

export type ResultCache = ReturnType<typeof createResultCache>;
