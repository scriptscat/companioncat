import { Environment, type ParseResult } from "@marcbachmann/cel-js";
import { installBudget, timedCall } from "./budget";
import { registerFunctions } from "./functions";

/** Every variable a rule expression can name (R8.3). */
export const VARIABLES = [
  "settings",
  "vars",
  "input",
  "secret",
  "options",
  "selection",
  "page",
  "site",
  "steps",
  "response",
  "stream",
  "result",
  "item",
  "params",
  "value",
] as const;

export type VarName = (typeof VARIABLES)[number];

/** A place in a rule where templates are evaluated, with the variables allowed there. */
export interface Position {
  readonly name: string;
  readonly vars: readonly VarName[];
}

export function position(name: string, vars: readonly VarName[]): Position {
  return { name, vars };
}

/** R8.4 structural limits, enforced at parse time. */
const LIMITS = {
  maxAstNodes: 2000,
  maxDepth: 32,
  maxListElements: 1000,
  maxMapEntries: 1000,
} as const;

/**
 * R8.1: the only functions an expression may call. CEL's standard macros are allowed too; the
 * rest of cel-js's standard library (matches, startsWith, int(), type(), …) is refused.
 */
const FUNCTION_WHITELIST: ReadonlySet<string> = new Set([
  "concat", "replace", "split", "join", "contains", "urlencode", "base64", "hex", "md5", "sha256",
  "hmacSha256", "now", "unix", "uuid", "random", "json", "extractJson", "match", "langName",
  "languages", "lang", "host", "has", "size",
  // standard macros
  "all", "exists", "exists_one", "map", "filter",
]);

/** Thrown at compile time for a call outside the whitelist; shaped like cel-js's own errors. */
class NotWhitelisted extends Error {
  override readonly name = "TypeError";
  readonly code = "not_whitelisted";
  constructor(
    readonly summary: string,
    readonly range: { start: number; end: number },
  ) {
    super(summary);
  }
}

type AstNode = { op: string; args: unknown; start?: number; end?: number };
const isNode = (v: unknown): v is AstNode => !!v && typeof v === "object" && typeof (v as AstNode).op === "string";

/** The first call (global or method) in `node` whose function is not whitelisted. */
function firstForbidden(node: unknown): NotWhitelisted | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const bad = firstForbidden(n);
      if (bad) return bad;
    }
    return undefined;
  }
  if (!isNode(node)) return undefined;
  if ((node.op === "call" || node.op === "rcall") && Array.isArray(node.args) && typeof node.args[0] === "string") {
    const name = node.args[0];
    if (!FUNCTION_WHITELIST.has(name)) {
      return new NotWhitelisted(`函数 ${name}() 不在白名单里`, { start: node.start ?? 0, end: node.end ?? 0 });
    }
  }
  return firstForbidden(node.args);
}

interface CompiledEnv {
  env: Environment;
  cache: Map<string, ParseResult>;
}

const envs = new Map<string, CompiledEnv>();
const CACHE_MAX = 4096;

/** One environment per allowed-variable set: unlisted variables fail type checking. */
function envFor(pos: Position): CompiledEnv {
  const key = [...new Set(pos.vars)].sort().join(",");
  let entry = envs.get(key);
  if (!entry) {
    const env = new Environment({ homogeneousAggregateLiterals: false, limits: LIMITS });
    for (const v of new Set(pos.vars)) env.registerVariable(v, "dyn");
    // Handlers run with the Evaluator as `this`; the first call hands it to the budget.
    registerFunctions(env, (h) =>
      function (this: unknown, ...args: never[]) {
        installBudget(this);
        return timedCall(() => h.apply(this, args));
      },
    );
    env.evaluate("languages()");
    entry = { env, cache: new Map() };
    envs.set(key, entry);
  }
  return entry;
}

/** Parses and type-checks `source` for `pos`; throws the CEL ParseError/TypeError. */
export function compile(pos: Position, source: string): ParseResult {
  const { env, cache } = envFor(pos);
  let parsed = cache.get(source);
  if (!parsed) {
    parsed = env.parse(source);
    const forbidden = firstForbidden(parsed.ast);
    if (forbidden) throw forbidden;
    const checked = parsed.check();
    if (!checked.valid) throw checked.error;
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(source, parsed);
  }
  return parsed;
}
