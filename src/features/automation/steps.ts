/**
 * R1.2 automation steps that read the page or ask an engine: `find` collects visible elements as
 * handles, `ask` builds the invoke request (also what a dry run reports it would send).
 */
import { CallError } from "../../core/errors";
import { elementHandle, elementOf, isElementHandle, renderTemplate, type ElementHandle, type PageHost, type Position, type Scope } from "../../core/expr";
import type { InvokeResult, Strategy } from "../../core/invoke";
import type { ActStep, AskStep, Below, FindStep } from "../../core/rules/types";
import { toList } from "../selection/steps";

/** A rule value the executor cannot use (not an expression error, not a call error). */
export class RuleValueError extends Error {
  override readonly name = "RuleValueError";
}

/**
 * Finds the candidates for an `auto:<name>` selector (e.g. auto:questions) inside `root`: elements
 * (kept when visible, as handles) or plain data carrying handles (kept as is, the finder chose them).
 */
export type Finder = (root: ParentNode, host: PageHost) => unknown[];

export interface FindDeps {
  host: PageHost;
  finders?: Readonly<Record<string, Finder>>;
}

function queryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    throw new RuleValueError(`选择器无效：${selector}`);
  }
}

/** Also for elements of another realm (frames), where instanceof Element fails. */
const isElement = (v: unknown): v is Element => !!v && typeof v === "object" && (v as Node).nodeType === 1;

/** The element to search inside: a handle, a selector (its first match) or nothing found. */
function rootOf(within: unknown): ParentNode | null {
  if (within === undefined) return document;
  if (within === null) return null;
  if (isElementHandle(within)) return elementOf(within);
  if (typeof within === "string") return queryAll(document, within)[0] ?? null;
  throw new RuleValueError("within 需要一个元素或选择器");
}

/**
 * Visible elements matching `step.find` as handles (first only unless `all`), filtered by `where`
 * with `item` = the element; `itemPos` is the run position with `item`. An `auto:` finder may give
 * plain data instead, which is filtered the same way. Nothing found → [].
 */
export async function findElements(step: FindStep, scope: Scope, pos: Position, itemPos: Position, deps: FindDeps): Promise<unknown[]> {
  const r = (await renderTemplate({ find: step.find, within: step.within }, scope, pos)) as { find: unknown; within?: unknown };
  if (typeof r.find !== "string" || !r.find) throw new RuleValueError("find 需要一个选择器");
  const selector = r.find;
  const root = rootOf(r.within);
  if (!root) return [];
  let candidates: unknown[];
  if (selector.startsWith("auto:")) {
    const finder = deps.finders?.[selector];
    if (!finder) throw new RuleValueError(`不认识的查找方式：${selector}`);
    candidates = finder(root, deps.host);
  } else {
    candidates = queryAll(root, selector);
  }
  const out: unknown[] = [];
  for (const c of candidates) {
    let item = c;
    if (isElement(c)) {
      if (!c.isConnected || !deps.host.visible(c)) continue;
      item = elementHandle(c, deps.host);
    }
    if (step.where !== undefined && (await renderTemplate(step.where, { ...scope, item }, itemPos)) !== true) continue;
    out.push(item);
    if (!step.all) break;
  }
  return out;
}

const STRATEGIES: ReadonlySet<string> = new Set<Strategy>(["first", "race", "all", "vote"]);

/** What an ask step sends, to which engines (the dry-run report shows it, R6.5). */
export interface AskRequest {
  contract: string;
  engines: string[];
  strategy: Strategy;
  input: unknown;
}

export async function planAsk(step: AskStep, scope: Scope, pos: Position, preferred: (contract: string) => string[]): Promise<AskRequest> {
  const r = (await renderTemplate({ engine: step.engine, engines: step.engines, strategy: step.strategy, input: step.input }, scope, pos)) as {
    engine?: unknown;
    engines?: unknown;
    strategy?: unknown;
    input?: unknown;
  };
  const strategy = r.strategy ?? "first";
  if (typeof strategy !== "string" || !STRATEGIES.has(strategy)) throw new RuleValueError(`不认识的策略：${String(strategy)}`);
  let engines = toList(r.engine ?? r.engines);
  if (!engines.length) engines = preferred(step.ask);
  return { contract: step.ask, engines, strategy: strategy as Strategy, input: r.input };
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The value an ask writes to vars: its output with the call's confidence (vote: the agreeing share). */
export function askValue(res: InvokeResult): unknown {
  if (!res.ok) throw res.error ?? new CallError("badOutput", `「${res.contract}」没有给出结果`);
  if (!isObject(res.output) || res.confidence === undefined) return res.output;
  return { ...res.output, confidence: res.confidence };
}

/** An act step's fields other than target, rendered and checked. */
export interface ActFields {
  confidence?: number;
  minConfidence?: number;
  below?: Below;
  describe?: string;
  value?: unknown;
  ms?: number;
  selector?: string;
  timeoutMs?: number;
}

const BELOW: ReadonlySet<string> = new Set<Below>(["ask", "hint", "skip"]);

function num(v: unknown, field: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new RuleValueError(`${field} 需要一个数字`);
}

function str(v: unknown, field: string): string | undefined {
  if (v === undefined || typeof v === "string") return v;
  throw new RuleValueError(`${field} 需要一段文字`);
}

/** Renders `pick` of the act's fields (a dry run renders only describe). */
export async function renderActFields(step: ActStep, scope: Scope, pos: Position, pick?: readonly (keyof ActFields)[]): Promise<ActFields> {
  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step)) if (k !== "act" && k !== "target" && (!pick || pick.includes(k as keyof ActFields))) raw[k] = v;
  const r = (await renderTemplate(raw, scope, pos)) as Record<string, unknown>;
  const below = str(r.below, "below");
  if (below !== undefined && !BELOW.has(below)) throw new RuleValueError(`below 只能是 ask、hint 或 skip：${below}`);
  const out: ActFields = {
    confidence: num(r.confidence, "confidence"),
    minConfidence: num(r.minConfidence, "minConfidence"),
    below: below as Below | undefined,
    describe: str(r.describe, "describe"),
    value: r.value,
    ms: num(r.ms, "ms"),
    selector: str(r.selector, "selector"),
    timeoutMs: num(r.timeoutMs, "timeoutMs"),
  };
  for (const k of Object.keys(out) as (keyof ActFields)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** The handles an act works on: none for wait; a target of null or [] gives none. */
export async function actTargets(step: ActStep, scope: Scope, pos: Position): Promise<ElementHandle[] | [undefined]> {
  if (step.act === "wait") return [undefined];
  const t = await renderTemplate(step.target, scope, pos);
  const list = Array.isArray(t) ? t : t === null || t === undefined ? [] : [t];
  if (!list.every(isElementHandle)) throw new RuleValueError("target 需要元素（例如 find 找到的结果）");
  return list;
}

export const ACT_VERBS: Readonly<Record<ActStep["act"], string>> = {
  click: "点击",
  fill: "填写",
  check: "勾选",
  select: "选择",
  scroll: "滚动到",
  focus: "聚焦",
  wait: "等待",
};
