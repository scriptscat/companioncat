/** Key masking for traces and errors (R7.3), with the display mask of the secret store. */
import { mask } from "../stores/secrets";

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (s: string) => Array.from(utf8(s), (b) => b.toString(16).padStart(2, "0")).join("");
function base64(s: string): string {
  let bin = "";
  for (const b of utf8(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * The forms a key can take inside a request a rule builds: raw, encodeURIComponent / urlencode(),
 * a `form` body (URLSearchParams), inside a JSON string, and base64() / hex() of the key itself.
 * Encodings of values derived from the key (e.g. base64("user:" + key)) are not recognised.
 */
function encodings(s: string): string[] {
  return [s, encodeURIComponent(s), new URLSearchParams({ k: s }).toString().slice(2), JSON.stringify(s).slice(1, -1), base64(s), hex(s)];
}

/** Returns a function that replaces every secret (in any of its encodings) inside any value. */
export function masker(secrets: Readonly<Record<string, string | undefined>> = {}): <T>(value: T) => T {
  const found = new Map<string, string>();
  for (const s of Object.values(secrets)) {
    if (!s) continue;
    for (const e of encodings(s)) if (!found.has(e)) found.set(e, mask(s));
  }
  const pairs = [...found].sort((a, b) => b[0].length - a[0].length);
  const str = (s: string) => pairs.reduce((acc, [k, m]) => acc.split(k).join(m), s);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return str(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return <T>(value: T) => (pairs.length ? (walk(value) as T) : value);
}
