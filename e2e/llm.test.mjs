import assert from "node:assert/strict";
import test from "node:test";
import { LLM_KEY, startFakeLlm } from "./llm.mjs";

const SYS_TRANSLATE = "你是翻译引擎。把用户给出的 JSON 字符串数组里的每一条翻译成简体中文，保持条数和顺序不变。只输出一个 JSON 字符串数组，不要任何解释。";
const SYS_CHOOSE = "你要根据给出的状态回答一个选择题。只输出一个 JSON 对象，包含 choice（选中的选项 id，必须是给出的选项之一）和 confidence（0 到 1 之间的数字，表示你有多确定），不要任何解释。";

let llm;
const base = () => `http://127.0.0.1:${llm.port}`;
const post = (path, body, key = LLM_KEY) =>
  fetch(base() + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
const chat = (messages, extra = {}) => post("/v1/chat/completions", { model: "m", messages, ...extra });
const text = async (res) => (await res.json()).choices[0].message.content;
const sse = async (res) => (await res.text()).split("\n\n").filter(Boolean);

test.before(async () => {
  llm = await startFakeLlm(0);
});
test.after(() => llm.close());
test.beforeEach(() => llm.reset());

test("chat non-stream returns a message", async () => {
  const res = await chat([{ role: "user", content: "hi" }]);
  assert.equal(res.status, 200);
  assert.match(await text(res), /./);
});

test("chat stream is SSE deltas ending with data: [DONE]", async () => {
  const res = await chat([{ role: "user", content: "hi" }], { stream: true });
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const events = await sse(res);
  assert.equal(events.at(-1), "data: [DONE]");
  const joined = events.slice(0, -1).map((e) => JSON.parse(e.replace(/^data: /, "")).choices[0].delta.content).join("");
  llm.reset();
  assert.equal(joined, await text(await chat([{ role: "user", content: "hi" }])));
});

test("responses stream has output_text.delta events and ends with response.completed", async () => {
  llm.queue("你好，世界");
  const res = await post("/v1/responses", { model: "m", input: [{ role: "user", content: "hi" }], stream: true });
  const events = await sse(res);
  assert.match(events[0], /^event: response\.output_text\.delta\n/);
  assert.match(events.at(-1), /^event: response\.completed\n/);
  const deltas = events.filter((e) => e.startsWith("event: response.output_text.delta")).map((e) => JSON.parse(e.split("data: ")[1]).delta);
  assert.equal(deltas.join(""), "你好，世界");
  assert.equal(JSON.parse(events.at(-1).split("data: ")[1]).response.output_text, "你好，世界");
});

test("a wrong key is a 401 JSON error, logged, and does not consume the script", async () => {
  llm.queue("scripted");
  const bad = await post("/v1/chat/completions", { messages: [] }, "wrong");
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("content-type"), /json/);
  assert.ok((await bad.json()).error.message);
  assert.equal(llm.log.at(-1).auth, false);
  assert.equal(await text(await chat([{ role: "user", content: "x" }])), "scripted");
  assert.ok(!JSON.stringify(llm.log).includes("wrong"));
});

test("the script queue answers in order, then falls back to defaults", async () => {
  llm.queue({ question: "只在这个网站吗？" }, { json: { draft: "bad" } }, "plain");
  const m = [{ role: "user", content: "x" }];
  assert.deepEqual(JSON.parse(await text(await chat(m))), { question: "只在这个网站吗？" });
  assert.deepEqual(JSON.parse(await text(await chat(m))), { draft: "bad" });
  assert.equal(await text(await chat(m)), "plain");
  assert.notEqual(await text(await chat(m)), "plain");
  assert.equal(llm.log.filter((l) => l.source === "script").length, 3);
});

test("a scripted reply can be an HTTP failure and can see the request", async () => {
  llm.queue({ status: 500, body: { error: { message: "boom" } } }, (req) => `saw ${req.messages.at(-1).content}`);
  assert.equal((await chat([{ role: "user", content: "q" }])).status, 500);
  assert.equal(await text(await chat([{ role: "user", content: "q2" }])), "saw q2");
});

test("the queue is also reachable over HTTP for a separate test process", async () => {
  const r = await fetch(base() + "/admin/script", { method: "POST", body: JSON.stringify({ replies: ["over http"] }) });
  assert.equal(r.status, 200);
  assert.equal(await text(await chat([{ role: "user", content: "q" }])), "over http");
  const log = await (await fetch(base() + "/admin/log")).json();
  assert.equal(log.at(-1).path, "/v1/chat/completions");
});

test("default for the llm-translate bridge is a JSON string array of the same length", async () => {
  const texts = ["one", "two", "three"];
  const out = JSON.parse(await text(await chat([{ role: "system", content: SYS_TRANSLATE }, { role: "user", content: JSON.stringify(texts) }])));
  assert.equal(out.length, 3);
  assert.ok(out.every((s) => typeof s === "string"));
});

test("default for llm-choose is a choice from the given options with a confidence", async () => {
  const user = `状态：{"button":"Skip Ad"}\n问题：是不是跳过按钮？\n选项（id 到说明）：${JSON.stringify({ yes: "是", no: "不是" })}`;
  const out = JSON.parse(await text(await chat([{ role: "system", content: SYS_CHOOSE }, { role: "user", content: user }])));
  assert.ok(["yes", "no"].includes(out.choice));
  assert.ok(out.confidence > 0 && out.confidence <= 1);
});
