import { afterEach, describe, expect, it } from "vitest";
import { installGmHttp, recording, type FakeGm } from "../../../test/fakes/gm-http";
import { executeImpl } from "./index";
import { ctxFor, official, providerOf } from "./testkit";

let fake: FakeGm | undefined;
afterEach(() => {
  expect(fake?.unmatched ?? []).toEqual([]);
  fake?.restore();
  fake = undefined;
});

const KEY = "sk-test-0000000000abcd";
const secrets = { apiKey: KEY };
const rules = official();
const deepseek = providerOf(rules, "official-llm/deepseek");
const openai = providerOf(rules, "official-llm/openai");
const hello = { messages: [{ role: "user", content: "用一句话介绍你自己。" }] };

const body = (i: number) => JSON.parse(fake!.calls[i]!.data!) as Record<string, unknown>;

describe("OpenAI-compatible chat (R5.2 sse)", () => {
  it.each(["scriptcat", "closing", "fallback"] as const)("streams Chat Completions deltas (%s stream support)", async (stream) => {
    fake = installGmHttp(recording("openai-chat-sse"), { stream, chunkSize: 16 });
    const ctx = ctxFor(rules, { secrets });
    const out = await executeImpl(deepseek, "chat", hello, ctx);
    expect(out).toEqual({ text: "你好！我是一个助手。" });
    expect(ctx.deltas).toEqual(["你好", "！我是", "一个助手。"]);
    const call = fake.calls[0]!;
    expect(call).toMatchObject({ method: "POST", url: "https://api.deepseek.com/v1/chat/completions", responseType: "stream" });
    expect(call.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(body(0)).toEqual({ model: "deepseek-chat", messages: hello.messages, stream: true });
    expect(ctx.trace).toContainEqual(expect.objectContaining({ type: "response", status: 200, chunks: 5 }));
  });

  it("uses the Responses API when options.api is responses", async () => {
    fake = installGmHttp(recording("openai-responses-sse"), { chunkSize: 32 });
    const ctx = ctxFor(rules, { secrets });
    const out = await executeImpl(openai, "chat", hello, ctx);
    expect(out).toEqual({ text: "我是 GPT。" });
    expect(ctx.deltas).toEqual(["我是", " GPT", "。"]);
    expect(body(0)).toEqual({ model: "gpt-4o-mini", input: hello.messages, stream: true });
  });

  it.each(["scriptcat", "fallback"] as const)("streams Responses API deltas (%s stream support)", async (stream) => {
    fake = installGmHttp(recording("openai-responses-sse"), { stream, chunkSize: 7 });
    const ctx = ctxFor(rules, { secrets });
    expect(await executeImpl(openai, "chat", hello, ctx)).toEqual({ text: "我是 GPT。" });
    expect(ctx.deltas.join("")).toBe("我是 GPT。");
  });

  it("a 401 on the stream fails promptly as auth with the rule's message", async () => {
    const url = "https://api.deepseek.com/v1/chat/completions";
    fake = installGmHttp([{ method: "POST", url, status: 401, headers: { "content-type": "application/json" }, json: { error: { message: "Incorrect API key provided" } } }]);
    const started = Date.now();
    const err = executeImpl(deepseek, "chat", hello, ctxFor(rules, { secrets, timeoutMs: 30_000 }));
    await expect(err).rejects.toMatchObject({ type: "auth", message: "这个 Key 无效或已过期", detail: { status: 401 } });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("times out a stream that never ends", async () => {
    const [chat] = recording("openai-chat-sse");
    fake = installGmHttp([{ ...chat!, body: chat!.body!.split("\n\n").slice(0, 2).join("\n\n") + "\n\n", stall: true }]);
    const ctx = ctxFor(rules, { secrets, timeoutMs: 50 });
    await expect(executeImpl(deepseek, "chat", hello, ctx)).rejects.toMatchObject({ type: "timeout" });
    expect(fake.aborted).toBe(1);
  });

  it("follows user options over the defaults", async () => {
    fake = installGmHttp(recording("openai-chat-sse").map((r) => ({ ...r, url: "https://proxy.test/v1/chat/completions" })));
    const options = { baseUrl: "https://proxy.test/v1", model: "m2", api: "chat" };
    await executeImpl(openai, "chat", hello, ctxFor(rules, { secrets, options }));
    expect(body(0)).toMatchObject({ model: "m2" });
  });
});

describe("bridges (R5.3)", () => {
  it("llm-translate maps translate onto chat and retries once with the check message", async () => {
    fake = installGmHttp(recording("llm-translate-retry"));
    const ctx = ctxFor(rules, { secrets });
    const out = await executeImpl(deepseek, "translate", { texts: ["Hello, world", "Good morning"], to: "zh-CN" }, ctx);
    expect(out).toEqual({ texts: ["你好，世界", "早上好"] });
    expect(fake.calls).toHaveLength(2);
    const first = body(0).messages as { role: string; content: string }[];
    expect(first[0]!.content).toContain("简体中文");
    expect(first[1]).toEqual({ role: "user", content: '["Hello, world","Good morning"]' });
    const retry = body(1).messages as { role: string; content: string }[];
    expect(retry.slice(0, 2)).toEqual(first);
    expect(retry.slice(2)).toEqual([
      { role: "assistant", content: "好的，翻译如下：你好，世界" },
      { role: "user", content: "上一次的回答不是和输入条数相同的 JSON 字符串数组，请只输出这个数组。" },
    ]);
    expect(ctx.trace).toContainEqual(expect.objectContaining({ type: "bridge", bridge: "official-llm/llm-translate", to: "chat" }));
    expect(ctx.deltas).toEqual([]);
  });

  it("fails as badOutput when the retry still does not pass the check", async () => {
    const [bad] = recording("llm-translate-retry");
    fake = installGmHttp([bad!, bad!]);
    const err = executeImpl(deepseek, "translate", { texts: ["Hello, world", "Good morning"], to: "zh-CN" }, ctxFor(rules, { secrets }));
    await expect(err).rejects.toMatchObject({ type: "badOutput", detail: { raw: "好的，翻译如下：你好，世界" } });
    expect(fake.calls).toHaveLength(2);
  });

  it("llm-choose reads a fenced JSON reply", async () => {
    fake = installGmHttp(recording("llm-choose"));
    const input = { state: { button: "Skip Ad ▸" }, question: "是不是跳过广告？", options: { yes: "是", no: "不是" } };
    const out = await executeImpl(deepseek, "choose", input, ctxFor(rules, { secrets }));
    expect(out).toEqual({ choice: "yes", confidence: 0.92 });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("Jev choose", () => {
  it("asks one choice question and maps the typed answer", async () => {
    const r = official();
    expect(r.diagnostics).toEqual([]);
    fake = installGmHttp(recording("jev-choose"));
    const input = { state: { button: "Skip Ad ▸", page: "视频播放页" }, question: "这个按钮是不是跳过广告的按钮？", options: { yes: "是", no: "不是" } };
    const out = await executeImpl(providerOf(r, "official-llm/jev"), "choose", input, ctxFor(r, { secrets: { apiKey: "jev-test-key-000000" } }));
    expect(out).toEqual({ choice: "yes", confidence: 1 });
    expect(body(0)).toEqual({
      model: "jev-latest",
      state: input.state,
      questions: { choice: { type: "choice", instructions: input.question, criteria: input.options } },
    });
  });
});
