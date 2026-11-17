import { JsonSyntaxError, parseLocated, pointer } from "./json";
import { isObject } from "./merge";
import { resolveRules } from "./resolve";
import { validatePack } from "./schema";
import type { Diagnostic, ExprLocation, PackSource, RulePack } from "./types";

export const LOCAL_PACK_ID = "local";

export interface LocalProblem {
  severity: "error" | "warning";
  /** 1-based line of the field in the edited text. */
  line: number;
  column: number;
  /** JSON pointer of the field. */
  path: string;
  message: string;
  expr?: ExprLocation;
}

export interface LocalCheck {
  /** R3.2: the text parses and passes the schema; expression and inheritance errors do not block saving. */
  canSave: boolean;
  pack?: RulePack;
  problems: LocalProblem[];
}

/** A literal that looks like an API key, e.g. `sk-` followed by a long token (R3.3). */
const KEY_LIKE = /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/;

function* strings(value: unknown, path: (string | number)[] = []): Generator<[string, string]> {
  if (typeof value === "string") yield [pointer(path), value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* strings(value[i], [...path, i]);
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) yield* strings(v, [...path, k]);
}

/**
 * Checks the local rules editor text (R3.2, R3.3) against the current subscriptions:
 * JSON syntax, schema, expressions, inheritance and overrides, each with its line.
 */
export function checkLocalRules(text: string, subscriptions: readonly PackSource[] = []): LocalCheck {
  let parsed;
  try {
    parsed = parseLocated(text);
  } catch (e) {
    if (!(e instanceof JsonSyntaxError)) throw e;
    return { canSave: false, problems: [{ severity: "error", ...e.position, path: "", message: e.message }] };
  }
  const { value, locate } = parsed;
  const problems: LocalProblem[] = [];
  const add = (p: { severity: LocalProblem["severity"]; path: string; message: string; expr?: ExprLocation }) =>
    problems.push({ severity: p.severity, ...locate(p.path), path: p.path, message: p.message, ...(p.expr ? { expr: p.expr } : {}) });

  const schema = validatePack(value);
  const schemaErrors = [...schema.errors];
  if (isObject(value) && typeof value.id === "string" && value.id !== LOCAL_PACK_ID) {
    schemaErrors.push({ path: "/id", message: `本地规则的 id 必须是 ${LOCAL_PACK_ID}` });
  }
  const canSave = schemaErrors.length === 0;
  for (const e of schemaErrors) add({ severity: "error", ...e });

  const localSource = subscriptions.length;
  const resolved = resolveRules([...subscriptions, { pack: value, local: true }]);
  const mine = (d: Diagnostic) => d.source === localSource && (canSave || d.expr !== undefined);
  for (const d of resolved.diagnostics.filter(mine)) add(d);

  for (const [path, s] of strings(value)) {
    if (KEY_LIKE.test(s)) add({ severity: "warning", path, message: "API Key 请在引擎页面填写" });
  }

  problems.sort((a, b) => a.line - b.line);
  return { canSave, ...(canSave ? { pack: value as RulePack } : {}), problems };
}
