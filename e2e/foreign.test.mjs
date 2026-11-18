import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { stripForeign } from "./foreign.mjs";

const body = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body;

test("other extensions' marks (Immersive Translate's data-imt-* attributes and popup) are removed", () => {
  const b = body('<nav><li data-imt-p="1">Home</li></nav><div id="immersive-translate-popup"></div><p data-immersive-translate-walked="x" class="a">Text</p>');
  stripForeign(b);
  assert.equal(b.innerHTML, '<nav><li>Home</li></nav><p class="a">Text</p>');
});

test("the page's own markup and the cat are left alone", () => {
  const html = '<p id="p1" data-n="1" class="imtx">One</p><companion-cat></companion-cat><companion-cat-tr></companion-cat-tr>';
  const b = body(html);
  stripForeign(b);
  assert.equal(b.innerHTML, html);
});

test("immersive-translate elements by tag or class are removed", () => {
  const b = body('<p>One<font class="immersive-translate-target-wrapper">一</font></p><immersive-translate-x></immersive-translate-x>');
  stripForeign(b);
  assert.equal(b.innerHTML, "<p>One</p>");
});

test("works on a detached clone (how the scenarios snapshot body)", () => {
  const b = body('<div><li data-imt-p="1">Home</li><div id="immersive-translate-popup"><span></span></div></div>').cloneNode(true);
  stripForeign(b);
  assert.equal(b.innerHTML, "<div><li>Home</li></div>");
});

test("an empty style attribute (left by another extension's inspection) is dropped; a real style stays", () => {
  const b = body('<p id="a" style="">A</p><p id="b" style="color: red;">B</p>');
  stripForeign(b);
  assert.equal(b.innerHTML, '<p id="a">A</p><p id="b" style="color: red;">B</p>');
});
