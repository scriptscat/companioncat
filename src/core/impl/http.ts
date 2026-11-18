/** The declarative `http` implementation (R5.2). */
import { createParser } from "eventsource-parser";
import { md5 } from "js-md5";
import type { Scope } from "../expr";
import { CallError, statusErrorType } from "../errors";
import { HttpFailure, httpRequest, type HttpHandlers, type HttpResponse } from "../../platform/http";
import { POSITIONS } from "../rules";
import type { HttpDef, HttpErrorDef, HttpStepDef, RequestDef } from "../rules";
import { fail, holds, isObject, render, trace, type Run } from "./run";
import { resolveHosts } from "./hosts";

interface BuiltRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

const MAIN = "request";

export async function executeHttp(run: Run, def: HttpDef, input: unknown): Promise<unknown> {
  const mapped = applyLangMap(def.langMap, input);
  if (def.batch && isObject(mapped) && Array.isArray(mapped.texts) && mapped.texts.every((t) => typeof t === "string")) {
    return runBatch(run, def, mapped as Record<string, unknown> & { texts: string[] });
  }
  return runOnce(run, def, mapped);
}

/** `langMap` rewrites input.from / input.to into the service's codes. */
function applyLangMap(map: Record<string, string> | undefined, input: unknown): unknown {
  if (!map || !isObject(input)) return input;
  const out = { ...input };
  for (const k of ["from", "to"]) {
    const v = out[k];
    if (typeof v === "string" && Object.hasOwn(map, v)) out[k] = map[v];
  }
  return out;
}

/** Groups text indexes by maxItems / maxChars; with join, a text containing the separator goes alone. */
export function groupTexts(texts: readonly string[], batch: NonNullable<HttpDef["batch"]>): number[][] {
  const { maxItems = Infinity, maxChars = Infinity, join } = batch;
  const sep = join?.length ?? 0;
  const groups: number[][] = [];
  let cur: number[] = [];
  let chars = 0;
  const flush = () => {
    if (cur.length) groups.push(cur);
    cur = [];
    chars = 0;
  };
  texts.forEach((t, i) => {
    const solo = join !== undefined && t.includes(join);
    const add = t.length + (cur.length ? sep : 0);
    if (cur.length && (solo || cur.length >= maxItems || chars + add > maxChars)) flush();
    chars += t.length + (cur.length ? sep : 0);
    cur.push(i);
    if (solo) flush();
  });
  flush();
  return groups;
}

async function runBatch(run: Run, def: HttpDef, input: Record<string, unknown> & { texts: string[] }): Promise<unknown> {
  const join = def.batch?.join;
  const texts: string[] = [];
  let merged: Record<string, unknown> = {};
  for (const group of groupTexts(input.texts, def.batch!)) {
    const items = group.map((i) => input.texts[i]!);
    const joined = join !== undefined && items.length > 1;
    const out = await runOnce(run, def, { ...input, texts: joined ? [items.join(join)] : items });
    if (!isObject(out) || !Array.isArray(out.texts)) {
      throw fail(run, "badOutput", "返回里没有 texts 列表", { raw: run.shared.lastRaw });
    }
    const first: unknown = out.texts[0];
    const got: unknown[] = joined ? (typeof first === "string" ? first.split(join) : []) : out.texts;
    if (got.length !== items.length) {
      throw fail(run, "badOutput", `发出 ${items.length} 条，返回了 ${got.length} 条`, { raw: run.shared.lastRaw });
    }
    texts.push(...(got as string[]));
    merged = { ...merged, ...out };
  }
  return { ...merged, texts };
}

/** On an auth failure the cached step results (e.g. a temporary token) are dropped, so the next call fetches them anew. */
async function runOnce(run: Run, def: HttpDef, input: unknown): Promise<unknown> {
  const cached: string[] = [];
  try {
    return await runRequest(run, def, input, cached);
  } catch (e) {
    if (e instanceof CallError && e.type === "auth") for (const key of cached) run.ctx.stepCache?.delete(key);
    throw e;
  }
}

/** Where a step ended up after redirects, as `landed.<step id>` in later requests and its own output. */
interface Landed {
  url: string;
  host: string;
}

async function runRequest(run: Run, def: HttpDef, input: unknown, cached: string[]): Promise<unknown> {
  const steps: Record<string, unknown> = {};
  const landed: Record<string, Landed> = {};
  const scope = () => ({ input, options: run.options, secret: run.secret, steps });
  for (const step of def.steps ?? []) {
    const done = await runStep(run, step, { ...scope(), landed }, cached);
    steps[step.id] = done.value;
    landed[step.id] = done.landed;
  }
  const base = scope();
  const req = await buildRequest(run, def.request, { ...base, landed }, MAIN);
  await allowHost(run, req.url, MAIN);
  if (def.response === "sse") return runSse(run, def, req, base);

  const res = await send(run, req, MAIN);
  run.shared.lastRaw = res.text;
  const format = def.response ?? "json";
  const parsed = parseBody(format, res.text);
  const response = parsed.ok ? parsed.value : res.text;
  const err = await detectError(run, def.errors, res.status, response, base);
  if (err) throw err;
  if (!parsed.ok) throw fail(run, "badOutput", "返回的内容不是 JSON", { status: res.status, raw: res.text, step: MAIN });
  return render(run, def.output, { ...base, response, stream: null }, POSITIONS.output, "badOutput", { status: res.status });
}

async function runSse(run: Run, def: HttpDef, req: BuiltRequest, base: Scope): Promise<unknown> {
  const delta = def.stream?.delta ?? "";
  const doneMark = def.stream?.done;
  const stream = { text: "" };
  let ok = false;
  let done = false;
  let events = 0;
  let last: unknown = null;
  let queue = Promise.resolve();
  let streamError: unknown;

  const onEvent = (data: string) => {
    if (done) return;
    if (doneMark !== undefined && data.trim() === doneMark) {
      done = true;
      return;
    }
    events++;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      event = data;
    }
    last = event;
    queue = queue.then(async () => {
      if (streamError !== undefined || run.ctx.signal?.aborted) return;
      try {
        const scope = { ...base, response: event, stream: { ...stream } };
        const value = await render(run, delta, scope, POSITIONS.stream, "badOutput", {}, true);
        const piece = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
        if (piece && streamError === undefined && !run.ctx.signal?.aborted) {
          stream.text += piece;
          run.onDelta?.({ text: piece });
        }
      } catch (e) {
        streamError = e;
      }
    });
  };
  const parser = createParser({ onEvent: (ev) => onEvent(ev.data) });
  const handlers: HttpHandlers = {
    onHead: (h) => (ok = h.status >= 200 && h.status < 300),
    onChunk: (c) => ok && parser.feed(c),
  };

  let res: HttpResponse;
  try {
    res = await send(run, req, MAIN, handlers, () => events);
  } catch (e) {
    streamError = e; // the call has failed: deltas still queued are dropped
    throw e;
  }
  await queue;
  if (!ok) {
    run.shared.lastRaw = res.text;
    const parsed = parseBody("json", res.text);
    const err = await detectError(run, def.errors, res.status, parsed.ok ? parsed.value : res.text, base);
    throw err ?? fail(run, "server", undefined, { status: res.status, raw: res.text, step: MAIN });
  }
  run.shared.lastRaw = stream.text;
  if (streamError !== undefined) throw streamError;
  const err = await detectError(run, def.errors, res.status, last, base);
  if (err) throw err;
  return render(run, def.output, { ...base, response: last, stream }, POSITIONS.output, "badOutput", { status: res.status });
}

interface StepResult {
  value: unknown;
  landed: Landed;
}

async function runStep(run: Run, step: HttpStepDef, scope: Scope & { landed: Record<string, Landed> }, cached: string[]): Promise<StepResult> {
  const req = await buildRequest(run, step.request, scope, step.id);
  const cache = step.cache ? run.ctx.stepCache : undefined;
  const key = cache && md5(JSON.stringify([run.provider.ref, step.id, req.method, req.url, req.headers, req.body ?? null]));
  if (key) cached.push(key);
  const hit = key ? cache!.get(key) : undefined;
  if (hit) {
    trace(run, { type: "cache", step: step.id, hit: true });
    return hit.value as StepResult;
  }
  await allowHost(run, req.url, step.id);
  const res = await send(run, req, step.id);
  run.shared.lastRaw = res.text;
  const format = step.response ?? "json";
  const parsed = parseBody(format, res.text);
  const type = statusErrorType(res.status);
  if (type) throw fail(run, type, undefined, { status: res.status, raw: res.text, step: step.id });
  if (!parsed.ok) throw fail(run, "badOutput", "返回的内容不是 JSON", { status: res.status, raw: res.text, step: step.id });
  const landed = { url: res.finalUrl, host: hostOf(res.finalUrl) };
  const value =
    step.output === undefined
      ? parsed.value
      : await render(
          run,
          step.output,
          { ...scope, landed: { ...scope.landed, [step.id]: landed }, response: parsed.value },
          POSITIONS.stepOutput,
          "badOutput",
          { step: step.id },
        );
  const result = { value, landed };
  if (key) cache!.set(key, result, step.cache!);
  return result;
}

function parseBody(format: "json" | "text" | "sse", text: string): { ok: true; value: unknown } | { ok: false } {
  if (format !== "json") return { ok: true, value: text };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const hasHeader = (h: Record<string, string>, name: string) => Object.keys(h).some((k) => k.toLowerCase() === name);

async function buildRequest(run: Run, def: RequestDef, scope: Scope, step: string): Promise<BuiltRequest> {
  const r = (await render(run, def, scope, POSITIONS.request, "badInput", { step })) as Record<string, unknown>;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(isObject(r.headers) ? r.headers : {})) {
    if (v !== null && v !== undefined) headers[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  let body: string | undefined;
  let type: string | undefined;
  if (r.json !== undefined) {
    body = JSON.stringify(r.json);
    type = "application/json";
  } else if (r.form !== undefined) {
    body = isObject(r.form)
      ? new URLSearchParams(Object.entries(r.form).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])).toString()
      : String(r.form);
    type = "application/x-www-form-urlencoded";
  } else if (r.text !== undefined) {
    body = String(r.text);
    type = "text/plain;charset=UTF-8";
  }
  if (type && !hasHeader(headers, "content-type")) headers["Content-Type"] = type;
  const method = typeof r.method === "string" ? r.method.toUpperCase() : "GET";
  return { method, url: String(r.url), headers, ...(body === undefined ? {} : { body }) };
}

/** Refuses hosts outside the provider's resolved `hosts`, then lets the caller confirm new ones. */
async function allowHost(run: Run, url: string, step: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw fail(run, "hostUndeclared", `请求地址无效：${url}`, { step });
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw fail(run, "hostUndeclared", `不支持的地址：${url}`, { step, host });
  }
  run.shared.hosts ??= resolveHosts(run.provider, run.options, (e) => trace(run, e));
  if (!(await run.shared.hosts).includes(host)) {
    throw fail(run, "hostUndeclared", `${host} 不在引擎声明的 hosts 里，已拒绝发送`, { step, host });
  }
  const confirm = run.ctx.confirmHost;
  if (!confirm || run.shared.confirmed.has(host)) return;
  if (!(await confirm(host, run.provider))) {
    throw fail(run, "hostUnconfirmed", `${host} 还没有确认，已暂停发送`, { step, host });
  }
  run.shared.confirmed.add(host);
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

async function send(run: Run, req: BuiltRequest, step: string, handlers?: HttpHandlers, count?: () => number): Promise<HttpResponse> {
  trace(run, { type: "request", step, ...req });
  const started = Date.now();
  const sentTo = hostOf(req.url);
  // A response that a redirect brought from another host is held back until that host passes allowHost.
  let moved = false;
  const guarded: HttpHandlers | undefined = handlers && {
    onHead: (h) => {
      if (hostOf(h.finalUrl) !== sentTo) moved = true;
      else handlers.onHead?.(h);
    },
    onChunk: (c) => {
      if (!moved) handlers.onChunk?.(c);
    },
  };
  let res: HttpResponse;
  try {
    res = await httpRequest(
      {
        ...req,
        timeoutMs: run.ctx.timeoutMs ?? run.provider.def.limits?.timeoutMs,
        signal: run.ctx.signal,
        stream: handlers !== undefined,
      },
      guarded,
    );
  } catch (e) {
    if (e instanceof HttpFailure) throw fail(run, e.kind, undefined, { step });
    throw e;
  }
  if (hostOf(res.finalUrl) !== sentTo) {
    await allowHost(run, res.finalUrl, step);
    handlers?.onHead?.(res);
    if (res.text) handlers?.onChunk?.(res.text);
  }
  trace(run, { type: "response", step, status: res.status, ms: Date.now() - started, chunks: count ? count() : res.chunks, body: res.text });
  return res;
}

function statusMatches(rule: NonNullable<HttpErrorDef["status"]>, status: number): boolean {
  if (typeof rule === "number") return rule === status;
  if (Array.isArray(rule)) return rule.includes(status);
  return /^[1-5]xx$/.test(rule) && Math.floor(status / 100) === Number(rule[0]);
}

/** First matching `errors` rule, else the default type for a non-2xx status. */
async function detectError(
  run: Run,
  rules: HttpErrorDef[] | undefined,
  status: number,
  response: unknown,
  base: Scope,
): Promise<CallError | undefined> {
  const scope = { ...base, response };
  const raw = run.shared.lastRaw;
  for (const rule of rules ?? []) {
    if (rule.status !== undefined && !statusMatches(rule.status, status)) continue;
    if (rule.when !== undefined && !(await holds(run, rule.when, scope, POSITIONS.errors))) continue;
    let message: string | undefined;
    if (rule.message !== undefined) {
      try {
        message = String(await render(run, rule.message, scope, POSITIONS.errors, "badOutput"));
      } catch {
        message = undefined;
      }
    }
    return fail(run, rule.type, message, { status, raw, step: MAIN });
  }
  const type = statusErrorType(status);
  return type ? fail(run, type, undefined, { status, raw, step: MAIN }) : undefined;
}
