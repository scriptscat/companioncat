/**
 * R1.2 / R1.6 / R6.5: runs an automation entry's steps. Expressions are rendered at
 * POSITIONS.autoRun (with `item` inside repeat-each bodies). A live run stops at the first
 * failure; a dry run never acts and never calls an engine, and reports what each step would do.
 */
import { isCallError, type ErrorType } from "../../core/errors";
import { domHost, ExprError, isElementHandle, renderTemplate, type ElementHandle, type PageHost, type Position, type Scope } from "../../core/expr";
import type { ConfirmHost, Invoker } from "../../core/invoke";
import { POSITIONS, withVars } from "../../core/rules/positions";
import type { ActStep, Below, RepeatStep, RunStepDef } from "../../core/rules/types";
import { planCall, renderSet, runCall, type StepEnv, type Vars } from "../selection/steps";
import { ACT_VERBS, actTargets, askValue, findElements, planAsk, renderActFields, RuleValueError, type AskRequest, type Finder } from "./steps";

export type { Finder } from "./steps";
export type { Vars } from "../selection/steps";

/** `settings`, `page`, `site`, and for some triggers `selection` / `trigger` (`vars`, `item` are added per step). */
export type AutoScope = Readonly<Partial<Record<"settings" | "selection" | "page" | "site" | "trigger", unknown>>>;

/** Where a step is inside the entry's `run`, e.g. [2, "then", 0]. */
export type StepPath = readonly (string | number)[];

export type StepKind = "set" | "call" | "find" | "act" | "ask" | "if" | "repeat" | "stop";

export interface StepError {
  /** A call error type (R6.3), `expr` for an expression error, `rule` for an unusable rule value. */
  type: ErrorType | "expr" | "rule";
  message: string;
}

/** What a call or ask step sends (or would send) and to which engines. */
export type WouldSend = AskRequest;

/** One executed step. */
export interface StepReport {
  path: StepPath;
  kind: StepKind;
  summary: string;
  /** find: the handles it found (for finder data, each item's `handle`); dry act: its targets (dry runs highlight them). */
  found?: ElementHandle[];
  send?: WouldSend;
  /** Dry run: the unknown answers (ask/call results) this step reads, so it is shown but not run. */
  dependsOn?: string[];
  error?: StepError;
}

export interface RunReport {
  mode: "live" | "dry";
  /** done: every step ran; stop: a stop step (or act) ended it; error: a step failed; aborted: discarded. */
  end: "done" | "stop" | "error" | "aborted";
  steps: StepReport[];
  vars: Vars;
}

/** An act step's fields rendered for this run. */
export interface ActCtx {
  path: StepPath;
  confidence?: number;
  minConfidence?: number;
  below?: Below;
  describe?: string;
  value?: unknown;
  ms?: number;
  selector?: string;
  timeoutMs?: number;
  vars: Vars;
  signal?: AbortSignal;
}

/** What an act did; `stop` ends the run (e.g. a wait that timed out), with `error` when it failed. */
export interface ActOutcome {
  summary?: string;
  error?: StepError;
  stop?: boolean;
}

export interface AutoEnv {
  invoker: Pick<Invoker, "invoke" | "preferredEngines">;
  /** Default live. */
  mode?: "live" | "dry";
  /** Aborting (navigation, re-trigger) discards the rest of the run. */
  signal?: AbortSignal;
  /** Performs one act on one target (none for wait). Never called in a dry run. */
  act(step: ActStep, target: ElementHandle | undefined, ctx: ActCtx): ActOutcome | void | Promise<ActOutcome | void>;
  /** Each step as it finishes (failures included); not called for a discarded step. */
  log?(entry: StepReport): void;
  /** `auto:<name>` find selectors. */
  finders?: Readonly<Record<string, Finder>>;
  /** Default the real page. */
  host?: PageHost;
  confirmHost?: ConfirmHost;
  nameOf?(ref: string): string | undefined;
}

class Halt {
  constructor(readonly end: "stop" | "error" | "aborted") {}
}

const AUTO = POSITIONS.autoRun;
const AUTO_ITEM = withVars(POSITIONS.autoRun, "item");

interface Frame {
  /** The innermost repeat-each item, when there is one. */
  item?: { value: unknown };
  /** Dry run: inside a branch that may not run (its condition read an unknown answer). */
  maybe?: boolean;
}

const KINDS = ["set", "call", "find", "act", "ask", "if", "repeat", "stop"] as const;

/** Undefined for a step the schema would refuse; such steps are skipped, as phase-1 run does. */
function kindOf(step: RunStepDef): StepKind | undefined {
  return KINDS.find((k) => step[k] !== undefined);
}

function toStepError(e: unknown): StepError {
  if (isCallError(e)) return { type: e.type, message: e.message };
  if (e instanceof ExprError) return { type: "expr", message: e.message };
  return { type: "rule", message: e instanceof Error ? e.message : String(e) };
}

/** The handles a find gave: the elements themselves, or the `handle` of each finder data item. */
const handlesOf = (found: readonly unknown[]): ElementHandle[] =>
  found.flatMap((x) => (isElementHandle(x) ? [x] : x && typeof x === "object" && isElementHandle((x as { handle?: unknown }).handle) ? [(x as { handle: ElementHandle }).handle] : []));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Which of `names` the templates in `value` read as vars.<name>. */
function reads(value: unknown, names: ReadonlySet<string>): string[] {
  if (!names.size) return [];
  const text = JSON.stringify(value) ?? "";
  return [...names].filter((n) => new RegExp(`vars\\s*(?:\\.\\s*${escape(n)}\\b|\\[\\s*\\\\?["']${escape(n)}\\\\?["']\\s*\\])`).test(text));
}

/** A step without its nested step lists. */
const NESTED = new Set(["then", "else", "steps"]);
const ownFields = (step: RunStepDef) => Object.fromEntries(Object.entries(step).filter(([k]) => !NESTED.has(k)));

const outputsOf = (step: RunStepDef): string[] =>
  step.set ? Object.keys(step.set) : step.call ? [step.as ?? "result"] : step.ask !== undefined ? [step.as ?? "result"] : step.find !== undefined ? [step.as] : [];

export async function runAutomation(steps: readonly RunStepDef[], scope: AutoScope, env: AutoEnv): Promise<RunReport> {
  const mode = env.mode ?? "live";
  const dry = mode === "dry";
  const host = env.host ?? domHost;
  const report: RunReport = { mode, end: "done", steps: [], vars: {} };
  let vars: Vars = {};
  /** Dry run: vars an ask or call would have written (their values are unknown). */
  const unknown = new Set<string>();
  const stepEnv: StepEnv = {
    invoker: env.invoker,
    nameOf: env.nameOf ?? (() => undefined),
    vars: { get: () => vars, set: (v) => (vars = v) },
    signal: env.signal,
    confirmHost: env.confirmHost,
  };

  const checkAbort = () => {
    if (env.signal?.aborted) throw new Halt("aborted");
  };
  const at = (frame: Frame): [Scope, Position] => [
    { ...scope, vars, ...(frame.item ? { item: frame.item.value } : {}) },
    frame.item ? AUTO_ITEM : AUTO,
  ];
  /** A step finished after an abort is discarded, not recorded. */
  const record = (entry: StepReport) => {
    checkAbort();
    report.steps.push(entry);
    env.log?.(entry);
  };
  /** Records a failed step; a live run ends there, a dry run goes on. */
  const fail = (entry: StepReport, e: unknown) => {
    entry.error = toStepError(e);
    entry.summary ||= "出错了";
    record(entry);
    if (!dry) throw new Halt("error");
  };

  /** Dry run: a step whose own fields read an unknown answer is shown, not run. */
  function dependent(step: RunStepDef, entry: StepReport): boolean {
    const deps = reads(step.act !== undefined ? { target: step.target, describe: step.describe } : ownFields(step), unknown);
    if (!deps.length) return false;
    entry.dependsOn = deps;
    entry.summary = `要看 ${deps.join("、")} 的结果`;
    for (const name of outputsOf(step)) unknown.add(name);
    if (step.act !== undefined) entry.summary = `可能${ACT_VERBS[step.act]}（${entry.summary}）`;
    return true;
  }

  async function act(step: ActStep, entry: StepReport, s: Scope, pos: Position): Promise<void> {
    const verb = ACT_VERBS[step.act];
    const targets = await actTargets(step, s, pos);
    const handles = targets.filter((t): t is ElementHandle => t !== undefined);
    if (dry) {
      const { describe } = await renderActFields(step, s, pos, ["describe"]);
      if (handles.length) entry.found = handles;
      entry.summary = targets.length ? `会${verb}${describe ? `：${describe}` : ""}` : "没有目标，不会动手";
      return;
    }
    if (!targets.length) {
      entry.summary = "没有目标，跳过";
      return;
    }
    const fields = await renderActFields(step, s, pos);
    checkAbort();
    const notes: string[] = [];
    for (const target of targets) {
      const out = (await env.act(step, target, { path: entry.path, ...fields, vars, signal: env.signal })) ?? {};
      checkAbort();
      if (out.summary) notes.push(out.summary);
      if (out.error) entry.error = out.error;
      if (out.stop || out.error) {
        entry.summary = notes.join("；") || (out.error ? out.error.message : `${verb}后结束`);
        record(entry);
        throw new Halt(out.error ? "error" : "stop");
      }
    }
    entry.summary = notes.join("；") || `${verb}${fields.describe ? `：${fields.describe}` : ""}`;
  }

  async function repeat(step: RepeatStep, entry: StepReport, path: StepPath, frame: Frame): Promise<void> {
    const [s, pos] = at(frame);
    const body = step.steps;
    if (step.repeat === true) {
      const { max } = step;
      entry.summary = `重复，直到条件成立，最多 ${max} 次`;
      record(entry);
      for (let i = 0; i < max; i++) {
        await runBlock(body, [...path, "steps"], frame);
        checkAbort();
        if (dry) {
          const deps = reads(step.until, unknown);
          if (deps.length) {
            entry.dependsOn = deps;
            break;
          }
        }
        let done: unknown;
        try {
          done = await renderTemplate(step.until, ...at(frame));
        } catch (e) {
          fail({ path: [...path, "until"], kind: "repeat", summary: "结束条件出错" }, e);
          break;
        }
        checkAbort();
        if (done === true) break;
      }
      return;
    }
    const list = await renderTemplate(step.repeat, s, pos);
    checkAbort();
    if (!Array.isArray(list)) throw new RuleValueError("repeat 需要一个列表");
    const n = step.max === undefined ? list.length : Math.min(list.length, step.max);
    entry.summary = `对 ${n} 项逐个执行`;
    record(entry);
    for (let i = 0; i < n; i++) await runBlock(body, [...path, "steps"], { ...frame, item: { value: list[i] } });
  }

  async function runStep(step: RunStepDef, path: StepPath, frame: Frame): Promise<void> {
    checkAbort();
    const kind = kindOf(step);
    if (!kind) return;
    const entry: StepReport = { path, kind, summary: "" };
    try {
      if (dry && dependent(step, entry)) {
        record(entry);
        if (step.if !== undefined) {
          await runBlock(step.then ?? [], [...path, "then"], { ...frame, maybe: true });
          await runBlock(step.else ?? [], [...path, "else"], { ...frame, maybe: true });
        }
        return;
      }
      const [s, pos] = at(frame);
      if (step.set) {
        const values = await renderSet(step.set, s, pos);
        checkAbort();
        vars = { ...vars, ...values };
        entry.summary = `记下 ${Object.keys(values).join("、")}`;
      } else if (step.call) {
        const plan = await planCall(step, s, stepEnv, pos);
        entry.send = { contract: plan.call.contract, engines: plan.engines, strategy: plan.strategy, input: plan.call.input };
        if (dry) {
          unknown.add(plan.call.as);
          entry.summary = `会调用「${plan.call.contract}」`;
        } else {
          await runCall(plan, stepEnv);
          checkAbort();
          entry.summary = `调用了「${plan.call.contract}」`;
        }
      } else if (step.find !== undefined) {
        const found = await findElements(step, s, pos, AUTO_ITEM, { host, finders: env.finders });
        checkAbort();
        vars = { ...vars, [step.as]: found };
        entry.found = handlesOf(found);
        entry.summary = found.length ? found.every(isElementHandle) ? `找到 ${found.length} 个元素` : `找到 ${found.length} 项` : "没有找到元素";
      } else if (step.ask !== undefined) {
        const as = step.as ?? "result";
        const req = await planAsk(step, s, pos, (c) => env.invoker.preferredEngines(c).engines);
        entry.send = req;
        if (dry) {
          unknown.add(as);
          entry.summary = `会问「${req.contract}」`;
        } else {
          const res = await env.invoker.invoke(req, { signal: env.signal, confirmHost: env.confirmHost });
          checkAbort();
          vars = { ...vars, [as]: askValue(res) };
          entry.summary = `问了「${req.contract}」`;
        }
      } else if (step.act !== undefined) {
        await act(step, entry, s, pos);
      } else if (step.if !== undefined) {
        const cond = await renderTemplate(step.if, s, pos);
        checkAbort();
        if (typeof cond !== "boolean") throw new RuleValueError("if 的条件需要是 true 或 false");
        entry.summary = cond ? "条件成立" : "条件不成立";
        record(entry);
        if (cond) await runBlock(step.then ?? [], [...path, "then"], frame);
        else await runBlock(step.else ?? [], [...path, "else"], frame);
        return;
      } else if (step.repeat !== undefined) {
        await repeat(step, entry, path, frame);
        return;
      } else if (step.stop !== undefined) {
        entry.summary = frame.maybe ? "可能在这里结束" : "结束这次运行";
        record(entry);
        if (!frame.maybe) throw new Halt("stop");
        return;
      }
    } catch (e) {
      if (e instanceof Halt) throw e;
      fail(entry, e);
      return;
    }
    record(entry);
  }

  async function runBlock(list: readonly RunStepDef[], path: StepPath, frame: Frame): Promise<void> {
    for (let i = 0; i < list.length; i++) await runStep(list[i]!, [...path, i], frame);
  }

  try {
    await runBlock(steps, [], {});
  } catch (e) {
    if (!(e instanceof Halt)) throw e;
    report.end = e.end;
  }
  report.vars = vars;
  return report;
}
