/**
 * The only way companioncat talks to the network: GM_xmlhttpRequest (R5.2).
 *
 * Streaming asks for `responseType: "stream"`. In ScriptCat 1.5.2 (content gm_xhr.ts) the
 * ReadableStream it hands out is never closed: at readyState 4 it only drops its controller. So the
 * end of a stream is onload / onloadend, not the reader's `done`. Without a stream (a GM that does
 * not support the type) the whole text arrives in responseText and is delivered as one chunk.
 */

interface GmResponse {
  status?: number;
  statusText?: string;
  finalUrl?: string;
  responseHeaders?: string;
  response?: unknown;
  responseText?: string;
}

interface GmDetails {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  timeout?: number;
  responseType?: "text" | "stream";
  onloadstart?: (r: GmResponse) => void;
  onreadystatechange?: (r: GmResponse) => void;
  onprogress?: (r: GmResponse) => void;
  onload?: (r: GmResponse) => void;
  onloadend?: (r: GmResponse) => void;
  onerror?: (r: unknown) => void;
  ontimeout?: (r: unknown) => void;
  onabort?: (r: unknown) => void;
}

type GmXhr = (details: GmDetails) => { abort(): void };

declare const GM_xmlhttpRequest: GmXhr | undefined;

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Deliver the body incrementally through onChunk. */
  stream?: boolean;
}

export interface HttpHead {
  status: number;
  statusText: string;
  /** Lower-cased names. */
  headers: Record<string, string>;
  finalUrl: string;
}

export interface HttpResponse extends HttpHead {
  text: string;
  /** How many onChunk calls delivered the body. */
  chunks: number;
}

export interface HttpHandlers {
  onHead?(head: HttpHead): void;
  onChunk?(chunk: string): void;
}

/** The request never produced a response. */
export class HttpFailure extends Error {
  override readonly name = "HttpFailure";
  constructor(
    readonly kind: "network" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

function parseHeaders(raw = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function gm(): GmXhr | undefined {
  return typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : undefined;
}

const isStream = (v: unknown): v is ReadableStream<Uint8Array> =>
  typeof ReadableStream !== "undefined" && v instanceof ReadableStream;

export function httpRequest(req: HttpRequest, handlers: HttpHandlers = {}): Promise<HttpResponse> {
  const xhr = gm();
  if (!xhr) return Promise.reject(new HttpFailure("network", "GM_xmlhttpRequest 不可用"));
  if (req.signal?.aborted) return Promise.reject(req.signal.reason);

  return new Promise<HttpResponse>((resolve, reject) => {
    let head: HttpHead | undefined;
    let text = "";
    let chunks = 0;
    let reading = false;
    let ending = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let handle: { abort(): void } | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const decoder = new TextDecoder();

    const cleanup = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      reader?.cancel().catch(() => {});
    };
    const fail = (e: unknown) => {
      if (settled) return;
      cleanup();
      handle?.abort();
      reject(e);
    };
    const takeHead = (r: GmResponse) => {
      if (head || (r.status ?? 0) === 0) return;
      head = {
        status: r.status ?? 0,
        statusText: r.statusText ?? "",
        headers: parseHeaders(r.responseHeaders),
        finalUrl: r.finalUrl || req.url,
      };
      handlers.onHead?.(head);
    };
    const push = (chunk: string) => {
      if (!chunk) return;
      text += chunk;
      chunks++;
      handlers.onChunk?.(chunk);
    };
    /** Adds whatever part of the full text so far has not been delivered yet. */
    const catchUp = (full: unknown) => {
      if (typeof full === "string" && full.length > text.length && full.startsWith(text)) push(full.slice(text.length));
    };
    const finish = () => {
      if (settled) return;
      if (!head) return fail(new HttpFailure("network", "请求没有返回"));
      if (reading) push(decoder.decode());
      cleanup();
      resolve({ ...head, text, chunks });
    };
    const read = async (stream: ReadableStream<Uint8Array>) => {
      reading = true;
      try {
        // inside the try: a stream that is already locked fails the request instead of hanging it
        const r = (reader = stream.getReader());
        for (;;) {
          const { done, value } = await r.read();
          if (settled) return;
          if (done) break;
          push(decoder.decode(value, { stream: true }));
        }
        finish();
      } catch (e) {
        fail(new HttpFailure("network", e instanceof Error ? e.message : String(e)));
      }
    };
    /** Any callback: the head once it has a status, then the stream or the text so far. */
    const seen = (r: GmResponse) => {
      if (settled) return;
      takeHead(r);
      if (!head || reading) return;
      // ScriptCat exposes `response` as a getter; read it only once the head is known
      const body = r.response;
      if (isStream(body)) void read(body);
      else catchUp(r.responseText ?? body);
    };
    /**
     * The response is complete. ScriptCat enqueued every chunk before this callback, and reading
     * queued chunks only takes microtasks, so the stream is drained by the next task.
     */
    const ended = (r: GmResponse) => {
      seen(r);
      if (settled || ending) return;
      if (!reading) return finish();
      ending = true;
      setTimeout(finish, 0);
    };
    const onAbort = () => fail(req.signal?.reason);

    // Before sending: a GM implementation may report an error synchronously from inside xhr().
    req.signal?.addEventListener("abort", onAbort);
    if (req.timeoutMs) timer = setTimeout(() => fail(new HttpFailure("timeout", "请求超时")), req.timeoutMs);
    try {
      handle = xhr({
        method: req.method,
        url: req.url,
        headers: req.headers,
        data: req.body,
        // ScriptCat's fetch strategy ends a timed-out stream as a normal load with a cut-off body,
        // so a stream's timeout is only ours.
        timeout: req.stream ? undefined : req.timeoutMs,
        responseType: req.stream ? "stream" : "text",
        onloadstart: seen,
        onreadystatechange: seen,
        onprogress: seen,
        onload: ended,
        onloadend: ended,
        onerror: (e) => {
          const msg = typeof e === "string" ? e : ((e as { error?: string } | undefined)?.error ?? "网络错误");
          fail(new HttpFailure("network", msg));
        },
        ontimeout: () => fail(new HttpFailure("timeout", "请求超时")),
        onabort: () => fail(req.signal?.reason ?? new HttpFailure("network", "请求被中止")),
      });
    } catch (e) {
      fail(new HttpFailure("network", e instanceof Error ? e.message : String(e)));
    }
  });
}
