import { afterEach, describe, expect, it } from "vitest";
import { chatter, chooser, hello, setup, sse, text, translates, translator, type Setup } from "./fixtures";
import type { EngineResult, InvokeDelta } from "./index";

let current: Setup | undefined;
const use = (s: Setup) => ((current = s), s);
afterEach(() => {
  current?.fake.restore();
  current = undefined;
});

const failing = (id: string, status = 503) => ({ url: `https://${id}.test/t`, status, json: {} });

describe("first (R6.2)", () => {
  it("tries engines in order and stops at the first success", async () => {
    const s = use(setup([translator("a"), translator("b"), translator("c")], { routes: [failing("a"), translates("b"), translates("c")] }));
    const r = await s.invoker.invoke({ contract: "translate", input: text(), strategy: "first", engines: ["test/a", "test/b", "test/c"] });
    expect(r).toMatchObject({ ok: true, strategy: "first", engine: "test/b", output: { texts: ["b:hello"] }, cached: false });
    expect(r.results.map((x) => [x.engine, x.ok])).toEqual([
      ["test/a", false],
      ["test/b", true],
    ]);
    expect(s.fake.calls.map((c) => c.url)).toEqual(["https://a.test/t", "https://b.test/t"]);
  });

  it("returns the last error with every engine's own error when all fail", async () => {
    const s = use(setup([translator("a"), translator("b")], { routes: [failing("a", 401), failing("b", 503)] }));
    const r = await s.invoker.invoke({ contract: "translate", input: text(), engines: ["test/a", "test/b"] });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe("server");
    expect(r.results.map((x) => !x.ok && x.error.type)).toEqual(["auth", "server"]);
  });

  it("streams deltas of the engine being tried", async () => {
    const s = use(
      setup([chatter("x"), chatter("y")], {
        routes: [
          { url: "https://x.test/c", status: 500, body: "" },
          { url: "https://y.test/c", body: sse("he", "llo") },
        ],
      }),
    );
    const deltas: InvokeDelta[] = [];
    const r = await s.invoker.invoke(
      { contract: "chat", input: hello, engines: ["test/x", "test/y"], stream: true },
      { onDelta: (d) => deltas.push(d) },
    );
    expect(r).toMatchObject({ ok: true, engine: "test/y", output: { text: "hello" } });
    expect(deltas).toEqual([
      { engine: "test/y", text: "he", full: "he", attempt: 1 },
      { engine: "test/y", text: "llo", full: "hello", attempt: 1 },
    ]);
  });

  it("sends no deltas unless streaming was asked for", async () => {
    const s = use(setup([chatter("y")], { routes: [{ url: "https://y.test/c", body: sse("he", "llo") }] }));
    const deltas: InvokeDelta[] = [];
    const r = await s.invoker.invoke({ contract: "chat", input: hello, engines: ["test/y"] }, { onDelta: (d) => deltas.push(d) });
    expect(r.output).toEqual({ text: "hello" });
    expect(deltas).toEqual([]);
  });
});

describe("race (R6.2)", () => {
  it("uses the first success and cancels the others", async () => {
    const s = use(
      setup([translator("slow", { limits: { concurrency: 1 } }), translator("fast"), translator("bad")], {
        routes: [{ url: "https://slow.test/t", error: "hang" }, failing("bad"), translates("fast")],
      }),
    );
    const r = await s.invoker.invoke({ contract: "translate", input: text(), strategy: "race", engines: ["test/slow", "test/bad", "test/fast"] });
    expect(r).toMatchObject({ ok: true, strategy: "race", engine: "test/fast", output: { texts: ["fast:hello"] } });
    expect(r.results.map((x) => x.engine).sort()).toEqual(["test/bad", "test/fast"]);
    expect(s.fake.calls).toHaveLength(3);
    expect(s.invoker.usage().map((u) => u.engine).sort()).toEqual(["test/bad", "test/fast"]);
    // The cancelled request gave its slot back: the next call to that engine goes out at once.
    s.fake.add(translates("slow"));
    const next = await s.invoker.invoke({ contract: "translate", input: text("again"), engines: ["test/slow"] });
    expect(next).toMatchObject({ ok: true, output: { texts: ["slow:again"] } });
  });

  it("fails with the last error when every engine fails", async () => {
    const s = use(setup([translator("a"), translator("b")], { routes: [failing("a", 401), failing("b", 401)] }));
    const r = await s.invoker.invoke({ contract: "translate", input: text(), strategy: "race", engines: ["test/a", "test/b"] });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe("auth");
    expect(r.results).toHaveLength(2);
  });
});

describe("all (R6.2)", () => {
  it("returns each engine's result or error in engine order, reporting each as it settles", async () => {
    const s = use(setup([translator("a"), translator("b"), translator("c")], { routes: [translates("a"), failing("b", 429), translates("c")] }));
    const settled: EngineResult[] = [];
    const r = await s.invoker.invoke(
      { contract: "translate", input: text(), strategy: "all", engines: ["test/a", "test/b", "test/c"] },
      { onResult: (x) => settled.push(x) },
    );
    expect(r).toMatchObject({ ok: true, strategy: "all", engine: "test/a", output: { texts: ["a:hello"] } });
    expect(r.results).toEqual([
      expect.objectContaining({ engine: "test/a", ok: true, output: { texts: ["a:hello"] }, cached: false }),
      expect.objectContaining({ engine: "test/b", ok: false, error: expect.objectContaining({ type: "rateLimit" }) }),
      expect.objectContaining({ engine: "test/c", ok: true, output: { texts: ["c:hello"] } }),
    ]);
    expect(settled.map((x) => x.engine).sort()).toEqual(["test/a", "test/b", "test/c"]);
  });

  it("pushes streamed deltas of every engine as they arrive", async () => {
    const s = use(
      setup([chatter("x"), chatter("y")], {
        routes: [
          { url: "https://x.test/c", body: sse("a", "b") },
          { url: "https://y.test/c", body: sse("1", "2", "3") },
        ],
        http: { chunkSize: 8 },
      }),
    );
    const deltas: InvokeDelta[] = [];
    const pending = s.invoker.invoke(
      { contract: "chat", input: hello, strategy: "all", engines: ["test/x", "test/y"], stream: true },
      { onDelta: (d) => deltas.push(d) },
    );
    const r = await pending;
    expect(r.results.map((x) => x.ok && x.output)).toEqual([{ text: "ab" }, { text: "123" }]);
    const of = (e: string) => deltas.filter((d) => d.engine === e).map((d) => d.full);
    expect(of("test/x")).toEqual(["a", "ab"]);
    expect(of("test/y")).toEqual(["1", "12", "123"]);
    // Interleaved: the first delta of y arrives before the last delta of x.
    expect(deltas.findIndex((d) => d.engine === "test/y")).toBeLessThan(deltas.findLastIndex((d) => d.engine === "test/x"));
  });
});

describe("vote (R6.2)", () => {
  const q = { state: {}, question: "which?", options: { a: "A", b: "B" } };

  it("compares choice for choose and sets confidence to the agreeing share", async () => {
    const s = use(
      setup([chooser("p"), chooser("q"), chooser("r")], {
        routes: [
          { url: "https://p.test/q", json: { choice: "b", confidence: 0.6 } },
          { url: "https://q.test/q", json: { choice: "a", confidence: 0.9 } },
          { url: "https://r.test/q", json: { choice: "b", confidence: 0.7 } },
        ],
      }),
    );
    const r = await s.invoker.invoke({ contract: "choose", input: q, strategy: "vote", engines: ["test/p", "test/q", "test/r"] });
    expect(r).toMatchObject({ ok: true, strategy: "vote", engine: "test/p", output: { choice: "b", confidence: 0.6 } });
    expect(r.confidence).toBeCloseTo(2 / 3);
    expect(r.results.map((x) => x.ok && x.confidence)).toEqual([0.6, 0.9, 0.7]);
  });

  it("compares normalized output for other contracts and ignores failed engines", async () => {
    const s = use(
      setup([translator("a"), translator("b"), translator("c"), translator("d")], {
        routes: [
          { url: "https://a.test/t", json: { texts: ["Hello  world"] } },
          { url: "https://b.test/t", json: { texts: ["hello world "] } },
          { url: "https://c.test/t", json: { texts: ["Hi"] } },
          failing("d"),
        ],
      }),
    );
    const r = await s.invoker.invoke({ contract: "translate", input: text(), strategy: "vote", engines: ["test/c", "test/a", "test/b", "test/d"] });
    expect(r).toMatchObject({ ok: true, engine: "test/a", output: { texts: ["Hello  world"] } });
    expect(r.confidence).toBeCloseTo(2 / 3);
    expect(r.results).toHaveLength(4);
  });

  it("breaks ties by engine order", async () => {
    const s = use(
      setup([chooser("p"), chooser("q")], {
        routes: [
          { url: "https://p.test/q", json: { choice: "a", confidence: 1 } },
          { url: "https://q.test/q", json: { choice: "b", confidence: 1 } },
        ],
      }),
    );
    const r = await s.invoker.invoke({ contract: "choose", input: q, strategy: "vote", engines: ["test/q", "test/p"] });
    expect(r).toMatchObject({ engine: "test/q", output: { choice: "b" }, confidence: 0.5 });
  });
});

describe("the caller's signal (R6.1)", () => {
  it("keeps no listener on it once a parallel call has finished", async () => {
    const s = use(setup([translator("a"), translator("b")], { routes: [translates("a"), translates("b")] }));
    const ctrl = new AbortController();
    let live = 0;
    const add = ctrl.signal.addEventListener.bind(ctrl.signal);
    const remove = ctrl.signal.removeEventListener.bind(ctrl.signal);
    ctrl.signal.addEventListener = ((...a: Parameters<typeof add>) => (live++, add(...a))) as typeof add;
    ctrl.signal.removeEventListener = ((...a: Parameters<typeof remove>) => (live--, remove(...a))) as typeof remove;
    for (const strategy of ["all", "race", "vote"] as const) {
      const r = await s.invoker.invoke({ contract: "translate", input: text(strategy), strategy, engines: ["test/a", "test/b"] }, { signal: ctrl.signal });
      expect(r.ok).toBe(true);
    }
    expect(live).toBe(0);
  });
});
