import { describe, expect, it, vi } from "vitest";
import { CallError } from "../../core/errors";
import type { InvokeRequest, InvokeResult } from "../../core/invoke";
import { splitBatches, translateBlocks, type BatchResult } from "./batch";
import type { Block } from "./blocks";
import { keyedTranslator, setup, translates, translator } from "../../core/invoke/fixtures";

const block = (text: string): Block => ({ el: { tagName: "P" } as unknown as Element, text });
const blocks = (...t: string[]) => t.map(block);

type Call = { req: InvokeRequest; signal?: AbortSignal };

/** Stub invoker: answers "<to>:<text>" unless `fail` says otherwise for that call. */
function stub(fail: (texts: string[], n: number) => CallError | undefined = () => undefined) {
  const calls: Call[] = [];
  const invoke = vi.fn(async (req: InvokeRequest, opts?: { signal?: AbortSignal }): Promise<InvokeResult> => {
    calls.push({ req, signal: opts?.signal });
    const { texts, to } = req.input as { texts: string[]; to: string };
    const error = fail(texts, calls.length - 1);
    if (error) return { ok: false, strategy: "first", contract: "translate", error, results: [] };
    return {
      ok: true,
      strategy: "first",
      contract: "translate",
      output: { texts: texts.map((t) => `${to}:${t}`) },
      cached: false,
      results: [],
    };
  });
  return { invoker: { invoke } as never, calls, invoke };
}

describe("splitBatches", () => {
  it("splits by item count", () => {
    const out = splitBatches(blocks("aaa", "bbb", "ccc", "ddd", "eee"), { maxItems: 2, maxChars: 1000 });
    expect(out.map((b) => b.map((x) => x.text))).toEqual([["aaa", "bbb"], ["ccc", "ddd"], ["eee"]]);
  });
  it("splits by total characters", () => {
    const out = splitBatches(blocks("aaaa", "bbbb", "cccc"), { maxItems: 10, maxChars: 8 });
    expect(out.map((b) => b.length)).toEqual([2, 1]);
  });
  it("puts an oversized block alone instead of dropping it", () => {
    const out = splitBatches(blocks("a", "x".repeat(50), "b"), { maxItems: 10, maxChars: 10 });
    expect(out.map((b) => b.map((x) => x.text.length))).toEqual([[1], [50], [1]]);
  });
  it("returns nothing for no blocks", () => {
    expect(splitBatches([], { maxItems: 2, maxChars: 10 })).toEqual([]);
  });
});

describe("translateBlocks", () => {
  const opts = { engine: "official/bing", to: "zh", maxItems: 2, maxChars: 1000 };

  it("calls the shared invoker once per batch with translate/first/engine and maps texts back", async () => {
    const bs = blocks("one", "two", "three");
    const { invoker, calls } = stub();
    const results = await translateBlocks(bs, opts, invoker);
    expect(calls.map((c) => c.req)).toEqual([
      { contract: "translate", input: { texts: ["one", "two"], to: "zh" }, strategy: "first", engines: ["official/bing"] },
      { contract: "translate", input: { texts: ["three"], to: "zh" }, strategy: "first", engines: ["official/bing"] },
    ]);
    expect(results).toHaveLength(2);
    const r0 = results[0]!;
    expect(r0.ok && r0.items.map((i) => [i.block, i.text])).toEqual([
      [bs[0], "zh:one"],
      [bs[1], "zh:two"],
    ]);
    const r1 = results[1]!;
    expect(r1.ok && r1.items[0]).toEqual({ block: bs[2], text: "zh:three" });
  });

  it("reports each batch through onBatch as it settles, with its index", async () => {
    const seen: BatchResult[] = [];
    const { invoker } = stub();
    await translateBlocks(blocks("a1", "b2", "c3"), { ...opts, onBatch: (r) => seen.push(r) }, invoker);
    expect(seen.map((r) => r.index).sort()).toEqual([0, 1]);
  });

  it("delivers a finished batch before a slower one is done", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const invoke = vi.fn(async (req: InvokeRequest): Promise<InvokeResult> => {
      const { texts } = req.input as { texts: string[] };
      if (texts[0] === "slow") await gate;
      return { ok: true, strategy: "first", contract: "translate", output: { texts: texts.map((t) => `T${t}`) }, results: [] };
    });
    const seen: number[] = [];
    const p = translateBlocks(blocks("slow", "fast"), { ...opts, maxItems: 1, onBatch: (r) => seen.push(r.index) }, {
      invoke,
    } as never);
    await vi.waitFor(() => expect(seen).toEqual([1]));
    release();
    await p;
    expect(seen).toEqual([1, 0]);
  });

  it("isolates a failed batch and keeps its error type and blocks", async () => {
    const bs = blocks("one", "two", "three", "four", "five");
    const { invoker } = stub((_t, n) => (n === 1 ? new CallError("rateLimit") : undefined));
    const results = await translateBlocks(bs, opts, invoker);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    const bad = results[1]!;
    expect(!bad.ok && bad.error.type).toBe("rateLimit");
    expect(bad.blocks).toEqual([bs[2], bs[3]]);
  });

  it("tells missingKey and disabled apart", async () => {
    const { invoker } = stub((t) => new CallError(t[0] === "k" ? "missingKey" : "disabled"));
    const results = await translateBlocks(blocks("k", "d"), { ...opts, maxItems: 1 }, invoker);
    expect(results.map((r) => !r.ok && r.error.type)).toEqual(["missingKey", "disabled"]);
  });

  it("treats a wrong number of output texts as a badOutput failure", async () => {
    const invoke = vi.fn(async (): Promise<InvokeResult> => ({
      ok: true,
      strategy: "first",
      contract: "translate",
      output: { texts: ["only one"] },
      results: [],
    }));
    const [r] = await translateBlocks(blocks("aa1", "bb2"), opts, { invoke } as never);
    expect(!r!.ok && r!.error.type).toBe("badOutput");
  });

  it("turns an unexpected rejection into a failed batch, not a crash", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("boom");
    });
    const [r] = await translateBlocks(blocks("aa1"), opts, { invoke } as never);
    expect(!r!.ok && r!.error.type).toBe("server");
  });

  it("marks cached batches", async () => {
    const invoke = vi.fn(async (req: InvokeRequest): Promise<InvokeResult> => ({
      ok: true,
      strategy: "first",
      contract: "translate",
      output: { texts: (req.input as { texts: string[] }).texts },
      cached: true,
      results: [],
    }));
    const [r] = await translateBlocks(blocks("aa1"), opts, { invoke } as never);
    expect(r!.ok && r!.cached).toBe(true);
  });

  it("uses the real invoker: cache serves a repeat, missing key is told apart", async () => {
    const s = setup([translator("a"), keyedTranslator("k")], { routes: [translates("a")] });
    try {
      const o = { engine: "test/a", to: "zh-CN", maxItems: 2, maxChars: 1000 };
      const bs = blocks("one", "two", "three");
      const first = await translateBlocks(bs, o, s.invoker);
      expect(first.map((r) => r.ok && r.cached)).toEqual([false, false]);
      expect(first[0]!.ok && first[0]!.items.map((i) => i.text)).toEqual(["a:one", "a:two"]);
      const sent = s.fake.calls.length;
      const again = await translateBlocks(bs, o, s.invoker);
      expect(again.map((r) => r.ok && r.cached)).toEqual([true, true]);
      expect(s.fake.calls.length).toBe(sent);
      const nokey = await translateBlocks(bs, { ...o, engine: "test/k" }, s.invoker);
      expect(nokey.map((r) => !r.ok && r.error.type)).toEqual(["missingKey", "missingKey"]);
    } finally {
      s.fake.restore();
    }
  });

  it("passes the signal to every call and rejects with its reason once cancelled", async () => {
    const ctl = new AbortController();
    const invoke = vi.fn(async (req: InvokeRequest, o?: { signal?: AbortSignal }): Promise<InvokeResult> => {
      ctl.abort();
      if (o?.signal?.aborted) throw o.signal.reason;
      return { ok: true, strategy: "first", contract: "translate", output: { texts: [] }, results: [] };
    });
    const onBatch = vi.fn();
    await expect(
      translateBlocks(blocks("a1", "b2", "c3"), { ...opts, maxItems: 1, signal: ctl.signal, onBatch }, { invoke } as never),
    ).rejects.toBe(ctl.signal.reason);
    expect(invoke.mock.calls[0]![1]!.signal).toBe(ctl.signal);
    expect(onBatch).not.toHaveBeenCalled();
  });

  it("rejects at once when already cancelled, without calling the invoker", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { invoker, invoke } = stub();
    await expect(translateBlocks(blocks("aa1"), { ...opts, signal: ctl.signal }, invoker)).rejects.toBe(ctl.signal.reason);
    expect(invoke).not.toHaveBeenCalled();
  });
});
