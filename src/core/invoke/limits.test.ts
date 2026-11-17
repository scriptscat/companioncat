import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LimitsDef } from "../rules";
import { chatter, hello, setup, sse, text, translates, translator, type Setup } from "./fixtures";
import { DEFAULT_TIMEOUT_MS, RETRY_DELAY_MS, type InvokeDelta, type InvokeResult } from "./index";

let current: Setup | undefined;
const use = (s: Setup) => ((current = s), s);
beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  current?.fake.restore();
  current = undefined;
  vi.useRealTimers();
});

const limited = (limits: LimitsDef) => translator("a", { limits });
const req = (t = "hello") => ({ contract: "translate", input: text(t), engines: ["test/a"] });
const hang = { url: "https://a.test/t", error: "hang" as const };
const status = (code: number) => ({ url: "https://a.test/t", status: code, json: {} });

/** Tracks when a pending invoke settles. */
function track(p: Promise<InvokeResult>) {
  const box: { result?: InvokeResult } = {};
  void p.then((r) => (box.result = r));
  return box;
}

describe("timeout (R5.1 limits.timeoutMs)", () => {
  it("fails with timeout once the engine's limit passes", async () => {
    const s = use(setup([limited({ timeoutMs: 1000 })], { routes: [hang] }));
    const box = track(s.invoker.invoke(req()));
    await vi.advanceTimersByTimeAsync(999);
    expect(box.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(box.result?.error?.type).toBe("timeout");
  });

  it("falls back to a default timeout", async () => {
    const s = use(setup([translator("a")], { routes: [hang] }));
    const box = track(s.invoker.invoke(req()));
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
    expect(box.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(box.result?.error?.type).toBe("timeout");
  });
});

describe("retry (R5.1 limits.retry)", () => {
  it("retries the listed error types with growing delays, up to max", async () => {
    const s = use(setup([limited({ retry: { on: ["server"], max: 2 } })], { routes: [status(503), status(502), translates("a")] }));
    const box = track(s.invoker.invoke(req()));
    await vi.advanceTimersByTimeAsync(10);
    expect(s.fake.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(s.fake.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(s.fake.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(s.fake.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(box.result).toMatchObject({ ok: true, output: { texts: ["a:hello"] } });
    expect(s.invoker.usage()).toHaveLength(1);
  });

  it("gives up after max retries with the last error", async () => {
    const s = use(setup([limited({ retry: { on: ["server"], max: 1 } })], { routes: [status(503), status(500), translates("a")] }));
    const box = track(s.invoker.invoke(req()));
    await vi.advanceTimersByTimeAsync(10 * RETRY_DELAY_MS);
    expect(s.fake.calls).toHaveLength(2);
    expect(box.result?.error?.type).toBe("server");
  });

  it("does not retry other types, or without retry limits", async () => {
    const s = use(setup([limited({ retry: { on: ["server"], max: 3 } })], { routes: [status(401), status(503)] }));
    const box = track(s.invoker.invoke(req()));
    await vi.advanceTimersByTimeAsync(10 * RETRY_DELAY_MS);
    expect(box.result?.error?.type).toBe("auth");
    expect(s.fake.calls).toHaveLength(1);

    s.rules.providers[0] = translator("a");
    const again = track(s.invoker.invoke(req("x")));
    await vi.advanceTimersByTimeAsync(10 * RETRY_DELAY_MS);
    expect(again.result?.error?.type).toBe("server");
    expect(s.fake.calls).toHaveLength(2);
  });

  it("R6.3: a type that is fixed as not retryable is never retried, even when a rule lists it", async () => {
    const s = use(setup([limited({ retry: { on: ["auth", "server"], max: 3 } })], { routes: [status(401), translates("a")] }));
    const box = track(s.invoker.invoke(req()));
    await vi.advanceTimersByTimeAsync(10 * RETRY_DELAY_MS);
    expect(box.result?.error?.type).toBe("auth");
    expect(s.fake.calls).toHaveLength(1);
  });

  it("numbers streamed attempts so a retry restarts the text", async () => {
    const s = use(
      setup([chatter("x", { limits: { retry: { on: ["server"], max: 1 } } })], {
        routes: [
          { url: "https://x.test/c", status: 500, body: "" },
          { url: "https://x.test/c", body: sse("o", "k") },
        ],
      }),
    );
    const deltas: InvokeDelta[] = [];
    const box = track(s.invoker.invoke({ contract: "chat", input: hello, engines: ["test/x"], stream: true }, { onDelta: (d) => deltas.push(d) }));
    await vi.advanceTimersByTimeAsync(2 * RETRY_DELAY_MS);
    expect(box.result?.output).toEqual({ text: "ok" });
    expect(deltas).toEqual([
      { engine: "test/x", text: "o", full: "o", attempt: 2 },
      { engine: "test/x", text: "k", full: "ok", attempt: 2 },
    ]);
  });
});

describe("rate limits (R5.1 limits.concurrency / perMinute)", () => {
  it("runs at most `concurrency` requests of an engine at once", async () => {
    const s = use(setup([limited({ concurrency: 1, timeoutMs: 5000 })], { routes: [hang, translates("a")] }));
    const one = track(s.invoker.invoke(req("1")));
    const two = track(s.invoker.invoke(req("2")));
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.fake.calls).toHaveLength(1);
    expect(two.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    expect(one.result?.error?.type).toBe("timeout");
    expect(s.fake.calls).toHaveLength(2);
    expect(two.result).toMatchObject({ ok: true });
  });

  it("waits when the engine's per-minute budget is used up", async () => {
    const s = use(setup([limited({ perMinute: 2 })], { routes: [translates("a")] }));
    const boxes = ["1", "2", "3"].map((t) => track(s.invoker.invoke(req(t))));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(s.fake.calls).toHaveLength(2);
    expect(boxes[2]!.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.fake.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(boxes.map((b) => b.result?.ok)).toEqual([true, true, true]);
  });

  it("does not spend the budget on cache hits", async () => {
    const s = use(setup([limited({ perMinute: 1, concurrency: 1 })], { routes: [translates("a")] }));
    const first = track(s.invoker.invoke(req()));
    await vi.advanceTimersByTimeAsync(10);
    expect(first.result?.ok).toBe(true);
    const hit = track(s.invoker.invoke(req()));
    await vi.advanceTimersByTimeAsync(0);
    expect(hit.result).toMatchObject({ ok: true, cached: true });
  });

  it("drops a queued call that is cancelled", async () => {
    const s = use(setup([limited({ concurrency: 1, timeoutMs: 5000 })], { routes: [hang, translates("a")] }));
    void s.invoker.invoke(req("1"));
    const ctrl = new AbortController();
    const queued = s.invoker.invoke(req("2"), { signal: ctrl.signal });
    const third = track(s.invoker.invoke(req("3")));
    await vi.advanceTimersByTimeAsync(10);
    ctrl.abort(new Error("gone"));
    await expect(queued).rejects.toThrow("gone");
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.fake.calls.map((c) => JSON.parse(c.data!).texts[0])).toEqual(["1", "3"]);
    expect(third.result?.ok).toBe(true);
  });
});
