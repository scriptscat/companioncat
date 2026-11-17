import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const ID = "virtual:builtin-packs";
const RESOLVED = `\0${ID}`;

export interface BuiltinPacksOptions {
  /** The rules repository checkout (default `rules`, relative to the cwd). */
  dir?: string;
}

/**
 * Exposes `virtual:builtin-packs`: `packs` (the JSON in rules/packs, parsed) and `commit` (the
 * rules commit, or a content hash when git is unavailable) as the built-in snapshot.
 */
export default function builtinPacks(options: BuiltinPacksOptions = {}): Plugin {
  const dir = path.resolve(options.dir ?? "rules");
  const packsDir = path.join(dir, "packs");

  function read() {
    const files = fs.readdirSync(packsDir).filter((f) => f.endsWith(".json")).sort();
    const texts = files.map((f) => fs.readFileSync(path.join(packsDir, f), "utf8"));
    let commit: string;
    try {
      commit = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      commit = createHash("sha1").update(texts.join("\n")).digest("hex");
    }
    return { commit, packs: texts.map((t) => JSON.parse(t) as unknown), files };
  }

  return {
    name: "companioncat:builtin-packs",
    resolveId(id) {
      return id === ID ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      const { commit, packs, files } = read();
      for (const f of files) this.addWatchFile(path.join(packsDir, f));
      return `export const commit = ${JSON.stringify(commit)};\nexport const packs = ${JSON.stringify(packs)};\n`;
    },
  };
}
