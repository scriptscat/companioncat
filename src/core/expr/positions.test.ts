import { describe, expect, it } from "vitest";
import { checkTemplate, ExprError, position, renderTemplate } from "./index";

const FEATURE_RUN = position("功能 run", ["settings", "vars", "selection", "page", "site", "steps", "result"]);
const ENGINE_REQUEST = position("引擎请求", ["input", "secret", "options", "vars", "steps"]);

describe("variables outside their positions (R8.3)", () => {
  it("checkTemplate reports a disallowed variable as a positioned syntax error", () => {
    const tpl = "Bearer {{ 'x' + secret.apiKey }}";
    const errors = checkTemplate(tpl, FEATURE_RUN);
    expect(errors).toHaveLength(1);
    const [e] = errors;
    expect(e).toBeInstanceOf(ExprError);
    expect(e).toMatchObject({ code: "syntax", expr: " 'x' + secret.apiKey ", path: [] });
    expect(tpl.slice(e!.start, e!.end)).toBe("secret");
    expect(e!.message).toContain("secret");
    expect(e!.message).toContain("功能 run");
  });

  it("allows the same variable where the position permits it", () => {
    expect(checkTemplate("{{ 'Bearer ' + secret.apiKey }}", ENGINE_REQUEST)).toEqual([]);
  });

  it("rejects disallowed variables inside macros and unknown identifiers too", () => {
    const [inMacro] = checkTemplate("{{ selection.items.map(b, secret) }}", FEATURE_RUN);
    expect(inMacro).toMatchObject({ code: "syntax" });
    expect(checkTemplate("{{ selection.items.map(b, b.text) }}", FEATURE_RUN)).toEqual([]);
    expect(checkTemplate("{{ blocks }}", FEATURE_RUN)).toEqual([expect.objectContaining({ code: "syntax", message: "未知变量 blocks" })]);
  });

  it("reports every bad template with its path inside nested values", () => {
    const value = { headers: { Authorization: "{{ secret.k }}" }, list: ["ok", "{{ 1 + }}"], fine: "{{ vars.to }}" };
    const errors = checkTemplate(value, FEATURE_RUN);
    expect(errors.map((e) => e.path)).toEqual([["headers", "Authorization"], ["list", 1]]);
    expect(errors.every((e) => e.code === "syntax")).toBe(true);
  });

  it("reports an unclosed {{ as a syntax error at the opening braces", () => {
    const [e] = checkTemplate("a {{ vars.to", FEATURE_RUN);
    expect(e).toMatchObject({ code: "syntax", start: 2 });
  });

  it("renderTemplate refuses a disallowed variable even when the scope has it", async () => {
    await expect(renderTemplate("{{ secret.apiKey }}", { secret: { apiKey: "sk-1" } }, FEATURE_RUN)).rejects.toMatchObject({
      code: "syntax",
      start: 3,
      end: 9,
    });
  });
});
