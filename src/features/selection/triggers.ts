/** R9.6: which entry (if any) a selection triggers, and how it confirms. */
import { renderTemplate, type Scope } from "../../core/expr";
import { POSITIONS } from "../../core/rules/positions";
import type { Resolved, ResolvedEntry, ResolvedFeature, SettingDef, TriggerDef } from "../../core/rules/types";
import type { SettingsStore, Storage } from "../../core/stores";
import { isEnabled } from "../page/enabled";
import { entryMatch, matchesAny } from "./match";

export const DEFAULT_IGNORE = ["input", "textarea", '[contenteditable]:not([contenteditable="false"])'];
export const DEFAULT_MIN = 1;
export const DEFAULT_MAX = 5000;

export type Confirm = "paw" | "none" | "alt";

export interface Chosen {
  feature: ResolvedFeature;
  entry: ResolvedEntry;
  settings: Record<string, unknown>;
  site: Record<string, unknown>;
  page: { url: string; title: string };
  confirm: Confirm;
}

export interface PickInput {
  resolved: Resolved;
  storage: Storage;
  settings: SettingsStore;
  hostname: string;
  url: string;
  title: string;
  /** Trimmed selection text. */
  text: string;
  /** Elements the selection (or the release event) is in; checked against ignoreIn. */
  elements: Element[];
}

function read(store: SettingsStore, owner: string, defs: Record<string, SettingDef> | undefined, host: string, out: Record<string, unknown>) {
  for (const [name, def] of Object.entries(defs ?? {})) out[name] = store.get(owner, name, def, def.scope === "site" ? host : undefined);
}

/** Feature settings, then entry settings (entry wins); per-site ones for this host. */
export function settingsOf(store: SettingsStore, f: ResolvedFeature, e: ResolvedEntry, host: string) {
  const out: Record<string, unknown> = {};
  read(store, f.ref, f.def.settings, host, out);
  read(store, e.ref, e.def.settings, host, out);
  return out;
}

/** `site`: the fields of the site rules for this entry and page (earlier rules win). */
export function siteOf(resolved: Resolved, entryRef: string, url: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of [...resolved.sites].reverse()) {
    if (s.def.for !== entryRef || !matchesAny(s.def.match, url)) continue;
    const { match: _m, for: _f, ...rest } = s.def;
    Object.assign(out, rest);
  }
  return out;
}

function inside(elements: Element[], selectors: readonly string[]): boolean {
  return elements.some((el) =>
    selectors.some((sel) => {
      try {
        return el.closest(sel) !== null;
      } catch {
        return false;
      }
    }),
  );
}

async function confirmOf(t: TriggerDef, scope: Scope): Promise<Confirm | null> {
  if (t.enabled !== undefined && (await renderTemplate(t.enabled, scope, POSITIONS.trigger)) !== true) return null;
  const c = t.confirm === undefined ? "paw" : await renderTemplate(t.confirm, scope, POSITIONS.trigger);
  return c === "none" || c === "alt" ? c : "paw";
}

export async function pick(i: PickInput): Promise<Chosen | null> {
  const length = [...i.text].length;
  const page = { url: i.url, title: i.title };
  for (const f of i.resolved.features) {
    if (!f.enabled || !isEnabled(i.storage, f.ref) || !matchesAny(f.def.match, i.url) || matchesAny(f.def.exclude, i.url)) continue;
    for (const e of f.entries) {
      if (!e.enabled || !isEnabled(i.storage, e.ref) || e.def.present?.surface?.type !== "near-selection") continue;
      if (!matchesAny(entryMatch(f.def, e.def), i.url)) continue;
      const triggers = e.def.triggers.filter((t) => t.on === "selection");
      if (!triggers.length) continue;
      const settings = settingsOf(i.settings, f, e, i.hostname);
      const site = siteOf(i.resolved, e.ref, i.url);
      for (const t of triggers) {
        if (length < (t.minLength ?? DEFAULT_MIN) || length > (t.maxLength ?? DEFAULT_MAX)) continue;
        if (inside(i.elements, t.ignoreIn ?? DEFAULT_IGNORE)) continue;
        let confirm: Confirm | null;
        try {
          confirm = await confirmOf(t, { settings, site, page });
        } catch {
          confirm = null; // a broken trigger expression never fires
        }
        if (confirm) return { feature: f, entry: e, settings, site, page, confirm };
      }
    }
  }
  return null;
}
