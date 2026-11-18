import assert from "node:assert/strict";
import test from "node:test";
import { checkPack } from "../rules/scripts/check.mjs";
import { startServer } from "./server.mjs";
import { DRAFT_BAD, DRAFT_V1, DRAFT_V2, TEACH_QUICK_REPLY, TEACH_CORRECTION, teachReplies } from "./script.mjs";

const wrap = (feature) => JSON.stringify({ schema: 1, id: "local", features: [feature] });
const problems = (feature) => checkPack(wrap(feature));

test("the fixed drafts v1 and v2 are valid automation features", () => {
  assert.deepEqual(problems(DRAFT_V1), []);
  assert.deepEqual(problems(DRAFT_V2), []);
});

test("the deliberately broken draft fails validation with exactly one problem", () => {
  assert.equal(problems(DRAFT_BAD).length, 1);
});

test("the drafts differ the way the scenario needs: v1 finds all buttons, v2 only the article's", () => {
  const find = (d) => d.entries[0].run.find((s) => s.find);
  assert.equal(find(DRAFT_V1).all, true);
  assert.notEqual(find(DRAFT_V2).all, true);
  assert.match(find(DRAFT_V2).find, /article/);
  assert.equal(DRAFT_BAD.id, DRAFT_V1.id);
  assert.equal(DRAFT_V2.id, DRAFT_V1.id);
});

test("teachReplies queue: question, broken draft, fixed draft v1, then v2, all in the teach reply format", () => {
  const replies = teachReplies();
  assert.equal(replies.length, 4);
  const [q, bad, v1, v2] = replies.map((r) => r.json);
  assert.ok(q.message && q.questions[0].quickReplies.includes(TEACH_QUICK_REPLY));
  assert.equal(q.draft, undefined);
  assert.deepEqual(bad.draft, DRAFT_BAD);
  assert.deepEqual(v1.draft, DRAFT_V1);
  assert.deepEqual(v2.draft, DRAFT_V2);
  assert.equal(TEACH_CORRECTION, "只点正文那个");
});

test("the news page is served with both 展开全文 buttons, reply buttons and click records", async () => {
  const s = await startServer(4731);
  try {
    const r = await fetch("http://localhost:4731/news");
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.equal(html.match(/展开全文/g).length >= 2, true);
    assert.match(html, /展开 \d+ 条回复/);
    assert.match(html, /dataset\.bodyClicks/);
    assert.match(html, /<article[\s\S]*展开全文[\s\S]*<\/article>/);
  } finally {
    await s.close();
  }
});
