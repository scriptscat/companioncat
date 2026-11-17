/** Test-only helpers (not imported by runtime code). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRules, type Resolved } from "../../core/rules";

const read = (n: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "rules/packs", `${n}.json`), "utf8"));

/** Both official packs through resolveRules, optionally under a local pack (for overrides). */
export function official(local?: object): Resolved {
  return resolveRules([
    ...(local ? [{ pack: { schema: 1, id: "local", ...local }, local: true }] : []),
    { pack: read("official-translate"), official: true },
    { pack: read("official-llm"), official: true },
  ]);
}
