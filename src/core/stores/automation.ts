import type { Storage } from "../../platform/storage";

/**
 * Keys (own namespace; settings.migrate deletes `cc:set:`):
 * `cc:auto:log:<site>` record list (newest first), `cc:auto:pause:<site>` true while paused,
 * `cc:auto:always:<site>` rule refs that run without asking (R2.3).
 */
export const AUTO_PREFIX = "cc:auto:";
const LOG_PREFIX = `${AUTO_PREFIX}log:`;
const PAUSE_PREFIX = `${AUTO_PREFIX}pause:`;
const ALWAYS_PREFIX = `${AUTO_PREFIX}always:`;

/** Records kept per site (R3.7). */
export const LOG_LIMIT = 20;
/** Longest target and failure text a record keeps: a rule's describe can be any page text. */
const TARGET_MAX = 200;
const FAILURE_MAX = 500;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export type ActionMode = "auto" | "asked-yes" | "asked-no" | "hint" | "skip" | "not-applicable" | "failed";

/**
 * What a caller may log. There is deliberately no field for a fill value or a key (R3.7);
 * append() copies only these fields, so extra properties are dropped.
 */
export interface ActionRecordInput {
  /** Hostname. */
  site: string;
  rule: string;
  entry: string;
  /** click, fill, check ... */
  action: string;
  /** Description of the target, never its content. */
  target: string;
  confidence?: number;
  mode: ActionMode;
  failure?: string;
}

export interface ActionRecord extends ActionRecordInput {
  id: string;
  time: number;
  /** Set when the user marked this action wrong (R2.4). */
  wrong?: boolean;
}

export function createActionLog(storage: Storage, now: () => number = Date.now) {
  const key = (site: string) => LOG_PREFIX + site;
  const read = (site: string) => storage.get<ActionRecord[]>(key(site)) ?? [];
  let seq = 0;

  return {
    append(input: ActionRecordInput): ActionRecord {
      const time = now();
      const record: ActionRecord = {
        id: `${time}-${seq++}-${Math.random().toString(36).slice(2, 8)}`,
        time,
        site: input.site,
        rule: input.rule,
        entry: input.entry,
        action: input.action,
        target: clip(input.target, TARGET_MAX),
        mode: input.mode,
      };
      if (input.confidence !== undefined) record.confidence = input.confidence;
      if (input.failure !== undefined) record.failure = clip(input.failure, FAILURE_MAX);
      storage.set(key(input.site), [record, ...read(input.site)].slice(0, LOG_LIMIT));
      return record;
    },

    /** Newest first. */
    list: read,

    markWrong(site: string, id: string) {
      const list = read(site);
      if (!list.some((r) => r.id === id)) return;
      storage.set(key(site), list.map((r) => (r.id === id ? { ...r, wrong: true } : r)));
    },

    /** Calls back when `site`'s log changes, here or in another tab. Returns unsubscribe. */
    subscribe(site: string, listener: () => void): () => void {
      return storage.onChange((k) => {
        if (k === key(site)) listener();
      });
    },
  };
}

export function createAutomationPrefs(storage: Storage) {
  const always = (site: string) => storage.get<string[]>(ALWAYS_PREFIX + site) ?? [];

  const prefs = {
    isPaused: (site: string) => storage.get(PAUSE_PREFIX + site) === true,
    /** R3.6: pausing changes nothing else; unpausing restores everything. */
    setPaused(site: string, paused: boolean) {
      if (paused) storage.set(PAUSE_PREFIX + site, true);
      else storage.delete(PAUSE_PREFIX + site);
    },

    isAlwaysDo: (site: string, rule: string) => always(site).includes(rule),
    /** R2.3: a site-level setting on this machine; the rule itself is untouched. */
    setAlwaysDo(site: string, rule: string, on: boolean) {
      const rest = always(site).filter((r) => r !== rule);
      const next = on ? [...rest, rule] : rest;
      if (next.length) storage.set(ALWAYS_PREFIX + site, next);
      else storage.delete(ALWAYS_PREFIX + site);
    },

    /** R2.4: flags the action (when its record id is given) and puts the rule back to asking on this site. */
    markWrong(site: string, rule: string, recordId?: string) {
      if (recordId) createActionLog(storage).markWrong(site, recordId);
      prefs.setAlwaysDo(site, rule, false);
    },

    /** Calls back on any automation preference change, here or in another tab. Returns unsubscribe. */
    subscribe(listener: () => void): () => void {
      return storage.onChange((k) => {
        if (k.startsWith(PAUSE_PREFIX) || k.startsWith(ALWAYS_PREFIX)) listener();
      });
    },
  };
  return prefs;
}

export type ActionLog = ReturnType<typeof createActionLog>;
export type AutomationPrefs = ReturnType<typeof createAutomationPrefs>;
