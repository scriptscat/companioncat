import { describe, expect, it } from "vitest";
import { PAGE_FUNCTIONS } from "../expr";
import { isAutomationEntry } from "./automation";
import { CHECKS, POSITIONS } from "./positions";

describe("isAutomationEntry", () => {
  it("is true when run has a find, act, ask, if, repeat or stop step", () => {
    for (const step of [{ find: "a", as: "x" }, { act: "wait", ms: 1 }, { ask: "choose", input: {} }, { if: true, then: [] }, { repeat: "{{ vars.x }}", steps: [] }, { stop: true }]) {
      expect(isAutomationEntry({ run: [{ set: { a: 1 } }, step] })).toBe(true);
    }
  });

  it("is false for set/call runs and for anything malformed", () => {
    expect(isAutomationEntry({ run: [{ set: { a: 1 } }, { call: "translate", input: {} }] })).toBe(false);
    for (const v of [undefined, null, "x", {}, { run: "find" }, { run: [null, "act"] }]) expect(isAutomationEntry(v)).toBe(false);
  });
});

const errorsIn = (entry: unknown) => {
  const out: { path: string; message: string; code: string }[] = [];
  CHECKS.entry(entry, [], (e, path) => out.push({ path: path.join("/"), message: e.message, code: e.code }));
  return out;
};

const SURFACE = { surface: { type: "page-card" }, view: { type: "text", value: "{{ vars.n }}" } };

describe("automation positions (R1.4, R1.7)", () => {
  it("add the page functions and the trigger variable, and nothing else changes", () => {
    for (const pos of [POSITIONS.autoRun, POSITIONS.autoTrigger]) {
      for (const fn of PAGE_FUNCTIONS) expect(pos.functions.has(fn)).toBe(true);
      expect(pos.vars).toContain("trigger");
    }
    expect(POSITIONS.autoRun.vars).toEqual(expect.arrayContaining([...POSITIONS.run.vars]));
    expect(POSITIONS.autoTrigger.vars).toEqual(expect.arrayContaining([...POSITIONS.trigger.vars]));
    for (const [name, pos] of Object.entries(POSITIONS)) {
      if (name === "autoRun" || name === "autoTrigger") continue;
      for (const fn of PAGE_FUNCTIONS) expect(pos.functions.has(fn), `${name} ${fn}`).toBe(false);
      expect(pos.vars, name).not.toContain("trigger");
    }
  });

  it("accept page functions in an automation entry's triggers and run, with item inside repeat and where", () => {
    const entry = {
      triggers: [{ on: "appear", selector: "button", enabled: "{{ visible(trigger.element) }}" }],
      run: [
        { find: "button", within: "{{ trigger.element }}", where: "{{ contains(text(item), '跳过') }}", all: true, as: "btns" },
        { repeat: "{{ vars.btns }}", steps: [{ if: "{{ visible(item) }}", then: [{ act: "click", target: "{{ closest(item, 'div') }}" }] }] },
        { ask: "choose", input: { question: "{{ describe(vars.btns[0]) }}", page: "{{ outline(trigger.element, 400) }}" }, as: "pick" },
        { set: { n: "{{ size(within(trigger.element, 'a')) + size(attr(vars.btns[0], 'id')) }}" } },
      ],
      present: SURFACE,
    };
    expect(errorsIn(entry)).toEqual([]);
  });

  it("refuse item outside repeat-each steps and where", () => {
    const entry = { triggers: [{ on: "page-load" }], run: [{ repeat: true, until: "{{ item }}", max: 2, steps: [{ act: "focus", target: "{{ item }}" }] }] };
    expect(errorsIn(entry).map((e) => e.path)).toEqual(["run/0/until", "run/0/steps/0/target"]);
  });

  it("make page functions and trigger a positioned syntax error everywhere else", () => {
    const phase1 = {
      triggers: [{ on: "selection", enabled: "{{ visible(trigger.element) }}" }],
      run: [{ set: { t: "{{ text(vars.x) }}" } }],
      present: SURFACE,
    };
    expect(errorsIn(phase1)).toEqual([
      { path: "triggers/0/enabled", code: "syntax", message: expect.stringContaining("visible()") },
      { path: "run/0/set/t", code: "syntax", message: expect.stringContaining("text()") },
    ]);
    const automationPresent = {
      triggers: [{ on: "page-load" }],
      run: [{ stop: true }],
      present: { surface: { type: "page-card" }, view: { type: "text", value: "{{ describe(vars.x) }}" } },
    };
    expect(errorsIn(automationPresent)).toEqual([
      { path: "present/view/value", code: "syntax", message: expect.stringMatching(/describe\(\).*「视图」/) },
    ]);
  });

  it("check templates in command hotkeys", () => {
    const entry = { triggers: [{ on: "command", title: "t", hotkey: "{{ settings.hotkey + }}" }], run: [{ stop: true }] };
    expect(errorsIn(entry)).toEqual([expect.objectContaining({ path: "triggers/0/hotkey", code: "syntax" })]);
  });
});
