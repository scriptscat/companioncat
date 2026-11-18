import type { Storage } from "../../platform/storage";
import { LOCAL_PACK_ID, type PackSource, type RulePack, type SchemaIssue, validatePack } from "../rules";

/** What the shell wires to GM_xmlhttpRequest. Header names in `headers` are matched case-insensitively. */
export interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}
export type FetchFn = (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchResponse>;

/** The shape of `virtual:builtin-packs`. */
export interface BuiltinSnapshot {
  /** Commit of the rules repository the packs were built from. */
  commit: string;
  packs: unknown[];
}

export interface Subscription {
  id: string;
  /** Tried in order; the second one is the mirror. */
  urls: string[];
  /** The cached pack JSON that rule resolution uses. */
  pack: RulePack;
  official?: boolean;
  /** Version of the built-in snapshot this copy came from, while it has not been replaced by a fetched one. */
  builtin?: string;
  etag?: string;
  lastModified?: string;
  /** Last time an update check finished (success or failure), ms. */
  lastChecked?: number;
  /** When the cached pack was last known good, and its version. */
  goodAt: number;
  goodVersion?: string;
  /** Set by a failed update; cleared by the next success. */
  error?: { message: string; at: number };
}

export type SubscribeResult =
  | { ok: true; id: string }
  | { ok: false; message: string; errors?: SchemaIssue[] };

export interface SubscriptionManager {
  subscribe(url: string): Promise<SubscribeResult>;
  /** Subscribes the built-in official packs on first run and upgrades older cached copies. */
  seed(snapshot: BuiltinSnapshot): void;
  /** Fetches one pack now (manual "check for updates"); failures are recorded on the subscription. */
  refresh(id: string): Promise<Subscription | undefined>;
  /** Refreshes every pack not checked for 24 h; across tabs one pack is fetched once per period. */
  checkDue(): Promise<void>;
  list(): Subscription[];
  get(id: string): Subscription | undefined;
  /** Packs in priority order, for resolveRules (the local rules are added by the caller). */
  sources(): PackSource[];
  reorder(ids: string[]): void;
  move(id: string, delta: number): void;
  /** Removes the subscription only; setting values, keys and confirmed hosts stay. */
  unsubscribe(id: string): boolean;
  onChange(listener: () => void): () => void;
}

export interface SubscriptionOptions {
  storage: Storage;
  fetch: FetchFn;
  now?: () => number;
  /** The "auto update" setting (default on). */
  autoUpdate?: () => boolean;
}

export const SUB_PREFIX = "cc:sub:";
export const ORDER_KEY = "cc:subs";
export const SEEDED_KEY = "cc:subs:seeded";
const LEASE_PREFIX = "cc:sublease:";
const CHECK_PERIOD = 24 * 3600_000;
const LEASE_MS = 2 * 60_000;

const RAW = "https://raw.githubusercontent.com/scriptscat/companioncat-rules/main/packs";
const CDN = "https://cdn.jsdelivr.net/gh/scriptscat/companioncat-rules@main/packs";

/** Primary then mirror address of an official pack. */
export const officialUrls = (id: string): [primary: string, mirror: string] => [`${RAW}/${id}.json`, `${CDN}/${id}.json`];

/** Compares dotted versions numerically (2026.11.16 > 2026.9.5); non-numeric parts compare as text. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    if (x === y) continue;
    const nx = /^\d+$/.test(x) && /^\d+$/.test(y);
    const d = nx ? Number(x) - Number(y) : x < y ? -1 : 1;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

type Fetched = { ok: true; pack: RulePack; etag?: string; lastModified?: string } | { ok: false; notModified?: boolean; message: string; errors?: SchemaIssue[] };

export function createSubscriptionManager(opts: SubscriptionOptions): SubscriptionManager {
  const { storage, fetch } = opts;
  const now = opts.now ?? Date.now;
  const autoUpdate = opts.autoUpdate ?? (() => true);

  const order = () => storage.get<string[]>(ORDER_KEY) ?? [];
  const get = (id: string) => storage.get<Subscription>(SUB_PREFIX + id);
  const put = (s: Subscription) => storage.set(SUB_PREFIX + s.id, s);
  const list = () => order().flatMap((id) => get(id) ?? []);

  async function fetchOne(url: string, headers: Record<string, string>): Promise<Fetched> {
    let res: FetchResponse;
    try {
      res = await fetch(url, { headers });
    } catch (e) {
      return { ok: false, message: `网络错误：${e instanceof Error ? e.message : String(e)}` };
    }
    if (res.status === 304) return { ok: false, notModified: true, message: "未修改" };
    if (res.status < 200 || res.status >= 300) return { ok: false, message: `HTTP ${res.status}` };
    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      return { ok: false, message: "内容不是 JSON" };
    }
    const v = validatePack(json);
    if (!v.ok) {
      const first = v.errors[0]!;
      return { ok: false, message: `不符合规则包格式：${first.path || "规则包"} ${first.message}`, errors: v.errors };
    }
    if (v.pack.id === LOCAL_PACK_ID) return { ok: false, message: `规则包 id 不能是「${LOCAL_PACK_ID}」，它留给本地规则` };
    const h = Object.fromEntries(Object.entries(res.headers).map(([k, val]) => [k.toLowerCase(), val]));
    return { ok: true, pack: v.pack, etag: h.etag, lastModified: h["last-modified"] };
  }

  async function subscribe(url: string): Promise<SubscribeResult> {
    const r = await fetchOne(url, {});
    if (!r.ok) return { ok: false, message: `${url}：${r.message}`, errors: r.errors };
    const id = r.pack.id;
    if (get(id)) return { ok: false, message: `已订阅「${id}」` };
    const t = now();
    // The official address of this id (primary or mirror): the pack is the official one again,
    // with its mirror and protected contracts (R2.2, R2.5), e.g. after the user unsubscribed it.
    const official = (officialUrls(id) as string[]).includes(url);
    const urls = official ? officialUrls(id) : [url];
    put({ id, urls, pack: r.pack, ...(official && { official: true }), etag: r.etag, lastModified: r.lastModified, lastChecked: t, goodAt: t, goodVersion: r.pack.version });
    storage.set(ORDER_KEY, [id, ...order()]);
    return { ok: true, id };
  }

  async function update(sub: Subscription): Promise<Subscription> {
    const headers: Record<string, string> = {};
    if (sub.etag) headers["If-None-Match"] = sub.etag;
    if (sub.lastModified) headers["If-Modified-Since"] = sub.lastModified;
    const failures: string[] = [];
    let next: Partial<Subscription> | undefined;
    for (const url of sub.urls) {
      const r = await fetchOne(url, headers);
      if (r.ok && r.pack.id !== sub.id) {
        failures.push(`${url}：规则包 id 是「${r.pack.id}」，不是「${sub.id}」`);
        continue;
      }
      if (r.ok) {
        const t = now();
        next = { pack: r.pack, etag: r.etag, lastModified: r.lastModified, builtin: undefined, goodAt: t, goodVersion: r.pack.version, error: undefined };
        break;
      }
      if (r.notModified) {
        next = { goodAt: now(), error: undefined };
        break;
      }
      failures.push(`${url}：${r.message}`);
    }
    const t = now();
    // Re-read: the subscription may have been removed or changed (reordered, upgraded by another
    // tab's seed) while the request was in flight; only what this check learned is written over it.
    const latest = get(sub.id);
    if (!latest) return sub;
    const done: Subscription = next
      ? { ...latest, ...next, lastChecked: t }
      : { ...latest, lastChecked: t, error: { message: failures.join("；"), at: t } };
    put(done);
    return done;
  }

  function refresh(id: string, force = true) {
    const sub = get(id);
    if (!sub) return Promise.resolve(undefined);
    const lease = storage.get<number>(LEASE_PREFIX + id);
    if (!force && lease !== undefined && lease > now()) return Promise.resolve(undefined);
    storage.set(LEASE_PREFIX + id, now() + LEASE_MS);
    return update(sub).finally(() => storage.delete(LEASE_PREFIX + id));
  }

  return {
    subscribe,
    refresh: (id) => refresh(id),
    async checkDue() {
      if (!autoUpdate()) return;
      const jobs: Promise<unknown>[] = [];
      for (const s of list()) {
        const due = s.lastChecked === undefined || now() - s.lastChecked >= CHECK_PERIOD;
        if (due) jobs.push(refresh(s.id, false));
      }
      await Promise.all(jobs);
    },
    seed(snapshot) {
      const seeded = new Set(storage.get<string[]>(SEEDED_KEY) ?? []);
      const t = now();
      const fresh: string[] = [];
      for (const raw of snapshot.packs) {
        const v = validatePack(raw);
        if (!v.ok || v.pack.id === LOCAL_PACK_ID) continue;
        const pack = v.pack;
        const existing = get(pack.id);
        const version = pack.version ?? "0";
        if (existing) {
          const newer = existing.official && compareVersions(version, existing.pack.version ?? "0") > 0;
          if (newer) {
            put({ ...existing, pack, builtin: version, etag: undefined, lastModified: undefined, goodAt: t, goodVersion: version, error: undefined });
          }
        } else if (!seeded.has(pack.id)) {
          put({ id: pack.id, urls: officialUrls(pack.id), pack, official: true, builtin: version, goodAt: t, goodVersion: version });
          fresh.push(pack.id);
        }
        seeded.add(pack.id);
      }
      if (fresh.length > 0) storage.set(ORDER_KEY, [...order(), ...fresh]);
      storage.set(SEEDED_KEY, [...seeded]);
    },
    list,
    get,
    sources: () => list().map((s) => ({ pack: s.pack, official: s.official })),
    reorder(ids) {
      const current = order();
      const head = ids.filter((id, i) => current.includes(id) && ids.indexOf(id) === i);
      storage.set(ORDER_KEY, [...head, ...current.filter((id) => !head.includes(id))]);
    },
    move(id, delta) {
      const ids = order();
      const i = ids.indexOf(id);
      const j = Math.min(ids.length - 1, Math.max(0, i + delta));
      if (i < 0 || i === j) return;
      ids.splice(j, 0, ...ids.splice(i, 1));
      storage.set(ORDER_KEY, ids);
    },
    unsubscribe(id) {
      if (!get(id)) return false;
      storage.delete(SUB_PREFIX + id);
      storage.set(ORDER_KEY, order().filter((x) => x !== id));
      // Remember the removal so a later seed never re-adds it, however it was first subscribed (R8.3).
      const seeded = storage.get<string[]>(SEEDED_KEY) ?? [];
      if (!seeded.includes(id)) storage.set(SEEDED_KEY, [...seeded, id]);
      return true;
    },
    onChange(listener) {
      return storage.onChange((key) => {
        if (key === ORDER_KEY || key.startsWith(SUB_PREFIX)) listener();
      });
    },
  };
}
