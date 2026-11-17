import { createInvoker, type ConfirmHost, type Invoker } from "../core/invoke";
import type { Resolved } from "../core/rules/types";
import { createSecretStore, type SecretStore } from "../core/stores";
import type { SubscriptionManager } from "../core/subscriptions";
import type { Storage } from "../platform/storage";

/** The current resolved rules, plus change notification (rule edits in this or another tab, R1.8). */
export interface RulesSource {
  /** Must return the same object until the rules change (it is a React external-store snapshot). */
  get(): Resolved;
  subscribe(cb: () => void): () => void;
}

/**
 * What the shell is wired to: src/app/app.ts builds every long-lived service once and start.tsx
 * passes them in. Everything a page or feature reads from the shell is declared here, in one place.
 */
export interface ShellServices {
  storage: Storage;
  rules: RulesSource;
  /** 「订阅官方规则」 (R1.6). Absent until subscriptions are wired: the button is then disabled. */
  subscribeOfficial?: () => unknown;
  /** The rules page is read-only without it. */
  subscriptions?: SubscriptionManager;
  /** The shared invoker: one result cache and rate limiter for every feature and page. */
  invoker?: Invoker;
  /** A storage-backed SecretStore. */
  secrets?: SecretStore;
  /** The R7.4 host dialog, used by calls that bring no per-call hook. */
  confirmHost?: ConfirmHost;
}

const fallbacks = new WeakMap<ShellServices, { secrets: SecretStore; invoker: Invoker }>();

/**
 * The shell's secret store and invoker. composeApp always wires both; shells built without them
 * (tests, partial wiring) get one fallback pair per services object, over the same storage.
 */
export function coreServices(services: ShellServices): { secrets: SecretStore; invoker: Invoker } {
  if (services.secrets && services.invoker) return { secrets: services.secrets, invoker: services.invoker };
  let hit = fallbacks.get(services);
  if (!hit) {
    const rules = () => services.rules.get();
    const secrets = services.secrets ?? createSecretStore(services.storage, rules);
    const invoker = services.invoker ?? createInvoker({ rules, secrets, confirmHost: services.confirmHost });
    fallbacks.set(services, (hit = { secrets, invoker }));
  }
  return hit;
}

export const EMPTY_RESOLVED: Resolved = {
  features: [],
  providers: [],
  views: [],
  bridges: [],
  contracts: [],
  sites: [],
  diagnostics: [],
};

export function staticRules(resolved: Resolved = EMPTY_RESOLVED): RulesSource {
  return { get: () => resolved, subscribe: () => () => {} };
}

/** "陪伴猫还什么都不会": no rule provides a feature or an engine (R1.6). */
export const isBare = (r: Resolved) => r.features.length === 0 && r.providers.length === 0;
