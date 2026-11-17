import { afterEach, describe, expect, it, vi } from "vitest";
import { installGmHttp, type FakeGm } from "../../../test/fakes/gm-http";
import { HttpFailure, httpRequest } from "../../platform/http";

let fake: FakeGm | undefined;
const g = globalThis as Record<string, unknown>;
afterEach(() => {
  fake?.restore();
  fake = undefined;
  delete g.GM_xmlhttpRequest;
  vi.useRealTimers();
});

/** A signal whose abort listeners can be counted. */
function countedSignal() {
  const ctrl = new AbortController();
  let live = 0;
  const add = ctrl.signal.addEventListener.bind(ctrl.signal);
  const remove = ctrl.signal.removeEventListener.bind(ctrl.signal);
  ctrl.signal.addEventListener = ((...a: Parameters<typeof add>) => (live++, add(...a))) as typeof add;
  ctrl.signal.removeEventListener = ((...a: Parameters<typeof remove>) => (live--, remove(...a))) as typeof remove;
  return { ctrl, live: () => live };
}

const SSE = "data: one\n\ndata: two\n\ndata: three\n\n";

describe("platform http over GM_xmlhttpRequest", () => {
  it("sends method, headers and body, and parses status and headers", async () => {
    fake = installGmHttp([
      { method: "POST", url: "https://a.test/x", status: 201, headers: { "Content-Type": "text/plain" }, body: "hello" },
    ]);
    const res = await httpRequest({ method: "POST", url: "https://a.test/x", headers: { "X-A": "1" }, body: "{}" });
    expect(res).toMatchObject({ status: 201, text: "hello", headers: { "content-type": "text/plain" } });
    expect(fake.calls).toEqual([expect.objectContaining({ method: "POST", data: "{}", headers: { "X-A": "1" } })]);
  });

  it("streams chunks from a stream that closes when the body ends (Tampermonkey)", async () => {
    fake = installGmHttp([{ url: "https://a.test/s", body: SSE }], { chunkSize: 8, stream: "closing" });
    const chunks: string[] = [];
    const res = await httpRequest({ method: "GET", url: "https://a.test/s", stream: true }, { onChunk: (c) => chunks.push(c) });
    expect(chunks.join("")).toBe(SSE);
    expect(res).toMatchObject({ status: 200, text: SSE, chunks: chunks.length });
  });

  it("streams chunks from ScriptCat's ReadableStream, which is never closed", async () => {
    fake = installGmHttp([{ url: "https://a.test/s", body: SSE }], { chunkSize: 8 });
    const chunks: string[] = [];
    const res = await httpRequest({ method: "GET", url: "https://a.test/s", stream: true }, { onChunk: (c) => chunks.push(c) });
    expect(fake.calls[0]!.responseType).toBe("stream");
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.join("")).toBe(SSE);
    expect(res).toMatchObject({ status: 200, text: SSE, chunks: chunks.length });
  });

  it("falls back to the whole responseText when the stream response type is not usable", async () => {
    fake = installGmHttp([{ url: "https://a.test/s", body: SSE }], { stream: "fallback" });
    const chunks: string[] = [];
    const res = await httpRequest({ method: "GET", url: "https://a.test/s", stream: true }, { onChunk: (c) => chunks.push(c) });
    expect(chunks).toEqual([SSE]);
    expect(res.text).toBe(SSE);
  });

  it("reads a text response once it is complete (ScriptCat gives no text before readyState 4)", async () => {
    fake = installGmHttp([{ url: "https://a.test/t", body: "x".repeat(200) }], { chunkSize: 64 });
    const chunks: string[] = [];
    const res = await httpRequest({ method: "GET", url: "https://a.test/t" }, { onChunk: (c) => chunks.push(c) });
    expect(chunks).toEqual(["x".repeat(200)]);
    expect(res).toMatchObject({ status: 200, text: "x".repeat(200), chunks: 1 });
  });

  it("reports progress chunks when the GM implementation offers the text so far", async () => {
    g.GM_xmlhttpRequest = (d: { onprogress?: (r: object) => void; onload?: (r: object) => void }) => {
      const head = { status: 200, finalUrl: "https://a.test/t", responseHeaders: "" };
      setTimeout(() => {
        d.onprogress?.({ ...head, readyState: 3, responseText: "ab" });
        d.onprogress?.({ ...head, readyState: 3, responseText: "abcd" });
        d.onload?.({ ...head, readyState: 4, responseText: "abcde" });
      }, 0);
      return { abort() {} };
    };
    const chunks: string[] = [];
    const res = await httpRequest({ method: "GET", url: "https://a.test/t" }, { onChunk: (c) => chunks.push(c) });
    expect(chunks).toEqual(["ab", "cd", "e"]);
    expect(res.chunks).toBe(3);
  });

  it("rejects network errors and timeouts as HttpFailure", async () => {
    fake = installGmHttp([
      { url: "https://a.test/n", error: "network" },
      { url: "https://a.test/t", error: "timeout" },
      { url: "https://a.test/h", error: "hang" },
    ]);
    await expect(httpRequest({ method: "GET", url: "https://a.test/n" })).rejects.toMatchObject({ kind: "network" });
    await expect(httpRequest({ method: "GET", url: "https://a.test/t" })).rejects.toMatchObject({ kind: "timeout" });
    const hung = httpRequest({ method: "GET", url: "https://a.test/h", timeoutMs: 20 });
    await expect(hung).rejects.toBeInstanceOf(HttpFailure);
    await expect(hung).rejects.toMatchObject({ kind: "timeout" });
  });

  it("aborts with the signal's reason", async () => {
    fake = installGmHttp([{ url: "https://a.test/h", error: "hang" }]);
    const ctrl = new AbortController();
    const p = httpRequest({ method: "GET", url: "https://a.test/h", signal: ctrl.signal });
    ctrl.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });

  it("settles a synchronous onerror as network and leaves no timer or abort listener behind", async () => {
    vi.useFakeTimers();
    g.GM_xmlhttpRequest = (d: { onerror?: (e: unknown) => void }) => (d.onerror?.({ error: "refused" }), { abort() {} });
    const s = countedSignal();
    await expect(httpRequest({ method: "GET", url: "https://a.test/x", timeoutMs: 1000, signal: s.ctrl.signal })).rejects.toMatchObject({
      kind: "network",
      message: "refused",
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(s.live()).toBe(0);
  });

  it("settles a GM_xmlhttpRequest that throws as network", async () => {
    vi.useFakeTimers();
    g.GM_xmlhttpRequest = () => {
      throw new Error("bad details");
    };
    const s = countedSignal();
    const err = await httpRequest({ method: "GET", url: "https://a.test/x", timeoutMs: 1000, signal: s.ctrl.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpFailure);
    expect(err).toMatchObject({ kind: "network", message: "bad details" });
    expect(vi.getTimerCount()).toBe(0);
    expect(s.live()).toBe(0);
  });

  it("cancels the response stream when aborted mid-stream", async () => {
    const cancel = vi.fn();
    const enc = new TextEncoder();
    g.GM_xmlhttpRequest = (d: { onloadstart?: (r: object) => void }) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode("data: one\n\n"));
        },
        cancel,
      });
      setTimeout(() => d.onloadstart?.({ status: 200, finalUrl: "https://a.test/s", responseHeaders: "", response: body }), 0);
      return { abort() {} };
    };
    const ctrl = new AbortController();
    const chunks: string[] = [];
    const p = httpRequest(
      { method: "GET", url: "https://a.test/s", stream: true, signal: ctrl.signal },
      { onChunk: (c) => (chunks.push(c), ctrl.abort(new Error("stop"))) },
    );
    await expect(p).rejects.toThrow("stop");
    expect(chunks).toEqual(["data: one\n\n"]);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  });

  it("fails as network, and stops the request, when the stream it was given cannot be read", async () => {
    let aborted = 0;
    g.GM_xmlhttpRequest = (d: { onreadystatechange?: (r: object) => void }) => {
      const body = new ReadableStream<Uint8Array>();
      body.getReader(); // someone else holds the lock
      setTimeout(() => d.onreadystatechange?.({ status: 200, finalUrl: "https://a.test/s", responseHeaders: "", response: body }), 0);
      return { abort: () => void aborted++ };
    };
    const p = httpRequest({ method: "GET", url: "https://a.test/s", stream: true, timeoutMs: 2000 });
    await expect(p).rejects.toMatchObject({ kind: "network" });
    expect(aborted).toBe(1);
  });

  describe("ScriptCat 1.5.2 stream semantics", () => {
    it("a 401 on a stream resolves promptly with its status and body", async () => {
      const body = JSON.stringify({ error: { message: "Incorrect API key provided" } });
      fake = installGmHttp([{ url: "https://a.test/s", status: 401, headers: { "content-type": "application/json" }, body }]);
      const heads: number[] = [];
      const started = Date.now();
      const res = await httpRequest({ method: "POST", url: "https://a.test/s", stream: true, timeoutMs: 30_000 }, { onHead: (h) => heads.push(h.status) });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(heads).toEqual([401]);
      expect(res).toMatchObject({ status: 401, text: body, headers: { "content-type": "application/json" } });
    });

    it("keeps the whole text when the chunks are still queued at onload", async () => {
      fake = installGmHttp([{ url: "https://a.test/s", body: SSE.repeat(20) }], { chunkSize: 3, burst: true });
      const res = await httpRequest({ method: "GET", url: "https://a.test/s", stream: true }, { onChunk: () => {} });
      expect(res.text).toBe(SSE.repeat(20));
    });

    it("times out a stream that never ends and stops the request", async () => {
      fake = installGmHttp([{ url: "https://a.test/s", body: "data: one\n\n", stall: true }]);
      const chunks: string[] = [];
      const p = httpRequest({ method: "GET", url: "https://a.test/s", stream: true, timeoutMs: 50 }, { onChunk: (c) => chunks.push(c) });
      await expect(p).rejects.toMatchObject({ kind: "timeout" });
      expect(chunks).toEqual(["data: one\n\n"]);
      expect(fake.aborted).toBe(1);
      // ScriptCat's fetch strategy turns its own timeout into a normal load with a cut-off body,
      // so the timeout of a stream is never handed to it.
      expect(fake.calls[0]!.timeout).toBeUndefined();
    });

    it("aborts a stream mid-way with the signal's reason", async () => {
      fake = installGmHttp([{ url: "https://a.test/s", body: "data: one\n\n", stall: true }]);
      const ctrl = new AbortController();
      const p = httpRequest(
        { method: "GET", url: "https://a.test/s", stream: true, signal: ctrl.signal },
        { onChunk: () => ctrl.abort(new Error("stop")) },
      );
      await expect(p).rejects.toThrow("stop");
      expect(fake.aborted).toBe(1);
    });
  });

  it("fails as network when GM_xmlhttpRequest is not granted", async () => {
    await expect(httpRequest({ method: "GET", url: "https://a.test/x" })).rejects.toMatchObject({ kind: "network" });
  });
});
