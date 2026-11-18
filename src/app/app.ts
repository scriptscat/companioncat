/**
 * The composition root: every long-lived service the shell, pages and features share, built once
 * over one storage. src/app/start.tsx plugs these into the shell through boot's `wire` hook.
 */
import { createInvoker, type ConfirmHost, type Invoker } from "../core/invoke";
import { createSecretStore, createSettingsStore, type SecretStore } from "../core/stores";
import {
  SEEDED_KEY,
  createSubscriptionManager,
  type BuiltinSnapshot,
  type FetchFn,
  type SubscriptionManager,
} from "../core/subscriptions";
import { watchTeachRecords } from "../features/teach/store";
import { autoUpdateEnabled, preferredEngine } from "../pages/general/prefs";
import type { PackVersions } from "../pages/engines/confirm";
import type { Storage } from "../platform/storage";
import { createRulesSource, type LiveRules } from "./rules-source";

/** Per pack: the version in use and the one before it, so the R7.4 dialog can say what changed. */
export const PACK_VERSIONS_KEY = "cc:app:pack-versions";

export interface AppOptions {
  storage: Storage;
  fetch: FetchFn;
  /** The official packs baked into the build (`virtual:builtin-packs`). */
  builtin: BuiltinSnapshot;
  /** The in-page host dialog (R7.4); every call that has no per-call hook uses it. */
  confirmHost: ConfirmHost;
}

export interface AppServices {
  rules: LiveRules;
  subscriptions: SubscriptionManager;
  secrets: SecretStore;
  invoker: Invoker;
  confirmHost: ConfirmHost;
  /** 「订阅官方规则」 (R1.6): re-adds the official packs from the built-in snapshot. */
  subscribeOfficial(): Promise<void>;
}

export interface App {
  services: AppServices;
  /** The version a pack moved from and to (for createConfirmHost). */
  versions: PackVersions;
  /** Background work after mounting: the R2.3 update check. */
  start(): Promise<void>;
  dispose(): void;
}

type VersionLog = Record<string, { from?: string; to?: string }>;

const builtinIds = (b: BuiltinSnapshot) =>
  b.packs.flatMap((p) => (p && typeof p === "object" && typeof (p as { id?: unknown }).id === "string" ? [(p as { id: string }).id] : []));

export function composeApp(o: AppOptions): App {
  const { storage, builtin } = o;
  const subscriptions = createSubscriptionManager({ storage, fetch: o.fetch, autoUpdate: autoUpdateEnabled(storage) });
  // First run and script upgrades: the built-in snapshot, before anything reads the rules (R2.2).
  subscriptions.seed(builtin);

  const rules = createRulesSource(storage, subscriptions);
  const secrets = createSecretStore(storage, () => rules.get());
  const settings = createSettingsStore(storage);
  const invoker = createInvoker({ rules: () => rules.get(), secrets, preferred: preferredEngine(storage), confirmHost: o.confirmHost });

  function trackVersions() {
    const log = storage.get<VersionLog>(PACK_VERSIONS_KEY) ?? {};
    let changed = false;
    for (const s of subscriptions.list()) {
      const to = s.pack.version;
      const seen = log[s.id];
      if (seen && seen.to === to) continue;
      log[s.id] = seen ? { from: seen.to, to } : { to };
      changed = true;
    }
    if (changed) storage.set(PACK_VERSIONS_KEY, log);
  }
  trackVersions();

  const stopRules = rules.subscribe(() => {
    settings.migrate(rules.get());
    trackVersions();
  });
  // Deleting an AI-written rule in the local rules editor deletes its conversation (R6.8).
  const stopTeach = watchTeachRecords(storage);

  const checkDue = () =>
    subscriptions.checkDue().catch((e: unknown) => {
      console.warn("[陪伴猫] rule update check failed", e);
    });

  async function subscribeOfficial() {
    const missing = new Set(builtinIds(builtin).filter((id) => !subscriptions.get(id)));
    if (missing.size === 0) return;
    // seed() skips packs it has seeded before (the user unsubscribed them); this is the user asking again.
    const seeded = storage.get<string[]>(SEEDED_KEY) ?? [];
    storage.set(SEEDED_KEY, seeded.filter((id) => !missing.has(id)));
    subscriptions.seed(builtin);
    void checkDue();
  }

  return {
    services: { rules, subscriptions, secrets, invoker, confirmHost: o.confirmHost, subscribeOfficial },
    versions: (id) => storage.get<VersionLog>(PACK_VERSIONS_KEY)?.[id],
    start: checkDue,
    dispose() {
      stopRules();
      stopTeach();
      rules.dispose();
    },
  };
}
