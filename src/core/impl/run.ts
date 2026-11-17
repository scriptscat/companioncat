import { ExprError, renderTemplate, type Position, type Scope } from "../expr";
import { CallError, RAW_LIMIT, type CallErrorDetail, type ErrorType } from "../errors";
import type { Resolved, ResolvedProvider } from "../rules";
import type { Delta, TraceEvent } from "./trace";

/** A code adapter behind a `builtin` implementation (R5.4). Phase 1 ships none. */
export type BuiltinAdapter = (
  contract: string,
  input: unknown,
  env: { options: Record<string, unknown>; secret: Record<string, string>; signal?: AbortSignal },
) => Promise<unknown>;

/** Short-lived results of `steps` with `cache` (R5.2), e.g. a temporary token. */
export interface StepCache {
  get(key: string): { value: unknown } | undefined;
  set(key: string, value: unknown, ttlSeconds: number): void;
  delete(key: string): void;
}

export interface ImplContext {
  /** Contracts (schemas) and bridges from resolveRules. */
  rules: Pick<Resolved, "contracts" | "bridges">;
  /** The user's option values; declared defaults fill the rest. */
  options?: Readonly<Record<string, unknown>>;
  /** Saved keys by secret name (for providers that inherit keys, the parent's). */
  secrets?: Readonly<Record<string, string | undefined>>;
  /** Shared across calls so cached steps survive; without it nothing is cached. */
  stepCache?: StepCache;
  /**
   * Called once per host per call before the first request to it, after the host passed the
   * declared-hosts check. Resolve false to stop with hostUnconfirmed (R7.4); may wait for the user.
   */
  confirmHost?: (host: string, provider: ResolvedProvider) => boolean | Promise<boolean>;
  onTrace?: (event: TraceEvent) => void;
  /** Streamed text of the top-level call (not of bridged inner calls). */
  onDelta?: (delta: Delta) => void;
  signal?: AbortSignal;
  /** Per-request timeout; defaults to the provider's limits.timeoutMs. */
  timeoutMs?: number;
  /** Builtin adapters by name; defaults to BUILTINS (empty). */
  builtins?: Readonly<Record<string, BuiltinAdapter>>;
}

/** State of one executeImpl call, shared with the bridged calls it makes. */
export interface Run {
  ctx: ImplContext;
  provider: ResolvedProvider;
  options: Record<string, unknown>;
  secret: Record<string, string>;
  mask: <T>(v: T) => T;
  shared: { hosts?: Promise<string[]>; confirmed: Set<string>; lastRaw?: string };
  depth: number;
  onDelta?: (delta: Delta) => void;
}

export function trace(run: Run, event: TraceEvent): void {
  run.ctx.onTrace?.(run.mask(event));
}

/** A CallError with keys masked out of the message and details; raw is cut to 500 characters. */
export function fail(run: Run, type: ErrorType, message?: string, detail: CallErrorDetail = {}): CallError {
  const d = run.mask(detail);
  if (d.raw !== undefined) d.raw = d.raw.slice(0, RAW_LIMIT);
  return new CallError(type, message === undefined ? undefined : run.mask(message), d);
}

/**
 * Renders a rule field and traces it (`quiet` traces failures only, for per-event stream fields);
 * an expression failure becomes a CallError of `onError`.
 */
export async function render(
  run: Run,
  template: unknown,
  scope: Scope,
  pos: Position,
  onError: ErrorType,
  detail: CallErrorDetail = {},
  quiet = false,
): Promise<unknown> {
  try {
    const value = await renderTemplate(template, scope, pos);
    if (!quiet) trace(run, { type: "expr", position: pos.name, template, value });
    return value;
  } catch (e) {
    if (!(e instanceof ExprError)) throw e;
    trace(run, { type: "expr", position: pos.name, template, error: e.message });
    throw fail(run, onError, `「${pos.name}」的表达式出错：${e.message}`, {
      raw: run.shared.lastRaw,
      ...detail,
      expr: { position: pos.name, path: e.path, source: e.expr, start: e.start, end: e.end, message: e.message },
    });
  }
}

/** Renders a boolean-ish field; an expression failure counts as false (and is traced). */
export async function holds(run: Run, template: unknown, scope: Scope, pos: Position): Promise<boolean> {
  try {
    return (await render(run, template, scope, pos, "badOutput")) === true;
  } catch (e) {
    if (e instanceof CallError) return false;
    throw e;
  }
}

export { isObject } from "../rules/merge";
