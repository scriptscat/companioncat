import { BUDGET_EXCEEDED, BUDGET_KEY, newBudget, spent, TIME_LIMIT_MS, withBudget } from "./budget";
import { fromCel, IntRangeError, stringify, toCel } from "./convert";
import { compile, type Position, VARIABLES } from "./env";
import { ExprError, type ValuePath } from "./errors";
import { scanTemplate } from "./scan";

export { ExprError, type ExprErrorCode, type ValuePath } from "./errors";
export { position, type Position, type VarName } from "./env";

export type Scope = Readonly<Record<string, unknown>>;

interface CelErrorLike {
  name?: string;
  code?: string;
  summary?: string;
  message?: string;
  range?: { start: number; end: number };
}

/** `evaluating`: the error came from running a compiled expression, so it is never a syntax error. */
function toExprError(e: unknown, source: string, offset: number, pos: Position, evaluating = false): ExprError {
  if (e instanceof ExprError) return e;
  const end = offset + source.length;
  if (e instanceof IntRangeError) return new ExprError("int-range", e.message, source, offset, end);
  const err = (e ?? {}) as CelErrorLike;
  const start = offset + (err.range?.start ?? 0);
  const stop = offset + (err.range?.end ?? source.length);
  let message = err.summary ?? err.message ?? String(e);
  if (err.code === "unknown_variable") {
    const name = source.slice(start - offset, stop - offset);
    message = (VARIABLES as readonly string[]).includes(name)
      ? `变量 ${name} 不能在「${pos.name}」里使用`
      : `未知变量 ${name}`;
  }
  const code = err.code === "limit_exceeded" ? "limit" : evaluating || err.name === "EvaluationError" ? "runtime" : "syntax";
  return new ExprError(code, message, source, start, Math.max(start, stop));
}

async function evalExpr(source: string, start: number, celScope: object, pos: Position): Promise<unknown> {
  const budget = newBudget();
  let fn;
  try {
    // Compile first: parsing, type checking and environment warm-up are not charged.
    fn = compile(pos, source);
  } catch (e) {
    throw toExprError(e, source, start, pos);
  }
  try {
    const result = await withBudget(budget, () => fn({ ...celScope, [BUDGET_KEY]: budget }));
    if (spent(budget)) throw BUDGET_EXCEEDED;
    return fromCel(result);
  } catch (e) {
    if (e === BUDGET_EXCEEDED || budget.expired) {
      const msg = `表达式运行超过 ${TIME_LIMIT_MS} ms，已停止`;
      throw new ExprError("timeout", msg, source, start, start + source.length);
    }
    throw toExprError(e, source, start, pos, true);
  }
}

async function renderString(s: string, celScope: object, pos: Position): Promise<unknown> {
  const parts = scanTemplate(s);
  const only = parts[0];
  if (parts.length === 1 && only?.kind === "expr") return evalExpr(only.source, only.start, celScope, pos);
  let out = "";
  for (const p of parts) {
    out += p.kind === "text" ? p.text : stringify(await evalExpr(p.source, p.start, celScope, pos));
  }
  return out;
}

async function renderValue(value: unknown, celScope: object, pos: Position, path: ValuePath): Promise<unknown> {
  try {
    if (typeof value === "string") return await renderString(value, celScope, pos);
  } catch (e) {
    throw e instanceof ExprError ? e.withPath(path) : e;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) out.push(await renderValue(value[i], celScope, pos, [...path, i]));
    return out;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await renderValue(v, celScope, pos, [...path, k]);
    return out;
  }
  return value;
}

/**
 * Renders every `{{ }}` template inside `value` (strings, arrays, objects).
 * A string that is exactly one `{{ }}` yields the raw result; otherwise results are
 * stringified and concatenated. Rejects with an ExprError.
 */
export function renderTemplate(value: unknown, scope: Scope, pos: Position): Promise<unknown> {
  return renderValue(value, toCel(scope) as object, pos, []);
}

function checkValue(value: unknown, pos: Position, path: ValuePath, out: ExprError[]): void {
  if (typeof value === "string") {
    try {
      for (const p of scanTemplate(value)) {
        if (p.kind !== "expr") continue;
        try {
          compile(pos, p.source);
        } catch (e) {
          out.push(toExprError(e, p.source, p.start, pos).withPath(path));
        }
      }
    } catch (e) {
      out.push(toExprError(e, value, 0, pos).withPath(path));
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => checkValue(v, pos, [...path, i], out));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) checkValue(v, pos, [...path, k], out);
  }
}

/** Statically checks every template in `value` (syntax, types, variables allowed at `pos`, limits). */
export function checkTemplate(value: unknown, pos: Position): ExprError[] {
  const out: ExprError[] = [];
  checkValue(value, pos, [], out);
  return out;
}
