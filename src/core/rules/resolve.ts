import type { ExprError } from "../expr";
import { escapePointer, pointer } from "./json";
import { applyPatch, isObject } from "./merge";
import { CHECKS, type ExprSink, type ItemKind, type Path } from "./positions";
import { type DefKind, type SchemaIssue, validateDef, validatePack } from "./schema";
import type {
  BridgeDef,
  ContractDef,
  Diagnostic,
  EntryDef,
  FeatureDef,
  JsonObject,
  PackSource,
  ProviderDef,
  Resolved,
  ResolvedContract,
  ResolvedEntry,
  ResolvedFeature,
  ResolvedItem,
  ResolvedProvider,
  ResolvedSite,
  RulePack,
  SiteDef,
  ViewTemplateDef,
} from "./types";

/** R2.5: at most this many inherited providers above any provider. */
const MAX_EXTENDS = 5;

interface Loc {
  source: number;
  pack: string;
  /** JSON pointer inside that source. */
  base: string;
}

interface Patch extends Loc {
  patch: JsonObject;
}

interface Node {
  kind: ItemKind;
  ref: string;
  id: string;
  /** The pack that provides the item. */
  owner: { source: number; pack: string; official: boolean };
  /** Where the definition is written (a local feature override can rewrite a feature's entries). */
  loc: Loc;
  raw: JsonObject;
  override?: Patch;
  /** False for an item shadowed by a higher-priority one with the same full id, or rejected. */
  active: boolean;
  problems: Diagnostic[];
  def?: JsonObject;
}

interface FeatureNode extends Node {
  merged: JsonObject;
  /** One slot per merged entry; null where the entry has no usable id. */
  entries: (Node | null)[];
}

interface Loaded {
  source: number;
  pack: RulePack;
  local: boolean;
  official: boolean;
  schemaIssues: SchemaIssue[];
}

/** Fields that hold items; a schema problem anywhere else rejects the whole pack. */
const ITEM_PATH = /^\/(?:(?:providers|bridges|contracts|sites|features)\/\d+|views\/[^/]+|overrides\/[^/]+)(?:\/|$)/;
const VERSIONED = /@\d+$/;

const fullRef = (ref: string, pack: string) => (ref.includes("/") ? ref : `${pack}/${ref}`);
const layer = (def: unknown, patch?: JsonObject) => (patch ? applyPatch(def, patch) : def) as JsonObject;
const isUnder = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

function getAt(root: unknown, path: Path): unknown {
  let cur = root;
  for (const seg of path) cur = isObject(cur) || Array.isArray(cur) ? (cur as Record<string, unknown>)[seg] : undefined;
  return cur;
}

/** Makes every `via` bridge reference in a provider fragment a full id, relative to the pack that wrote it. */
function normalizeVia(fragment: JsonObject, pack: string): JsonObject {
  if (!isObject(fragment.implements)) return fragment;
  const fix = (impl: unknown) => (isObject(impl) && typeof impl.via === "string" ? { ...impl, via: fullRef(impl.via, pack) } : impl);
  const implementsOut: JsonObject = {};
  for (const [k, v] of Object.entries(fragment.implements)) implementsOut[k] = Array.isArray(v) ? v.map(fix) : fix(v);
  return { ...fragment, implements: implementsOut };
}

/**
 * Turns packs into the resolved model (R2.5, R2.6, R4.1, R4.2): validates each pack,
 * applies priority (local first, then list order), `extends`, local `overrides` and
 * contract protection, and disables only the items that fail, saying why.
 */
export function resolveRules(input: readonly PackSource[]): Resolved {
  const order = input.map((s, source) => ({ s, source })).sort((a, b) => Number(!!b.s.local) - Number(!!a.s.local));
  const rank = new Map(order.map(({ source }, i) => [source, i]));
  const reported = new Set<Diagnostic>();

  const diag = (severity: Diagnostic["severity"], at: { source: number; pack: string }, path: string, message: string): Diagnostic => ({
    severity,
    source: at.source,
    pack: at.pack,
    path,
    message,
  });
  const report = (d: Diagnostic, ...nodes: Node[]) => {
    reported.add(d);
    for (const n of nodes) {
      d.item ??= n.ref;
      n.problems.push(d);
    }
  };
  const hasError = (n: Node) => n.problems.some((p) => p.severity === "error");
  /** "（原因）" of a disabled node, so whatever depends on it says why (R2.6). */
  const why = (n: Node) => {
    const m = n.problems.find((p) => p.severity === "error")?.message;
    return m ? `（${m}）` : "";
  };

  // ---- load: whole-pack schema problems reject the pack; item problems are judged per item later
  const loaded: Loaded[] = [];
  for (const { s, source } of order) {
    const id = isObject(s.pack) && typeof s.pack.id === "string" ? s.pack.id : "";
    const v = validatePack(s.pack);
    const top = v.errors.filter((e) => !ITEM_PATH.test(e.path));
    if (top.length > 0) {
      for (const e of top) report(diag("error", { source, pack: id }, e.path, e.message));
      continue;
    }
    loaded.push({ source, pack: s.pack as RulePack, local: !!s.local, official: !!s.official, schemaIssues: v.errors });
  }

  const overrides = new Map<string, Patch>();
  for (const L of loaded) {
    if (L.pack.overrides === undefined) continue;
    if (!L.local) {
      report(diag("warning", { source: L.source, pack: L.pack.id }, "/overrides", "overrides 只在本地规则里有效，已忽略"));
      continue;
    }
    for (const [key, patch] of Object.entries(L.pack.overrides)) {
      const base = `/overrides/${escapePointer(key)}`;
      if (isObject(patch) && !overrides.has(key)) overrides.set(key, { source: L.source, pack: L.pack.id, base, patch });
    }
  }

  // ---- build item nodes in priority order
  const nodes: Node[] = [];
  const index = new Map<string, Node>(); // `${kind} ${ref}` -> the active node
  const registry = new Map<string, Node[]>(); // `${source} ${pointer}` -> nodes written there
  const register = (source: number, base: string, n: Node | null) => {
    const key = `${source} ${base}`;
    const list = registry.get(key) ?? [];
    if (n) list.push(n);
    registry.set(key, list);
  };
  const matchedOverrides = new Set<string>();
  const features: FeatureNode[] = [];
  const sites: { node: Node; L: Loaded }[] = [];

  const drop = (L: Loaded, base: string, fallback: string) => {
    const issues = L.schemaIssues.filter((e) => isUnder(e.path, base));
    for (const e of issues.length > 0 ? issues : [{ path: base, message: fallback }]) {
      report(diag("error", { source: L.source, pack: L.pack.id }, e.path, e.message));
    }
    register(L.source, base, null);
  };

  const add = (kind: ItemKind, L: Loaded, raw: JsonObject, id: string, ref: string, loc: Loc, overridable: boolean): Node => {
    const n: Node = {
      kind,
      ref,
      id,
      owner: { source: L.source, pack: L.pack.id, official: L.official },
      loc,
      raw,
      active: true,
      problems: [],
    };
    const prev = index.get(`${kind} ${ref}`);
    if (prev) {
      n.active = false;
      if (prev.owner.source === L.source) report(diag("error", loc, loc.base, `id ${id} 重复`), n);
    } else if (kind !== "contract") {
      index.set(`${kind} ${ref}`, n);
    }
    if (n.active && overridable) {
      n.override = overrides.get(ref);
      if (n.override) {
        matchedOverrides.add(ref);
        register(n.override.source, n.override.base, n);
      }
    }
    register(loc.source, loc.base, n);
    nodes.push(n);
    return n;
  };

  for (const L of loaded) {
    const at = (base: string): Loc => ({ source: L.source, pack: L.pack.id, base });
    const list = (field: "contracts" | "bridges" | "providers", kind: ItemKind) =>
      ((L.pack[field] ?? []) as unknown[]).forEach((raw, i) => {
        const base = `/${field}/${i}`;
        if (!isObject(raw) || typeof raw.id !== "string") return drop(L, base, "缺少 id");
        const ref = kind === "contract" ? raw.id : `${L.pack.id}/${raw.id}`;
        add(kind, L, raw, raw.id, ref, at(base), kind !== "contract");
      });
    list("contracts", "contract");
    list("bridges", "bridge");
    list("providers", "provider");

    for (const [id, raw] of Object.entries(L.pack.views ?? {})) {
      const base = `/views/${escapePointer(id)}`;
      if (raw === null) continue;
      if (!isObject(raw)) {
        drop(L, base, "格式不对");
        continue;
      }
      add("view", L, raw, id, `${L.pack.id}/${id}`, at(base), true);
    }

    (L.pack.features ?? []).forEach((raw: unknown, i) => {
      const base = `/features/${i}`;
      if (!isObject(raw) || typeof raw.id !== "string") return drop(L, base, "缺少 id");
      const f = add("feature", L, raw, raw.id, `${L.pack.id}/${raw.id}`, at(base), true) as FeatureNode;
      f.merged = layer(applyPatch({}, raw), f.override?.patch);
      f.entries = [];
      if (!f.active) return;
      features.push(f);
      const fromOverride = f.override && "entries" in f.override.patch ? f.override : undefined;
      if (fromOverride && Array.isArray(raw.entries)) raw.entries.forEach((_, j) => register(L.source, `${base}/entries/${j}`, null));
      const entries: unknown[] = Array.isArray(f.merged.entries) ? f.merged.entries : [];
      entries.forEach((e, j) => {
        const loc = fromOverride ? { ...fromOverride, base: `${fromOverride.base}/entries/${j}` } : at(`${base}/entries/${j}`);
        if (!isObject(e) || typeof e.id !== "string") {
          f.entries.push(null);
          return;
        }
        f.entries.push(add("entry", L, e, e.id, `${f.ref}.${e.id}`, loc, true));
      });
    });

    (L.pack.sites ?? []).forEach((raw: unknown, i) => {
      const base = `/sites/${i}`;
      if (!isObject(raw)) return drop(L, base, "格式不对");
      sites.push({ node: add("site", L, raw, String(i), `${L.pack.id}#sites/${i}`, at(base), false), L });
    });
  }

  // ---- contract registration: official ids are protected, new ids need a major version
  const contracts: Node[] = [];
  {
    const declared = nodes.filter((n) => n.kind === "contract");
    const officialIds = new Set(declared.filter((n) => n.owner.official).map((n) => n.id));
    const registered = new Map<string, Node>();
    const byOfficial = [...declared].sort((a, b) => Number(b.owner.official) - Number(a.owner.official));
    for (const n of byOfficial) {
      n.active = false;
      if (!n.owner.official && officialIds.has(n.id)) {
        report(diag("error", n.loc, n.loc.base, `契约 ${n.id} 是官方规则包声明的，不能覆盖`), n);
      } else if (!n.owner.official && !VERSIONED.test(n.id)) {
        report(diag("error", n.loc, n.loc.base, `新契约的 id 要带大版本号，例如 weather/current@1`), n);
      } else if (registered.has(n.id)) {
        if (registered.get(n.id)!.owner.source === n.owner.source) report(diag("error", n.loc, n.loc.base, `契约 ${n.id} 重复`), n);
      } else {
        n.active = true;
        registered.set(n.id, n);
        contracts.push(n);
      }
    }
    for (const n of contracts) index.set(`contract ${n.id}`, n);
  }

  // ---- expression problems, attributed to the item (or override) that wrote them
  const attach = (source: number, ptr: string, d: Diagnostic) => {
    for (let p = ptr; ; p = p.slice(0, p.lastIndexOf("/"))) {
      const found = registry.get(`${source} ${p}`);
      if (found) {
        const live = found.filter((n) => n.active);
        if (live.length > 0) report(d, ...live);
        return;
      }
      if (p === "") return report(d);
    }
  };
  for (const L of loaded) {
    const seen = new Set<string>();
    const sink: ExprSink = (e: ExprError, path) => {
      const ptr = pointer(path);
      const key = `${ptr} ${e.start} ${e.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      const template = getAt(L.pack, path);
      const d = diag("error", { source: L.source, pack: L.pack.id }, ptr, `表达式错误：${e.message}`);
      d.expr = { template: typeof template === "string" ? template : "", source: e.expr, start: e.start, end: e.end };
      attach(L.source, ptr, d);
    };
    const p = L.pack;
    (p.contracts ?? []).forEach((v, i) => CHECKS.contract(v, ["contracts", i], sink));
    (p.bridges ?? []).forEach((v, i) => CHECKS.bridge(v, ["bridges", i], sink));
    (p.providers ?? []).forEach((v, i) => CHECKS.provider(v, ["providers", i], sink));
    for (const [k, v] of Object.entries(p.views ?? {})) CHECKS.view(v, ["views", k], sink);
    (p.features ?? []).forEach((v, i) => CHECKS.feature(v, ["features", i], sink));
    (p.sites ?? []).forEach((v, i) => CHECKS.site(v, ["sites", i], sink));
    if (L.local) {
      for (const [key, patch] of Object.entries(p.overrides ?? {})) {
        const kinds = new Set(nodes.filter((n) => n.active && n.override?.patch === patch).map((n) => n.kind));
        for (const kind of kinds) CHECKS[kind](patch, ["overrides", key], sink);
      }
    }
  }

  // ---- merged definitions
  /** Where problems in a merged definition are reported: the local override when there is one. */
  const blame = (n: Node): Loc => n.override ?? n.loc;
  const schemaProblems = (n: Node, issues: SchemaIssue[]) => {
    const at = blame(n);
    for (const e of issues) report(diag("error", at, at.base + e.path, e.message), n);
  };
  const simple = (kind: DefKind, n: Node) => {
    n.def = layer(applyPatch({}, n.raw), n.override?.patch);
    schemaProblems(n, validateDef(kind, n.def));
  };

  for (const n of contracts) {
    n.def = n.raw;
    schemaProblems(n, validateDef("contract", n.def));
  }
  const active = (kind: ItemKind) => nodes.filter((n) => n.kind === kind && n.active);
  for (const n of active("bridge")) simple("bridge", n);
  for (const n of active("view")) simple("viewTemplate", n);

  // Problems an item has on its own (expressions, duplicates), before inheritance is judged.
  const ownError = new Set(nodes.filter(hasError));
  const providerOut: ResolvedProvider[] = [];
  for (const n of active("provider")) {
    const extendsOf = (x: Node): string | undefined => {
      const v = x.override && "extends" in x.override.patch ? x.override.patch.extends : x.raw.extends;
      if (typeof v !== "string") return undefined;
      return fullRef(v, x.override && "extends" in x.override.patch ? x.override.pack : x.owner.pack);
    };
    const extendsAt = `${blame(n).base}/extends`;
    const chain = [n];
    let broken = false;
    for (let target = extendsOf(n); target !== undefined; target = extendsOf(chain.at(-1)!)) {
      const fail = (message: string) => {
        report(diag("error", blame(n), extendsAt, message), n);
        broken = true;
      };
      if (chain.some((c) => c.ref === target)) {
        fail(`继承成环：${[...chain.map((c) => c.ref), target].join(" → ")}`);
        break;
      }
      const parent = index.get(`provider ${target}`);
      if (!parent) {
        fail(`继承的 ${target} 找不到`);
        break;
      }
      chain.push(parent);
      if (chain.length - 1 > MAX_EXTENDS) {
        fail(`继承超过 ${MAX_EXTENDS} 层：${chain.map((c) => c.ref).join(" → ")}`);
        break;
      }
    }
    if (!broken) {
      for (const a of chain.slice(1)) if (ownError.has(a)) report(diag("error", blame(n), extendsAt, `继承的 ${a.ref} 有错误`), n);
    }

    let def: JsonObject = {};
    for (const c of [...chain].reverse()) {
      def = layer(def, normalizeVia(c.raw, c.owner.pack));
      if (c.override) def = layer(def, normalizeVia(c.override.patch, c.override.pack));
    }
    const abstract = def.abstract === true;
    delete def.extends;
    delete def.abstract;
    n.def = def;
    if (abstract) continue;

    if (!broken) {
      schemaProblems(n, validateDef("provider", def));
      const at = blame(n);
      for (const [contract, impls] of Object.entries(isObject(def.implements) ? def.implements : {})) {
        const implPath = `${at.base}/implements/${escapePointer(contract)}`;
        if (!index.has(`contract ${contract}`)) report(diag("warning", at, implPath, `契约 ${contract} 没有声明`), n);
        const list = Array.isArray(impls) ? impls : [impls];
        list.forEach((impl: unknown, i) => {
          if (!isObject(impl) || typeof impl.via !== "string") return;
          const viaPath = `${implPath}${Array.isArray(impls) ? `/${i}` : ""}/via`;
          const bridge = index.get(`bridge ${impl.via}`);
          if (!bridge) report(diag("error", at, viaPath, `桥接 ${impl.via} 找不到`), n);
          else if (hasError(bridge)) report(diag("error", at, viaPath, `桥接 ${impl.via} 已停用${why(bridge)}`), n);
          else if (bridge.def?.from !== contract) {
            report(diag("error", at, viaPath, `桥接 ${impl.via} 实现的是 ${String(bridge.def?.from)}，不是 ${contract}`), n);
          }
        });
      }
    }
    const secretsFrom = chain.find((c) => "secrets" in c.raw || (c.override && "secrets" in c.override.patch)) ?? n;
    providerOut.push({
      ...item<ProviderDef>(n),
      ancestors: chain.slice(1).map((c) => c.ref),
      secretsFrom: secretsFrom.ref,
    });
  }

  const featureOut: ResolvedFeature[] = [];
  for (const f of features) {
    const entryDefs = f.entries.map((e, j) => {
      if (!e) return (f.merged.entries as unknown[])[j];
      const def = layer(applyPatch({}, e.raw), e.override?.patch); // a copy: present.view.use is rewritten below
      const view = getAt(def, ["present", "view"]);
      if (isObject(view) && typeof view.use === "string") {
        const writer = getAt(e.override?.patch, ["present", "view", "use"]) !== undefined ? e.override! : e.loc;
        def.present = { ...(def.present as JsonObject), view: { ...view, use: fullRef(view.use, writer.pack) } };
      }
      e.def = def;
      return def;
    });
    const fAt = blame(f);
    for (const issue of validateDef("feature", { ...f.merged, entries: entryDefs })) {
      const m = /^\/entries\/(\d+)(\/.*)?$/.exec(issue.path);
      const e = m ? f.entries[Number(m[1])] : null;
      if (e) schemaProblems(e, [{ path: m![2] ?? "", message: issue.message }]);
      else report(diag("error", fAt, fAt.base + issue.path, issue.message), f);
    }
    const { entries: _entries, ...featureDef } = f.merged;
    f.def = featureDef;

    const entries: ResolvedEntry[] = [];
    for (const e of f.entries) {
      if (!e || !e.active) continue;
      const use = getAt(e.def, ["present", "view", "use"]);
      if (typeof use === "string") {
        const at = blame(e);
        const view = index.get(`view ${use}`);
        const usePath = `${at.base}/present/view/use`;
        if (!view) report(diag("error", at, usePath, `视图 ${use} 找不到`), e);
        else if (hasError(view)) report(diag("error", at, usePath, `视图 ${use} 已停用${why(view)}`), e);
      }
      const out = item<EntryDef>(e);
      if (hasError(f)) out.enabled = false;
      entries.push(out);
    }
    featureOut.push({ ...item<Omit<FeatureDef, "entries">>(f), entries });
  }

  const siteOut: ResolvedSite[] = [];
  for (const { node, L } of sites) {
    if (!node.active) continue;
    schemaProblems(node, validateDef("site", node.raw));
    if (!hasError(node)) siteOut.push({ pack: L.pack.id, source: L.source, def: node.raw as SiteDef });
  }

  for (const [key, o] of overrides) {
    if (!matchedOverrides.has(key)) report(diag("warning", o, o.base, `要修改的 ${key} 找不到`));
  }

  function item<T>(n: Node): ResolvedItem<T> {
    return {
      ref: n.ref,
      id: n.id,
      pack: n.owner.pack,
      source: n.owner.source,
      def: n.def as T,
      enabled: !hasError(n),
      problems: n.problems,
    };
  }
  const listOf = <T>(kind: ItemKind) => active(kind).map((n) => item<T>(n));

  return {
    features: featureOut,
    providers: providerOut,
    views: listOf<ViewTemplateDef>("view"),
    bridges: listOf<BridgeDef>("bridge"),
    contracts: contracts.map((n): ResolvedContract => ({ ...item<ContractDef>(n), official: n.owner.official })),
    sites: siteOut,
    diagnostics: [...reported].sort((a, b) => (rank.get(a.source) ?? 0) - (rank.get(b.source) ?? 0)),
  };
}
