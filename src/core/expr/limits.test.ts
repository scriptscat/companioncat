import { describe, expect, it } from "vitest";
import { checkTemplate, type ExprError, position, renderTemplate } from "./index";

const POS = position("test", ["input"]);
const at = (tpl: string, e: ExprError | undefined) => tpl.slice(e!.start, e!.end);

describe("structural limits (R8.4)", () => {
  it("rejects more than 2000 AST nodes", () => {
    const ok = `{{ ${Array(1000).fill("1").join("+")} }}`; // 1999 nodes
    const tooMany = `{{ ${Array(1001).fill("1").join("+")} }}`;
    expect(checkTemplate(ok, POS)).toEqual([]);
    const [e] = checkTemplate(tooMany, POS);
    expect(e).toMatchObject({ code: "limit" });
    expect(e!.message).toContain("2000");
    expect(e!.start).toBeGreaterThanOrEqual(3);
  });

  it("rejects nesting deeper than 32, pointing at the offending level", () => {
    const deep = (n: number) => `x={{ ${"[".repeat(n)}${"]".repeat(n)} }}`;
    expect(checkTemplate(deep(32), POS)).toEqual([]);
    const tpl = deep(33);
    const [e] = checkTemplate(tpl, POS);
    expect(e).toMatchObject({ code: "limit" });
    expect(e!.message).toContain("32");
    expect(e!.start).toBe("x={{ ".length + 32);
  });

  it("rejects list literals over 1000 items and map literals over 1000 entries", () => {
    const list = (n: number) => `{{ [${Array(n).fill("1").join(",")}] }}`;
    const map = (n: number) => `{{ {${Array.from({ length: n }, (_, i) => `${i}:1`).join(",")}} }}`;
    expect(checkTemplate(list(1000), POS)).toEqual([]);
    expect(checkTemplate(list(1001), POS)).toEqual([expect.objectContaining({ code: "limit" })]);
    expect(checkTemplate(map(1001), POS)).toEqual([expect.objectContaining({ code: "limit" })]);
  });

  it("renderTemplate fails with the same limit error", async () => {
    await expect(renderTemplate(`{{ [${Array(1001).fill("1").join(",")}] }}`, {}, POS)).rejects.toMatchObject({ code: "limit" });
  });
});

describe("50 ms evaluation budget (R8.4)", () => {
  const big = { input: { a: Array.from({ length: 1000 }, (_, i) => i) } };

  it("fails a slow expression with a timeout error positioned on the expression", async () => {
    const tpl = "r={{ input.a.map(x, input.a.map(y, x + y)).size() }}";
    const t0 = performance.now();
    const huge = { input: { a: Array.from({ length: 4000 }, (_, i) => i) } };
    const err = await renderTemplate(tpl, huge, POS).catch((e: unknown) => e as ExprError);
    expect(err).toMatchObject({ code: "timeout" });
    expect((err as ExprError).message).toContain("50");
    expect(at(tpl, err as ExprError)).toBe(" input.a.map(x, input.a.map(y, x + y)).size() ");
    // pre-empted instead of running to completion (16M iterations, seconds unchecked)
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("pre-empts a combinatorial blow-up that would otherwise run for minutes", async () => {
    const scope = { input: { l: Array.from({ length: 100 }, (_, i) => i) } };
    const tpl = "{{ input.l.map(a, input.l.map(b, input.l.map(c, input.l.map(d, a + b + c + d)))) }}";
    const t0 = performance.now();
    await expect(renderTemplate(tpl, scope, POS)).rejects.toMatchObject({ code: "timeout" });
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("pre-empts a slow quantifier (exists) that swallows per-item errors", async () => {
    const tpl = "{{ input.a.exists(x, input.a.exists(y, x + y < 0)) }}";
    await expect(renderTemplate(tpl, big, POS)).rejects.toMatchObject({ code: "timeout" });
  });

  it("times out expressions that spend the budget in async functions", async () => {
    const scope = { input: { a: Array.from({ length: 100_000 }, (_, i) => i) } };
    await expect(renderTemplate("{{ input.a.map(x, sha256(json(x))).size() }}", scope, POS)).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("charges time spent in match() to the budget", async () => {
    const scope = { input: { a: Array.from({ length: 100_000 }, (_, i) => i), s: "a".repeat(50_000) } };
    const t0 = performance.now();
    await expect(renderTemplate("{{ input.a.map(x, match(input.s, 'z(.)')).size() }}", scope, POS)).rejects.toMatchObject({
      code: "timeout",
    });
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("keeps fast expressions and later evaluations working after a timeout", async () => {
    await renderTemplate("{{ input.a.map(x, input.a.map(y, x + y)).size() }}", big, POS).catch(() => undefined);
    await expect(renderTemplate("{{ input.a.map(x, x * 2).size() }}", big, POS)).resolves.toBe(1000);
    await expect(renderTemplate("{{ sha256('a') }}", {}, POS)).resolves.toHaveLength(64);
  });
});

describe("int results become JS numbers (R8.2)", () => {
  it("converts ints and uints, including nested ones", async () => {
    await expect(renderTemplate("{{ 3 }}", {}, POS)).resolves.toBe(3);
    await expect(renderTemplate("{{ 1u + 2u }}", {}, POS)).resolves.toBe(3);
    await expect(renderTemplate("{{ {'n': [size('ab')]} }}", {}, POS)).resolves.toEqual({ n: [2] });
    await expect(renderTemplate("{{ 9007199254740991 }}", {}, POS)).resolves.toBe(Number.MAX_SAFE_INTEGER);
    await expect(renderTemplate("{{ -9007199254740991 }}", {}, POS)).resolves.toBe(Number.MIN_SAFE_INTEGER);
  });

  it("errors beyond the safe integer range, positioned on the expression", async () => {
    const tpl = "n={{ 9007199254740991 + 1 }}";
    const err = await renderTemplate(tpl, {}, POS).catch((e: unknown) => e as ExprError);
    expect(err).toMatchObject({ code: "int-range" });
    expect(at(tpl, err as ExprError)).toBe(" 9007199254740991 + 1 ");
    await expect(renderTemplate("{{ [-9007199254740992] }}", {}, POS)).rejects.toMatchObject({ code: "int-range" });
    await expect(renderTemplate("{{ json(9007199254740992) }}", {}, POS)).rejects.toMatchObject({ code: "int-range" });
    await expect(renderTemplate("{{ 18446744073709551615u }}", {}, POS)).rejects.toMatchObject({ code: "int-range" });
  });

  it("keeps whole numbers beyond the safe integer range as doubles instead of failing", async () => {
    await expect(renderTemplate("{{ input.x }}", { input: { x: 2 ** 60 } }, POS)).resolves.toBe(2 ** 60);
    await expect(renderTemplate("{{ json(input) }}", { input: { id: 1e21, n: 3 } }, POS)).resolves.toBe('{"id":1e+21,"n":3}');
    await expect(renderTemplate("{{ input.n + 1 }}", { input: { n: 41 } }, POS)).resolves.toBe(42);
  });

  it("leaves doubles alone", async () => {
    await expect(renderTemplate("{{ 9007199254740993.0 * 2.0 }}", {}, POS)).resolves.toBe(9007199254740993 * 2);
  });
});
