import type { Storage } from "../../platform/storage";
import type { Resolved, SettingDef } from "../rules/types";

/**
 * Key layout: `cc:set:<owner>/<name>[@<hostname>]`, where owner is the feature ref
 * (`pack/feature`) or the entry ref (`pack/feature.entry`); `@hostname` only for scope "site".
 */
const SETTING_PREFIX = "cc:set:";
/** `cc:settype:<owner>/<name>`: the setting type a stored value was written for (R9.4 type changes). */
const SETTING_TYPE_PREFIX = "cc:settype:";

function settingKey(owner: string, name: string, def: Pick<SettingDef, "scope">, host?: string) {
  if (def.scope === "site") {
    if (!host) throw new Error(`setting ${owner}/${name} is per-site and needs a hostname`);
    return `${SETTING_PREFIX}${owner}/${name}@${host}`;
  }
  return `${SETTING_PREFIX}${owner}/${name}`;
}

/** Whether `value` is a legal stored value for `def` (type changed or option gone -> false). */
function isValidSetting(def: SettingDef, value: unknown): boolean {
  switch (def.type) {
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && !!def.options && Object.hasOwn(def.options, value);
    case "language":
    case "engine":
    case "string":
      return typeof value === "string";
    case "engines":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (def.min === undefined || value >= def.min) &&
        (def.max === undefined || value <= def.max)
      );
  }
}

export interface MigrationReport {
  /** Keys deleted because their setting no longer exists. */
  removed: string[];
  /** Keys deleted because the value no longer fits (back to default). */
  reset: string[];
}

export function createSettingsStore(storage: Storage) {
  return {
    get(owner: string, name: string, def: SettingDef, host?: string): unknown {
      const stored = storage.get(settingKey(owner, name, def, host));
      return stored !== undefined && isValidSetting(def, stored) ? stored : def.default;
    },

    /** Returns false (and stores nothing) when the value does not fit the definition. */
    set(owner: string, name: string, def: SettingDef, value: unknown, host?: string): boolean {
      const key = settingKey(owner, name, def, host);
      if (!isValidSetting(def, value)) return false;
      storage.set(key, value);
      const typeKey = `${SETTING_TYPE_PREFIX}${owner}/${name}`;
      if (storage.get(typeKey) !== def.type) storage.set(typeKey, def.type);
      return true;
    },

    /** R9.4: keep valid values, drop removed settings, reset invalid ones. New settings need no write. */
    migrate(resolved: Resolved): MigrationReport {
      const packs = new Set<string>();
      for (const group of [resolved.features, resolved.providers, resolved.views, resolved.bridges, resolved.contracts])
        for (const item of group) packs.add(item.pack);
      const defsByOwner = new Map<string, Record<string, SettingDef> | undefined>();
      for (const f of resolved.features) {
        defsByOwner.set(f.ref, f.def.settings);
        for (const e of f.entries) defsByOwner.set(e.ref, e.def.settings);
      }
      const report: MigrationReport = { removed: [], reset: [] };
      for (const key of storage.keys(SETTING_PREFIX)) {
        const body = key.slice(SETTING_PREFIX.length);
        const at = body.indexOf("@");
        const path = at < 0 ? body : body.slice(0, at);
        const slash = path.lastIndexOf("/");
        const owner = path.slice(0, slash);
        const name = path.slice(slash + 1);
        if (!packs.has(owner.split("/")[0] ?? "")) continue; // pack not loaded: leave its values alone
        const def = defsByOwner.get(owner)?.[name];
        const typeKey = SETTING_TYPE_PREFIX + path;
        const wasType = storage.get(typeKey);
        if (!def) {
          storage.delete(key);
          report.removed.push(key);
        } else if ((wasType !== undefined && wasType !== def.type) || !isValidSetting(def, storage.get(key))) {
          storage.delete(key);
          report.reset.push(key);
        } else if (wasType === undefined) {
          storage.set(typeKey, def.type); // values stored before types were recorded
        }
      }
      // the type records follow their settings: dropped with them, updated to the current type
      for (const key of storage.keys(SETTING_TYPE_PREFIX)) {
        const path = key.slice(SETTING_TYPE_PREFIX.length);
        const slash = path.lastIndexOf("/");
        const owner = path.slice(0, slash);
        if (!packs.has(owner.split("/")[0] ?? "")) continue;
        const def = defsByOwner.get(owner)?.[path.slice(slash + 1)];
        if (!def) storage.delete(key);
        else if (storage.get(key) !== def.type) storage.set(key, def.type);
      }
      return report;
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
