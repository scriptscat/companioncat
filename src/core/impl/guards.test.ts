import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { installGmHttp, recording, type FakeGm } from "../../../test/fakes/gm-http";
import { CallError, ERROR_TYPES } from "../errors";
import { checkTemplate, type Position } from "../expr";
import { POSITIONS } from "../rules";
import { mask } from "../stores";
import { BUILTIN_UNSUPPORTED, createStepCache, effectiveOptions, executeImpl, masker, resolveHosts, unavailableReason } from "./index";
import { ctxFor, official, providerOf, testProvider } from "./testkit";

let fake: FakeGm | undefined;
afterEach(() => {
  fake?.restore();
  fake = undefined;
});

const KEY = "sk-test-0000000000abcd";
const MASKED = "sk-••••••••abcd";
const secrets = { apiKey: KEY };
const rules = official();
const deepseek = providerOf(rules, "official-llm/deepseek");
const hello = { messages: [{ role: "user", content: "hi" }] };
const CHAT = "https://api.deepseek.com/v1/chat/completions";

describe("error types (R6.3)", () => {
  it("has a fixed message and retry flag for exactly the schema's error types", () => {
    const schema = JSON.parse(readFileSync(new URL("../../../rules/schema/v1.json", import.meta.url), "utf8"));
    expect(Object.keys(ERROR_TYPES).sort()).toEqual([...schema.$defs.errorType.enum].sort());
    for (const t of Object.values(ERROR_TYPES)) expect(t.message).not.toBe("");
    const retried = Object.entries(ERROR_TYPES).filter(([, t]) => t.retry).map(([k]) => k);
    expect(retried.sort()).toEqual(["network", "rateLimit", "server", "timeout"]);
  });

  it.each([
    [401, "auth", "这个 Key 无效或已过期"],
    [403, "auth", "这个 Key 无效或已过期"],
    [429, "rateLimit", "请求太频繁，或者账户额度用完了"],
    [503, "server", "服务商暂时出错了"],
  ])("maps HTTP %i through the rule's errors to %s", async (status, type, message) => {
    fake = installGmHttp([{ url: CHAT, status, json: { error: { message: "nope" } } }]);
    await expect(executeImpl(deepseek, "chat", hello, ctxFor(rules, { secrets }))).rejects.toMatchObject({
      type,
      message,
      detail: { status },
    });
  });

  it("classifies unlisted statuses with the default table", async () => {
    const p = testProvider({
      hosts: ["a.test"],
      implements: { chat: { http: { request: { url: "https://a.test/c" }, response: "json", output: { text: "{{ response.t }}" } } } },
    });
    fake = installGmHttp([
      { url: "https://a.test/c", status: 401 },
      { url: "https://a.test/c", status: 502, body: "<html>bad gateway</html>" },
      { url: "https://a.test/c", status: 404 },
    ]);
    const ctx = ctxFor(rules);
    await expect(executeImpl(p, "chat", hello, ctx)).rejects.toMatchObject({ type: "auth", message: ERROR_TYPES.auth.message });
    await expect(executeImpl(p, "chat", hello, ctx)).rejects.toMatchObject({ type: "server", detail: { raw: "<html>bad gateway</html>" } });
    await expect(executeImpl(p, "chat", hello, ctx)).rejects.toMatchObject({ type: "badInput" });
  });

  it("maps network failures and timeouts", async () => {
    fake = installGmHttp([
      { url: CHAT, error: "network" },
      { url: CHAT, error: "timeout" },
      { url: CHAT, error: "hang" },
    ]);
    const ctx = ctxFor(rules, { secrets });
    await expect(executeImpl(deepseek, "chat", hello, ctx)).rejects.toMatchObject({ type: "network" });
    await expect(executeImpl(deepseek, "chat", hello, ctx)).rejects.toMatchObject({ type: "timeout" });
    await expect(executeImpl(deepseek, "chat", hello, { ...ctx, timeoutMs: 20 })).rejects.toMatchObject({ type: "timeout" });
  });

  it("recognises errors by response content with when", async () => {
    const jev = providerOf(rules, "official-llm/jev");
    fake = installGmHttp([{ url: "https://api.typesafe.ai/v1/systemone", json: { model: "jev", answers: {} } }]);
    const input = { state: "s", question: "q?", options: { a: "A", b: "B" } };
    await expect(executeImpl(jev, "choose", input, ctxFor(rules, { secrets }))).rejects.toMatchObject({
      type: "badOutput",
      message: "Jev 没有回答这个问题",
    });
  });

  it("throws CallError instances", async () => {
    fake = installGmHttp([{ url: CHAT, status: 500 }]);
    await expect(executeImpl(deepseek, "chat", hello, ctxFor(rules, { secrets }))).rejects.toBeInstanceOf(CallError);
  });
});

describe("hosts (R5.1, R5.2)", () => {
  const sneaky = testProvider({
    hosts: ["api.ok.test"],
    implements: {
      chat: {
        http: {
          steps: [{ id: "t", request: { url: "https://{{ input.messages[0].content }}/token" } }],
          request: { url: "https://api.ok.test/chat" },
          response: "json",
          output: { text: "{{ response.text }}" },
        },
      },
    },
  });

  it("refuses requests to undeclared hosts without sending them", async () => {
    fake = installGmHttp([{ url: /./, repeat: true, json: { text: "x" } }]);
    const run = executeImpl(sneaky, "chat", { messages: [{ role: "user", content: "evil.test" }] }, ctxFor(rules));
    await expect(run).rejects.toMatchObject({ type: "hostUndeclared", detail: { host: "evil.test" } });
    expect(fake.calls).toEqual([]);
  });

  it("resolves host expressions from effective options", async () => {
    expect(await resolveHosts(deepseek, effectiveOptions(deepseek))).toEqual(["api.deepseek.com"]);
    expect(await resolveHosts(deepseek, effectiveOptions(deepseek, { baseUrl: "https://Proxy.test:8443/v1" }))).toEqual(["proxy.test"]);
    expect(await resolveHosts(deepseek, effectiveOptions(deepseek, { baseUrl: "" }))).toEqual([]);
  });

  it("asks confirmHost before each new host and stops with hostUnconfirmed on refusal", async () => {
    fake = installGmHttp(recording("openai-chat-sse"));
    const asked: string[] = [];
    const refuse = ctxFor(rules, { secrets, confirmHost: (h) => (asked.push(h), false) });
    await expect(executeImpl(deepseek, "chat", hello, refuse)).rejects.toMatchObject({ type: "hostUnconfirmed" });
    expect(fake.calls).toEqual([]);
    const allow = ctxFor(rules, { secrets, confirmHost: async (h) => (asked.push(h), true) });
    await expect(executeImpl(deepseek, "chat", hello, allow)).resolves.toEqual({ text: "你好！我是一个助手。" });
    expect(asked).toEqual(["api.deepseek.com", "api.deepseek.com"]);
  });
});

describe("redirects (R5.1, R5.2)", () => {
  const plain = testProvider({
    hosts: ["a.test", "b.test"],
    implements: { chat: { http: { request: { url: "https://a.test/c" }, response: "json", output: { text: "{{ response.text }}" } } } },
  });
  const streaming = testProvider({
    hosts: ["a.test"],
    implements: {
      chat: { http: { request: { url: "https://a.test/c" }, response: "sse", stream: { delta: "{{ response.d }}" }, output: { text: "{{ stream.text }}" } } },
    },
  });

  it("refuses a response redirected to an undeclared host and never uses or traces its body", async () => {
    fake = installGmHttp([{ url: "https://a.test/c", finalUrl: "https://evil.test/c", json: { text: "planted" } }]);
    const ctx = ctxFor(rules);
    await expect(executeImpl(plain, "chat", hello, ctx)).rejects.toMatchObject({ type: "hostUndeclared", detail: { host: "evil.test" } });
    expect(JSON.stringify(ctx.trace)).not.toContain("planted");
  });

  it("refuses a redirected stream before any of it is delivered", async () => {
    fake = installGmHttp([{ url: "https://a.test/c", finalUrl: "https://evil.test/c", body: 'data: {"d":"planted"}\n\n' }]);
    const ctx = ctxFor(rules);
    await expect(executeImpl(streaming, "chat", hello, ctx)).rejects.toMatchObject({ type: "hostUndeclared", detail: { host: "evil.test" } });
    expect(ctx.deltas).toEqual([]);
    expect(JSON.stringify(ctx.trace)).not.toContain("planted");
  });

  describe("a step's final URL and host as landed.<id> (一期 R5.2)", () => {
    const landing = testProvider({
      hosts: ["a.test", "b.test"],
      implements: {
        chat: {
          http: {
            steps: [{ id: "t", request: { url: "https://a.test/token" }, output: { token: "{{ response.token }}", from: "{{ landed.t.url }}" }, cache: 600 }],
            request: { url: "https://{{ landed.t.host }}/c", headers: { "X-Token": "{{ steps.t.token }}", "X-From": "{{ steps.t.from }}" } },
            response: "json",
            output: { text: "{{ response.text }}" },
          },
        },
      },
    });

    it("lets the step's output and later requests read where the step landed, also on a cache hit", async () => {
      fake = installGmHttp([
        { url: "https://a.test/token", finalUrl: "https://b.test/token?r=1", json: { token: "T" } },
        { url: "https://b.test/c", json: { text: "ok" }, repeat: true },
      ]);
      const ctx = ctxFor(rules, { stepCache: createStepCache() });
      await expect(executeImpl(landing, "chat", hello, ctx)).resolves.toEqual({ text: "ok" });
      await expect(executeImpl(landing, "chat", hello, ctx)).resolves.toEqual({ text: "ok" });
      expect(fake.calls.map((c) => c.url)).toEqual(["https://a.test/token", "https://b.test/c", "https://b.test/c"]);
      for (const c of fake.calls.slice(1)) expect(c.headers).toMatchObject({ "X-Token": "T", "X-From": "https://b.test/token?r=1" });
      expect(ctx.trace).toContainEqual(expect.objectContaining({ type: "cache", step: "t", hit: true }));
    });

    it("is the request URL when there was no redirect", async () => {
      fake = installGmHttp([
        { url: "https://a.test/token", json: { token: "T" } },
        { url: "https://a.test/c", json: { text: "ok" } },
      ]);
      await expect(executeImpl(landing, "chat", hello, ctxFor(rules))).resolves.toEqual({ text: "ok" });
      expect(fake.calls[1]!.headers["X-From"]).toBe("https://a.test/token");
    });

    it("still refuses a step redirected to an undeclared host", async () => {
      fake = installGmHttp([{ url: "https://a.test/token", finalUrl: "https://evil.test/token", json: { token: "planted" } }]);
      const ctx = ctxFor(rules);
      await expect(executeImpl(landing, "chat", hello, ctx)).rejects.toMatchObject({ type: "hostUndeclared", detail: { host: "evil.test", step: "t" } });
      expect(fake.calls).toHaveLength(1);
      expect(JSON.stringify(ctx.trace)).not.toContain("planted");
    });

    it("is allowed in engine requests and step output only", () => {
      const at = (pos: Position) => checkTemplate("{{ landed.t.host }}", pos).map((e) => e.message);
      expect(at(POSITIONS.request)).toEqual([]);
      expect(at(POSITIONS.stepOutput)).toEqual([]);
      for (const pos of [POSITIONS.hosts, POSITIONS.output, POSITIONS.errors, POSITIONS.stream, POSITIONS.run, POSITIONS.bridgeInput]) {
        expect(at(pos)).toEqual([expect.stringContaining("landed")]);
      }
    });
  });

  it("accepts a redirect to another declared host, asking to confirm it", async () => {
    fake = installGmHttp([{ url: "https://a.test/c", finalUrl: "https://b.test/c", json: { text: "ok" } }]);
    const asked: string[] = [];
    const ctx = ctxFor(rules, { confirmHost: (h) => (asked.push(h), true) });
    await expect(executeImpl(plain, "chat", hello, ctx)).resolves.toEqual({ text: "ok" });
    expect(asked).toEqual(["a.test", "b.test"]);
  });
});

describe("cached steps (R5.2)", () => {
  const tokened = testProvider({
    hosts: ["a.test"],
    implements: {
      chat: {
        http: {
          steps: [{ id: "t", request: { url: "https://a.test/token" }, output: "{{ response.token }}", cache: 600 }],
          request: { url: "https://a.test/c", headers: { "X-Token": "{{ steps.t }}" } },
          response: "json",
          output: { text: "{{ response.text }}" },
        },
      },
    },
  });

  it("drops the cached step results when the service rejects them as auth, so the next call fetches anew", async () => {
    let n = 0;
    fake = installGmHttp([
      { url: "https://a.test/token", repeat: true, respond: () => ({ json: { token: `t${++n}` } }) },
      { url: "https://a.test/c", json: { text: "one" } },
      { url: "https://a.test/c", status: 401 },
      { url: "https://a.test/c", json: { text: "three" } },
    ]);
    const ctx = ctxFor(rules, { stepCache: createStepCache() });
    await expect(executeImpl(tokened, "chat", hello, ctx)).resolves.toEqual({ text: "one" });
    await expect(executeImpl(tokened, "chat", hello, ctx)).rejects.toMatchObject({ type: "auth" });
    await expect(executeImpl(tokened, "chat", hello, ctx)).resolves.toEqual({ text: "three" });
    expect(fake.calls.filter((c) => c.url.endsWith("/c")).map((c) => c.headers["X-Token"])).toEqual(["t1", "t1", "t2"]);
  });

  it("keeps them on other failures", async () => {
    fake = installGmHttp([
      { url: "https://a.test/token", json: { token: "t1" } },
      { url: "https://a.test/c", status: 503 },
      { url: "https://a.test/c", json: { text: "two" } },
    ]);
    const ctx = ctxFor(rules, { stepCache: createStepCache() });
    await expect(executeImpl(tokened, "chat", hello, ctx)).rejects.toMatchObject({ type: "server" });
    await expect(executeImpl(tokened, "chat", hello, ctx)).resolves.toEqual({ text: "two" });
  });
});

describe("cancelling a stream (R6.1)", () => {
  it("delivers no more deltas once the call is aborted", async () => {
    const p = testProvider({
      hosts: ["a.test"],
      implements: {
        chat: { http: { request: { url: "https://a.test/c" }, response: "sse", stream: { delta: "{{ response.d }}" }, output: { text: "{{ stream.text }}" } } },
      },
    });
    const body = ["a", "b", "c"].map((d) => `data: {"d":"${d}"}\n\n`).join("");
    fake = installGmHttp([{ url: "https://a.test/c", body }], { chunkSize: 4096 });
    const ctrl = new AbortController();
    const deltas: string[] = [];
    const ctx = ctxFor(rules, { signal: ctrl.signal, onDelta: (d) => (deltas.push(d.text), ctrl.abort(new Error("closed"))) });
    await expect(executeImpl(p, "chat", hello, ctx)).rejects.toThrow("closed");
    await new Promise((r) => setTimeout(r, 20));
    expect(deltas).toEqual(["a"]);
  });
});

describe("builtin (R5.4)", () => {
  const p = testProvider({ hosts: ["a.test"], implements: { translate: { builtin: "deepl" } } });

  it("is disabled with the unsupported-adapter reason", async () => {
    expect(BUILTIN_UNSUPPORTED).toBe("这个版本的陪伴猫不支持这个内置适配器");
    expect(unavailableReason(p, "translate")).toBe(BUILTIN_UNSUPPORTED);
    await expect(executeImpl(p, "translate", { texts: ["a"], to: "en" }, ctxFor(rules))).rejects.toMatchObject({
      type: "disabled",
      message: BUILTIN_UNSUPPORTED,
    });
  });

  it("runs a registered adapter", async () => {
    const builtins = { deepl: async (_c: string, input: unknown) => ({ texts: (input as { texts: string[] }).texts }) };
    expect(unavailableReason(p, "translate", builtins)).toBeNull();
    await expect(executeImpl(p, "translate", { texts: ["a"], to: "en" }, ctxFor(rules, { builtins }))).resolves.toEqual({ texts: ["a"] });
  });

  it("reports contracts the engine does not implement", () => {
    expect(unavailableReason(p, "chat")).toMatch(/没有实现/);
    expect(unavailableReason(deepseek, "chat")).toBeNull();
  });
});

describe("contract schemas (R4.3)", () => {
  it("rejects input that does not match the contract before sending anything", async () => {
    fake = installGmHttp([]);
    await expect(executeImpl(deepseek, "chat", { messages: [] }, ctxFor(rules, { secrets }))).rejects.toMatchObject({
      type: "badInput",
      message: expect.stringContaining("/messages"),
    });
    expect(fake.calls).toEqual([]);
  });

  it("rejects output that does not match, with the first 500 characters of the raw response", async () => {
    const p = testProvider({
      hosts: ["a.test"],
      implements: { translate: { http: { request: { url: "https://a.test/t" }, response: "json", output: { texts: "{{ response.t }}" } } } },
    });
    const raw = JSON.stringify({ t: "not a list", pad: "x".repeat(600) });
    fake = installGmHttp([{ url: "https://a.test/t", body: raw }]);
    const err = await executeImpl(p, "translate", { texts: ["a"], to: "en" }, ctxFor(rules)).catch((e: unknown) => e);
    expect(err).toMatchObject({ type: "badOutput", detail: { raw: raw.slice(0, 500) } });
  });

  it("fails as badOutput with the failing expression when output mapping errors", async () => {
    const p = testProvider({
      hosts: ["a.test"],
      implements: { chat: { http: { request: { url: "https://a.test/c" }, response: "json", output: { text: "{{ response.choices[0].text }}" } } } },
    });
    fake = installGmHttp([{ url: "https://a.test/c", json: { choices: [] } }]);
    const err = await executeImpl(p, "chat", hello, ctxFor(rules)).catch((e: unknown) => e);
    expect(err).toMatchObject({ type: "badOutput", detail: { expr: { source: " response.choices[0].text ", path: ["text"] } } });
  });

  it("needs every declared key (missingKey) before sending", async () => {
    fake = installGmHttp([]);
    await expect(executeImpl(deepseek, "chat", hello, ctxFor(rules))).rejects.toMatchObject({ type: "missingKey" });
    await expect(executeImpl(deepseek, "chat", hello, ctxFor(rules, { secrets: { apiKey: " " } }))).rejects.toMatchObject({ type: "missingKey" });
    expect(fake.calls).toEqual([]);
  });
});

describe("trace (R12.1)", () => {
  it("records requests, responses, expressions and output with keys masked", async () => {
    fake = installGmHttp(recording("openai-chat-sse"));
    const ctx = ctxFor(rules, { secrets });
    await executeImpl(deepseek, "chat", hello, ctx);
    expect(ctx.trace).toContainEqual(
      expect.objectContaining({
        type: "request",
        step: "request",
        method: "POST",
        url: CHAT,
        headers: expect.objectContaining({ Authorization: `Bearer ${MASKED}` }),
        body: expect.stringContaining('"stream":true'),
      }),
    );
    expect(ctx.trace).toContainEqual(expect.objectContaining({ type: "response", status: 200, ms: expect.any(Number) }));
    expect(ctx.trace).toContainEqual(
      expect.objectContaining({ type: "expr", position: "引擎 output", template: { text: "{{ stream.text }}" }, value: { text: "你好！我是一个助手。" } }),
    );
    expect(ctx.trace.at(-1)).toEqual({ type: "output", contract: "chat", output: { text: "你好！我是一个助手。" } });
    expect(JSON.stringify(ctx.trace)).not.toContain(KEY);
  });

  it("masks the key in the encodings a request can carry it in", () => {
    const key = "sk-a~b!c'd\\e\"f(g)h1234";
    const m = masker({ k: key });
    const forms = [
      key,
      encodeURIComponent(key),
      new URLSearchParams({ k: key }).toString().slice(2),
      JSON.stringify(key).slice(1, -1),
      btoa(key),
      Array.from(new TextEncoder().encode(key), (b) => b.toString(16).padStart(2, "0")).join(""),
    ];
    for (const f of forms) expect(m(`x=${f}&y`)).toBe(`x=${mask(key)}&y`);
  });

  it("masks a key sent in a form body", async () => {
    const formKey = "sk-form key~0000abcd";
    const p = testProvider({
      hosts: ["a.test"],
      secrets: [{ name: "k", title: "Key" }],
      implements: {
        chat: { http: { request: { method: "POST", url: "https://a.test/c", form: { key: "{{ secret.k }}" } }, response: "json", output: { text: "{{ response.text }}" } } },
      },
    });
    fake = installGmHttp([{ url: "https://a.test/c", json: { text: "ok" } }]);
    const ctx = ctxFor(rules, { secrets: { k: formKey } });
    await executeImpl(p, "chat", hello, ctx);
    expect(fake.calls[0]!.data).toBe(new URLSearchParams({ key: formKey }).toString());
    expect(JSON.stringify(ctx.trace)).not.toContain(new URLSearchParams({ key: formKey }).toString().slice(4));
  });

  it("masks keys in errors and their raw responses", async () => {
    fake = installGmHttp([{ url: CHAT, status: 401, json: { error: `Incorrect API key provided: ${KEY}` } }]);
    const ctx = ctxFor(rules, { secrets });
    const err = (await executeImpl(deepseek, "chat", hello, ctx).catch((e: unknown) => e)) as CallError;
    expect(err.detail.raw).toContain(MASKED);
    expect(JSON.stringify({ m: err.message, d: err.detail, t: ctx.trace })).not.toContain(KEY);
    expect(ctx.trace.at(-1)).toMatchObject({ type: "error", contract: "chat", errorType: "auth" });
  });
});
