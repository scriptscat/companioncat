import { isObject } from "./merge";

/** Run steps that make an entry an automation entry (the schema's "present may be omitted" rule). */
export const AUTOMATION_STEPS = ["find", "act", "ask", "if", "repeat", "stop"] as const;

/**
 * Whether `entry` (a raw definition, a resolved EntryDef or an override patch) is an automation
 * entry: its run has a find, act, ask, if, repeat or stop step. Only automation entries may use
 * the page functions and the `trigger` variable, in their triggers and run (R1.4).
 */
export function isAutomationEntry(entry: unknown): boolean {
  if (!isObject(entry) || !Array.isArray(entry.run)) return false;
  return entry.run.some((step) => isObject(step) && AUTOMATION_STEPS.some((k) => k in step));
}
