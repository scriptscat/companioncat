import { describe, expect, it } from "vitest";
import { collect, defineFeature, definePage } from "./registry";

describe("self-registration seam", () => {
  it("collects default exports of glob modules (pages and features, single or arrays), in path order", () => {
    const a = definePage({ id: "rules", group: "companion", component: () => null });
    const b = definePage({ id: "general", group: "companion", component: () => null });
    const f = defineFeature({ id: "selection" });
    const regs = collect(
      { "../pages/rules/register.tsx": { default: a }, "../pages/general/register.tsx": { default: b } },
      { "../features/selection/register.tsx": { default: [f] } },
    );
    expect(regs).toEqual([b, a, f]);
  });

  it("an empty glob yields nothing", () => {
    expect(collect({}, {})).toEqual([]);
  });

  it("rejects a register module without a registration default export", () => {
    expect(() => collect({ "../pages/x/register.tsx": { foo: 1 } })).toThrow(/pages\/x\/register\.tsx/);
  });
});
