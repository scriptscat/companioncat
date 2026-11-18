import assert from "node:assert/strict";
import test from "node:test";
import { GRANTS, checkBuild } from "./check-build.mjs";

const CSS = ':host { --fur: #f80; --color-x: 1px; } .rounded-sm { border-radius: 2px; }';
const header = [
  "// ==UserScript==",
  "// @name         陪伴猫",
  "// @namespace    https://example.test",
  "// @version      0.1.0",
  "// @description  d",
  "// @match        http://*/*",
  "// @match        https://*/*",
  "// @noframes",
  "// @connect      *",
  ...GRANTS.map((g) => `// @grant        ${g}`),
  "// ==/UserScript==",
].join("\n");
const bundle = (body) => `${header}\nconst css = ${JSON.stringify(CSS)};\n${body}`;
const FEATURES = ["automation", "compare", "teach"];
const withFeatures = FEATURES.map((f) => `defineFeature({ id: "${f}" });`).join("\n");

test("a bundle with every feature runtime and shadow-root CSS passes", () => {
  assert.deepEqual(checkBuild(bundle(`${withFeatures}\nshadow.adoptedStyleSheets = [sheet];`), [], FEATURES), []);
});

test("a feature runtime missing from the bundle is reported by id", () => {
  const failures = checkBuild(bundle('defineFeature({ id: "automation" });'), [], FEATURES);
  assert.deepEqual(failures, ["feature runtime compare not in the bundle", "feature runtime teach not in the bundle"]);
});

test("adopting a stylesheet into the page document fails (CSS only goes into shadow roots)", () => {
  const failures = checkBuild(bundle(`${withFeatures}\ndocument.adoptedStyleSheets = [sheet];`), [], FEATURES);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /document\.adoptedStyleSheets/);
});

test("eval is still refused", () => {
  assert.match(checkBuild(bundle(`${withFeatures}\neval("1")`), [], FEATURES).join("\n"), /eval\(/);
});
