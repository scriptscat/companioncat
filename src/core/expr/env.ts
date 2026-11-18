import { Environment, type ParseResult } from "@marcbachmann/cel-js";
import { installBudget, timedCall } from "./budget";
import { registerFunctions } from "./functions";
import { PAGE_FUNCTIONS, type PageFunction, registerElementType, registerPageFunctions } from "./page";

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
  /** Automation only: the trigger that fired (R1.4). */
  "trigger",
  /** Engine requests and step output only: `landed.<step id>.url` / `.host`, where a step ended up after redirects. */
  "landed",
] as const;

export type VarName = (typeof VARIABLES)[number];

/**
 * R8.1: the functions every position may call. CEL's standard macros are allowed too; the
 * rest of cel-js's standard library (matches, startsWith, int(), type(), …) is refused.
 */
export const BASE_FUNCTIONS = [
  "concat", "replace", "split", "join", "contains", "urlencode", "base64", "hex", "md5", "sha256",
  "hmacSha256", "now", "unix", "uuid", "random", "json", "extractJson", "match", "langName",
  "languages", "lang", "host", "has", "size",
  // standard macros
  "all", "exists", "exists_one", "map", "filter",
] as const;

export type FunctionName = (typeof BASE_FUNCTIONS)[number] | PageFunction;

/** A place in a rule where templates are evaluated, with the variables and functions allowed there. */
export interface Position {
  readonly name: string;
  readonly vars: readonly VarName[];
  readonly functions: ReadonlySet<FunctionName>;
}

export function position(name: string, vars: readonly VarName[], functions: readonly FunctionName[] = BASE_FUNCTIONS): Position {
  return { name, vars, functions: new Set(functions) };
}

/** R8.4 structural limits, enforced at parse time. */
const LIMITS = {
  maxAstNodes: 2000,
  maxDepth: 32,
  maxListElements: 1000,
  maxMapEntries: 1000,
} as const;

/** Thrown at compile time for a call the position does not allow; shaped like cel-js's own errors. */
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

const isPageFunction = (name: string) => (PAGE_FUNCTIONS as readonly string[]).includes(name);

/** The first call (global or method) in `node` whose function `pos` does not allow. */
function firstForbidden(node: unknown, pos: Position): NotWhitelisted | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const bad = firstForbidden(n, pos);
      if (bad) return bad;
    }
    return undefined;
  }
  if (!isNode(node)) return undefined;
  if ((node.op === "call" || node.op === "rcall") && Array.isArray(node.args) && typeof node.args[0] === "string") {
    const name = node.args[0];
    if (!pos.functions.has(name as FunctionName)) {
      const message = isPageFunction(name)
        ? `函数 ${name}() 不能在「${pos.name}」里使用，只能用在自动化入口的 triggers、run 里`
        : `函数 ${name}() 不在白名单里`;
      return new NotWhitelisted(message, { start: node.start ?? 0, end: node.end ?? 0 });
    }
  }
  return firstForbidden(node.args, pos);
}

interface CompiledEnv {
  env: Environment;
  cache: Map<string, ParseResult>;
}

const envs = new Map<string, CompiledEnv>();
const envKeys = new WeakMap<Position, string>();
const CACHE_MAX = 4096;

/** Handlers run with the Evaluator as `this`; the first call hands it to the budget. */
const budgeted =
  (h: (this: unknown, ...args: never[]) => unknown) =>
  function (this: unknown, ...args: never[]) {
    installBudget(this);
    return timedCall(() => h.apply(this, args));
  };

/**
 * One environment per allowed variable and page-function set: unlisted variables fail type
 * checking, and page functions exist only where the position allows them.
 */
function envFor(pos: Position): CompiledEnv {
  let key = envKeys.get(pos);
  if (key === undefined) {
    // The compile cache skips the function check, so the key holds the whole function set.
    key = `${[...new Set(pos.vars)].sort().join(",")}|${[...pos.functions].sort().join(",")}`;
    envKeys.set(pos, key);
  }
  let entry = envs.get(key);
  if (!entry) {
    const env = new Environment({ homogeneousAggregateLiterals: false, limits: LIMITS });
    for (const v of new Set(pos.vars)) env.registerVariable(v, "dyn");
    registerElementType(env);
    registerFunctions(env, budgeted);
    registerPageFunctions(env, [...pos.functions].filter(isPageFunction), budgeted);
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
    const forbidden = firstForbidden(parsed.ast, pos);
    if (forbidden) throw forbidden;
    const checked = parsed.check();
    if (!checked.valid) throw checked.error;
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(source, parsed);
  }
  return parsed;
}
