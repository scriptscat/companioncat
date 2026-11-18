/**
 * Edits one feature of the local rules editor text (cc:rules:local) and leaves the rest of the pack
 * as it was (R6.7, R6.8). The text is re-serialised as 2-space JSON; text that is not JSON, or not a
 * pack object, is never touched.
 */
import { LOCAL_PACK_ID } from "./local";
import { isObject } from "./merge";

export type LocalEdit = { ok: true; text: string } | { ok: false; error: string };

type Pack = Record<string, unknown> & { features?: unknown };
type Feature = Record<string, unknown> & { id: string };

const fail = (error: string): LocalEdit => ({ ok: false, error });

/** The pack in `text`: empty text is a new local pack; otherwise an error message. */
function parse(text: string): Pack | string {
  if (!text.trim()) return { schema: 1, id: LOCAL_PACK_ID, features: [] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return `本地规则不是有效的 JSON，没有改动：${(e as Error).message}`;
  }
  if (!isObject(value)) return "本地规则不是一个规则包对象，没有改动";
  if (value.features !== undefined && !Array.isArray(value.features)) return "本地规则的 features 不是列表，没有改动";
  return value;
}

const idOf = (f: unknown) => (isObject(f) && typeof f.id === "string" ? f.id : undefined);
const asFeature = (f: unknown): Feature | undefined => (idOf(f) !== undefined ? (f as Feature) : undefined);

/** Applies `edit` to the features list of the pack in `text`. */
function edit(text: string, change: (features: unknown[]) => unknown[] | string): LocalEdit {
  const pack = parse(text);
  if (typeof pack === "string") return fail(pack);
  const next = change([...((pack.features as unknown[] | undefined) ?? [])]);
  if (typeof next === "string") return fail(next);
  return { ok: true, text: JSON.stringify({ ...pack, features: next }, null, 2) };
}

const notFeature = "要写入的功能不是带 id 的对象";
const taken = (id: string) => `本地规则里已经有 id 为 ${id} 的功能`;
const missing = (id: string) => `本地规则里没有 id 为 ${id} 的功能`;

/** Adds `feature` after the local pack's features, creating the pack when the text is empty. */
export function appendFeature(text: string, feature: unknown): LocalEdit {
  const f = asFeature(feature);
  if (!f) return fail(notFeature);
  return edit(text, (features) => (features.some((x) => idOf(x) === f.id) ? taken(f.id) : [...features, f]));
}

/** Puts `feature` where the feature `id` is; nothing else changes. */
export function replaceFeature(text: string, id: string, feature: unknown): LocalEdit {
  const f = asFeature(feature);
  if (!f) return fail(notFeature);
  return edit(text, (features) => {
    const at = features.findIndex((x) => idOf(x) === id);
    if (at < 0) return missing(id);
    if (f.id !== id && features.some((x) => idOf(x) === f.id)) return taken(f.id);
    return features.map((x, i) => (i === at ? f : x));
  });
}

/** Drops the feature `id`; nothing else changes. */
export function removeFeature(text: string, id: string): LocalEdit {
  return edit(text, (features) => (features.some((x) => idOf(x) === id) ? features.filter((x) => idOf(x) !== id) : missing(id)));
}

/** The feature `id` in `text`; undefined when it is absent or the text is not a pack. */
export function getFeature(text: string, id: string): Feature | undefined {
  const pack = parse(text);
  if (typeof pack === "string") return undefined;
  return ((pack.features as unknown[] | undefined) ?? []).map(asFeature).find((f) => f?.id === id);
}

/** The feature ids in `text` (empty text: none); undefined when the text is not a pack. */
export function featureIds(text: string): string[] | undefined {
  const pack = parse(text);
  if (typeof pack === "string") return undefined;
  return ((pack.features as unknown[] | undefined) ?? []).flatMap((f) => idOf(f) ?? []);
}

const TEACH = "teach-";

/**
 * A feature id like `teach-<slug>` that no feature in `text` uses and `taken` does not refuse.
 * The slug comes from `hint` (usually the draft's own id), reduced to the schema's id characters.
 */
export function freeFeatureId(text: string, hint: string | undefined, isTaken: (id: string) => boolean = () => false): string {
  const slug =
    (hint ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(new RegExp(`^${TEACH}`), "") || "rule";
  const used = new Set(featureIds(text) ?? []);
  const base = TEACH + slug;
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!used.has(id) && !isTaken(id)) return id;
  }
}
