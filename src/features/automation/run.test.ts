// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CallError } from "../../core/errors";
import { elementOf, isElementHandle, type ElementHandle, type PageHost } from "../../core/expr";
import type { InvokeRequest, InvokeResult } from "../../core/invoke";
import type { RunStepDef } from "../../core/rules/types";
import { runAutomation, type ActCtx, type AutoEnv } from "./run";

/** jsdom has no layout or innerText: text is textContent, hidden is the `hidden` attribute. */
const host: PageHost = {
  text: (el) => el.textContent ?? "",
  visible: (el) => !el.closest("[hidden]"),
};

const scope = { settings: { min: 0.8 }, page: { url: "https://v.test/", title: "V" }, site: {} };
const run = (steps: unknown[]) => steps as RunStepDef[];
const $ = (sel: string) => document.querySelector(sel)!;
const els = (v: unknown) => (v as ElementHandle[]).map(elementOf);

type Answer = (req: InvokeRequest) => Partial<InvokeResult> | Promise<Partial<InvokeResult>>;

function env(answer?: Answer, over: Partial<AutoEnv> = {}) {
  const acts: { kind: string; el?: Element; ctx: ActCtx }[] = [];
  const invoke = vi.fn(async (req: InvokeRequest): Promise<InvokeResult> => {
    const base: InvokeResult = {
      ok: true,
      strategy: req.strategy ?? "first",
      contract: req.contract,
      engine: (req.engines as string[])[0],
      output: { choice: "b", confidence: 0.5 },
      confidence: 0.9,
      results: [],
    };
    return { ...base, ...(await answer?.(req)) };
  });
  const e: AutoEnv = {
    invoker: { invoke, preferredEngines: () => ({ engines: ["p/pref"] }) },
    host,
    act: vi.fn(async (step, target, ctx) => {
      acts.push({ kind: step.act, el: target ? elementOf(target) : undefined, ctx });
    }),
    log: vi.fn(),
    ...over,
  };
  return { e, invoke, acts };
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="player">
      <div class="ad">
        <button class="skip">跳过广告</button>
        <button class="skip" hidden>隐藏的跳过</button>
      </div>
      <ul class="opts"><li class="opt">A 苹果</li><li class="opt">B 香蕉</li><li class="opt">C 樱桃</li></ul>
    </div>
    <button class="skip" id="outside">外面的跳过</button>`;
});

describe("set and call (phase-1 semantics, R1.2)", () => {
  it("set writes vars and call invokes with input rendered at the automation run position", async () => {
    const { e, invoke } = env(() => ({ output: { texts: ["Skip ad"] } }));
    const r = await runAutomation(
      run([
        { set: { lang: "en" } },
        { find: ".skip", as: "btn" },
        { call: "translate", engines: "p/x", input: { texts: ["{{ text(vars.btn[0]) }}"], to: "{{ vars.lang }}" }, as: "tr" },
      ]),
      scope,
      e,
    );
    expect(r.end).toBe("done");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0]).toMatchObject({ contract: "translate", engines: ["p/x"], strategy: "first", input: { texts: ["跳过广告"], to: "en" } });
    expect(r.vars.lang).toBe("en");
    expect(r.vars.tr).toEqual({ texts: ["Skip ad"] });
  });

  it("a failing call stops the run with its error type", async () => {
    const { e } = env(() => ({ ok: false, output: undefined, error: new CallError("rateLimit") }));
    const r = await runAutomation(run([{ call: "translate", engines: "p/x", input: { texts: ["a"] } }, { set: { after: true } }]), scope, e);
    expect(r.end).toBe("error");
    expect(r.steps[0]!.error).toMatchObject({ type: "rateLimit" });
    expect(r.vars.after).toBeUndefined();
  });
});

describe("find (R1.2)", () => {
  it("returns only visible elements as handles; the first one unless all", async () => {
    const { e } = env();
    const r = await runAutomation(run([{ find: ".skip", as: "one" }, { find: ".skip", all: true, as: "every" }]), scope, e);
    expect((r.vars.one as unknown[]).every(isElementHandle)).toBe(true);
    expect(els(r.vars.one)).toEqual([$(".ad .skip")]);
    expect(els(r.vars.every)).toEqual([$(".ad .skip"), $("#outside")]);
    expect(r.steps.map((s) => s.found?.length)).toEqual([1, 2]);
  });

  it("searches within a handle or a selector and filters with where (item = the element)", async () => {
    const { e } = env();
    const r = await runAutomation(
      run([
        { find: "#player", as: "player" },
        { find: ".skip", within: "{{ vars.player[0] }}", all: true, as: "inside" },
        { find: ".opt", within: ".opts", all: true, where: "{{ text(item) != 'B 香蕉' }}", as: "opts" },
      ]),
      scope,
      e,
    );
    expect(els(r.vars.inside)).toEqual([$(".ad .skip")]);
    expect(els(r.vars.opts).map((el) => el.textContent)).toEqual(["A 苹果", "C 樱桃"]);
  });

  it("finding nothing gives an empty list, not an error (R1.6)", async () => {
    const { e } = env();
    const r = await runAutomation(run([{ find: ".nope", all: true, as: "none" }, { set: { after: true } }]), scope, e);
    expect(r.end).toBe("done");
    expect(r.vars.none).toEqual([]);
    expect(r.steps[0]!.error).toBeUndefined();
    expect(r.vars.after).toBe(true);
  });

  it("uses a named finder for auto: selectors", async () => {
    const finder = vi.fn((root: ParentNode) => Array.from(root.querySelectorAll(".opt")).slice(1));
    const { e } = env(undefined, { finders: { "auto:questions": finder } });
    const r = await runAutomation(run([{ find: "auto:questions", all: true, as: "qs" }]), scope, e);
    expect(els(r.vars.qs).map((el) => el.textContent)).toEqual(["B 香蕉", "C 樱桃"]);
  });
});

describe("ask (R1.2, R1.6)", () => {
  it("invokes the contract through the invoker and keeps the confidence in vars.<as>", async () => {
    const { e, invoke } = env();
    const r = await runAutomation(
      run([
        { find: ".skip", as: "btn" },
        { ask: "choose", engine: "p/a", strategy: "vote", input: { question: "{{ describe(vars.btn[0]) }}" }, as: "pick" },
      ]),
      scope,
      e,
    );
    expect(invoke.mock.calls[0]![0]).toMatchObject({ contract: "choose", engines: ["p/a"], strategy: "vote", input: { question: "「跳过广告」按钮" } });
    expect(r.vars.pick).toEqual({ choice: "b", confidence: 0.9 });
    expect(r.steps[1]!.send).toEqual({ contract: "choose", engines: ["p/a"], strategy: "vote", input: { question: "「跳过广告」按钮" } });
  });

  it("uses the preferred engines when the step names none", async () => {
    const { e, invoke } = env();
    await runAutomation(run([{ ask: "choose", input: { question: "q" } }]), scope, e);
    expect(invoke.mock.calls[0]![0]).toMatchObject({ engines: ["p/pref"], strategy: "first" });
  });

  it("a failing ask is logged with its error type and stops the run", async () => {
    const { e, acts } = env(() => ({ ok: false, output: undefined, error: new CallError("auth") }));
    const r = await runAutomation(
      run([
        { find: ".skip", as: "btn" },
        { ask: "choose", engine: "p/a", input: { question: "q" }, as: "pick" },
        { act: "click", target: "{{ vars.btn[0] }}" },
      ]),
      scope,
      e,
    );
    expect(r.end).toBe("error");
    expect(r.steps).toHaveLength(2);
    expect(r.steps[1]!.error).toMatchObject({ type: "auth" });
    expect(e.log).toHaveBeenLastCalledWith(expect.objectContaining({ path: [1], kind: "ask", error: expect.objectContaining({ type: "auth" }) }));
    expect(acts).toEqual([]);
  });

  it("an expression error stops a live run", async () => {
    const { e } = env();
    const r = await runAutomation(run([{ set: { x: "{{ vars.nope.deeper }}" } }, { set: { after: true } }]), scope, e);
    expect(r.end).toBe("error");
    expect(r.steps[0]!.error?.type).toBe("expr");
    expect(r.vars.after).toBeUndefined();
  });
});

describe("if, repeat, stop (R1.2)", () => {
  it("if runs then when true and else otherwise", async () => {
    const { e } = env();
    const r = await runAutomation(
      run([
        { if: "{{ settings.min > 0.5 }}", then: [{ set: { a: "then" } }], else: [{ set: { a: "else" } }] },
        { if: false, then: [{ set: { b: "then" } }], else: [{ set: { b: "else" } }] },
        { if: false, then: [{ set: { c: "then" } }] },
      ]),
      scope,
      e,
    );
    expect(r.vars).toMatchObject({ a: "then", b: "else" });
    expect(r.vars.c).toBeUndefined();
    expect(r.steps.map((s) => s.path)).toEqual([[0], [0, "then", 0], [1], [1, "else", 0], [2]]);
  });

  it("repeat runs its steps for each item of a list, at most max", async () => {
    const { e, acts } = env();
    const r = await runAutomation(
      run([
        { find: ".opt", all: true, as: "opts" },
        { repeat: "{{ vars.opts }}", steps: [{ if: "{{ text(item) != 'B 香蕉' }}", then: [{ act: "click", target: "{{ item }}" }] }] },
        { repeat: "{{ vars.opts }}", max: 1, steps: [{ act: "focus", target: "{{ item }}" }] },
      ]),
      scope,
      e,
    );
    expect(r.end).toBe("done");
    expect(acts.map((a) => `${a.kind}:${a.el!.textContent}`)).toEqual(["click:A 苹果", "click:C 樱桃", "focus:A 苹果"]);
  });

  it("repeat true runs until the condition holds, at most max times", async () => {
    const { e } = env();
    const r = await runAutomation(
      run([
        { set: { n: 0, m: 0 } },
        { repeat: true, until: "{{ vars.n >= 3 }}", max: 10, steps: [{ set: { n: "{{ vars.n + 1 }}" } }] },
        { repeat: true, until: "{{ false }}", max: 4, steps: [{ set: { m: "{{ vars.m + 1 }}" } }] },
      ]),
      scope,
      e,
    );
    expect(r.vars).toMatchObject({ n: 3, m: 4 });
  });

  it("stop ends the whole run, also from inside a repeat", async () => {
    const { e } = env();
    const r = await runAutomation(
      run([
        { set: { n: 0 } },
        { repeat: true, until: "{{ false }}", max: 5, steps: [{ set: { n: "{{ vars.n + 1 }}" } }, { if: "{{ vars.n == 2 }}", then: [{ stop: true }] }] },
        { set: { after: true } },
      ]),
      scope,
      e,
    );
    expect(r.end).toBe("stop");
    expect(r.vars.n).toBe(2);
    expect(r.vars.after).toBeUndefined();
  });
});

describe("act (R1.2, R1.3 fields, R1.6)", () => {
  const skipFlow = (act: object = {}) =>
    run([
      { find: ".skip", as: "btn" },
      { ask: "choose", engine: "p/a", input: { question: "q" }, as: "pick" },
      {
        act: "click",
        target: "{{ vars.btn[0] }}",
        confidence: "{{ vars.pick.confidence }}",
        minConfidence: "{{ settings.min }}",
        below: "ask",
        describe: "点{{ describe(vars.btn[0]) }}",
        ...act,
      },
      { set: { after: true } },
    ]);

  it("delegates to env.act with the target handle and the rendered threshold fields", async () => {
    const { e, acts } = env();
    const r = await runAutomation(skipFlow(), scope, e);
    expect(r.end).toBe("done");
    expect(acts).toHaveLength(1);
    expect(acts[0]!.el).toBe($(".ad .skip"));
    expect(acts[0]!.ctx).toMatchObject({ path: [2], confidence: 0.9, minConfidence: 0.8, below: "ask", describe: "点「跳过广告」按钮" });
    expect(vi.mocked(e.act).mock.calls[0]![0]).toMatchObject({ act: "click", target: "{{ vars.btn[0] }}" });
    expect(r.vars.after).toBe(true);
  });

  it("acts on each handle of a list target and renders value; wait has no target", async () => {
    const { e, acts } = env();
    await runAutomation(
      run([
        { find: ".skip", all: true, as: "btns" },
        { act: "fill", target: "{{ vars.btns }}", value: "{{ page.title }}!" },
        { act: "wait", ms: "{{ 200 + 50 }}" },
      ]),
      scope,
      e,
    );
    expect(acts.map((a) => [a.kind, a.el ? a.el.id || a.el.textContent : null, a.ctx.value ?? a.ctx.ms])).toEqual([
      ["fill", "跳过广告", "V!"],
      ["fill", "outside", "V!"],
      ["wait", null, 250],
    ]);
  });

  it("an act reporting stop (a wait timeout) ends the run with its error", async () => {
    const act = vi.fn(async () => ({ stop: true, error: { type: "timeout" as const, message: "等到超时" } }));
    const { e } = env(undefined, { act });
    const r = await runAutomation(run([{ act: "wait", selector: ".later", timeoutMs: 10 }, { set: { after: true } }]), scope, e);
    expect(r.end).toBe("error");
    expect(r.steps[0]!.error).toEqual({ type: "timeout", message: "等到超时" });
    expect(r.vars.after).toBeUndefined();
  });

  it("a target that is not an element is a rule error", async () => {
    const { e, acts } = env();
    const r = await runAutomation(run([{ act: "click", target: "{{ 'button' }}" }]), scope, e);
    expect(r.end).toBe("error");
    expect(r.steps[0]!.error?.type).toBe("rule");
    expect(acts).toEqual([]);
  });
});

describe("abort (R1.6)", () => {
  it("aborting while an ask is pending discards the rest of the run", async () => {
    const ctl = new AbortController();
    let release!: () => void;
    const { e, acts } = env(() => new Promise((res) => (release = () => res({})) ), { signal: ctl.signal });
    const pending = runAutomation(skipLike(), scope, e);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    ctl.abort();
    release();
    const r = await pending;
    expect(r.end).toBe("aborted");
    expect(acts).toEqual([]);
    expect(r.steps.map((s) => s.kind)).toEqual(["find"]);
    expect(e.log).toHaveBeenCalledTimes(1);
  });

  it("an already aborted signal runs nothing", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { e } = env(undefined, { signal: ctl.signal });
    const r = await runAutomation(run([{ set: { a: 1 } }]), scope, e);
    expect(r).toMatchObject({ end: "aborted", steps: [], vars: {} });
  });

  it("aborting during an act stops before the next step", async () => {
    const ctl = new AbortController();
    const act = vi.fn(async () => ctl.abort());
    const { e } = env(undefined, { signal: ctl.signal, act });
    const r = await runAutomation(run([{ find: ".skip", as: "btn" }, { act: "click", target: "{{ vars.btn[0] }}" }, { set: { after: true } }]), scope, e);
    expect(r.end).toBe("aborted");
    expect(r.vars.after).toBeUndefined();
  });
});

function skipLike() {
  return run([
    { find: ".skip", as: "btn" },
    { ask: "choose", engine: "p/a", input: { question: "q" }, as: "pick" },
    { act: "click", target: "{{ vars.btn[0] }}" },
  ]);
}

describe("dry mode (R6.5)", () => {
  it("never acts or calls an engine; reports found handles, what it would send and where", async () => {
    const { e, invoke, acts } = env(undefined, { mode: "dry" });
    const r = await runAutomation(
      run([
        { find: ".skip", all: true, as: "btns" },
        { ask: "choose", engine: "p/a", input: { question: "哪个是跳过按钮", options: "{{ outline(vars.btns[0], 60) }}" }, as: "pick" },
        { if: "{{ vars.pick.confidence >= settings.min }}", then: [{ act: "click", target: "{{ vars.btns[0] }}", describe: "点跳过" }] },
        { call: "translate", input: { texts: ["{{ text(vars.btns[1]) }}"] }, as: "tr" },
        { act: "focus", target: "{{ vars.btns[1] }}" },
      ]),
      scope,
      e,
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(acts).toEqual([]);
    expect(e.act).not.toHaveBeenCalled();
    expect(r).toMatchObject({ mode: "dry", end: "done" });
    const [find, ask, cond, click, call, focus] = r.steps;
    expect(els(find!.found)).toEqual([$(".ad .skip"), $("#outside")]);
    expect(ask).toMatchObject({ path: [1], kind: "ask", send: { contract: "choose", engines: ["p/a"], strategy: "first" } });
    expect((ask!.send!.input as { options: string }).options).toContain("跳过广告");
    // the answer is unknown in a dry run: steps reading it are shown, not failed
    expect(cond).toMatchObject({ path: [2], kind: "if", dependsOn: ["pick"] });
    expect(cond!.error).toBeUndefined();
    expect(click).toMatchObject({ path: [2, "then", 0], kind: "act", summary: expect.stringContaining("点跳过") });
    expect(click!.error).toBeUndefined();
    expect(call).toMatchObject({ kind: "call", send: { contract: "translate", engines: ["p/pref"], input: { texts: ["外面的跳过"] } } });
    expect(els(focus!.found)).toEqual([$("#outside")]);
    expect(r.vars.pick).toBeUndefined();
  });

  it("records a real error on its step and keeps going", async () => {
    const { e } = env(undefined, { mode: "dry" });
    const r = await runAutomation(run([{ set: { x: "{{ vars.nope.deeper }}" } }, { set: { after: true } }]), scope, e);
    expect(r.steps[0]!.error?.type).toBe("expr");
    expect(r.vars.after).toBe(true);
  });
});
