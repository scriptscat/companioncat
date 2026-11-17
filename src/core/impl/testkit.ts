/** Test-only helpers shared by the impl tests (not imported by runtime code). */
import { readFileSync } from "node:fs";
import { resolveRules, type ProviderDef, type Resolved, type ResolvedProvider } from "../rules";
import type { ImplContext, TraceEvent } from "./index";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../rules/packs/${name}.json`, import.meta.url), "utf8"));

/** Both official packs, optionally under a local pack (for overrides). */
export function official(local?: object): Resolved {
  return resolveRules([
    ...(local ? [{ pack: { schema: 1, id: "local", ...local }, local: true }] : []),
    { pack: read("official-translate"), official: true },
    { pack: read("official-llm"), official: true },
  ]);
}

export function providerOf(r: Resolved, ref: string): ResolvedProvider {
  const p = r.providers.find((x) => x.ref === ref);
  if (!p) throw new Error(`no provider ${ref}`);
  return p;
}

/** A provider built straight from a definition, skipping rule resolution. */
export function testProvider(def: Partial<ProviderDef> & Pick<ProviderDef, "implements">): ResolvedProvider {
  const full: ProviderDef = { id: "x", name: "测试引擎", ...def };
  return {
    ref: `test/${full.id}`,
    id: full.id,
    pack: "test",
    source: 0,
    def: full,
    enabled: true,
    problems: [],
    ancestors: [],
    secretsFrom: `test/${full.id}`,
  };
}

export type TestContext = ImplContext & { trace: TraceEvent[]; deltas: string[] };

export function ctxFor(r: Resolved, extra: Partial<ImplContext> = {}): TestContext {
  const trace: TraceEvent[] = [];
  const deltas: string[] = [];
  return {
    rules: r,
    onTrace: (e) => trace.push(e),
    onDelta: (d) => deltas.push(d.text),
    ...extra,
    trace,
    deltas,
  };
}

