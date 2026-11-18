/**
 * R9.8: an entry's `run` steps. `set` writes `vars`, `call` invokes a contract. With strategy "all"
 * `as` holds one ResultItem per engine, live (loading → streaming → ok/error/needKey); with the other
 * strategies it holds the winning output. A failing step stops the rest; its message goes to the card.
 */
import { renderTemplate, type Position, type Scope } from "../../core/expr";
import type { ConfirmHost, InvokeResult, Invoker, Strategy } from "../../core/invoke";
import { POSITIONS } from "../../core/rules/positions";
import type { CallStep, JsonObject, RunStepDef } from "../../core/rules/types";
import type { ResultItem } from "../../views";
import { applyDelta, applyResult, pendingItems } from "./items";

export type Vars = Record<string, unknown>;

/** Where `vars` live: the runtime keeps them in the card so retries and steps see the same list. */
export interface VarStore {
  get(): Vars;
  set(vars: Vars): void;
}

export function localVars(onSet?: (vars: Vars) => void): VarStore {
  let vars: Vars = {};
  return {
    get: () => vars,
    set(v) {
      vars = v;
      onSet?.(v);
    },
  };
}

/** `settings`, `selection`, `page`, `site` (`vars` is added per step). */
export type StepScope = Readonly<Record<"settings" | "selection" | "page" | "site", unknown>>;

/** A call that wrote a result list, kept so one engine can be retried with the same request. */
export interface CallRecord {
  as: string;
  contract: string;
  input: unknown;
  stream: boolean;
}

export interface StepEnv {
  invoker: Pick<Invoker, "invoke" | "preferredEngines">;
  nameOf(ref: string): string | undefined;
  vars: VarStore;
  signal?: AbortSignal;
  confirmHost?: ConfirmHost;
  onCall?(call: CallRecord): void;
}

export interface StepOutcome {
  vars: Vars;
  error?: string;
}

/** Strategies whose `as` is the per-engine result list. */
const LIST: ReadonlySet<Strategy> = new Set(["all"]);

export const toList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).filter((x): x is string => typeof x === "string" && x !== "");

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Invokes `engines` and keeps `vars[call.as]` (a ResultItem list) up to date. */
export async function invokeInto(call: CallRecord, engines: string[], strategy: Strategy, env: StepEnv): Promise<InvokeResult> {
  const items = () => (env.vars.get()[call.as] as ResultItem[] | undefined) ?? [];
  const put = (next: ResultItem[]) => {
    if (!env.signal?.aborted) env.vars.set({ ...env.vars.get(), [call.as]: next });
  };
  // Results already delivered live are not applied again: by now that engine may have been
  // retried, and its old result would overwrite the newer one.
  const delivered = new Set<string>();
  const res = await env.invoker.invoke(
    { contract: call.contract, input: call.input, strategy, engines, stream: call.stream },
    {
      signal: env.signal,
      confirmHost: env.confirmHost,
      onDelta: (d) => {
        if (!delivered.has(d.engine)) put(applyDelta(items(), d, call.contract));
      },
      onResult: (r) => {
        delivered.add(r.engine);
        put(applyResult(items(), r));
      },
    },
  );
  let final = items();
  for (const r of res.results) if (!delivered.has(r.engine)) final = applyResult(final, r);
  put(final);
  return res;
}

/** The values a `set` step writes, rendered at `pos`. */
export async function renderSet(set: JsonObject, scope: Scope, pos: Position): Promise<Vars> {
  return (await renderTemplate(set, scope, pos)) as Vars;
}

/** A `call` step rendered at `pos`: the request it makes, engines defaulting to the preferred ones. */
export interface CallPlan {
  call: CallRecord;
  engines: string[];
  strategy: Strategy;
}

export async function planCall(step: CallStep, scope: Scope, env: Pick<StepEnv, "invoker">, pos: Position): Promise<CallPlan> {
  const r = (await renderTemplate({ engines: step.engines, input: step.input, stream: step.stream }, scope, pos)) as {
    engines?: unknown;
    input?: unknown;
    stream?: unknown;
  };
  const contract = step.call;
  const strategy = step.strategy ?? "first";
  let engines = toList(r.engines);
  if (!engines.length) engines = env.invoker.preferredEngines(contract).engines;
  return { call: { as: step.as ?? "result", contract, input: r.input, stream: r.stream === true }, engines, strategy };
}

/** Makes the call and writes `vars[as]`; throws when it failed. */
export async function runCall({ call, engines, strategy }: CallPlan, env: StepEnv): Promise<void> {
  const { contract } = call;
  if (LIST.has(strategy)) {
    env.vars.set({ ...env.vars.get(), [call.as]: pendingItems(engines, env.nameOf) });
    env.onCall?.(call);
    const res = await invokeInto(call, engines, strategy, env);
    if (!res.ok && !res.results.length) throw res.error ?? new Error(`「${contract}」调用失败`);
  } else {
    const res = await env.invoker.invoke(
      { contract, input: call.input, strategy, engines, stream: call.stream },
      { signal: env.signal, confirmHost: env.confirmHost },
    );
    if (!res.ok) throw res.error ?? new Error(`「${contract}」调用失败`);
    env.vars.set({ ...env.vars.get(), [call.as]: res.output });
  }
}

export async function runSteps(steps: readonly RunStepDef[], scope: StepScope, env: StepEnv, overrides: Vars = {}): Promise<StepOutcome> {
  env.vars.set({ ...overrides });
  const scopeNow = (): Scope => ({ ...scope, vars: env.vars.get() });
  try {
    for (const step of steps) {
      if (env.signal?.aborted) break;
      if (step.set) {
        const values = await renderSet(step.set, scopeNow(), POSITIONS.run);
        env.vars.set({ ...env.vars.get(), ...values, ...overrides });
        continue;
      }
      if (!step.call) continue;
      await runCall(await planCall(step, scopeNow(), env, POSITIONS.run), env);
    }
  } catch (e) {
    if (env.signal?.aborted) return { vars: env.vars.get() };
    return { vars: env.vars.get(), error: message(e) };
  }
  return { vars: env.vars.get() };
}
