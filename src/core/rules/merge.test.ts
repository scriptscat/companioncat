import { describe, expect, it } from "vitest";
import { applyPatch } from "./merge";

describe("applyPatch (R2.5 merge rules)", () => {
  it("merges objects level by level", () => {
    const base = { a: 1, o: { x: 1, deep: { k: "v", keep: true } } };
    expect(applyPatch(base, { b: 2, o: { y: 2, deep: { k: "w" } } })).toEqual({
      a: 1,
      b: 2,
      o: { x: 1, y: 2, deep: { k: "w", keep: true } },
    });
  });

  it("replaces arrays as a whole", () => {
    expect(applyPatch({ hosts: ["a", "b"], o: { list: [1, 2, 3] } }, { hosts: ["c"], o: { list: [] } })).toEqual({
      hosts: ["c"],
      o: { list: [] },
    });
  });

  it("deletes a field patched with null, at any depth", () => {
    expect(applyPatch({ a: 1, b: 2, o: { x: 1, y: 2 } }, { a: null, o: { y: null } })).toEqual({ b: 2, o: { x: 1 } });
  });

  it("drops nulls that delete nothing and replaces non-object values", () => {
    expect(applyPatch({ o: "text" }, { o: { x: 1, gone: null }, n: null })).toEqual({ o: { x: 1 } });
    expect(applyPatch({ o: { x: 1 } }, { o: "text" })).toEqual({ o: "text" });
  });

  it("does not mutate its inputs", () => {
    const base = { o: { x: 1 } };
    const patch = { o: { y: 2 } };
    applyPatch(base, patch);
    expect(base).toEqual({ o: { x: 1 } });
    expect(patch).toEqual({ o: { y: 2 } });
  });
});
