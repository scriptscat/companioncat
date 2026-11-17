import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveRules, summarize, validatePack } from "./index";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../rules/packs/${name}.json`, import.meta.url), "utf8"));
const translatePack = read("official-translate");
const llmPack = read("official-llm");

describe("official packs", () => {
  it("pass the schema", () => {
    expect(validatePack(translatePack)).toMatchObject({ ok: true, errors: [] });
    expect(validatePack(llmPack)).toMatchObject({ ok: true, errors: [] });
  });

  it("resolve with zero diagnostics", () => {
    const r = resolveRules([
      { pack: translatePack, official: true },
      { pack: llmPack, official: true },
    ]);
    expect(r.diagnostics).toEqual([]);
    expect(r.providers.map((p) => [p.ref, p.enabled])).toEqual([
      ["official-translate/google", true],
      ["official-translate/microsoft", true],
      ["official-llm/deepseek", true],
      ["official-llm/glm", true],
      ["official-llm/qwen", true],
      ["official-llm/openai", true],
      ["official-llm/jev", true],
    ]);
    expect(r.views.map((v) => v.ref)).toEqual(["official-translate/translation-card"]);
    expect(r.bridges.map((b) => b.ref)).toEqual(["official-llm/llm-translate", "official-llm/llm-choose"]);
    expect(r.features.map((f) => [f.ref, f.entries.map((e) => [e.ref, e.enabled])])).toEqual([
      [
        "official-translate/translate",
        [
          ["official-translate/translate.selection", true],
          ["official-translate/translate.page", true],
        ],
      ],
    ]);

    const selection = r.features[0]!.entries[0]!;
    expect(selection.def.present.view).toMatchObject({ use: "official-translate/translation-card" });

    const openai = r.providers.find((p) => p.ref === "official-llm/openai")!;
    expect(openai.ancestors).toEqual(["official-llm/openai-compatible"]);
    expect(openai.def.options).toMatchObject({
      api: { type: "enum", default: "responses" },
      baseUrl: { type: "string", default: "https://api.openai.com/v1" },
    });
    expect(openai.def.implements.translate).toEqual({ via: "official-llm/llm-translate" });
    expect(openai.def.hosts).toEqual(["{{ host(options.baseUrl) }}"]);
    expect(openai.def).not.toHaveProperty("abstract");
  });

  it("register the three built-in contracts with input and output schemas (R4.1)", () => {
    const r = resolveRules([{ pack: llmPack, official: true }]);
    expect(r.contracts.map((c) => [c.id, c.official, c.enabled, c.def.bridgeable])).toEqual([
      ["translate", true, true, true],
      ["chat", true, true, false],
      ["choose", true, true, true],
    ]);
    const translate = r.contracts[0]!.def;
    expect(translate.input).toMatchObject({ required: ["texts", "to"] });
    expect(translate.output).toMatchObject({ required: ["texts"] });
  });
});

describe("summarize (R2.7)", () => {
  it("counts what each official pack contributes", () => {
    expect(summarize(translatePack).counts).toEqual({
      features: 1,
      entries: 2,
      providers: 2,
      settings: 8,
      quick: 4,
      views: 1,
      contracts: 0,
    });
    expect(summarize(llmPack).counts).toEqual({
      features: 0,
      entries: 0,
      providers: 5,
      settings: 0,
      quick: 0,
      views: 0,
      contracts: 3,
    });
  });

  it("lists the items for the detail page", () => {
    const s = summarize(translatePack);
    expect(s.features).toEqual([
      {
        id: "translate",
        name: "翻译",
        entries: [
          { id: "selection", name: "划词翻译" },
          { id: "page", name: "网页对照翻译" },
        ],
      },
    ]);
    expect(s.providers).toEqual([
      { id: "google", name: "Google 翻译" },
      { id: "microsoft", name: "微软翻译" },
    ]);
    expect(s.settings.filter((x) => x.quick).map((x) => x.key)).toEqual(["to", "siteEnabled", "engines", "show"]);
    expect(s.views).toEqual([{ id: "translation-card", description: expect.any(String) }]);
    expect(summarize(llmPack).providers.map((p) => p.id)).toEqual(["deepseek", "glm", "qwen", "openai", "jev"]);
    expect(summarize(llmPack).contracts.map((c) => c.id)).toEqual(["translate", "chat", "choose"]);
  });

  it("returns zero counts for something that is not a pack", () => {
    expect(summarize(null).counts).toEqual({ features: 0, entries: 0, providers: 0, settings: 0, quick: 0, views: 0, contracts: 0 });
  });
});

describe("validatePack", () => {
  it("reports each schema problem at its field path", () => {
    const result = validatePack({ schema: 1, id: "x", providers: [{ id: "p", name: "P", implements: {}, colour: "red" }] });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ path: "/providers/0/colour", message: "不认识的字段 colour" }]);
    expect(validatePack({ id: "x" }).errors).toEqual([{ path: "", message: "缺少必填字段 schema" }]);
  });
});
