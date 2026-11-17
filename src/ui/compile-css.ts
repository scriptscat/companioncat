/**
 * Test helper: compiles src/ui/styles.css with Tailwind the way the build does, using every
 * class-like token found in src/**\/*.tsx as candidates. Tests use the real stylesheet this way
 * because Vitest does not process `?inline` CSS (it comes back as "").
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { compile } from "tailwindcss";

const SRC = path.resolve(import.meta.dirname, "..");
const TAILWIND = path.dirname(path.resolve(import.meta.dirname, "../../node_modules/tailwindcss/package.json"));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return sources(p);
    return /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [p] : [];
  });
}

export async function compileStyles(extra: string[] = []): Promise<string> {
  const entry = path.join(SRC, "ui/styles.css");
  const compiler = await compile(readFileSync(entry, "utf8"), {
    base: path.dirname(entry),
    async loadStylesheet(id, base) {
      const file =
        id === "tailwindcss"
          ? path.join(TAILWIND, "index.css")
          : id.startsWith("./") || id.startsWith("../")
            ? path.resolve(base, id)
            : path.join(TAILWIND, id.replace(/^tailwindcss\//, ""));
      return { path: file, base: path.dirname(file), content: readFileSync(file, "utf8") };
    },
  });
  const candidates = new Set(extra);
  for (const f of sources(SRC)) for (const t of readFileSync(f, "utf8").split(/[\s"'`]+/)) if (t) candidates.add(t);
  return compiler.build([...candidates]);
}

export const rawStyles = () => readFileSync(path.join(SRC, "ui/styles.css"), "utf8");
