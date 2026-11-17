import type { Resolved, ResolvedFeature, ResolvedProvider, SettingDef } from "../rules/types";

/** Test helper: a hand-built Resolved with only what the stores read. */
export function makeResolved(opts: {
  settings?: Record<string, SettingDef>;
  entrySettings?: Record<string, SettingDef>;
  providers?: { ref: string; secrets?: string[]; secretsFrom?: string; hosts?: string[] }[];
}): Resolved {
  const feature = {
    ref: "p/translate",
    id: "translate",
    pack: "p",
    source: 0,
    enabled: true,
    problems: [],
    def: { id: "translate", name: "T", match: [], settings: opts.settings },
    entries: [
      {
        ref: "p/translate.select",
        id: "select",
        pack: "p",
        source: 0,
        enabled: true,
        problems: [],
        def: { id: "select", name: "S", settings: opts.entrySettings, triggers: [], run: [], present: {} },
      },
    ],
  } as unknown as ResolvedFeature;
  const providers = (opts.providers ?? []).map(
    (p) =>
      ({
        ref: p.ref,
        id: p.ref.split("/")[1],
        pack: p.ref.split("/")[0],
        source: 0,
        enabled: true,
        problems: [],
        ancestors: [],
        secretsFrom: p.secretsFrom ?? p.ref,
        def: {
          id: p.ref.split("/")[1],
          name: p.ref,
          hosts: p.hosts,
          // like the resolver: a child that does not redeclare secrets inherits its owner's list
          secrets: (p.secrets ?? opts.providers?.find((o) => o.ref === p.secretsFrom)?.secrets)?.map((name) => ({ name, title: name })),
          implements: {},
        },
      }) as unknown as ResolvedProvider,
  );
  return { features: [feature], providers, views: [], bridges: [], contracts: [], sites: [], diagnostics: [] };
}
