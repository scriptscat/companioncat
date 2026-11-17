import { afterEach, describe, expect, it } from "vitest";
import { chatter, hello, setup, sse, text, translates, translator, type Setup } from "./fixtures";
import { CACHE_SIZE, createResultCache } from "./cache";

let current: Setup | undefined;
const use = (s: Setup) => ((current = s), s);
afterEach(() => {
  current?.fake.restore();
  current = undefined;
});

describe("result cache (R6.4)", () => {
  it("holds at most 5000 entries by default", () => {
    expect(CACHE_SIZE).toBe(5000);
    const cache = createResultCache();
    for (let i = 0; i < 5001; i++) cache.set(`k${i}`, i);
    expect(cache.stats().entries).toBe(5000);
    expect(cache.get("k0")).toBeUndefined();
    expect(cache.get("k5000")).toEqual({ value: 5000 });
  });

  it("evicts the least recently used entry and estimates its size", () => {
    const cache = createResultCache(2);
    cache.set("a", { texts: ["x"] });
    cache.set("b", 2);
    expect(cache.get("a")).toEqual({ value: { texts: ["x"] } });
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.stats()).toEqual({ entries: 2, bytes: 2 * ("a".length + '{"texts":["x"]}'.length + "c".length + "3".length) });
    cache.clear();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });
});

describe("invoke caching (R6.4)", () => {
  const req = (engines = ["test/a"], input = text()) => ({ contract: "translate", input, engines });

  it("serves a repeated translation from the cache, marked cached", async () => {
    const s = use(setup([translator("a")], { routes: [translates("a")] }));
    const first = await s.invoker.invoke(req());
    const again = await s.invoker.invoke(req());
    expect(first).toMatchObject({ ok: true, cached: false });
    expect(again).toMatchObject({ ok: true, cached: true, output: first.output });
    expect(again.results[0]).toMatchObject({ engine: "test/a", ok: true, cached: true });
    expect(s.fake.calls).toHaveLength(1);
    expect(s.invoker.cacheStats()).toEqual({ entries: 1, bytes: expect.any(Number) });
  });

  it("keys by engine, effective options and input", async () => {
    const tone = { type: "string" as const, default: "plain" };
    const p = translator("a", { options: { tone, unused: { type: "string" } } });
    const s = use(setup([p, translator("b")], { routes: [translates("a"), translates("b")] }));
    await s.invoker.invoke(req());
    await s.invoker.invoke(req(["test/b"]));
    await s.invoker.invoke(req(["test/a"], text("other")));
    await s.invoker.invoke({ contract: "translate", input: { to: "zh-CN", texts: ["hello"] }, engines: ["test/a"] });
    expect(s.fake.calls).toHaveLength(3);
    tone.default = "formal"; // what a local override of the option does to the resolved engine
    expect((await s.invoker.invoke(req())).cached).toBe(false);
    expect(s.fake.calls).toHaveLength(4);
  });

  it("caches only successful translate results", async () => {
    const s = use(
      setup([translator("a"), chatter("c")], {
        routes: [{ url: "https://a.test/t", status: 503 }, translates("a"), { url: "https://c.test/c", body: sse("x"), repeat: true }],
      }),
    );
    expect((await s.invoker.invoke(req())).ok).toBe(false);
    expect((await s.invoker.invoke(req())).cached).toBe(false);
    await s.invoker.invoke({ contract: "chat", input: hello, engines: ["test/c"] });
    expect((await s.invoker.invoke({ contract: "chat", input: hello, engines: ["test/c"] })).cached).toBe(false);
    expect(s.invoker.cacheStats().entries).toBe(1);
  });

  it("can be cleared", async () => {
    const s = use(setup([translator("a")], { routes: [translates("a")] }));
    await s.invoker.invoke(req());
    s.invoker.clearCache();
    expect(s.invoker.cacheStats()).toEqual({ entries: 0, bytes: 0 });
    expect((await s.invoker.invoke(req())).cached).toBe(false);
  });
});
