import { describe, expect, it } from "vitest";
import { appendFeature, featureIds, freeFeatureId, getFeature, removeFeature, replaceFeature } from "./local-edit";
import { checkLocalRules } from "./local";

const feature = (id: string, name = `功能 ${id}`) => ({
  id,
  name,
  match: ["*://news.example.cn/*"],
  entries: [{ id: "expand", name: "展开全文", triggers: [{ on: "page-load" }], run: [{ find: ".fold", as: "fold" }] }],
});

/** Hand-written local rules: a feature, a site block and an override the edits must not disturb. */
const HAND = {
  schema: 1,
  id: "local",
  name: "我的规则",
  features: [feature("mine", "我写的")],
  sites: [{ match: ["*://a.example/*"], for: "official-translate/translate.page", blocks: ["main"] }],
  overrides: { "official-translate/translate": { name: "改过的名字" } },
};
const handText = JSON.stringify(HAND, null, 2);

const ok = <T extends { ok: boolean }>(r: T) => {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r as Extract<T, { ok: true }>;
};

describe("appendFeature", () => {
  it("creates the local pack when the text is empty or blank", () => {
    for (const text of ["", "  \n"]) {
      const { text: out } = ok(appendFeature(text, feature("teach-a")));
      expect(JSON.parse(out)).toEqual({ schema: 1, id: "local", features: [feature("teach-a")] });
      expect(out).toBe(JSON.stringify(JSON.parse(out), null, 2));
      expect(checkLocalRules(out).canSave).toBe(true);
    }
  });

  it("appends after the existing features and leaves every other part of the pack as it was (R6.7)", () => {
    const { text } = ok(appendFeature(handText, feature("teach-a")));
    const out = JSON.parse(text);
    expect(out.features).toEqual([feature("mine", "我写的"), feature("teach-a")]);
    expect({ ...out, features: undefined }).toEqual({ ...HAND, features: undefined });
    expect(Object.keys(out)).toEqual(Object.keys(HAND));
    expect(text).toBe(JSON.stringify(out, null, 2));
  });

  it("adds a features list to a pack that has none", () => {
    const { text } = ok(appendFeature(JSON.stringify({ schema: 1, id: "local", sites: [] }), feature("teach-a")));
    expect(JSON.parse(text)).toEqual({ schema: 1, id: "local", sites: [], features: [feature("teach-a")] });
  });

  it("refuses a duplicate feature id", () => {
    const r = appendFeature(handText, feature("mine"));
    expect(r).toEqual({ ok: false, error: expect.stringContaining("mine") });
  });

  it("refuses invalid JSON and text that is not a pack, with a clear error", () => {
    expect(appendFeature('{ "schema": 1, ', feature("a"))).toEqual({ ok: false, error: expect.stringContaining("JSON") });
    expect(appendFeature("[1, 2]", feature("a"))).toEqual({ ok: false, error: expect.stringContaining("对象") });
    expect(appendFeature('{"schema":1,"id":"local","features":{}}', feature("a"))).toEqual({
      ok: false,
      error: expect.stringContaining("features"),
    });
    expect(appendFeature(handText, "not a feature")).toEqual({ ok: false, error: expect.stringContaining("id") });
  });
});

describe("replaceFeature", () => {
  const two = ok(appendFeature(handText, feature("teach-a"))).text;

  it("replaces only that feature, in place (R6.8)", () => {
    const next = { ...feature("teach-a"), name: "改过" };
    const { text } = ok(replaceFeature(two, "teach-a", next));
    const out = JSON.parse(text);
    expect(out.features).toEqual([feature("mine", "我写的"), next]);
    expect({ ...out, features: undefined }).toEqual({ ...HAND, features: undefined });

    const first = ok(replaceFeature(two, "mine", { ...feature("mine"), name: "新" })).text;
    expect(JSON.parse(first).features.map((f: { id: string }) => f.id)).toEqual(["mine", "teach-a"]);
  });

  it("refuses a missing id, a new id that collides, and invalid JSON", () => {
    expect(replaceFeature(two, "gone", feature("gone"))).toEqual({ ok: false, error: expect.stringContaining("gone") });
    expect(replaceFeature(two, "teach-a", feature("mine"))).toEqual({ ok: false, error: expect.stringContaining("mine") });
    expect(replaceFeature("{oops", "teach-a", feature("teach-a"))).toEqual({ ok: false, error: expect.stringContaining("JSON") });
    expect(replaceFeature("", "teach-a", feature("teach-a"))).toEqual({ ok: false, error: expect.stringContaining("teach-a") });
  });
});

describe("removeFeature, getFeature, featureIds, freeFeatureId", () => {
  const two = ok(appendFeature(handText, feature("teach-a"))).text;

  it("removes only that feature", () => {
    const { text } = ok(removeFeature(two, "teach-a"));
    expect(JSON.parse(text)).toEqual(HAND);
    expect(removeFeature(two, "gone")).toEqual({ ok: false, error: expect.stringContaining("gone") });
    expect(removeFeature("nope", "teach-a")).toEqual({ ok: false, error: expect.stringContaining("JSON") });
  });

  it("reads a feature and the feature ids; nothing from empty or invalid text", () => {
    expect(getFeature(two, "teach-a")).toEqual(feature("teach-a"));
    expect(getFeature(two, "gone")).toBeUndefined();
    expect(getFeature("{oops", "teach-a")).toBeUndefined();
    expect(featureIds(two)).toEqual(["mine", "teach-a"]);
    expect(featureIds("")).toEqual([]);
    expect(featureIds("{oops")).toBeUndefined();
  });

  it("picks a free teach-<slug> id that passes the schema id pattern", () => {
    expect(freeFeatureId("", "auto-expand")).toBe("teach-auto-expand");
    expect(freeFeatureId("", "Auto_Expand 全文!")).toBe("teach-auto-expand");
    expect(freeFeatureId("", "展开")).toBe("teach-rule");
    expect(freeFeatureId("", undefined)).toBe("teach-rule");
    const taken = ok(appendFeature(ok(appendFeature("", feature("teach-x"))).text, feature("teach-x-2"))).text;
    expect(freeFeatureId(taken, "x")).toBe("teach-x-3");
    expect(freeFeatureId("", "x", (id) => id === "teach-x")).toBe("teach-x-2");
    expect(freeFeatureId("", "teach-x")).toBe("teach-x");
  });
});
