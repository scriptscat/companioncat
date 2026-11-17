/** The only place GM value storage is touched. Everything else goes through createStorage(). */

export interface GmStorageApi {
  GM_getValue(key: string, def?: unknown): unknown;
  GM_setValue(key: string, value: unknown): void;
  GM_deleteValue(key: string): void;
  GM_listValues(): string[];
  GM_addValueChangeListener(
    key: string,
    cb: (name: string, oldValue: unknown, newValue: unknown, remote: boolean) => void,
  ): number | string;
  GM_removeValueChangeListener?(id: number | string): void;
}

/** Every key the app writes starts with this. */
export const PREFIX = "cc:";
/**
 * Bumped on every write. GM_addValueChangeListener needs a key name up front, so other tabs
 * listen to this one key and rescan to find which keys changed (R1.8).
 */
export const REV_KEY = "cc:rev";

export type ChangeListener = (key: string, oldValue: unknown, newValue: unknown, remote: boolean) => void;

export interface Storage {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  /** Keys starting with `prefix` (never the revision key). */
  keys(prefix?: string): string[];
  /** Local writes report remote=false, writes from other tabs remote=true. Returns unsubscribe. */
  onChange(listener: ChangeListener): () => void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function createStorage(gm: GmStorageApi = globalThis as unknown as GmStorageApi): Storage {
  const listeners = new Set<ChangeListener>();
  let snapshot: Map<string, unknown> | null = null;
  /** The GM listener id while anyone listens; removed with the last listener. */
  let watch: number | string | undefined;

  const keys = (prefix = PREFIX) =>
    gm.GM_listValues().filter((k) => k !== REV_KEY && k.startsWith(prefix));
  const emit = (key: string, o: unknown, n: unknown, remote: boolean) =>
    listeners.forEach((l) => l(key, o, n, remote));
  const bump = () => gm.GM_setValue(REV_KEY, `${Date.now()}:${Math.random()}`);

  function rescan() {
    if (!snapshot) return;
    const prev = snapshot;
    const next = new Map<string, unknown>();
    for (const k of keys()) next.set(k, gm.GM_getValue(k));
    snapshot = next;
    for (const [k, v] of next) if (!prev.has(k) || !same(prev.get(k), v)) emit(k, prev.get(k), v, true);
    for (const [k, v] of prev) if (!next.has(k)) emit(k, v, undefined, true);
  }

  return {
    get: <T>(key: string) => gm.GM_getValue(key) as T | undefined,
    set(key, value) {
      const old = gm.GM_getValue(key);
      gm.GM_setValue(key, value);
      snapshot?.set(key, value);
      bump();
      if (!same(old, value)) emit(key, old, value, false);
    },
    delete(key) {
      const old = gm.GM_getValue(key);
      gm.GM_deleteValue(key);
      snapshot?.delete(key);
      bump();
      if (old !== undefined) emit(key, old, undefined, false);
    },
    keys,
    onChange(listener) {
      listeners.add(listener);
      snapshot ??= new Map(keys().map((k) => [k, gm.GM_getValue(k)]));
      watch ??= gm.GM_addValueChangeListener(REV_KEY, (_n, _o, _v, remote) => {
        if (remote) rescan();
      });
      return () => {
        if (!listeners.delete(listener) || listeners.size) return;
        // Nobody listens: stop rescanning (a no-op without a snapshot), and drop the GM listener where the API allows.
        snapshot = null;
        if (watch !== undefined && gm.GM_removeValueChangeListener) {
          gm.GM_removeValueChangeListener(watch);
          watch = undefined;
        }
      };
    },
  };
}
