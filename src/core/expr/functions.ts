import { type Environment, EvaluationError } from "@marcbachmann/cel-js";
import { md5 } from "js-md5";
import { detectLang, languageName, LANGUAGES } from "../languages";
import { fromCel, stringify, toCel } from "./convert";

/**
 * The R8.1 whitelist beyond CEL's standard library (has/size/macros/methods).
 * Nothing here touches the DOM, network or storage.
 */

type Handler = (this: unknown, ...args: never[]) => unknown;

const fail = (message: string): never => {
  throw new EvaluationError(message);
};

const utf8 = (s: string) => new TextEncoder().encode(s);
const toBytes = (v: unknown): Uint8Array =>
  v instanceof Uint8Array ? v : typeof v === "string" ? utf8(v) : fail("需要 string 或 bytes 参数");

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function base64Of(b: Uint8Array): string {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin);
}

/** Digest output: lowercase hex by default, or "base64" / "bytes". */
function encodeDigest(b: Uint8Array, enc: unknown = "hex"): string | Uint8Array {
  switch (enc) {
    case "hex":
      return hexOf(b);
    case "base64":
      return base64Of(b);
    case "bytes":
      return b;
    default:
      return fail(`不支持的编码 "${String(enc)}"，可选 hex / base64 / bytes`);
  }
}

const subtle = () => globalThis.crypto?.subtle ?? fail("当前页面不提供 WebCrypto");
const buf = (b: Uint8Array) => b.slice().buffer;

async function sha256(data: unknown, enc?: unknown) {
  return encodeDigest(new Uint8Array(await subtle().digest("SHA-256", buf(toBytes(data)))), enc);
}

async function hmacSha256(key: unknown, data: unknown, enc?: unknown) {
  const k = await subtle().importKey("raw", buf(toBytes(key)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encodeDigest(new Uint8Array(await subtle().sign("HMAC", k, buf(toBytes(data)))), enc);
}

const md5Of = (data: unknown, enc?: unknown) => encodeDigest(new Uint8Array(md5.arrayBuffer(toBytes(data))), enc);

function urlencode(v: unknown): string {
  if (typeof v === "string") return encodeURIComponent(v);
  const obj = fromCel(v);
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return fail("urlencode 需要 string 或 map");
  const pairs: string[] = [];
  for (const [k, val] of Object.entries(obj)) {
    for (const item of Array.isArray(val) ? val : [val]) {
      pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(stringify(item))}`);
    }
  }
  return pairs.join("&");
}

/** R8.1 limits: regex source length for match(), and the most text a function reads or builds. */
const MATCH_MAX_REGEX = 200;
const TEXT_MAX = 1024 * 1024;
const TEXT_MAX_LABEL = "1 MB";

/** Fails unless a string of `length` UTF-16 units fits the text limit. */
function fits(length: number, fn: string): void {
  if (length > TEXT_MAX) fail(`${fn} 的结果不能超过 ${TEXT_MAX_LABEL}`);
}

function occurrences(s: string, x: string): number {
  if (x === "") return s.length + 1;
  let n = 0;
  for (let i = s.indexOf(x); i >= 0; i = s.indexOf(x, i + x.length)) n++;
  return n;
}

function replace(s: string, a: string, b: string): string {
  if (b.length > a.length) fits(s.length + occurrences(s, a) * (b.length - a.length), "replace");
  return s.replaceAll(a, b);
}

function join(l: unknown[], sep = ""): string {
  const parts = l.map((x) => stringify(fromCel(x)));
  let length = parts.length > 0 ? sep.length * (parts.length - 1) : 0;
  for (const p of parts) length += p.length;
  fits(length, "join");
  return parts.join(sep);
}

function split(s: string, sep: string): string[] {
  if (s.length > TEXT_MAX) fail(`split 的输入文本不能超过 ${TEXT_MAX_LABEL}`);
  return s.split(sep);
}

/** Index just past the JSON object/array starting at `i`, or -1 when it never closes or is mismatched. */
function jsonEnd(s: string, i: number): number {
  const stack: string[] = [];
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"') {
      for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === "\\") j++;
    } else if (c === "{" || c === "[") {
      stack.push(c === "{" ? "}" : "]");
    } else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return j + 1;
    }
  }
  return -1;
}

/** At most this many `{` / `[` positions are tried as the start of the JSON value. */
const EXTRACT_MAX_CANDIDATES = 64;

/** Parses the first JSON object/array in free text (e.g. an LLM reply with ``` fences). */
function extractJson(s: string): unknown {
  if (s.length > TEXT_MAX) return fail(`extractJson 的输入文本不能超过 ${TEXT_MAX_LABEL}`);
  try {
    return toCel(JSON.parse(s));
  } catch {
    // fall through to scanning
  }
  let tried = 0;
  for (let i = 0; i < s.length && tried < EXTRACT_MAX_CANDIDATES; i++) {
    if (s[i] !== "{" && s[i] !== "[") continue;
    tried++;
    const end = jsonEnd(s, i);
    // Nothing closes from here on, so no later start can close either.
    if (end < 0 && !/[\]}]/.test(s.slice(i + 1))) break;
    if (end < 0) continue;
    try {
      return toCel(JSON.parse(s.slice(i, end)));
    } catch {
      // try the next candidate
    }
  }
  return fail("文本里没有可解析的 JSON");
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return fail(`不是有效的 URL：${url}`);
  }
}

function uuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = hexOf(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const regexes = new Map<string, RegExp>();

/** A quantifier at the start of the text; group 1 is the most repeats, "" for unbounded. */
const QUANTIFIER = /^(?:([*+])|(\?)|\{\d+\}|\{\d+,(\d*)\})/;

/**
 * Why a regex can backtrack exponentially, or undefined. A single regex run cannot be
 * pre-empted and the input limit does not bound backtracking, so patterns are refused when
 * they use backreferences, or repeat a group whose body holds a quantifier or an alternation
 * (`(a+)+`, `(a|aa)*`, `(?:x*){2,}`). Plain atoms and character classes may be repeated.
 */
function backtrackRisk(re: string): string | undefined {
  const open: boolean[] = []; // per open group: its body holds a quantifier or "|"
  let prevRiskyGroup = false; // the atom just before the current position is such a group
  const markOpen = () => {
    if (open.length > 0) open[open.length - 1] = true;
  };
  for (let i = 0; i < re.length; i++) {
    const c = re[i]!;
    const q = QUANTIFIER.exec(re.slice(i, i + 24));
    if (q) {
      const exact = /^\{(\d+)\}$/.exec(q[0]);
      const repeats = q[1] !== undefined || (q[3] !== undefined && q[3] !== "1") || (exact !== null && exact[1] !== "1" && exact[1] !== "0");
      if (q[2] === undefined && repeats && prevRiskyGroup) return "嵌套重复";
      markOpen();
      prevRiskyGroup = false;
      i += q[0].length - 1;
      continue;
    }
    prevRiskyGroup = false;
    if (c === "\\") {
      const n = re[i + 1] ?? "";
      if (/[1-9]/.test(n) || n === "k") return "反向引用";
      i++;
    } else if (c === "[") {
      for (i++; i < re.length && re[i] !== "]"; i++) if (re[i] === "\\") i++;
    } else if (c === "(") {
      open.push(false);
      if (re.startsWith("(?<", i) && re[i + 3] !== "=" && re[i + 3] !== "!") i = re.indexOf(">", i);
      else if (re[i + 1] === "?") i += re[i + 2] === "<" ? 3 : 2;
    } else if (c === ")") {
      const risky = open.pop() ?? false;
      if (risky) markOpen();
      prevRiskyGroup = risky;
    } else if (c === "|") {
      markOpen();
    }
  }
  return undefined;
}

/**
 * The first match's capture groups (unmatched optional groups as ""), or [] when nothing
 * matches. JS RegExp syntax, no flags. The time is charged to the expression budget, but a
 * single run cannot be pre-empted, so regexes that could backtrack exponentially are refused.
 */
function match(text: string, regex: string): string[] {
  if (regex.length > MATCH_MAX_REGEX) return fail(`match 的正则不能超过 ${MATCH_MAX_REGEX} 个字符`);
  if (text.length > TEXT_MAX) return fail(`match 的输入文本不能超过 ${TEXT_MAX_LABEL}`);
  let re = regexes.get(regex);
  if (!re) {
    try {
      re = new RegExp(regex);
    } catch (e) {
      return fail(`match 的正则无效：${(e as Error).message}`);
    }
    const risk = backtrackRisk(regex);
    if (risk) return fail(`match 的正则可能大量回溯（${risk}），请改写`);
    if (regexes.size >= 256) regexes.clear();
    regexes.set(regex, re);
  }
  const m = re.exec(text);
  return m ? m.slice(1).map((g) => g ?? "") : [];
}

function randomInt(min: bigint, max: bigint): bigint {
  if (max < min) return fail("random(min, max) 需要 min <= max");
  return min + BigInt(Math.floor(Math.random() * (Number(max - min) + 1)));
}

const FUNCTIONS: [signature: string, handler: Handler][] = [
  ["concat(list, list): list", (a: unknown[], b: unknown[]) => [...a, ...b]],
  ["concat(string, string): string", (a: string, b: string) => (fits(a.length + b.length, "concat"), a + b)],
  ["replace(string, string, string): string", replace],
  ["string.replace(string, string): string", replace],
  ["split(string, string): list<string>", split],
  ["join(list): string", (l: unknown[]) => join(l)],
  ["join(list, string): string", join],
  ["contains(string, string): bool", (s: string, x: string) => s.includes(x)],
  ["contains(list, dyn): bool", (l: unknown[], x: unknown) => l.includes(x)],
  ["urlencode(dyn): string", urlencode],
  ["base64(dyn): string", (v: unknown) => base64Of(toBytes(v))],
  ["hex(dyn): string", (v: unknown) => hexOf(toBytes(v))],
  ["md5(dyn): string", (v: unknown) => md5Of(v)],
  ["md5(dyn, string): dyn", md5Of],
  ["sha256(dyn): string", (v: unknown) => sha256(v)],
  ["sha256(dyn, string): dyn", sha256],
  ["hmacSha256(dyn, dyn): string", (k: unknown, d: unknown) => hmacSha256(k, d)],
  ["hmacSha256(dyn, dyn, string): dyn", hmacSha256],
  ["now(): int", () => BigInt(Date.now())],
  ["unix(): int", () => BigInt(Math.floor(Date.now() / 1000))],
  ["uuid(): string", uuid],
  ["random(): double", () => Math.random()],
  ["random(int, int): int", randomInt],
  ["json(dyn): string", (v: unknown) => JSON.stringify(fromCel(v)) ?? "null"],
  ["extractJson(string): dyn", extractJson],
  ["match(string, string): list<string>", match],
  ["langName(string): string", languageName],
  ["languages(): list", () => LANGUAGES.map((l) => ({ value: l.value, label: l.label }))],
  ["lang(string): string", detectLang],
  ["host(string): string", host],
];

export function registerFunctions(env: Environment, wrap: (h: Handler) => Handler = (h) => h): void {
  for (const [signature, handler] of FUNCTIONS) env.registerFunction(signature, wrap(handler) as never);
}
