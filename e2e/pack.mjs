/**
 * The E2E rule pack. Every engine points at the local fake translator (e2e/server.mjs).
 * Version 1 sends the keyed engine to `localhost`; version 2 moves it to `127.0.0.1`, which is
 * the "rule update changed the address" case of R7.4.
 * `fake-page` translates a whole batch of texts per request (网页对照), and fails on demand via the server's `failPage` state.
 * `fake-llm` answers choose and chat from the scriptable fake LLM on port + 1 (e2e/llm.mjs); its key is
 * the fake's own constant, so the automation scenarios need no key typed in.
 */
import { LLM_KEY } from "./llm.mjs";

export const PACK_ID = "e2e";

const translate = (url, extra = {}) => ({
  http: {
    request: { method: "GET", url, ...extra },
    response: "json",
    output: { texts: "{{ response.texts }}" },
    errors: [
      { status: 401, type: "auth", message: "假服务说 Key 不对" },
      { status: "5xx", type: "server", message: "假服务出错了" },
    ],
  },
});

const CHOOSE_SYSTEM =
  "你要根据给出的状态回答一个选择题。只输出一个 JSON 对象，包含 choice（选中的选项 id，必须是给出的选项之一）和 confidence（0 到 1 之间的数字，表示你有多确定），不要任何解释。";

/** A non-streaming Chat Completions call to the fake LLM; `messages` and `output` are templates. */
const llmChat = (port, messages, output, host = "localhost") => ({
  http: {
    request: {
      method: "POST",
      url: `http://${host}:${port + 1}/v1/chat/completions`,
      headers: { Authorization: `Bearer ${LLM_KEY}` },
      json: { model: "fake-llm", messages, stream: false },
    },
    response: "json",
    output,
    errors: [
      { status: [401, 403], type: "auth", message: "假模型说 Key 不对" },
      { status: "5xx", type: "server", message: "假模型出错了" },
    ],
  },
});

/** The choose contract on the fake LLM: the model answers `{"choice", "confidence"}`. */
const choose = (port, host) =>
  llmChat(
    port,
    [
      { role: "system", content: CHOOSE_SYSTEM },
      { role: "user", content: "状态：{{ json(input.state) }}\n问题：{{ input.question }}\n选项（id 到说明）：{{ json(input.options) }}" },
    ],
    { choice: "{{ extractJson(response.choices[0].message.content).choice }}", confidence: "{{ extractJson(response.choices[0].message.content).confidence }}" },
    host,
  );

const q = "to={{ input.to }}&q={{ urlencode(input.texts[0]) }}";

export function testPack(port, version = 1) {
  const keyHost = version >= 2 ? "127.0.0.1" : "localhost";
  return {
    schema: 1,
    id: PACK_ID,
    name: "E2E 测试规则",
    description: "指向本地假翻译服务的测试规则包",
    version: `1.0.${version}`,
    providers: [
      {
        id: "fake-a",
        name: "假翻译 A",
        description: "本地假服务，不用 Key",
        icon: "languages",
        hosts: ["localhost"],
        limits: { timeoutMs: 5000 },
        implements: { translate: translate(`http://localhost:${port}/api/a?${q}`) },
      },
      {
        id: "fake-b",
        name: "假翻译 B",
        description: "本地假服务，不用 Key；可以让它出错",
        icon: "languages",
        hosts: ["localhost"],
        limits: { timeoutMs: 5000 },
        implements: { translate: translate(`http://localhost:${port}/api/b?${q}`) },
      },
      {
        id: "fake-page",
        name: "假整页翻译",
        description: "本地假服务，不用 Key；一次翻译整批段落，可以让其中一批出错",
        icon: "languages",
        hosts: ["localhost"],
        limits: { timeoutMs: 5000 },
        implements: {
          translate: {
            http: {
              request: { method: "POST", url: `http://localhost:${port}/api/page`, json: { texts: "{{ input.texts }}", to: "{{ input.to }}" } },
              response: "json",
              output: { texts: "{{ response.texts }}" },
              errors: [{ status: "5xx", type: "server", message: "假服务出错了" }],
            },
          },
        },
      },
      {
        id: "fake-key",
        name: "带 Key 的假翻译",
        description: "本地假服务，需要 Key",
        icon: "key-round",
        secrets: [{ name: "apiKey", title: "API Key", placeholder: "e2e-…" }],
        hosts: [keyHost],
        limits: { timeoutMs: 5000 },
        implements: {
          translate: translate(`http://${keyHost}:${port}/api/key?${q}`, {
            headers: { Authorization: "Bearer {{ secret.apiKey }}" },
          }),
        },
      },
      {
        id: "fake-llm",
        name: "假大模型",
        description: "本地假大模型，不用 Key；答案由测试脚本指定",
        icon: "bot",
        hosts: ["localhost"],
        limits: { timeoutMs: 8000 },
        implements: {
          choose: choose(port),
          chat: llmChat(port, "{{ input.messages }}", { text: "{{ response.choices[0].message.content }}" }),
        },
      },
      {
        // The same fake model under another host: picking it for 跳过广告 changes where the entry
        // sends, which pauses it until the user confirms again (R3.3).
        id: "fake-llm-other",
        name: "假大模型（另一个地址）",
        description: "同一个本地假大模型，走 127.0.0.1",
        icon: "bot",
        hosts: ["127.0.0.1"],
        limits: { timeoutMs: 8000 },
        implements: { choose: choose(port, "127.0.0.1") },
      },
      {
        // Inherits fake-key's secrets: the "共用 Key" state (R5.6).
        id: "fake-key-mirror",
        extends: "fake-key",
        name: "带 Key 的假翻译（镜像）",
        description: "和「带 Key 的假翻译」共用 Key",
      },
      {
        // Extends an engine from a pack nobody subscribed: the "引擎有问题" state (R2.6).
        id: "fake-broken",
        extends: "e2e-missing/engine",
        name: "坏掉的假翻译",
        description: "继承了一个不存在的引擎",
      },
    ],
  };
}
