import { describe, expect, it, vi } from "vitest";
import type { EngineResult, InvokeRequest, InvokeResult } from "../../core/invoke";
import { CallError } from "../../core/errors";
import { official } from "./testing";
import type { ResultItem } from "../../views";
import { applyDelta, applyResult, pendingItems } from "./items";
import { matchUrl, matchesAny } from "./match";
import { CARD_WIDTH, GAP, MARGIN, PAW_SIZE, placeCard, placePaw } from "./place";
import { sentenceAround } from "./sentence";
import { invokeInto, localVars, runSteps, type StepEnv } from "./steps";

const SEL_ENTRY = () => official().features[0]!.entries.find((e) => e.id === "selection")!;

describe("match patterns", () => {
  it("matches scheme, host wildcards and paths", () => {
    expect(matchUrl("*://*/*", "https://example.com/a")).toBe(true);
    expect(matchUrl("*://*/*", "http://localhost:3000/")).toBe(true);
    expect(matchUrl("*://*/*", "file:///tmp/a.html")).toBe(false);
    expect(matchUrl("https://*.example.com/*", "https://a.b.example.com/x")).toBe(true);
    expect(matchUrl("https://*.example.com/*", "https://example.com/x")).toBe(true);
    expect(matchUrl("https://*.example.com/*", "https://badexample.com/x")).toBe(false);
    expect(matchUrl("https://example.com/docs/*", "https://example.com/blog/1")).toBe(false);
    expect(matchUrl("<all_urls>", "https://x.y/")).toBe(true);
    expect(matchesAny(undefined, "https://x.y/")).toBe(false);
  });
});

describe("placement (R9.9)", () => {
  const anchor = { left: 100, top: 200, right: 300, bottom: 220 };
  it("puts the card below the selection, left-aligned", () => {
    expect(placeCard(anchor, 200, 1280, 800)).toMatchObject({ side: "below", top: 220 + GAP, left: 100, width: CARD_WIDTH });
  });
  it("flips above when there is no room below", () => {
    const low = { left: 100, top: 700, right: 300, bottom: 720 };
    expect(placeCard(low, 200, 1280, 800)).toMatchObject({ side: "above", top: 700 - GAP - 200 });
  });
  it("stays below when neither side fits but below is roomier", () => {
    const high = { left: 100, top: 100, right: 300, bottom: 120 };
    expect(placeCard(high, 900, 1280, 800)).toMatchObject({ side: "below", top: 120 + GAP });
  });
  it("never runs off the left or right edge", () => {
    expect(placeCard({ left: 1200, top: 200, right: 1270, bottom: 220 }, 200, 1280, 800).left).toBe(1280 - CARD_WIDTH - MARGIN);
    expect(placeCard({ left: -40, top: 200, right: 10, bottom: 220 }, 200, 1280, 800).left).toBe(MARGIN);
  });
  it("almost fills a narrow screen", () => {
    expect(placeCard(anchor, 200, 400, 800)).toMatchObject({ left: 10, width: 380 });
  });
  it("points the tail at the selection, inside the card", () => {
    const p = placeCard(anchor, 200, 1280, 800);
    expect(p.tail).toBe(200 - 100 - 8);
    expect(placeCard({ left: 1200, top: 200, right: 1270, bottom: 220 }, 200, 1280, 800).tail).toBeLessThanOrEqual(CARD_WIDTH - 34);
  });
  it("caps the card's height to the room on its side, so it never runs off the screen", () => {
    const high = { left: 100, top: 100, right: 300, bottom: 120 };
    const p = placeCard(high, 900, 1280, 800);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(800 - MARGIN);
    const low = { left: 100, top: 700, right: 300, bottom: 720 };
    const q = placeCard(low, 900, 1280, 800);
    expect(q.side).toBe("above");
    expect(q.top).toBeGreaterThanOrEqual(MARGIN);
    expect(q.top + Math.min(900, q.maxHeight)).toBeLessThanOrEqual(700 - GAP);
  });
  it("puts the paw before the end in right-to-left text", () => {
    expect(placePaw({ left: 280, top: 200, right: 300, bottom: 220 }, 1280, 800, true)).toEqual({ left: 280 - 4 - PAW_SIZE, top: 210 - PAW_SIZE / 2 });
  });
  it("puts the paw at the end of the selection, inside the viewport", () => {
    expect(placePaw({ left: 280, top: 200, right: 300, bottom: 220 }, 1280, 800)).toEqual({ left: 304, top: 210 - PAW_SIZE / 2 });
    expect(placePaw({ left: 1260, top: 790, right: 1279, bottom: 810 }, 1280, 800)).toEqual({
      left: 1280 - PAW_SIZE - MARGIN,
      top: 800 - PAW_SIZE - MARGIN,
    });
  });
});

describe("sentence (R9.7)", () => {
  const block = "First sentence here. The event loop schedules tasks and microtasks. Last one!";
  it("is the whole sentence around the selection", () => {
    const at = block.indexOf("event loop");
    expect(sentenceAround(block, at, at + 10)).toBe("The event loop schedules tasks and microtasks.");
  });
  it("splits Chinese sentences", () => {
    const zh = "第一句。事件循环负责调度任务！最后一句";
    const at = zh.indexOf("调度");
    expect(sentenceAround(zh, at, at + 2)).toBe("事件循环负责调度任务！");
  });
  it("is capped at 500 characters and keeps the selection", () => {
    const long = "a".repeat(400) + " middle " + "b".repeat(400);
    const at = long.indexOf("middle");
    const s = sentenceAround(long, at, at + 6);
    expect(s.length).toBeLessThanOrEqual(500);
    expect(s).toContain("middle");
  });
});

describe("result items (R10.5)", () => {
  const names = (ref: string) => ({ "p/a": "A", "p/b": "B" })[ref];
  it("starts every engine loading, in order, with names", () => {
    expect(pendingItems(["p/a", "p/b"], names)).toEqual([
      { engine: "p/a", engineName: "A", state: "loading" },
      { engine: "p/b", engineName: "B", state: "loading" },
    ]);
  });
  it("streams partial text, then settles each engine on its own", () => {
    let items: ResultItem[] = pendingItems(["p/a", "p/b"], names);
    items = applyDelta(items, { engine: "p/a", text: "你", full: "你好", attempt: 1 }, "translate");
    expect(items[0]).toMatchObject({ state: "streaming", output: { texts: ["你好"] } });
    expect(items[1]!.state).toBe("loading");
    const ok: EngineResult = { engine: "p/a", ok: true, output: { texts: ["你好世界"] }, cached: true, ms: 1 };
    items = applyResult(items, ok);
    expect(items[0]).toMatchObject({ state: "ok", output: { texts: ["你好世界"] }, cached: true });
    items = applyResult(items, { engine: "p/b", ok: false, error: new CallError("timeout", "10 秒没有响应"), ms: 1 });
    expect(items[1]).toMatchObject({ state: "error", error: { type: "timeout", message: "10 秒没有响应" } });
    expect(items[0]!.state).toBe("ok");
  });
  it("shows a missing key as needKey", () => {
    const items = applyResult(pendingItems(["p/a"], names), { engine: "p/a", ok: false, error: new CallError("missingKey", "还没有填写「API Key」"), ms: 0 });
    expect(items[0]!.state).toBe("needKey");
  });
  it("chat-like contracts stream into output.text", () => {
    const items = applyDelta(pendingItems(["p/a"], names), { engine: "p/a", text: "x", full: "xy", attempt: 1 }, "chat");
    expect(items[0]!.output).toEqual({ text: "xy" });
  });
});

describe("steps (R9.8)", () => {
  const scope = (settings: Record<string, unknown>, lang = "en") => ({
    settings: { to: "zh-CN", swapIfSame: true, engines: ["official-translate/google", "official-translate/microsoft"], ...settings },
    selection: { text: "Hello", lang, sentence: "Hello there.", rect: {} },
    page: { url: "https://example.com/", title: "T" },
    site: {},
  });
  function env(answer?: (req: InvokeRequest) => Partial<InvokeResult>) {
    const calls: InvokeRequest[] = [];
    const varsSeen: Record<string, unknown>[] = [];
    const e: StepEnv = {
      invoker: {
        invoke: vi.fn(async (req: InvokeRequest, opts) => {
          calls.push(req);
          const engines = req.engines as string[];
          const results: EngineResult[] = engines.map((engine) => ({ engine, ok: true, output: { texts: [`${engine}:${req.contract}`] }, cached: false, ms: 1 }));
          results.forEach((r) => opts?.onResult?.(r));
          return { ok: true, strategy: req.strategy ?? "first", contract: req.contract, results, output: results[0]!.ok ? results[0]!.output : undefined, ...answer?.(req) };
        }),
        preferredEngines: () => ({ engines: ["p/pref"] }),
      },
      nameOf: () => undefined,
      vars: localVars((v) => varsSeen.push(v)),
    };
    return { e, calls, varsSeen };
  }

  it("set writes vars (swap-if-same) and call invokes with the rendered request, `as` holding the items", async () => {
    const { e, calls, varsSeen } = env();
    const out = await runSteps(SEL_ENTRY().def.run, scope({}, "zh-CN"), e);
    expect(out.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      contract: "translate",
      strategy: "all",
      stream: true,
      engines: ["official-translate/google", "official-translate/microsoft"],
      input: { texts: ["Hello"], to: "en", context: "Hello there." },
    });
    expect(out.vars.to).toBe("en");
    const results = out.vars.results as ResultItem[];
    expect(results.map((r) => [r.engine, r.state])).toEqual([
      ["official-translate/google", "ok"],
      ["official-translate/microsoft", "ok"],
    ]);
    // the card sees the loading list before any engine answers
    expect(varsSeen.some((v) => (v.results as ResultItem[] | undefined)?.every((r) => r.state === "loading"))).toBe(true);
  });

  it("keeps the target language when swap-if-same is off, or when the text is not in it", async () => {
    const off = env();
    expect((await runSteps(SEL_ENTRY().def.run, scope({ swapIfSame: false }, "zh-CN"), off.e)).vars.to).toBe("zh-CN");
    const other = env();
    expect((await runSteps(SEL_ENTRY().def.run, scope({}, "en"), other.e)).vars.to).toBe("zh-CN");
    const toEn = env();
    expect((await runSteps(SEL_ENTRY().def.run, scope({ to: "en" }, "en"), toEn.e)).vars.to).toBe("zh-CN");
  });

  it("overrides (a temporary rerun) win over set and reach the call", async () => {
    const { e, calls } = env();
    const out = await runSteps(SEL_ENTRY().def.run, scope({}, "zh-CN"), e, { to: "ja" });
    expect(out.vars.to).toBe("ja");
    expect((calls[0]!.input as { to: string }).to).toBe("ja");
  });

  it("an empty engine list falls back to the preferred engines", async () => {
    const { e, calls } = env();
    await runSteps(SEL_ENTRY().def.run, scope({ engines: [] }), e);
    expect(calls[0]!.engines).toEqual(["p/pref"]);
  });

  it("a failing step stops the rest and reports the error", async () => {
    const { e, calls } = env();
    const steps = [{ set: { a: "{{ 1 / 0 }}" } }, ...SEL_ENTRY().def.run];
    const out = await runSteps(steps, scope({}), e);
    expect(out.error).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("a non-list strategy writes the winning output", async () => {
    const { e } = env();
    const out = await runSteps([{ call: "translate", strategy: "first", engines: ["p/x"], input: { texts: ["a"], to: "en" }, as: "r" }], scope({}), e);
    expect(out.vars.r).toEqual({ texts: ["p/x:translate"] });
  });

  it("a call nothing answers is an error for non-list strategies", async () => {
    const { e } = env(() => ({ ok: false, error: new CallError("network", "连不上"), results: [] }));
    const out = await runSteps([{ call: "translate", strategy: "first", engines: ["p/x"], input: { texts: ["a"], to: "en" }, as: "r" }], scope({}), e);
    expect(out.error).toBe("连不上");
  });
});

describe("retry vs the original call (R10.5)", () => {
  it("a late original result does not overwrite an engine that was retried meanwhile", async () => {
    const fail: EngineResult = { engine: "p/a", ok: false, error: new CallError("rateLimit", "busy"), ms: 1 };
    const okB: EngineResult = { engine: "p/b", ok: true, output: { texts: ["B"] }, cached: false, ms: 1 };
    const okA: EngineResult = { engine: "p/a", ok: true, output: { texts: ["A"] }, cached: false, ms: 1 };
    let finishOriginal!: () => void;
    const gate = new Promise<void>((r) => (finishOriginal = r));
    const e: StepEnv = {
      invoker: {
        invoke: vi.fn(async (req: InvokeRequest, opts) => {
          const engines = req.engines as string[];
          if (engines.length === 1) {
            opts?.onResult?.(okA);
            return { ok: true, strategy: "first" as const, contract: req.contract, results: [okA], output: okA.output };
          }
          opts?.onResult?.(fail);
          await gate;
          opts?.onResult?.(okB);
          return { ok: true, strategy: "all" as const, contract: req.contract, results: [fail, okB], output: okB.output };
        }),
        preferredEngines: () => ({ engines: [] }),
      },
      nameOf: () => undefined,
      vars: localVars(),
    };
    const call = { as: "r", contract: "translate", input: {}, stream: false };
    e.vars.set({ r: pendingItems(["p/a", "p/b"], () => undefined) });
    const original = invokeInto(call, ["p/a", "p/b"], "all", e);
    await Promise.resolve();
    expect((e.vars.get().r as ResultItem[])[0]!.state).toBe("error");
    await invokeInto(call, ["p/a"], "first", e);
    finishOriginal();
    await original;
    expect((e.vars.get().r as ResultItem[]).map((it) => it.state)).toEqual(["ok", "ok"]);
  });
});
