import { ExprError, renderTemplate } from "../expr";
import { POSITIONS, type ResolvedProvider } from "../rules";
import type { TraceEvent } from "./trace";

/** The option values in effect: the user's values over the declared defaults. */
export function effectiveOptions(provider: ResolvedProvider, values: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, opt] of Object.entries(provider.def.options ?? {})) {
    const v = values[name] !== undefined ? values[name] : opt.default;
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/**
 * The provider's `hosts` rendered with `options` (lower-cased hostnames, no duplicates).
 * An entry whose expression fails (e.g. no baseUrl yet) contributes nothing, so requests to it are refused.
 */
export async function resolveHosts(
  provider: ResolvedProvider,
  options: Readonly<Record<string, unknown>>,
  onTrace?: (e: TraceEvent) => void,
): Promise<string[]> {
  const out = new Set<string>();
  for (const template of provider.def.hosts ?? []) {
    try {
      const value = await renderTemplate(template, { options }, POSITIONS.hosts);
      onTrace?.({ type: "expr", position: POSITIONS.hosts.name, template, value });
      if (typeof value === "string" && value.trim()) out.add(value.trim().toLowerCase());
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      onTrace?.({ type: "expr", position: POSITIONS.hosts.name, template, error: e.message });
    }
  }
  return [...out];
}
