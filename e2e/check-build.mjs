#!/usr/bin/env node
/**
 * Checks dist/companioncat.user.js: the R1.1 header, CSS only for the shadow root (R1.2: no
 * GM_addStyle, nothing written to document.head, px-only compiled Tailwind), nothing that a strict
 * CSP forbids (R13.1: no eval / new Function), the official packs baked in (R2.2) and every
 * src/features/<id>/register.tsx runtime bundled.
 * Usage: node e2e/check-build.mjs [file]   — exit 1 lists every failed check.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.resolve(process.argv[2] ?? path.join(ROOT, "dist/companioncat.user.js"));

export const RELEASE_BASE = "https://github.com/scriptscat/companioncat/releases/latest/download/";
export const GRANTS = [
  "GM_xmlhttpRequest",
  "GM_getValue",
  "GM_setValue",
  "GM_deleteValue",
  "GM_listValues",
  "GM_addValueChangeListener",
  "GM_registerMenuCommand",
  "GM_setClipboard",
];

/** `@key value` lines of the ==UserScript== block, in order. */
export function parseHeader(code) {
  const m = /\/\/ ==UserScript==\n([\s\S]*?)\/\/ ==\/UserScript==/.exec(code);
  if (!m || !code.startsWith("// ==UserScript==")) return null;
  return m[1]
    .split("\n")
    .map((l) => /^\/\/\s+@(\S+)(?:\s+(.*))?$/.exec(l.trim()))
    .filter(Boolean)
    .map((x) => ({ key: x[1], value: (x[2] ?? "").trim() }));
}

/** The JS string literal that holds the shell stylesheet (the one defining the :host tokens). */
function stylesheet(code) {
  for (const m of code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*?:host\s*\{(?:\\.|(?!\1)[^\\])*)\1/g)) {
    if (m[2].includes("--color-") || m[2].includes("--fur")) return m[2];
  }
  return null;
}

/** meta.js must be exactly the user.js header block (plus a trailing newline). */
export function checkMeta(code, meta) {
  if (meta == null) return ["dist/companioncat.meta.js is missing"];
  const end = "// ==/UserScript==";
  const head = code.slice(0, code.indexOf(end) + end.length);
  return meta.trim() === head.trim() ? [] : ["dist/companioncat.meta.js does not match the user.js header"];
}

/** opts.version: the package.json version the header must carry. */
export function checkBuild(code, packs, features = [], opts = {}) {
  const failures = [];
  const fail = (msg) => failures.push(msg);
  const header = parseHeader(code);
  if (!header) return ["no ==UserScript== header at the top of the file"];
  const all = (k) => header.filter((h) => h.key === k).map((h) => h.value);
  const one = (k) => all(k)[0];

  if (one("name") !== "陪伴猫") fail(`@name is ${one("name")}, want 陪伴猫`);
  for (const k of ["namespace", "version", "description"]) if (!one(k)) fail(`@${k} missing`);
  if (opts.version && one("version") !== opts.version) fail(`@version is ${one("version")}, package.json says ${opts.version}`);
  if (one("updateURL") !== `${RELEASE_BASE}companioncat.meta.js`) fail(`@updateURL is ${one("updateURL")}, want ${RELEASE_BASE}companioncat.meta.js`);
  if (one("downloadURL") !== `${RELEASE_BASE}companioncat.user.js`) fail(`@downloadURL is ${one("downloadURL")}, want ${RELEASE_BASE}companioncat.user.js`);
  if (one("license") !== "GPL-3.0") fail(`@license is ${one("license")}, want GPL-3.0`);
  const matches = all("match").sort();
  if (JSON.stringify(matches) !== JSON.stringify(["http://*/*", "https://*/*"])) fail(`@match is ${JSON.stringify(matches)}, want http://*/* and https://*/*`);
  if (all("include").length || all("exclude-match").length) fail("unexpected @include / @exclude-match");
  if (!header.some((h) => h.key === "noframes")) fail("@noframes missing");
  if (JSON.stringify(all("connect")) !== JSON.stringify(["*"])) fail(`@connect is ${JSON.stringify(all("connect"))}, want only *`);
  const grants = all("grant").sort();
  if (JSON.stringify(grants) !== JSON.stringify([...GRANTS].sort())) fail(`@grant is ${JSON.stringify(grants)}, want ${JSON.stringify([...GRANTS].sort())}`);
  for (const k of ["require", "resource"]) if (all(k).length) fail(`unexpected @${k}: the bundle must be self-contained`);
  const runAt = one("run-at");
  if (runAt && runAt !== "document-idle" && runAt !== "document-end") fail(`@run-at ${runAt}`);

  const body = code.slice(code.indexOf("// ==/UserScript=="));
  if (/GM_addStyle|GM\.addStyle/.test(body)) fail("GM_addStyle found: CSS must only go into the shadow root (R1.2)");
  if (/document\.head/.test(body)) fail("document.head found: nothing may be injected into the page's head (R1.2)");
  if (/\bdocument\.adoptedStyleSheets/.test(body)) fail("document.adoptedStyleSheets found: CSS must only go into shadow roots (R1.2)");
  if (/\beval\s*\(/.test(body)) fail("eval( found (R13.1 strict CSP)");
  if (/\bnew\s+Function\s*\(/.test(body) || /[^.\w$]Function\s*\(\s*["'`]/.test(body)) fail("new Function / Function(string) found (R13.1 strict CSP)");

  const css = stylesheet(body);
  if (!css) fail("compiled stylesheet (with :host tokens) not found in the bundle");
  else {
    if (/@import\s+["']tailwindcss/.test(css) || /@apply\b/.test(css)) fail("stylesheet is not compiled by Tailwind");
    if (!/\.rounded-sm\s*\{/.test(css.replace(/\\n/g, "\n"))) fail("stylesheet lacks compiled utilities (.rounded-sm)");
    const rem = /\d*\.?\d+rem\b/.exec(css);
    if (rem) fail(`stylesheet uses rem (${rem[0]}): only px is allowed (R1.2)`);
  }

  for (const p of packs) {
    if (!body.includes(p.id) || (p.version && !body.includes(p.version))) fail(`official pack ${p.id}@${p.version} not embedded`);
    for (const prov of p.providers ?? []) {
      if (prov.name && !body.includes(prov.name)) fail(`official pack ${p.id}: provider ${prov.id} not embedded`);
    }
  }
  for (const f of features) {
    if (!new RegExp(`\\bid:\\s*["']${f}["']`).test(body)) fail(`feature runtime ${f} not in the bundle`);
  }
  return failures;
}

/** Feature ids registered by src/features/<id>/register.tsx (main.tsx globs them). */
function featureIds() {
  const dir = path.join(ROOT, "src/features");
  return readdirSync(dir).filter((d) => existsSync(path.join(dir, d, "register.tsx")));
}

function officialPacks() {
  const dir = path.join(ROOT, "rules/packs");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code;
  try {
    code = readFileSync(FILE, "utf8");
  } catch {
    console.error(`FAIL ${path.relative(ROOT, FILE)} does not exist — run the build first`);
    process.exit(1);
  }
  const packs = officialPacks();
  const features = featureIds();
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const failures = checkBuild(code, packs, features, { version: pkg.version });
  const metaFile = FILE.replace(/\.user\.js$/, ".meta.js");
  failures.push(...checkMeta(code, existsSync(metaFile) ? readFileSync(metaFile, "utf8") : null));
  let commit = "";
  try {
    commit = execFileSync("git", ["-C", path.join(ROOT, "rules"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {}
  if (commit && !code.includes(commit)) failures.push(`rules commit ${commit} not embedded as the built-in snapshot version`);
  for (const f of failures) console.error(`FAIL ${f}`);
  if (failures.length) process.exit(1);
  console.log(`ok   ${path.relative(ROOT, FILE)} (${(code.length / 1024).toFixed(0)} KiB): header v${pkg.version} (urls, license, meta.js), shadow-root CSS, no eval, ${packs.length} official packs, features ${features.join(" ")}`);
}
