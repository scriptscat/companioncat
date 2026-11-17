/**
 * R8.4 time budget: at most 50 ms of the expression's *own* evaluation work.
 *
 * CEL evaluation is synchronous, so the budget is enforced from inside the evaluator:
 * cel-js calls registered function handlers with the environment's Evaluator as `this`,
 * and every child node (including each macro loop iteration, also after an await) is
 * evaluated through `evaluator.run(ast, ctx)`. We patch that instance method to time each
 * outermost synchronous run segment and charge it to the budget found on the context
 * chain (`ctx.getValue`) under a key no CEL identifier can spell. Time between segments —
 * awaited function latency, other code blocking the event loop — is never charged, and
 * neither is parsing / type checking, which happens before evaluation starts.
 * Wall-clock time inside a segment still includes GC pauses and the process being
 * descheduled. The clock is sampled every SAMPLE_NODES node evaluations and each gap
 * between samples is charged at most MAX_GAP_MS: real work is spread over many short
 * gaps and is charged in full, while one host stall cannot make a small expression "slow".
 * A synchronous whitelisted function call is one native step with no nodes inside it, so its
 * time is charged in full by timedCall(); an async one (WebCrypto) is charged like a gap, and
 * its awaited latency is not charged at all.
 * Guarded by limits.test.ts and budget.test.ts against cel-js internals changing.
 */

export const TIME_LIMIT_MS = 50;
export const BUDGET_KEY = "@budget";
/** Most that one gap between clock samples can charge; longer gaps are host stalls. */
const MAX_GAP_MS = 5;
const SAMPLE_MASK = 127; // sample every 128 node evaluations

export interface Budget {
  /** Milliseconds of evaluation work charged so far. */
  used: number;
  expired: boolean;
}

/** Thrown inside the evaluator; preallocated so tight loops can unwind cheaply. */
export const BUDGET_EXCEEDED = new Error("expression time budget exceeded");

const now = () => performance.now();

export function newBudget(): Budget {
  return { used: 0, expired: false };
}

/** Marks and reports whether the budget has run out. */
export function spent(b: Budget): boolean {
  if (!b.expired && b.used > TIME_LIMIT_MS) b.expired = true;
  return b.expired;
}

interface EvalContext {
  getValue?(key: string): unknown;
}
interface PatchableEvaluator {
  run(ast: unknown, ctx: EvalContext): unknown;
}

const patched = new WeakSet<object>();

// Synchronous JS cannot interleave, so one segment is active at a time across evaluators.
let depth = 0;
let current: Budget | undefined;
let lastSample = 0;
let ticks = 0;

function charge(b: Budget): void {
  const t = now();
  b.used += Math.min(t - lastSample, MAX_GAP_MS);
  lastSample = t;
}

function overrun(b: Budget): never {
  b.expired = true;
  throw BUDGET_EXCEEDED;
}

// The budget of the expression whose synchronous start is running (evalExpr). cel-js evaluates
// the root node directly, not through run(), so a call at the root is charged through this.
let rootBudget: Budget | undefined;

/** Runs the synchronous start of an expression's evaluation with `b` as its budget. */
export function withBudget<T>(b: Budget, fn: () => T): T {
  const prev = rootBudget;
  rootBudget = b;
  try {
    return fn();
  } finally {
    rootBudget = prev;
  }
}

/** Runs one function handler, charging its synchronous wall time in full to the active budget. */
export function timedCall<T>(fn: () => T): T {
  const inRun = depth > 0 && current !== undefined;
  const b = inRun ? current : rootBudget;
  if (!b) return fn();
  if (inRun && !b.expired) charge(b); // settle node time up to the call
  const start = inRun ? lastSample : now();
  let async = false;
  try {
    const out = fn();
    async = out instanceof Promise;
    return out;
  } finally {
    const end = now();
    // An async handler (WebCrypto) only starts its work here; charge that like any gap.
    b.used += async ? Math.min(end - start, MAX_GAP_MS) : end - start;
    if (inRun) lastSample = end;
    spent(b);
  }
}

export function installBudget(evaluator: unknown): void {
  const ev = evaluator as PatchableEvaluator;
  if (!ev || typeof ev.run !== "function" || patched.has(ev)) return;
  patched.add(ev);
  const run = ev.run;
  ev.run = function (ast, ctx) {
    if (depth === 0) {
      const b = ctx?.getValue?.(BUDGET_KEY) as Budget | undefined;
      if (b && spent(b)) overrun(b);
      current = b;
      lastSample = now();
    } else if (current && (current.expired || (++ticks & SAMPLE_MASK) === 0)) {
      // Once expired, every node throws so loops that swallow errors unwind fast.
      if (!current.expired) charge(current);
      if (spent(current)) overrun(current);
    }
    depth++;
    try {
      return run.call(this, ast, ctx);
    } finally {
      if (--depth === 0 && current) {
        charge(current);
        current = undefined;
      }
    }
  };
}
