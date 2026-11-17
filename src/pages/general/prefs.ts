/**
 * The 「通用」 page's own settings. Readers here are what task 16 passes to the core:
 * `preferredEngine(storage)` as createInvoker's `preferred`, `autoUpdateEnabled(storage)` as
 * createSubscriptionManager's `autoUpdate`. Theme and the global cat switch are shell prefs (cc:shell:*).
 */
import type { Storage } from "../../platform/storage";

export const GENERAL_PREFIX = "cc:general:";
/** Absent means on (R2.3 default). */
export const AUTO_UPDATE_KEY = `${GENERAL_PREFIX}auto-update`;
export const preferredKey = (capability: string) => `${GENERAL_PREFIX}preferred:${capability}`;

export function preferredEngine(storage: Storage): (capability: string) => string | undefined {
  return (capability) => {
    const v = storage.get<unknown>(preferredKey(capability));
    return typeof v === "string" && v !== "" ? v : undefined;
  };
}

/** `ref` undefined means automatic (the rule order decides). */
export function setPreferredEngine(storage: Storage, capability: string, ref: string | undefined): void {
  if (ref === undefined) storage.delete(preferredKey(capability));
  else storage.set(preferredKey(capability), ref);
}

export function autoUpdateEnabled(storage: Storage): () => boolean {
  return () => storage.get<unknown>(AUTO_UPDATE_KEY) !== false;
}

export function setAutoUpdate(storage: Storage, on: boolean): void {
  storage.set(AUTO_UPDATE_KEY, on);
}
