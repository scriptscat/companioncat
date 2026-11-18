import { describe, expect, it } from "vitest";
import { BASE_FUNCTIONS, PAGE_FUNCTIONS } from "../../core/expr";
import { repairPrompt, systemPrompt } from "./prompt";

describe("systemPrompt", () => {
  const text = systemPrompt({}, {});
  it("explains item and reading elements through page functions", () => {
    expect(text).toContain("item");
    expect(text).toContain("text(");
    expect(text).toContain("attr(item, 'x')");
  });
  it("lists every page function and whitelisted function", () => {
    for (const f of [...PAGE_FUNCTIONS, ...BASE_FUNCTIONS]) expect(text).toContain(f);
  });
  it("lists the variables of triggers and run", () => {
    for (const v of ["trigger", "vars", "settings", "page", "site", "selection"]) expect(text).toContain(v);
  });
});

describe("repairPrompt", () => {
  it("adds the allowed variables and functions for an unknown variable in find.where", () => {
    const out = repairPrompt([{ path: "entries[0].run[1].where", message: "未知变量 element" }]);
    expect(out).toContain("未知变量 element");
    expect(out).toContain("item");
    expect(out).toContain("text(item)");
    for (const f of PAGE_FUNCTIONS) expect(out).toContain(f);
  });
  it("does not add the list for other problems", () => {
    const out = repairPrompt([{ path: "id", message: "缺少必填字段" }]);
    expect(out).not.toContain("可用的变量");
  });
  it("leaves item out of triggers", () => {
    const out = repairPrompt([{ path: "entries[0].triggers[0].enabled", message: "未知变量 item" }]);
    expect(out).toContain("可用的变量：");
    expect(out).not.toMatch(/可用的变量：[^\n]*item/);
  });
});
