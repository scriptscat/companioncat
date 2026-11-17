import { isObject } from "./merge";

export interface PackSummary {
  /** R2.7: what a pack contributes, as shown on each subscription in the rules page. */
  counts: {
    features: number;
    entries: number;
    /** Engines, not counting abstract ones that exist only to be inherited. */
    providers: number;
    settings: number;
    /** Settings shown in the cat's bubble (`quick`). */
    quick: number;
    views: number;
    contracts: number;
  };
  features: { id: string; name: string; entries: { id: string; name: string }[] }[];
  providers: { id: string; name: string }[];
  /** `feature` is the feature id; `entry` is set for entry-level settings. */
  settings: { feature: string; entry?: string; key: string; title: string; quick: boolean }[];
  views: { id: string; description?: string }[];
  contracts: { id: string; name?: string }[];
}

const objects = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObject) : []);
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);

/** Lists what a raw pack contributes (R2.7), for the subscription row and its detail page. */
export function summarize(pack: unknown): PackSummary {
  const p = isObject(pack) ? pack : {};
  const settings: PackSummary["settings"] = [];
  const collect = (from: unknown, feature: string, entry?: string) => {
    if (!isObject(from)) return;
    for (const [key, s] of Object.entries(from)) {
      if (!isObject(s)) continue;
      settings.push({ feature, ...(entry ? { entry } : {}), key, title: str(s.title, key), quick: !!s.quick });
    }
  };
  const features = objects(p.features).map((f) => {
    const id = str(f.id);
    collect(f.settings, id);
    const entries = objects(f.entries).map((e) => {
      collect(e.settings, id, str(e.id));
      return { id: str(e.id), name: str(e.name, str(e.id)) };
    });
    return { id, name: str(f.name, id), entries };
  });
  const providers = objects(p.providers)
    .filter((x) => x.abstract !== true)
    .map((x) => ({ id: str(x.id), name: str(x.name, str(x.id)) }));
  const views = Object.entries(isObject(p.views) ? p.views : {})
    .filter(([, v]) => isObject(v))
    .map(([id, v]) => ({ id, ...(typeof (v as Record<string, unknown>).description === "string" ? { description: (v as { description: string }).description } : {}) }));
  const contracts = objects(p.contracts).map((c) => ({ id: str(c.id), ...(typeof c.name === "string" ? { name: c.name } : {}) }));
  return {
    counts: {
      features: features.length,
      entries: features.reduce((n, f) => n + f.entries.length, 0),
      providers: providers.length,
      settings: settings.length,
      quick: settings.filter((s) => s.quick).length,
      views: views.length,
      contracts: contracts.length,
    },
    features,
    providers,
    settings,
    views,
    contracts,
  };
}
