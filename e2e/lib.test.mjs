import assert from "node:assert/strict";
import test from "node:test";
import { Page, inPageFillBody } from "./lib.mjs";

const SECRET = "s3cr3t-value-ZZZ";

/** A Page whose browser calls are recorded instead of made. */
function fakePage({ evalResult, evalThrows }) {
  const p = new Page("1");
  p.calls = [];
  p.eval = (body) => {
    p.calls.push(["eval", body]);
    if (evalThrows) throw evalThrows;
    return evalResult;
  };
  p.ref = () => "e9";
  p.sctlRun = (args) => p.calls.push(["sctl", args]);
  return p;
}

/** Runs the in-page body against a tiny fake DOM; returns {result, input}. */
async function runBody(body, inputs) {
  const events = [];
  const proto = { _v: "" };
  class HTMLInputElement {}
  Object.defineProperty(HTMLInputElement.prototype, "value", { set(v) { this._v = v; }, get() { return this._v; }, configurable: true });
  class Event { constructor(type) { this.type = type; } }
  const els = inputs.map((i) => Object.assign(new HTMLInputElement(), { ...i, focused: false, getAttribute: (n) => i.attrs?.[n] ?? null, focus() { this.focused = true; }, dispatchEvent(e) { events.push(e.type); } }));
  const doc = { querySelector: () => null, querySelectorAll: () => els };
  const fn = new Function("document", "HTMLInputElement", "Event", `return (async () => { ${body}\n})()`);
  const result = await fn(doc, HTMLInputElement, Event);
  return { result, els, events };
}

test("a password input is set in-page with input+change, never focused", async () => {
  const { result, els, events } = await runBody(inPageFillBody("API Key", SECRET, false), [{ type: "password", attrs: { "aria-label": "API Key" } }]);
  assert.equal(result, "set");
  assert.equal(els[0].value, SECRET);
  assert.equal(els[0].focused, false);
  assert.deepEqual(events, ["input", "change"]);
});

test("a text input is left for sctl fill unless marked secret", async () => {
  const text = [{ type: "text", attrs: { "aria-label": "Token" } }];
  assert.equal((await runBody(inPageFillBody("Token", SECRET, false), text)).result, "skip");
  const r = await runBody(inPageFillBody("Token", SECRET, true), text);
  assert.equal(r.result, "set");
  assert.equal(r.els[0].value, SECRET);
});

test("a missing field is skip for a plain fill and an error without the value for a secret one", async () => {
  assert.equal((await runBody(inPageFillBody("Nope", SECRET, false), [])).result, "skip");
  await assert.rejects(() => runBody(inPageFillBody("Nope", SECRET, true), []), (e) => !e.message.includes(SECRET) && /Nope/.test(e.message));
});

test("Page.fill routes: in-page result set means no sctl fill; skip falls back to sctl fill", () => {
  const a = fakePage({ evalResult: "set" });
  a.fill("textbox", "API Key", SECRET);
  assert.equal(a.calls.filter((c) => c[0] === "sctl").length, 0);
  const b = fakePage({ evalResult: "skip" });
  b.fill("textbox", "规则订阅地址", "http://x");
  assert.deepEqual(b.calls.at(-1), ["sctl", ["page", "fill", "e9", "http://x", "--tab", "1"]]);
});

test("Page.fill errors never carry the value", () => {
  const p = fakePage({ evalThrows: new Error(`boom ${SECRET}`) });
  assert.throws(() => p.fill("textbox", "API Key", SECRET, { secret: true }), (e) => !e.message.includes(SECRET));
});

const NOT_AUTOMATABLE = new Error("sctl page eval failed: error: PAGE_NOT_AUTOMATABLE: Cannot access a chrome-extension:// URL of different extension");

test("Page.recover: a tab that is not automatable (a password manager's frame) is reloaded and the command tried once more", () => {
  const p = new Page("7");
  const calls = [];
  p.sctlRun = (args) => calls.push(args);
  let n = 0;
  const v = p.recover(() => {
    if (n++ === 0) throw NOT_AUTOMATABLE;
    return "ok";
  });
  assert.equal(v, "ok");
  assert.equal(n, 2);
  assert.deepEqual(calls, [["tabs", "reload", "7"], ["page", "wait", "--load", "load", "--tab", "7"]]);
  assert.equal(p.recovered, 1);
});

test("Page.recover: other errors, and a second failure, are thrown as they are", () => {
  const p = new Page("7");
  p.sctlRun = () => {};
  assert.throws(() => p.recover(() => { throw new Error("timeout waiting for x"); }), /timeout waiting/);
  assert.equal(p.recovered ?? 0, 0);
  assert.throws(() => p.recover(() => { throw NOT_AUTOMATABLE; }), /PAGE_NOT_AUTOMATABLE/);
});
