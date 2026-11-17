import type { Storage } from "../../core/stores";

/**
 * Feature and entry on/off switches (R9.1, both default on). Kept apart from `cc:set:` so a rule
 * update's settings migration (R9.4) never mistakes them for removed settings. Only `false` is
 * stored; switching back on deletes the key.
 */
export const ENABLED_PREFIX = "cc:on:";

/** `ref` is a feature ref (`pack/feature`) or an entry ref (`pack/feature.entry`). */
export const enabledKey = (ref: string) => `${ENABLED_PREFIX}${ref}`;

/** Whether the feature or entry `ref` is switched on (the default). */
export const isEnabled = (storage: Pick<Storage, "get">, ref: string) => storage.get(enabledKey(ref)) !== false;
