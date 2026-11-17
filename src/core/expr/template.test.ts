import { describe, expect, it } from "vitest";
import { position, renderTemplate } from "./index";

const ANY = position("test", ["settings", "vars", "input", "selection", "item", "params"]);

describe("renderTemplate: whole-string vs mixed (R8.2)", () => {
  it("returns the raw value when the whole string is one {{ }}", async () => {
    const scope = { input: { texts: ["a", "b"], meta: { ok: true } } };
    await expect(renderTemplate("{{ input.texts }}", scope, ANY)).resolves.toEqual(["a", "b"]);
    await expect(renderTemplate("{{ input.meta }}", scope, ANY)).resolves.toEqual({ ok: true });
    await expect(renderTemplate("{{ input.meta.ok }}", scope, ANY)).resolves.toBe(true);
    await expect(renderTemplate("{{1 + 2}}", {}, ANY)).resolves.toBe(3);
    await expect(renderTemplate("{{ 1.5 }}", {}, ANY)).resolves.toBe(1.5);
    await expect(renderTemplate("{{ null }}", {}, ANY)).resolves.toBeNull();
  });

  it("stringifies and concatenates when the template has surrounding text", async () => {
    const scope = { settings: { n: 2, to: "en", list: ["x", 1] } };
    await expect(renderTemplate("n={{ settings.n }}!", scope, ANY)).resolves.toBe("n=2!");
    await expect(renderTemplate("{{ settings.to }}-{{ settings.n * 2 }}", scope, ANY)).resolves.toBe("en-4");
    await expect(renderTemplate(" {{ true }}", {}, ANY)).resolves.toBe(" true");
    await expect(renderTemplate("v:{{ null }}", {}, ANY)).resolves.toBe("v:");
    await expect(renderTemplate("l:{{ settings.list }}", scope, ANY)).resolves.toBe('l:["x",1]');
  });

  it("leaves strings without templates and non-string values untouched", async () => {
    await expect(renderTemplate("plain text", {}, ANY)).resolves.toBe("plain text");
    await expect(renderTemplate(42, {}, ANY)).resolves.toBe(42);
    await expect(renderTemplate(null, {}, ANY)).resolves.toBeNull();
  });

  it("renders templates nested inside arrays and objects", async () => {
    const scope = { selection: { text: "hi" }, vars: { to: "zh-CN" } };
    const value = { texts: ["{{ selection.text }}"], to: "{{ vars.to }}", n: 1, keep: "x" };
    await expect(renderTemplate(value, scope, ANY)).resolves.toEqual({
      texts: ["hi"],
      to: "zh-CN",
      n: 1,
      keep: "x",
    });
  });

  it("does not end an expression at }} that belongs to a map literal or a string", async () => {
    await expect(renderTemplate("{{ {'a': {'b': 1}} }}", {}, ANY)).resolves.toEqual({ a: { b: 1 } });
    await expect(renderTemplate("<{{ 'x}}y' }}>", {}, ANY)).resolves.toBe("<x}}y>");
  });

  it("passes integer scope numbers into CEL as ints so int arithmetic works", async () => {
    await expect(renderTemplate("{{ settings.n + 1 }}", { settings: { n: 3 } }, ANY)).resolves.toBe(4);
    await expect(renderTemplate("{{ settings.n * 2.0 }}", { settings: { n: 1.25 } }, ANY)).resolves.toBe(2.5);
  });
});
