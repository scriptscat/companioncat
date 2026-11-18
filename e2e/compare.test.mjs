import assert from "node:assert/strict";
import test from "node:test";
import { checkPack } from "../rules/scripts/check.mjs";
import { STRICT_CSP, startServer } from "./server.mjs";
import { PACK_ID, testPack } from "./pack.mjs";

const PORT = 47210;
const base = `http://localhost:${PORT}`;
const getJson = async (p) => (await fetch(base + p, { headers: { connection: "close" } })).json();
const postPage = (texts, to = "zh-CN") =>
  fetch(`${base}/api/page`, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify({ texts, to }) });
const setState = (patch) =>
  fetch(`${base}/admin/state`, { method: "POST", headers: { connection: "close" }, body: JSON.stringify(patch) });

test("the long article: more than 30 paragraphs, a nav, pre/code, a [translate=no] element and an append button", async () => {
  const s = await startServer(PORT);
  try {
    const res = await fetch(`${base}/article`, { headers: { connection: "close" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-security-policy"), null);
    const html = await res.text();
    assert.ok((html.match(/<p[ >]/g) ?? []).length > 30, "paragraph count");
    assert.match(html, /<nav[ >]/);
    assert.match(html, /<pre><code>/);
    assert.match(html, /translate="no"/);
    assert.match(html, /id="append"/);
    assert.match(html, /id="appended"/);
  } finally {
    await s.close();
  }
});

test("the strict-CSP variant sends the STRICT_CSP header and needs no inline script or style", async () => {
  const s = await startServer(PORT);
  try {
    const res = await fetch(`${base}/article-csp`, { headers: { connection: "close" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-security-policy"), STRICT_CSP);
    const html = await res.text();
    assert.ok((html.match(/<p[ >]/g) ?? []).length > 30);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, "inline script");
    assert.doesNotMatch(html, /<style[ >]/, "inline style element");
    assert.doesNotMatch(html, /\sstyle=/, "inline style attribute");
    for (const asset of ["/article.js", "/article.css"]) {
      assert.match(html, new RegExp(`(src|href)="${asset}"`));
      const a = await fetch(base + asset, { headers: { connection: "close" } });
      assert.equal(a.status, 200, asset);
    }
  } finally {
    await s.close();
  }
});

test("the page translator answers one text per input, and failPage fails exactly that many batches", async () => {
  const s = await startServer(PORT);
  try {
    const ok = await postPage(["Hello there", "Second one"]);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { texts: ["[P → zh-CN] Hello there", "[P → zh-CN] Second one"] });

    await setState({ failPage: 1 });
    const bad = await postPage(["x"]);
    assert.equal(bad.status, 500);
    const again = await postPage(["x"]);
    assert.equal(again.status, 200, "only one batch fails");

    const log = await getJson("/admin/log");
    const pages = log.filter((l) => l.path === "/api/page");
    assert.deepEqual(pages.map((l) => l.count), [2, 1, 1], "each request is logged with its text count");
    assert.equal(s.state.failPage, 0);
  } finally {
    await s.close();
  }
});

test("a malformed page-translator body is a 400, not a crash", async () => {
  const s = await startServer(PORT);
  try {
    const r = await fetch(`${base}/api/page`, { method: "POST", headers: { connection: "close" }, body: "{nope" });
    assert.equal(r.status, 400);
  } finally {
    await s.close();
  }
});

test("the test pack has a keyless batch engine 假整页翻译 that POSTs texts to /api/page, and still passes the pack check", () => {
  const pack = testPack(5000, 1);
  const p = pack.providers.find((x) => x.id === "fake-page");
  assert.ok(p, "fake-page provider");
  assert.equal(p.name, "假整页翻译");
  assert.equal(p.secrets, undefined);
  assert.deepEqual(p.hosts, ["localhost"]);
  const req = p.implements.translate.http.request;
  assert.equal(req.method, "POST");
  assert.equal(req.url, "http://localhost:5000/api/page");
  assert.deepEqual(req.json, { texts: "{{ input.texts }}", to: "{{ input.to }}" });
  assert.equal(pack.id, PACK_ID);
  assert.deepEqual(checkPack(JSON.stringify(pack)), []);
});
