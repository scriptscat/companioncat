import assert from "node:assert/strict";
import test from "node:test";
import { GRANTS, checkBuild, checkMeta, RELEASE_BASE } from "./check-build.mjs";

const CSS = ':host { --fur: #f80; --color-x: 1px; } .rounded-sm { border-radius: 2px; }';
const header = [
  "// ==UserScript==",
  "// @name         陪伴猫",
  "// @namespace    https://example.test",
  "// @version      0.2.0",
  "// @license      GPL-3.0",
  "// @updateURL    https://github.com/scriptscat/companioncat/releases/latest/download/companioncat.meta.js",
  "// @downloadURL  https://github.com/scriptscat/companioncat/releases/latest/download/companioncat.user.js",
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
  assert.deepEqual(checkBuild(bundle(`${withFeatures}\nshadow.adoptedStyleSheets = [sheet];`), [], FEATURES, { version: "0.2.0" }), []);
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

const OPTS = { version: "0.2.0" };
const run = (h, o = OPTS) => checkBuild(`${h}\nconst css = ${JSON.stringify(CSS)};\n${withFeatures}`, [], FEATURES, o);

test("the header version must equal package.json", () => {
  assert.deepEqual(run(header, { version: "0.3.0" }), ["@version is 0.2.0, package.json says 0.3.0"]);
});

test("updateURL and downloadURL must point at the GitHub release assets", () => {
  const bad = header.replace("releases/latest/download/companioncat.meta.js", "x/meta.js").replace(/@downloadURL.*/, "@downloadURL  https://x.test/a.js");
  const f = run(bad).join("\n");
  assert.match(f, /@updateURL/);
  assert.match(f, /@downloadURL/);
  assert.equal(RELEASE_BASE, "https://github.com/scriptscat/companioncat/releases/latest/download/");
});

test("a missing @license is reported", () => {
  assert.deepEqual(run(header.replace("// @license      GPL-3.0\n", "")), ["@license is undefined, want GPL-3.0"]);
});

test("meta.js must be exactly the user.js header", () => {
  assert.deepEqual(checkMeta(`${header}\nbody`, `${header}\n`), []);
  assert.deepEqual(checkMeta(`${header}\nbody`, null), ["dist/companioncat.meta.js is missing"]);
  assert.match(checkMeta(`${header}\nbody`, header.replace("0.2.0", "0.1.0"))[0], /does not match/);
  assert.match(checkMeta(`${header}\nbody`, `${header}\nbody`)[0], /does not match/);
});
