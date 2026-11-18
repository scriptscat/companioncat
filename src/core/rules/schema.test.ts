import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validatePack } from "./schema";
import type { ActStep, AskStep, EntryDef, FindStep, RunStepDef, SettingDef, SurfaceDef, TriggerDef } from "./types";

const rulesDir = new URL("../../../rules/", import.meta.url);
const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, rulesDir), "utf8"));
const automation = () => read("test/fixtures/valid-automation.json") as Record<string, any>;
const minimal = () => read("test/fixtures/valid-minimal.json") as Record<string, any>;

/** The errors of a pack built from `base` with `edit` applied. */
function errorsAfter(base: () => Record<string, any>, edit: (p: Record<string, any>) => void) {
  const pack = base();
  edit(pack);
  const v = validatePack(pack);
  expect(v.ok, JSON.stringify(v.errors)).toBe(false);
  return v.errors;
}

const E = "/features/0/entries";

describe("round 2 rule format (R1.1–R1.3, R1.7, R8.1)", () => {
  it("accepts appear/page-load/command triggers, nested automation steps, thresholds, hotkey, percent, optional present and page-card", () => {
    expect(validatePack(automation())).toEqual({ ok: true, pack: automation(), errors: [] });
  });

  it("still accepts every phase-1 pack and fixture", () => {
    for (const f of readdirSync(new URL("packs/", rulesDir))) expect(validatePack(read(`packs/${f}`)).errors, f).toEqual([]);
    for (const f of ["valid-minimal", "braces-and-quotes", "cel-syntax-error", "cel-unclosed", "unknown-variable", "has-invalid"])
      expect(validatePack(read(`test/fixtures/${f}.json`)).errors, f).toEqual([]);
  });

  it("keeps present required on entries without automation steps", () => {
    expect(errorsAfter(minimal, (p) => delete p.features[0].entries[0].present)).toEqual([
      { path: `${E}/0`, message: "缺少必填字段 present" },
    ]);
    expect(errorsAfter(automation, (p) => delete p.features[0].entries[3].present)).toEqual([
      { path: `${E}/3`, message: "缺少必填字段 present" },
    ]);
  });

  const cases: [string, (p: Record<string, any>) => void, string, RegExp][] = [
    ["appear without selector", (p) => delete p.features[0].entries[0].triggers[0].selector, `${E}/0/triggers/0`, /缺少必填字段 selector/],
    ["negative debounceMs", (p) => (p.features[0].entries[0].triggers[0].debounceMs = -1), `${E}/0/triggers/0/debounceMs`, /./],
    ["selector on a page-load trigger", (p) => (p.features[0].entries[1].triggers[0].selector = "a"), `${E}/1/triggers/0/selector`, /不认识的字段 selector/],
    ["command hotkey that is not a key combination", (p) => (p.features[0].entries[3].triggers[0].hotkey = "Alt A"), `${E}/3/triggers/0/hotkey`, /格式不对/],
    ["unknown act", (p) => (p.features[0].entries[0].run[3].act = "tap"), `${E}/0/run/3/act`, /取值不对/],
    ["below outside ask/hint/skip", (p) => (p.features[0].entries[0].run[3].below = "maybe"), `${E}/0/run/3/below`, /./],
    ["minConfidence above 1", (p) => (p.features[0].entries[0].run[3].minConfidence = 1.5), `${E}/0/run/3/minConfidence`, /./],
    ["minConfidence without confidence", (p) => delete p.features[0].entries[0].run[3].confidence, `${E}/0/run/3`, /confidence/],
    ["below without minConfidence", (p) => delete p.features[0].entries[1].run[1].steps[0].minConfidence, `${E}/1/run/1/steps/0`, /minConfidence/],
    ["click without target", (p) => delete p.features[0].entries[0].run[3].target, `${E}/0/run/3`, /缺少必填字段 target/],
    ["fill without value", (p) => delete p.features[0].entries[1].run[3].value, `${E}/1/run/3`, /缺少必填字段 value/],
    ["check with a non-boolean value", (p) => (p.features[0].entries[1].run[4].value = "yes"), `${E}/1/run/4/value`, /./],
    ["wait with neither ms nor selector", (p) => delete p.features[0].entries[1].run[1].steps[1].ms, `${E}/1/run/1/steps/1`, /ms|selector/],
    ["wait with a target", (p) => (p.features[0].entries[1].run[1].steps[1].target = "{{ item }}"), `${E}/1/run/1/steps/1/target`, /不认识的字段 target/],
    ["timeoutMs on a click", (p) => (p.features[0].entries[0].run[3].timeoutMs = 10), `${E}/0/run/3/timeoutMs`, /不认识的字段 timeoutMs/],
    ["unknown field nested in repeat", (p) => (p.features[0].entries[1].run[1].steps[0].selctor = "a"), `${E}/1/run/1/steps/0/selctor`, /不认识的字段 selctor/],
    ["unknown field nested in if/then", (p) => (p.features[0].entries[0].run[1].then[0].stop = "yes"), `${E}/0/run/1/then/0/stop`, /./],
    ["unknown field nested in if/else", (p) => (p.features[0].entries[2].run[1].steps[0].else[0].engin = "x"), `${E}/2/run/1/steps/0/else/0/engin`, /不认识的字段 engin/],
    ["a step that is none of the known kinds", (p) => (p.features[0].entries[0].run[0] = { click: "a" }), `${E}/0/run/0`, /set、call、find、act、ask、if、repeat、stop/],
    ["two step kinds in one step", (p) => (p.features[0].entries[0].run[1].stop = true), `${E}/0/run/1/stop`, /不认识的字段 stop/],
    ["if without then", (p) => delete p.features[0].entries[0].run[1].then, `${E}/0/run/1`, /缺少必填字段 then/],
    ["repeat true without until", (p) => delete p.features[0].entries[1].run[2].until, `${E}/1/run/2`, /缺少必填字段 until/],
    ["repeat true without max", (p) => delete p.features[0].entries[1].run[2].max, `${E}/1/run/2`, /缺少必填字段 max/],
    ["until on a list repeat", (p) => (p.features[0].entries[1].run[1].until = "{{ true }}"), `${E}/1/run/1/until`, /不认识的字段 until/],
    ["repeat without steps", (p) => delete p.features[0].entries[1].run[1].steps, `${E}/1/run/1`, /缺少必填字段 steps/],
    ["unknown auto: finder", (p) => (p.features[0].entries[2].run[0].find = "auto:question"), `${E}/2/run/0/find`, /./],
    ["find without as", (p) => delete p.features[0].entries[1].run[0].as, `${E}/1/run/0`, /缺少必填字段 as/],
    ["ask without input", (p) => delete p.features[0].entries[0].run[2].input, `${E}/0/run/2`, /缺少必填字段 input/],
    ["ask with both engine and engines", (p) => (p.features[0].entries[0].run[2].engines = ["a"]), `${E}/0/run/2/engines`, /不认识的字段 engines/],
    ["stop that is not true", (p) => (p.features[0].entries[0].run[1].then[0].stop = false), `${E}/0/run/1/then/0/stop`, /./],
    ["hotkey default that is not a key combination", (p) => (p.features[0].settings.hotkey.default = "Alt+"), "/features/0/settings/hotkey/default", /格式不对/],
    ["unknown number format", (p) => (p.features[0].settings.threshold.format = "money"), "/features/0/settings/threshold/format", /取值不对/],
    ["format on a non-number setting", (p) => (p.features[0].settings.below.format = "percent"), "/features/0/settings/below/format", /不认识的字段 format/],
    ["unknown surface type", (p) => (p.features[0].entries[2].present.surface.type = "corner-card"), `${E}/2/present/surface/type`, /取值不对/],
  ];

  it.each(cases)("rejects %s with its field path", (_name, edit, path, message) => {
    const errors = errorsAfter(automation, edit);
    expect(errors.map((e) => e.path)).toContain(path);
    expect(errors.find((e) => e.path === path)?.message).toMatch(message);
  });
});

describe("round 2 rule types", () => {
  it("type the new shapes as discriminated unions", () => {
    const steps: RunStepDef[] = [
      { find: "auto:questions", as: "questions" },
      { if: "{{ true }}", then: [{ stop: true }], else: [{ set: { a: 1 } }] },
      { repeat: "{{ vars.questions }}", steps: [{ act: "focus", target: "{{ item }}" }] },
      { repeat: true, until: "{{ vars.done }}", max: 3, steps: [{ act: "wait", ms: 100 }] },
      { ask: "choose", input: {}, as: "pick" },
      { act: "click", target: "{{ vars.a }}", confidence: "{{ vars.pick.confidence }}", minConfidence: 0.8, below: "hint" },
      // @ts-expect-error one step is one kind
      { act: "click", target: "x", call: "translate" },
    ];
    const find: FindStep = { find: "a", all: true, as: "x" };
    const ask: AskStep = { ask: "chat", engine: "{{ settings.e }}", input: {} };
    const act: ActStep = { act: "fill", target: "x", value: "y" };
    const triggers: TriggerDef[] = [
      { on: "appear", selector: "a", debounceMs: 300 },
      { on: "command", title: "t", hotkey: "Alt+A" },
      // @ts-expect-error appear needs a selector
      { on: "appear" },
    ];
    const hotkey: SettingDef = { type: "hotkey", title: "快捷键", default: "Alt+A" };
    const percent: SettingDef = { type: "number", title: "门槛", format: "percent" };
    const surface: SurfaceDef = { type: "page-card" };
    const noPresent: EntryDef = { id: "e", name: "e", triggers: [{ on: "page-load" }], run: [{ stop: true }] };
    expect([steps, find, ask, act, triggers, hotkey, percent, surface, noPresent]).toHaveLength(9);
  });
});
