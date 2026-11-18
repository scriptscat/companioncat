import { isAutomationEntry } from "../../core/rules/automation";
import type { EntryDef, ResolvedEntry } from "../../core/rules/types";
import type { Storage } from "../../platform/storage";
import { actsOf, sendsOf, type DescribeCtx } from "./describe";

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

/**
 * Consent to a subscribed automation entry (R3.1, R3.3): the fingerprint it was enabled with, under
 * `cc:auto:consent:<ref>`. Outside `cc:set:` (which settings.migrate prunes) and `cc:on:`.
 */
export const CONSENT_PREFIX = "cc:auto:consent:";
export const consentKey = (ref: string) => `${CONSENT_PREFIX}${ref}`;

/** What the user agreed to: the sorted act kinds plus the sorted send hosts (R3.3). */
export function fingerprint(entry: EntryDef, ctx: DescribeCtx = {}): string {
  // the engine that goes first in 通用 is the user's choice, not the rule's: changing it is not an update to re-confirm
  const { preferred: _preferred, ...rule } = ctx;
  const hosts = [...new Set(sendsOf(entry, rule).flatMap((s) => s.hosts))].sort();
  return `acts:${actsOf(entry).join(",")}|hosts:${hosts.join(",")}`;
}

export type Gate = "on" | "off" | "needs-consent" | "paused-by-update";

export interface GateOptions {
  /** The entry comes from the local pack: on by default, no consent (R3.4). */
  local?: boolean;
  /** Settings and hosts the fingerprint is computed with. */
  describe?: DescribeCtx;
}

/**
 * Whether `entry` runs. Non-automation entries keep the phase-1 switch (R3.5). Automation entries from
 * a subscribed pack are off until consent (`needs-consent`), are `off` once switched off, and are
 * `paused-by-update` when an update changed the act kinds or send hosts consented to (R3.3).
 * Local ones are on unless switched off (R3.4).
 */
export function gateOf(storage: Pick<Storage, "get">, entry: ResolvedEntry, opts: GateOptions = {}): Gate {
  if (!isEnabled(storage, entry.ref)) return "off";
  if (!isAutomationEntry(entry.def) || opts.local) return "on";
  const consent = storage.get(consentKey(entry.ref));
  if (typeof consent !== "string") return "needs-consent";
  return consent === fingerprint(entry.def, opts.describe) ? "on" : "paused-by-update";
}

/** Switch an automation entry on and record the fingerprint the user saw (also re-consent after an update). */
export function enableWithConsent(storage: Pick<Storage, "set" | "delete">, ref: string, fp: string): void {
  storage.set(consentKey(ref), fp);
  storage.delete(enabledKey(ref));
}

/** Switch an entry off. Consent is kept, so switching back on after an unchanged rule needs no new fingerprint. */
export function disable(storage: Pick<Storage, "set">, ref: string): void {
  storage.set(enabledKey(ref), false);
}
