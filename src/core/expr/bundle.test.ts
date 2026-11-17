import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Rollup } from "vite";
import { describe, expect, it } from "vitest";

// Page CSP (R13.1) forbids string-to-code; the bundled expression layer must not use it.
const DYNAMIC_CODE = /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*["'`]|\bsetTimeout\s*\(\s*["'`]/;

async function bundle(entry: string): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: "silent",
    build: { write: false, minify: false, lib: { entry, formats: ["es"], fileName: "out" } },
  })) as Rollup.RollupOutput[] | Rollup.RollupOutput;
  const outputs = Array.isArray(out) ? out : [out];
  return outputs
    .flatMap((o) => o.output)
    .map((c) => (c.type === "chunk" ? c.code : ""))
    .join("\n");
}

describe("bundle path has no eval / new Function (R13.1)", () => {
  it("the detector flags dynamic code in a bundle", async () => {
    const entry = join(mkdtempSync(join(tmpdir(), "cc-bundle-")), "planted.js");
    writeFileSync(entry, 'export const f = new Function("return 1");\n');
    const code = await bundle(entry);
    expect(code).toMatch(DYNAMIC_CODE);
  });

  it("the bundled expression layer (cel-js, js-md5, languages) contains none", async () => {
    const code = await bundle(fileURLToPath(new URL("./index.ts", import.meta.url)));
    expect(code).toContain("hmacSha256"); // really bundled the whitelist
    expect(code).toContain("maxAstNodes"); // and cel-js itself
    expect(code).not.toMatch(DYNAMIC_CODE);
  }, 30_000);
});
