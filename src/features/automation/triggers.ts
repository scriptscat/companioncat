/**
 * R1.1: which automation entries apply to the page, and the page-load / appear trigger watchers.
 * Commands are registered by the runtime (they need the shell's command API).
 */
import { renderTemplate, type Scope } from "../../core/expr";
import { isAutomationEntry } from "../../core/rules/automation";
import { POSITIONS } from "../../core/rules/positions";
import type { Resolved, ResolvedEntry, ResolvedFeature, TriggerDef } from "../../core/rules/types";
import type { Storage } from "../../core/stores";
import { isEnabled } from "../page/enabled";
import { entryMatch, matchesAny } from "../selection/match";

export const DEFAULT_DEBOUNCE_MS = 300;

export interface AutoEntry {
  feature: ResolvedFeature;
  entry: ResolvedEntry;
}

/** Automation entries whose feature and entry match `url` and are not switched off (consent and pause are checked when they fire). */
export function automationEntries(resolved: Resolved, storage: Pick<Storage, "get">, url: string): AutoEntry[] {
  const out: AutoEntry[] = [];
  for (const feature of resolved.features) {
    if (!feature.enabled || !isEnabled(storage, feature.ref) || !matchesAny(feature.def.match, url) || matchesAny(feature.def.exclude, url)) continue;
    for (const entry of feature.entries) {
      if (!entry.enabled || !isEnabled(storage, entry.ref) || !isAutomationEntry(entry.def)) continue;
      if (matchesAny(entryMatch(feature.def, entry.def), url)) out.push({ feature, entry });
    }
  }
  return out;
}

/** The trigger's `enabled` (e.g. a site setting); a broken expression never fires. */
export async function triggerAllows(t: TriggerDef, scope: Scope): Promise<boolean> {
  if (t.enabled === undefined) return true;
  try {
    return (await renderTemplate(t.enabled, scope, POSITIONS.autoTrigger)) === true;
  } catch {
    return false;
  }
}

/** Calls `cb` once after the page has loaded (now, when it already has). Returns cancel. */
export function afterLoad(win: Window, cb: () => void): () => void {
  if (win.document.readyState === "complete") {
    const t = win.setTimeout(cb, 0);
    return () => win.clearTimeout(t);
  }
  const on = () => cb();
  win.addEventListener("load", on, { once: true });
  return () => win.removeEventListener("load", on);
}

const validSelector = (doc: Document, selector: string) => {
  try {
    doc.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
};

/**
 * Calls `cb` with the first element matching `selector` added after the call (elements already on
 * the page never count); further matches within `debounceMs` of the first belong to the same batch.
 * `skip` leaves out our own UI. An invalid selector never fires. Returns stop.
 */
export function watchAppear(doc: Document, selector: string, debounceMs: number, skip: (el: Element) => boolean, cb: (el: Element) => void): () => void {
  if (!validSelector(doc, selector)) return () => {};
  const win = doc.defaultView ?? window;
  let batch: Element[] = [];
  let timer = 0;
  const flush = () => {
    timer = 0;
    const el = batch.find((e) => e.isConnected);
    batch = [];
    if (el) cb(el);
  };
  const mo = new win.MutationObserver((records) => {
    for (const r of records)
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || skip(n as Element)) continue;
        const el = n as Element;
        if (el.matches(selector)) batch.push(el);
        batch.push(...el.querySelectorAll(selector));
      }
    if (batch.length && !timer) timer = win.setTimeout(flush, debounceMs);
  });
  mo.observe(doc, { childList: true, subtree: true });
  return () => {
    mo.disconnect();
    if (timer) win.clearTimeout(timer);
    timer = 0;
    batch = [];
  };
}
