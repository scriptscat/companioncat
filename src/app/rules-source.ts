import { resolveRules } from "../core/rules";
import type { PackSource, Resolved } from "../core/rules/types";
import { ORDER_KEY, SUB_PREFIX, type SubscriptionManager } from "../core/subscriptions";
import { LOCAL_RULES_KEY } from "../pages/rules/RulesPage";
import type { Storage } from "../platform/storage";
import type { RulesSource } from "../shell/services";

export interface LiveRules extends RulesSource {
  dispose(): void;
}

/** The local rules editor text as a pack source; text that is empty or not JSON contributes nothing. */
function localSource(text: unknown): PackSource[] {
  if (typeof text !== "string" || !text.trim()) return [];
  try {
    return [{ pack: JSON.parse(text) as unknown, local: true }];
  } catch {
    return [];
  }
}

const isRuleKey = (key: string) => key === ORDER_KEY || key === LOCAL_RULES_KEY || key.startsWith(SUB_PREFIX);

/**
 * The resolved rules over the subscriptions plus the local pack. Re-resolves when a subscription,
 * the subscription order or cc:rules:local changes, in this tab or another one (R1.8), and keeps
 * returning the same object while the packs themselves stay the same (a refresh that only bumps
 * `lastChecked` is not a change).
 */
export function createRulesSource(storage: Storage, subscriptions: Pick<SubscriptionManager, "sources">): LiveRules {
  const listeners = new Set<() => void>();
  const sources = () => [...subscriptions.sources(), ...localSource(storage.get(LOCAL_RULES_KEY))];

  let input = sources();
  let signature = JSON.stringify(input);
  let current: Resolved = resolveRules(input);

  function recompute(): boolean {
    input = sources();
    const next = JSON.stringify(input);
    if (next === signature) return false;
    signature = next;
    current = resolveRules(input);
    return true;
  }

  const stop = storage.onChange((key) => {
    if (!isRuleKey(key) || !recompute()) return;
    for (const l of [...listeners]) l();
  });

  return {
    get: () => current,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      stop();
      listeners.clear();
    },
  };
}
