import assert from "node:assert/strict";
import test from "node:test";
import { checkPack } from "../rules/scripts/check.mjs";
import { startServer } from "./server.mjs";
import { testPack, PACK_ID } from "./pack.mjs";
import { LLM_KEY } from "./llm.mjs";
import { blankReply, buttonKey, chooseReply, scriptLlm } from "./script.mjs";

test("buttonKey is the option key describe() gives a button", () => {
  assert.equal(buttonKey("跳过广告 5"), "「跳过广告 5」按钮");
});

test("chooseReply and blankReply are JSON replies the fake serves as the model's text", () => {
  assert.deepEqual(chooseReply("B", 0.5), { json: { choice: "B", confidence: 0.5 } });
  assert.deepEqual(blankReply("Promise", 0.9), { json: { answer: "Promise", confidence: 0.9 } });
});

test("confidence outside 0..1 is refused", () => {
  assert.throws(() => chooseReply("A", 1.5), /confidence/);
  assert.throws(() => chooseReply("A", -0.1), /confidence/);
  assert.throws(() => blankReply("x", Number.NaN), /confidence/);
});

test("the test pack has a keyless engine with choose and chat aimed at the fake llm on port+1", () => {
  const pack = testPack(5000, 1);
  const p = pack.providers.find((x) => x.id === "fake-llm");
  assert.ok(p, "fake-llm provider");
  assert.equal(p.secrets, undefined);
  assert.deepEqual(p.hosts, ["localhost"]);
  for (const c of ["choose", "chat"]) {
    const req = p.implements[c].http.request;
    assert.equal(req.url, "http://localhost:5001/v1/chat/completions");
    assert.equal(req.headers.Authorization, `Bearer ${LLM_KEY}`);
  }
  assert.equal(pack.id, PACK_ID);
});

test("a second keyless choose engine reaches the same fake llm on another host (127.0.0.1), for the R3.3 re-consent", async () => {
  const pack = testPack(5000, 1);
  const p = pack.providers.find((x) => x.id === "fake-llm-other");
  assert.ok(p, "fake-llm-other provider");
  assert.equal(p.name, "假大模型（另一个地址）");
  assert.equal(p.secrets, undefined);
  assert.deepEqual(p.hosts, ["127.0.0.1"]);
  assert.deepEqual(Object.keys(p.implements), ["choose"]);
  assert.equal(p.implements.choose.http.request.url, "http://127.0.0.1:5001/v1/chat/completions");
  assert.deepEqual(checkPack(JSON.stringify(pack)), []);
});

test("server serves the video and quiz pages and scripts the fake llm", async () => {
  const s = await startServer(47190);
  try {
    const video = await (await fetch("http://localhost:47190/video")).text();
    assert.match(video, /id="start-ad"/);
    assert.match(video, /跳过广告 5/);
    assert.match(video, /了解更多/);
    const quiz = await (await fetch("http://localhost:47190/quiz")).text();
    assert.match(quiz, /type="radio"/);
    assert.match(quiz, /type="checkbox"/);
    assert.match(quiz, /id="submit"/);
    assert.equal((await fetch("http://localhost:47190/nope")).status, 404);

    await scriptLlm("http://localhost:47190", [chooseReply("B", 0.5)]);
    const r = await fetch("http://localhost:47191/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${LLM_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
    });
    assert.deepEqual(JSON.parse((await r.json()).choices[0].message.content), { choice: "B", confidence: 0.5 });
  } finally {
    await s.close();
  }
});
