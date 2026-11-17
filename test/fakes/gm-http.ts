/**
 * A fake GM_xmlhttpRequest that replays recorded responses (test/fixtures/recorded/*.json),
 * plus a fetch-backed one for live smoke tests. Both install onto globalThis, which is where
 * src/platform/http.ts looks the GM API up.
 *
 * The replay follows what ScriptCat 1.5.2 hands a content script (src/app/service/content/gm_api/
 * gm_xhr.ts, fed by src/pkg/utils/xhr/bg_gm_xhr.ts and fetch_xhr.ts):
 *
 * - `responseType: "stream"` (fetch strategy): onloadstart (readyState 1, status 0) → onreadystatechange
 *   (readyState 2, status and headers) → per chunk: enqueue + onprogress (readyState 3) →
 *   onreadystatechange (4) → onload → onloadend. `response` is the same ReadableStream on every
 *   callback, `responseText` is undefined (onloadend: ""). ScriptCat never closes that stream: at
 *   readyState 4 it only drops its controller (gm_xhr.ts "controller = undefined"), so a reader
 *   waiting for `done` waits forever. A 401 takes the same path; its body comes through the stream.
 * - any other response type (XHR strategy): onreadystatechange (1) → onloadstart → onreadystatechange
 *   (2, 3) → onprogress without response or responseText (they appear only at readyState 4) →
 *   onreadystatechange (4) → onload → onloadend.
 * - errors: onerror / ontimeout, then onloadend. abort(): onabort (status 0) and then onloadend, only
 *   when an onabort callback was given; afterwards nothing else fires.
 * - response, responseText and responseXML are non-enumerable getters, as in ScriptCat (spreading the
 *   response object drops them).
 */
import { readFileSync } from "node:fs";

export interface Recorded {
  method?: string;
  /** Exact URL, or a RegExp tested against the full URL. */
  url: string | RegExp;
  status?: number;
  headers?: Record<string, string>;
  /** Raw body; `json` is stringified instead when given. */
  body?: string;
  json?: unknown;
  /** The URL the answer came from after redirects (default: the request URL). */
  finalUrl?: string;
  /** Fail the request instead of answering; "hang" never answers (no headers either). */
  error?: "network" | "timeout" | "hang";
  /** Send the headers and the body, then keep the connection open: the response never ends. */
  stall?: boolean;
  /** The server answers only once this settles (to look at a request while it is in flight). */
  wait?: Promise<unknown>;
  /** Answer every matching request; otherwise the exchange is used once. */
  repeat?: boolean;
  /** Computes the answer from the request. */
  respond?: (req: SentRequest) => Omit<Recorded, "url" | "method" | "respond" | "repeat" | "wait">;
}

export interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  data?: string;
  responseType?: string;
  timeout?: number;
}

export interface FakeGm {
  /** Every request sent, in order. */
  calls: SentRequest[];
  /** Requests no recorded exchange matched (answered with a network error). */
  unmatched: SentRequest[];
  /** How many requests were aborted through the handle GM_xmlhttpRequest returned. */
  aborted: number;
  add(...routes: Recorded[]): void;
  restore(): void;
}

export interface FakeOptions {
  /**
   * How `responseType: "stream"` behaves:
   * - "scriptcat" (default): ScriptCat 1.5.2 — a ReadableStream that is never closed, completion only
   *   through onload / onloadend;
   * - "closing": like "scriptcat", but the stream is closed after the last chunk (Tampermonkey);
   * - "fallback": the stream type is not supported and the request behaves like a text request.
   */
  stream?: "scriptcat" | "closing" | "fallback";
  /** Bytes per delivered chunk (stream and onprogress). */
  chunkSize?: number;
  /**
   * Deliver a stream's chunks and its onload back to back in one task, as ScriptCat does when the
   * messages queue up: the chunks are enqueued but not yet read when onload fires.
   */
  burst?: boolean;
}

type Callback = (r: object) => void;
type Details = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  responseType?: string;
  timeout?: number;
  onloadstart?: Callback;
  onreadystatechange?: Callback;
  onprogress?: Callback;
  onload?: Callback;
  onloadend?: Callback;
  onerror?: Callback;
  ontimeout?: Callback;
  onabort?: Callback;
};

const FIXTURES = new URL("../fixtures/recorded/", import.meta.url);

/** The exchanges of a recorded fixture. */
export function recording(name: string): Recorded[] {
  const file = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")) as { exchanges: Recorded[] };
  return file.exchanges;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function headerText(h: Record<string, string> = {}): string {
  return Object.entries(h)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
}

function matches(r: Recorded, req: SentRequest): boolean {
  if (r.method && r.method.toUpperCase() !== req.method) return false;
  return typeof r.url === "string" ? r.url === req.url : r.url.test(req.url);
}

function bytesOf(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

/** A ScriptCat-style response object: plain fields plus non-enumerable response getters. */
function responseObject(fields: Record<string, unknown>, body?: { response: () => unknown; responseText: () => unknown }): object {
  const o = Object.create(null) as Record<string, unknown>;
  Object.assign(o, fields);
  if (body) {
    Object.defineProperty(o, "response", { get: body.response, enumerable: false });
    Object.defineProperty(o, "responseText", { get: body.responseText, enumerable: false });
    Object.defineProperty(o, "responseXML", { get: () => undefined, enumerable: false });
  }
  return o;
}

export function installGmHttp(routes: Recorded[] = [], opts: FakeOptions = {}): FakeGm {
  const g = globalThis as Record<string, unknown>;
  const previous = g.GM_xmlhttpRequest;
  const pending = [...routes];
  const size = opts.chunkSize ?? 64;
  const fake: FakeGm = {
    calls: [],
    unmatched: [],
    aborted: 0,
    add: (...r) => void pending.push(...r),
    restore: () => {
      if (previous === undefined) delete g.GM_xmlhttpRequest;
      else g.GM_xmlhttpRequest = previous;
    },
  };

  g.GM_xmlhttpRequest = (d: Details) => {
    const req: SentRequest = {
      method: (d.method ?? "GET").toUpperCase(),
      url: String(d.url),
      headers: { ...d.headers },
      data: d.data,
      responseType: d.responseType,
      timeout: d.timeout,
    };
    fake.calls.push(req);
    const i = pending.findIndex((r) => matches(r, req));
    const route = i < 0 ? undefined : pending[i];
    if (route && !route.repeat) pending.splice(i, 1);

    // ScriptCat's reqDone: after an error, a timeout, an abort or loadend nothing else fires.
    let done = false;
    let loadend: (() => void) | undefined;
    const end = () => {
      if (loadend) {
        const f = loadend;
        loadend = undefined;
        f();
      }
    };
    const streamMode = d.responseType === "stream" && opts.stream !== "fallback";
    let gmTimer: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
      await tick();
      if (done) return;
      if (!route) {
        fake.unmatched.push(req);
        done = true;
        d.onerror?.(responseObject({ readyState: 4, status: 0, error: `no recorded response for ${req.method} ${req.url}` }));
        d.onloadend?.(responseObject({ readyState: 4, status: 0 }));
        return;
      }
      if (route.wait) await route.wait;
      if (done) return;
      const ans = route.respond ? route.respond(req) : route;
      const base = { finalUrl: ans.finalUrl ?? req.url, statusText: "", responseHeaders: headerText(ans.headers) };
      const status = ans.status ?? 200;
      const text = ans.json !== undefined ? JSON.stringify(ans.json) : (ans.body ?? "");

      if (streamMode) {
        let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start: (c) => void (ctrl = c),
        });
        let responseText: string | undefined;
        const body = { response: () => stream, responseText: () => responseText };
        const ev = (readyState: number, s: number, extra: Record<string, unknown> = {}) =>
          responseObject({ ...base, ...(s ? {} : { finalUrl: "", responseHeaders: "" }), readyState, status: s, responseType: "stream", ...extra }, body);
        loadend = () => {
          responseText = "";
          d.onloadend?.(ev(4, status));
        };
        const finish = () => {
          d.onreadystatechange?.(ev(4, status));
          d.onload?.(ev(4, status));
          done = true;
          end();
        };
        d.onloadstart?.(ev(1, 0));
        await tick();
        if (done) return;
        if (ans.error) return void fail(ans.error);
        d.onreadystatechange?.(ev(2, status));
        let loaded = 0;
        for (const part of bytesOf(text, size)) {
          if (!opts.burst) await tick();
          if (done) return;
          ctrl?.enqueue(part);
          loaded += part.byteLength;
          d.onprogress?.(ev(3, status, { loaded, total: -1, lengthComputable: false }));
        }
        if (opts.stream === "closing") ctrl?.close();
        if (ans.stall) {
          // fetch_xhr.ts: a `timeout` aborts the body read, which ends the request as a normal load
          if (d.timeout) gmTimer = setTimeout(() => !done && finish(), d.timeout);
          return;
        }
        if (!opts.burst) await tick();
        if (!done) finish();
        return;
      }

      // the XHR strategy: no response before readyState 4
      let full: string | undefined;
      const body = { response: () => full, responseText: () => full };
      const ev = (readyState: number, s: number, extra: Record<string, unknown> = {}) =>
        responseObject({ ...base, ...(s ? {} : { finalUrl: "", responseHeaders: "" }), readyState, status: s, ...extra }, readyState === 4 ? body : undefined);
      loadend = () => d.onloadend?.(ev(4, status));
      d.onreadystatechange?.(ev(1, 0));
      d.onloadstart?.(ev(1, 0));
      if (ans.error) return void fail(ans.error);
      if (d.timeout) gmTimer = setTimeout(() => fail("timeout"), d.timeout);
      await tick();
      if (done) return;
      d.onreadystatechange?.(ev(2, status));
      d.onreadystatechange?.(ev(3, status));
      let loaded = 0;
      for (const part of bytesOf(text, size)) {
        await tick();
        if (done) return;
        loaded += part.byteLength;
        d.onprogress?.(ev(3, status, { loaded, total: text.length, lengthComputable: true }));
      }
      if (ans.stall) return;
      await tick();
      if (done) return;
      clearTimeout(gmTimer);
      full = text;
      d.onreadystatechange?.(ev(4, status));
      d.onload?.(ev(4, status));
      done = true;
      end();
    })();

    function fail(kind: "network" | "timeout" | "hang") {
      if (kind === "hang" || done) return;
      done = true;
      clearTimeout(gmTimer);
      if (kind === "network") d.onerror?.(responseObject({ readyState: 4, status: 0, error: "net::ERR_CONNECTION_RESET" }));
      else d.ontimeout?.(responseObject({ readyState: 4, status: 0 }));
      end();
    }

    return {
      abort: () => {
        fake.aborted++;
        clearTimeout(gmTimer);
        if (done) return;
        done = true;
        if (!d.onabort) return;
        d.onabort(responseObject({ error: "aborted", readyState: 0, status: 0, statusText: "", responseHeaders: "", response: null, responseText: "" }));
        void Promise.resolve().then(end);
      },
    };
  };
  return fake;
}

/** A GM_xmlhttpRequest backed by fetch, for live smoke tests. Supports responseType "stream". */
export function installFetchGm(): { restore(): void } {
  const g = globalThis as Record<string, unknown>;
  const previous = g.GM_xmlhttpRequest;
  g.GM_xmlhttpRequest = (d: Details) => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch(d.url, { method: d.method ?? "GET", headers: d.headers, body: d.data, signal: ctrl.signal });
        const head = {
          status: res.status,
          statusText: res.statusText,
          finalUrl: res.url,
          responseHeaders: headerText(Object.fromEntries(res.headers.entries())),
        };
        if (d.responseType === "stream") return void d.onloadstart?.({ ...head, readyState: 2, response: res.body });
        const text = await res.text();
        d.onload?.({ ...head, readyState: 4, responseText: text, response: text });
      } catch (e) {
        if (!ctrl.signal.aborted) d.onerror?.({ error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return { abort: () => (ctrl.abort(), d.onabort?.({})) };
  };
  return {
    restore: () => {
      if (previous === undefined) delete g.GM_xmlhttpRequest;
      else g.GM_xmlhttpRequest = previous;
    },
  };
}
