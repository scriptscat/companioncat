/** `vote` (R6.2): engines agree when `choose` gives the same choice, or other outputs match once normalized. */
import { isObject } from "../rules/merge";
import { stableJson } from "./cache";

/** Strings trimmed, case and inner whitespace folded; reported confidence and usage ignored. */
function normalize(v: unknown, top = false): unknown {
  if (typeof v === "string") return v.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  if (Array.isArray(v)) return v.map((x) => normalize(x));
  if (isObject(v)) {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !(top && (k === "confidence" || k === "usage")))
        .map(([k, x]) => [k, normalize(x)]),
    );
  }
  return v;
}

export function voteKey(contract: string, output: unknown): string {
  if (contract === "choose" && isObject(output)) return `choice:${String(output.choice)}`;
  return stableJson(normalize(output, true));
}

/**
 * Index (into `outputs`) of the first member of the largest agreeing group, and that group's share.
 * Ties go to the group whose first member comes first.
 */
export function tally(contract: string, outputs: readonly unknown[]): { winner: number; share: number } | undefined {
  const groups = new Map<string, { first: number; size: number }>();
  outputs.forEach((o, i) => {
    const k = voteKey(contract, o);
    const g = groups.get(k);
    if (g) g.size++;
    else groups.set(k, { first: i, size: 1 });
  });
  let best: { first: number; size: number } | undefined;
  for (const g of groups.values()) if (!best || g.size > best.size) best = g;
  return best && { winner: best.first, share: best.size / outputs.length };
}
