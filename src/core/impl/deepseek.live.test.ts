/**
 * Live smoke test of the official DeepSeek engine (openai-compatible) against the real API.
 * The key is read from ~/.env (DEEPSEEK_API_KEY, not exported to the shell) and never printed:
 * every assertion message goes through mask(), and the trace is checked not to hold it.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installFetchGm } from "../../../test/fakes/gm-http";
import { executeImpl } from "./index";
import { ctxFor, official, providerOf, type TestContext } from "./testkit";

function envKey(name: string): string | undefined {
  try {
    const env = readFileSync(join(homedir(), ".env"), "utf8");
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`, "m").exec(env);
    const v = m?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
    return v || undefined;
  } catch {
    return undefined;
  }
}

const key = envKey("DEEPSEEK_API_KEY");
const mask = (s: string) => (key ? s.split(key).join("sk-***") : s);

/** A failure as a key-free {type, message, status}. */
function failureOf(e: unknown) {
  const err = e as { type?: string; message?: string; detail?: { status?: number } };
  return { type: err.type, message: mask(String(err.message)), status: err.detail?.status };
}

function noKeyIn(ctx: TestContext) {
  expect(JSON.stringify(ctx.trace).includes(key!), "trace holds the key").toBe(false);
}

describe.skipIf(!key)("DeepSeek live smoke", () => {
  const gm = installFetchGm();
  afterAll(() => gm.restore());
  const r = official();
  const deepseek = providerOf(r, "official-llm/deepseek");
  const run = async (contract: string, input: unknown, ctx: TestContext) => {
    let failure: ReturnType<typeof failureOf> | undefined;
    const out = await executeImpl(deepseek, contract, input, ctx).catch((e: unknown) => void (failure = failureOf(e)));
    noKeyIn(ctx);
    return { out, failure };
  };

  it("chat streams a short reply over Chat Completions SSE", { timeout: 60_000 }, async () => {
    const ctx = ctxFor(r, { secrets: { apiKey: key! } });
    const { out, failure } = await run("chat", { messages: [{ role: "user", content: "只回复两个字：你好" }] }, ctx);
    expect(failure).toBeUndefined();
    const text = (out as { text: string }).text;
    expect(text.trim()).not.toBe("");
    expect(ctx.deltas.length).toBeGreaterThan(0);
    expect(ctx.deltas.join("")).toBe(text);
    expect(ctx.trace).toContainEqual(expect.objectContaining({ type: "request", url: "https://api.deepseek.com/v1/chat/completions" }));
    expect(ctx.trace).toContainEqual(expect.objectContaining({ type: "response", status: 200 }));
  });

  // Observed 2026-11-18: DeepSeek answers POST /v1/responses with response.output_text.delta events.
  it("chat with options.api responses streams over the Responses API", { timeout: 60_000 }, async () => {
    const ctx = ctxFor(r, { secrets: { apiKey: key! }, options: { api: "responses" } });
    const { out, failure } = await run("chat", { messages: [{ role: "user", content: "只回复两个字：你好" }] }, ctx);
    expect(failure).toBeUndefined();
    const text = (out as { text: string }).text;
    expect(text.trim()).not.toBe("");
    expect(ctx.deltas.length).toBeGreaterThan(0);
    expect(ctx.deltas.join("")).toBe(text);
    expect(ctx.trace).toContainEqual(expect.objectContaining({ type: "request", url: "https://api.deepseek.com/v1/responses" }));
  });

  it("translate through llm-translate: 2 texts to zh-CN come back as 2 CJK texts", { timeout: 60_000 }, async () => {
    const ctx = ctxFor(r, { secrets: { apiKey: key! } });
    const { out, failure } = await run("translate", { texts: ["Good morning", "Thank you very much"], from: "en", to: "zh-CN" }, ctx);
    expect(failure).toBeUndefined();
    const texts = (out as { texts: unknown[] }).texts;
    expect(texts).toHaveLength(2);
    for (const t of texts) expect(t).toMatch(/[一-鿿]/);
    expect(ctx.trace).toContainEqual(expect.objectContaining({ type: "bridge", bridge: "official-llm/llm-translate", to: "chat" }));
  });

  it("choose through llm-choose: a 3-option question gets a valid choice and a 0–1 confidence", { timeout: 60_000 }, async () => {
    const ctx = ctxFor(r, { secrets: { apiKey: key! } });
    const options = { skip: "「跳过广告 5s」按钮", volume: "「音量」按钮", none: "都不是" };
    const input = {
      state: '<div class="player"><div class="ad-overlay">广告 <button>跳过广告 5s</button></div><button>音量</button></div>',
      question: "哪个是跳过广告的按钮？",
      options,
    };
    const { out, failure } = await run("choose", input, ctx);
    expect(failure).toBeUndefined();
    const { choice, confidence } = out as { choice: string; confidence: number };
    expect(Object.keys(options)).toContain(choice);
    expect(typeof confidence).toBe("number");
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
    expect(ctx.trace).toContainEqual(expect.objectContaining({ type: "bridge", bridge: "official-llm/llm-choose", to: "chat" }));
  });

  it("a wrong key fails as auth with the rule's message", { timeout: 60_000 }, async () => {
    const ctx = ctxFor(r, { secrets: { apiKey: "sk-companioncat-deliberately-wrong-0000" } });
    const { failure } = await run("chat", { messages: [{ role: "user", content: "你好" }] }, ctx);
    expect(failure).toMatchObject({ type: "auth", message: "这个 Key 无效或已过期", status: 401 });
  });
});
