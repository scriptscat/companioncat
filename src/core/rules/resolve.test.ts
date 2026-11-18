import { describe, expect, it } from "vitest";
import { resolveRules, type PackSource, type Resolved } from "./index";

const pack = (id: string, body: Record<string, unknown> = {}) => ({ schema: 1, id, name: id, version: "1", ...body });
const sub = (id: string, body: Record<string, unknown> = {}): PackSource => ({ pack: pack(id, body) });
const local = (body: Record<string, unknown>): PackSource => ({ pack: pack("local", body), local: true });

const CONTRACTS: PackSource = {
  official: true,
  pack: pack("official-llm", {
    contracts: [
      { id: "translate", input: { type: "object" }, output: { type: "object" } },
      { id: "chat", input: { type: "object" }, output: { type: "object" } },
    ],
  }),
};

const http = (url = "https://a.test/t") => ({
  http: { request: { url }, response: "json", output: { texts: "{{ [response.text] }}" } },
});
const provider = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  hosts: ["a.test"],
  implements: { translate: http() },
  ...extra,
});
const child = (id: string, parent: string, extra: Record<string, unknown> = {}) => ({ id, extends: parent, ...extra });

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  triggers: [{ on: "selection", enabled: "{{ settings.on }}" }],
  run: [{ call: "translate", input: { texts: ["{{ selection.text }}"], to: "{{ settings.to }}" }, as: "results" }],
  present: { surface: { type: "near-selection" }, view: { type: "text", value: "{{ vars.results[0] }}" } },
  ...extra,
});
const feature = (id: string, entries: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  match: ["*://*/*"],
  entries,
  ...extra,
});

const prov = (r: Resolved, ref: string) => r.providers.find((p) => p.ref === ref);
const entryOf = (r: Resolved, ref: string) => r.features.flatMap((f) => f.entries).find((e) => e.ref === ref);
const reasons = (item: { problems: { message: string }[] } | undefined) => item?.problems.map((p) => p.message);

describe("priority (R2.5)", () => {
  it("puts local rules first, then subscriptions in list order", () => {
    const r = resolveRules([
      sub("first", { providers: [provider("a")] }),
      sub("second", { providers: [provider("b")] }),
      local({ providers: [provider("mine")] }),
      CONTRACTS,
    ]);
    expect(r.providers.map((p) => p.ref)).toEqual(["local/mine", "first/a", "second/b"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("takes the whole higher-priority item for the same full id, without field merging", () => {
    const r = resolveRules([
      sub("community", { providers: [provider("kimi", { name: "A", description: "from A" })] }),
      sub("community", { providers: [provider("kimi", { name: "B", icon: "star" }), provider("other")] }),
      CONTRACTS,
    ]);
    const kimi = r.providers.filter((p) => p.ref === "community/kimi");
    expect(kimi).toHaveLength(1);
    expect(kimi[0]!.def).toMatchObject({ name: "A", description: "from A" });
    expect(kimi[0]!.def).not.toHaveProperty("icon");
    expect(prov(r, "community/other")?.source).toBe(1);
  });
});

describe("extends (R2.5)", () => {
  const base = sub("base", {
    providers: [
      provider("parent", {
        abstract: true,
        description: "parent text",
        hosts: ["p1.test", "p2.test"],
        options: {
          model: { type: "string", title: "模型", placeholder: "m" },
          baseUrl: { type: "string", title: "地址" },
        },
        secrets: [{ name: "apiKey", title: "API Key" }],
      }),
    ],
  });

  it("inherits across packs: deep-merges objects, replaces arrays, deletes null fields", () => {
    const r = resolveRules([
      base,
      sub("community", {
        providers: [
          child("kid", "base/parent", {
            abstract: false,
            name: "Kid",
            description: null,
            hosts: ["kid.test"],
            options: { model: { default: "kimi" }, baseUrl: null },
          }),
        ],
      }),
      CONTRACTS,
    ]);
    const kid = prov(r, "community/kid")!;
    expect(kid.enabled).toBe(true);
    expect(kid.def).toMatchObject({
      name: "Kid",
      hosts: ["kid.test"],
      options: { model: { type: "string", title: "模型", placeholder: "m", default: "kimi" } },
      implements: { translate: http() },
    });
    expect(kid.def).not.toHaveProperty("description");
    expect(kid.def).not.toHaveProperty("extends");
    expect(kid.def.options).not.toHaveProperty("baseUrl");
    expect(kid.ancestors).toEqual(["base/parent"]);
    expect(kid.secretsFrom).toBe("base/parent");
    // abstract providers are only for inheriting; `abstract` itself is inherited like any field
    expect(prov(r, "base/parent")).toBeUndefined();
    const twin = resolveRules([base, sub("c", { providers: [child("twin", "base/parent", { name: "Twin" })] }), CONTRACTS]);
    expect(prov(twin, "c/twin")).toBeUndefined();
    expect(r.diagnostics).toEqual([]);
  });

  it("resolves an unqualified parent inside the same pack", () => {
    const r = resolveRules([sub("p", { providers: [provider("root"), child("leaf", "root", { name: "Leaf" })] }), CONTRACTS]);
    expect(prov(r, "p/leaf")).toMatchObject({ enabled: true, ancestors: ["p/root"], secretsFrom: "p/leaf" });
    expect(prov(r, "p/leaf")!.def.hosts).toEqual(["a.test"]);
  });

  it("allows at most 5 levels of inheritance", () => {
    const chain = [provider("p0"), ...[1, 2, 3, 4, 5, 6].map((i) => child(`p${i}`, `p${i - 1}`))];
    const r = resolveRules([sub("deep", { providers: chain }), CONTRACTS]);
    expect(prov(r, "deep/p5")).toMatchObject({ enabled: true });
    expect(prov(r, "deep/p5")!.ancestors).toHaveLength(5);
    const p6 = prov(r, "deep/p6")!;
    expect(p6.enabled).toBe(false);
    expect(reasons(p6)).toEqual([expect.stringContaining("继承超过 5 层")]);
    expect(p6.problems[0]).toMatchObject({ severity: "error", path: "/providers/6/extends", item: "deep/p6" });
  });

  it("disables providers whose inheritance forms a cycle", () => {
    const r = resolveRules([
      sub("loop", { providers: [child("a", "b", { name: "A" }), child("b", "a", { name: "B" }), provider("ok")] }),
      CONTRACTS,
    ]);
    expect(reasons(prov(r, "loop/a"))).toEqual(["继承成环：loop/a → loop/b → loop/a"]);
    expect(prov(r, "loop/b")!.enabled).toBe(false);
    expect(prov(r, "loop/ok")!.enabled).toBe(true);
  });
});

describe("local overrides (R2.5)", () => {
  const community = sub("community", {
    providers: [
      provider("base", { abstract: true, options: { model: { type: "string", title: "模型", default: "m1" } } }),
      child("kimi", "base", { name: "Kimi", abstract: false }),
    ],
    views: { card: { type: "text", value: "{{ params.x }}", params: ["x"] } },
    features: [feature("f", [entry("sel"), entry("other")])],
  });

  it("merges a local override onto the target with the same rules", () => {
    const r = resolveRules([
      community,
      local({
        overrides: {
          "community/kimi": { name: "Kimi 2", hosts: ["b.test"], options: { model: { default: "m2" } } },
          "community/f.sel": { triggers: [{ on: "selection", enabled: false }], present: { surface: { pinnable: true } } },
          "community/card": { tone: "muted" },
        },
      }),
      CONTRACTS,
    ]);
    expect(prov(r, "community/kimi")!.def).toMatchObject({
      name: "Kimi 2",
      hosts: ["b.test"],
      options: { model: { type: "string", title: "模型", default: "m2" } },
    });
    expect(entryOf(r, "community/f.sel")!.def).toMatchObject({
      triggers: [{ on: "selection", enabled: false }],
      present: { surface: { type: "near-selection", pinnable: true } },
    });
    expect(entryOf(r, "community/f.other")!.def.triggers).toEqual(entry("other").triggers);
    expect(r.views.find((v) => v.ref === "community/card")!.def).toMatchObject({ type: "text", tone: "muted" });
    expect(r.diagnostics).toEqual([]);
  });

  it("applies an override on a parent before children inherit from it", () => {
    const r = resolveRules([community, local({ overrides: { "community/base": { options: { model: { default: "m9" } } } } }), CONTRACTS]);
    expect(prov(r, "community/kimi")!.def.options).toEqual({ model: { type: "string", title: "模型", default: "m9" } });
  });

  it("ignores overrides outside local rules, and reports missing targets", () => {
    const r = resolveRules([
      sub("community", { providers: [provider("kimi")], overrides: { "community/kimi": { name: "hacked" } } }),
      local({ overrides: { "community/nope": { name: "x" } } }),
      CONTRACTS,
    ]);
    expect(prov(r, "community/kimi")!.def.name).toBe("kimi");
    expect(r.diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", pack: "local", path: "/overrides/community~1nope", message: "要修改的 community/nope 找不到" }),
      expect.objectContaining({ severity: "warning", pack: "community", path: "/overrides", message: "overrides 只在本地规则里有效，已忽略" }),
    ]);
  });

  it("disables the target when an override deletes a required field", () => {
    const r = resolveRules([community, local({ overrides: { "community/f.sel": { run: null } } }), CONTRACTS]);
    const sel = entryOf(r, "community/f.sel")!;
    expect(sel.enabled).toBe(false);
    expect(sel.problems).toEqual([
      expect.objectContaining({ message: "缺少必填字段 run", pack: "local", path: "/overrides/community~1f.sel" }),
    ]);
    expect(entryOf(r, "community/f.other")!.enabled).toBe(true);
  });
});

describe("contracts (R2.5, R4.1, R4.2)", () => {
  it("keeps official contract ids from being overridden by other packs", () => {
    const r = resolveRules([
      local({ contracts: [{ id: "translate", input: { type: "string" }, output: { type: "string" } }] }),
      sub("evil", { contracts: [{ id: "chat", input: {}, output: {} }] }),
      CONTRACTS,
    ]);
    const translate = r.contracts.find((c) => c.id === "translate")!;
    expect(translate).toMatchObject({ pack: "official-llm", official: true, enabled: true });
    expect(translate.def.input).toEqual({ type: "object" });
    expect(r.contracts.filter((c) => c.id === "chat")).toHaveLength(1);
    expect(r.diagnostics.map((d) => [d.pack, d.path, d.message])).toEqual([
      ["local", "/contracts/0", "契约 translate 是官方规则包声明的，不能覆盖"],
      ["evil", "/contracts/0", "契约 chat 是官方规则包声明的，不能覆盖"],
    ]);
  });

  it("registers a new contract that engines can implement", () => {
    const weather = {
      id: "weather/current@1",
      name: "当前天气",
      description: "查询城市的当前天气",
      input: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      output: { type: "object", properties: { temp: { type: "number" } }, required: ["temp"] },
      bridgeable: false,
      sample: { city: "杭州" },
      view: { type: "text", value: "{{ result.temp }}°" },
    };
    const r = resolveRules([
      sub("wx", {
        contracts: [weather],
        providers: [
          {
            id: "wttr",
            name: "wttr",
            hosts: ["wttr.test"],
            implements: {
              "weather/current@1": {
                http: { request: { url: "https://wttr.test/{{ input.city }}" }, output: { temp: "{{ response.t }}" } },
              },
            },
          },
        ],
      }),
      CONTRACTS,
    ]);
    expect(r.contracts.map((c) => c.id)).toEqual(["translate", "chat", "weather/current@1"]);
    expect(r.contracts[2]).toMatchObject({ ref: "weather/current@1", pack: "wx", official: false, enabled: true, def: weather });
    expect(prov(r, "wx/wttr")!.enabled).toBe(true);
    expect(r.diagnostics).toEqual([]);
  });

  it("requires a major version on new contract ids and warns about undeclared contracts", () => {
    const r = resolveRules([
      sub("wx", {
        contracts: [{ id: "weather", input: {}, output: {} }],
        providers: [provider("p", { implements: { "weather/now@1": http() } })],
      }),
      CONTRACTS,
    ]);
    expect(r.contracts.map((c) => c.id)).toEqual(["translate", "chat"]);
    expect(prov(r, "wx/p")!.enabled).toBe(true);
    expect(r.diagnostics.map((d) => [d.severity, d.path, d.message])).toEqual([
      ["error", "/contracts/0", "新契约的 id 要带大版本号，例如 weather/current@1"],
      ["warning", "/providers/0/implements/weather~1now@1", "契约 weather/now@1 没有声明"],
    ]);
  });
});

describe("partial failure (R2.6)", () => {
  const { run: _run, ...noRun } = entry("no-run");
  it("disables only the broken engine, entry or view and says why", () => {
    const r = resolveRules([
      sub("community", {
        views: {
          good: { type: "text", value: "{{ params.x }}", params: ["x"] },
          bad: { type: "text", value: "{{ vars.x }}" },
        },
        providers: [
          child("orphan", "community/kimi-base", { name: "Orphan" }),
          provider("leaky", { hosts: ["{{ secret.apiKey }}.test"] }),
          { id: "nameless", hosts: ["a.test"], implements: { translate: http() } },
          provider("fine"),
          provider("bridged", { implements: { translate: { via: "nowhere" } } }),
        ],
        features: [
          feature("f", [
            noRun,
            entry("missing-view", { present: { surface: { type: "bubble" }, view: { use: "ghost" } } }),
            entry("bad-view", { present: { surface: { type: "bubble" }, view: { use: "bad" } } }),
            entry("ok", { present: { surface: { type: "bubble" }, view: { use: "good", with: { x: "{{ vars.results }}" } } } }),
          ]),
        ],
      }),
      CONTRACTS,
    ]);
    expect(reasons(prov(r, "community/orphan"))).toEqual(["继承的 community/kimi-base 找不到"]);
    expect(prov(r, "community/leaky")!.problems).toEqual([
      expect.objectContaining({
        path: "/providers/1/hosts/0",
        message: expect.stringContaining("变量 secret 不能在「引擎 hosts」里使用"),
        expr: { template: "{{ secret.apiKey }}.test", source: " secret.apiKey ", start: 3, end: 9 },
      }),
    ]);
    expect(reasons(prov(r, "community/nameless"))).toEqual(["缺少必填字段 name"]);
    expect(reasons(prov(r, "community/bridged"))).toEqual(["桥接 community/nowhere 找不到"]);
    expect(prov(r, "community/fine")!.enabled).toBe(true);

    expect(reasons(entryOf(r, "community/f.no-run"))).toEqual(["缺少必填字段 run"]);
    expect(reasons(entryOf(r, "community/f.missing-view"))).toEqual(["视图 community/ghost 找不到"]);
    expect(reasons(entryOf(r, "community/f.bad-view"))).toEqual(["视图 community/bad 已停用（表达式错误：变量 vars 不能在「视图模板」里使用）"]);
    expect(entryOf(r, "community/f.ok")).toMatchObject({ enabled: true });
    expect(entryOf(r, "community/f.ok")!.def.present!.view).toEqual({ use: "community/good", with: { x: "{{ vars.results }}" } });

    const bad = r.views.find((v) => v.ref === "community/bad")!;
    expect(bad.enabled).toBe(false);
    expect(bad.problems[0]).toMatchObject({ path: "/views/bad/value", message: expect.stringContaining("变量 vars 不能在「视图模板」里使用") });
    expect(r.views.find((v) => v.ref === "community/good")!.enabled).toBe(true);
    expect(r.features[0]!.enabled).toBe(true);
  });

  it("disables a child whose parent has an expression error", () => {
    const r = resolveRules([
      sub("p", { providers: [provider("root", { abstract: true, hosts: ["{{ 1 + }}"] }), child("leaf", "root", { name: "Leaf", abstract: false })] }),
      CONTRACTS,
    ]);
    expect(reasons(prov(r, "p/leaf"))).toEqual(["继承的 p/root 有错误"]);
    expect(r.diagnostics.some((d) => d.item === "p/root" && d.path === "/providers/0/hosts/0")).toBe(true);
  });

  it("checks variables per position: item only inside result-list items, value only inside onChange", () => {
    const view = {
      type: "card",
      params: ["results"],
      header: [{ type: "select", value: "{{ params.to }}", options: "{{ languages() }}", onChange: { rerun: { vars: { to: "{{ value }}" } } } }],
      body: {
        type: "result-list",
        from: "{{ params.results }}",
        item: { ok: { type: "text", value: "{{ item.output.texts[0] }}" } },
        meta: ["{{ item.engineName }}"],
        itemActions: [{ label: "复制", action: { copy: "{{ item.output.texts[0] }}" } }],
      },
      children: [{ type: "text", value: "{{ item.x }} {{ value }}" }],
    };
    const r = resolveRules([sub("v", { views: { card: view } }), CONTRACTS]);
    expect(r.diagnostics.map((d) => [d.path, d.expr?.source])).toEqual([
      ["/views/card/children/0/value", " item.x "],
      ["/views/card/children/0/value", " value "],
    ]);
  });

  it("disables engines whose bridge is missing, broken or implements another contract", () => {
    const bridge = (id: string, from: string, extra: Record<string, unknown> = {}) => ({
      id,
      from,
      to: "chat",
      input: { messages: [{ role: "user", content: "{{ json(input.texts) }}" }] },
      output: { texts: "{{ [result.text] }}" },
      ...extra,
    });
    const r = resolveRules([
      sub("b", {
        bridges: [bridge("good", "translate"), bridge("broken", "translate", { output: "{{ secret.k }}" }), bridge("other", "chat")],
        providers: [
          provider("via-good", { implements: { translate: { via: "good" } } }),
          provider("via-broken", { implements: { translate: { via: "broken" } } }),
          provider("via-other", { implements: { translate: [{ when: "{{ options.x }}", via: "b/other" }] } }),
          provider("dup"),
          provider("dup", { name: "second" }),
        ],
      }),
      CONTRACTS,
    ]);
    expect(prov(r, "b/via-good")).toMatchObject({ enabled: true, def: { implements: { translate: { via: "b/good" } } } });
    expect(reasons(prov(r, "b/via-broken"))).toEqual(["桥接 b/broken 已停用（表达式错误：变量 secret 不能在「桥接 output」里使用）"]);
    expect(prov(r, "b/via-other")!.problems).toEqual([
      expect.objectContaining({ path: "/providers/2/implements/translate/0/via", message: "桥接 b/other 实现的是 chat，不是 translate" }),
    ]);
    expect(r.bridges.find((x) => x.ref === "b/broken")!.problems[0]).toMatchObject({
      path: "/bridges/1/output",
      message: expect.stringContaining("变量 secret 不能在「桥接 output」里使用"),
    });
    expect(r.providers.filter((p) => p.ref === "b/dup").map((p) => p.def.name)).toEqual(["dup"]);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ path: "/providers/4", message: "id dup 重复" }));
  });

  it("checks entries that a local feature override writes, at the override's path", () => {
    const r = resolveRules([
      sub("c", { features: [feature("f", [entry("old", { run: [{ set: { x: "{{ 1 + }}" } }] })])] }),
      local({ overrides: { "c/f": { entries: [entry("new"), entry("bad", { run: [{ set: { x: "{{ secret.k }}" } }] })] } } }),
      CONTRACTS,
    ]);
    const entries = r.features[0]!.entries;
    expect(entries.map((e) => [e.ref, e.enabled])).toEqual([
      ["c/f.new", true],
      ["c/f.bad", false],
    ]);
    expect(r.diagnostics).toEqual([
      expect.objectContaining({ pack: "local", item: "c/f.bad", path: "/overrides/c~1f/entries/1/run/0/set/x" }),
    ]);
  });

  it("keeps valid site rules and drops invalid ones", () => {
    const r = resolveRules([
      sub("s", {
        sites: [
          { match: ["*://news.test/*"], for: "official-translate/translate.page", blocks: ["article p"] },
          { match: ["*://x.test/*"], for: "official-translate/translate.page", skip: "{{ selection.text }}" },
        ],
      }),
      CONTRACTS,
    ]);
    expect(r.sites.map((s) => s.def.blocks)).toEqual([["article p"]]);
    expect(r.diagnostics).toEqual([expect.objectContaining({ path: "/sites/1/skip", message: expect.stringContaining("selection") })]);
  });

  it("rejects a pack whose top level is broken, keeping the others", () => {
    const r = resolveRules([{ pack: { schema: 2, id: "x" } }, { pack: "nope" }, sub("ok", { providers: [provider("p")] }), CONTRACTS]);
    expect(r.providers.map((p) => p.ref)).toEqual(["ok/p"]);
    expect(new Set(r.diagnostics.map((d) => d.source))).toEqual(new Set([0, 1]));
    expect(r.diagnostics.every((d) => d.severity === "error" && d.item === undefined)).toBe(true);
  });

  it("rejects a pack nested too deeply instead of overflowing the stack, keeping the others", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 5000; i++) deep = [deep];
    const bad = sub("bad", { providers: [provider("p", { implements: { translate: { http: { request: { url: "https://a.test", json: deep } } } } })] });
    const r = resolveRules([bad, sub("ok", { providers: [provider("p")] }), CONTRACTS]);
    expect(r.providers.map((p) => p.ref)).toEqual(["ok/p"]);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ source: 0, severity: "error", message: expect.stringContaining("64") }));
  });

  it("does not change the packs it is given", () => {
    const sources = [
      sub("p", {
        views: { v: { type: "text", value: "x" } },
        providers: [provider("root", { abstract: true }), child("leaf", "root", { name: "Leaf" })],
        features: [feature("f", [entry("e", { present: { surface: { type: "near-selection" }, view: { use: "v" } } })])],
      }),
      local({ overrides: { "p/leaf": { name: "Mine" } } }),
      CONTRACTS,
    ];
    const before = structuredClone(sources);
    resolveRules(sources);
    expect(sources).toEqual(before);
  });
});

