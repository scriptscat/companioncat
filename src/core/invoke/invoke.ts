/**
 * The call pipeline (R6.1): every feature and page calls a capability through invoke().
 * Per engine: validate input → confirm hosts → read cache → (implementation chosen by executeImpl)
 * → rate limit → execute with timeout and retries → output checked by executeImpl → confidence
 * → write cache → usage. Strategies (R6.2) decide which engines run and how results combine.
 */
import { CallError, isCallError, type ErrorType } from "../errors";
import { createStepCache, effectiveOptions, executeImpl, resolveHosts, unavailableReason } from "../impl";
import type { BuiltinAdapter, TraceEvent } from "../impl";
import { schemaProblem } from "../impl/schema";
import type { Resolved, ResolvedProvider } from "../rules";
import { isObject } from "../rules/merge";
import type { SecretStore } from "../stores";
import { cacheKey, createResultCache, type CacheStats } from "./cache";
import { abortable, createLimiter, sleep, type Limiter } from "./limiter";
import { tally } from "./vote";

export type Strategy = "first" | "race" | "all" | "vote";

/** Used when an engine declares no limits.timeoutMs. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Wait before the first retry; doubles for each further one. */
export const RETRY_DELAY_MS = 1000;
/** Usage records kept in memory. */
export const USAGE_LIMIT = 500;
/** The only contract whose results are cached (R6.4). */
const CACHED_CONTRACT = "translate";

export interface InvokeRequest {
  contract: string;
  input: unknown;
  /** Default "first". */
  strategy?: Strategy;
  /** Full provider refs in order; empty or absent → preferredEngines(contract). */
  engines?: string | readonly string[];
  /** Forward streamed text through onDelta. */
  stream?: boolean;
  /** false: neither read nor write the result cache (a key test must reach the service, R7.2). */
  cache?: boolean;
}

/** What the host dialog shows (R7.4); resolve true to allow and record the hosts, false to disable the engine. */
export interface HostConfirmRequest {
  provider: ResolvedProvider;
  /** Hosts not confirmed yet. */
  hosts: string[];
  /** Hosts confirmed before. */
  confirmed: string[];
}
export type ConfirmHost = (req: HostConfirmRequest) => boolean | Promise<boolean>;

/** A piece of streamed text from one engine; `full` is the text so far in this attempt. */
export interface InvokeDelta {
  engine: string;
  text: string;
  full: string;
  /** 1-based; a retry starts over with a new attempt number. */
  attempt: number;
}

export interface InvokeOptions {
  /** Overrides the invoker's confirmHost for this call. */
  confirmHost?: ConfirmHost;
  /** Streamed text (only when the request has stream: true). */
  onDelta?: (delta: InvokeDelta) => void;
  /** Each engine's result as soon as it settles. */
  onResult?: (result: EngineResult) => void;
  onTrace?: (engine: string, event: TraceEvent) => void;
  /** Aborting cancels every engine; invoke then rejects with the signal's reason. */
  signal?: AbortSignal;
  /**
   * R7.2 test-and-save: run `engine` with these candidate secret values in place of the saved
   * ones. Nothing is stored: the engine's hosts count as confirmed for this call without being
   * recorded, and its disabled flag is ignored (a passing test is what enables it).
   */
  keyTest?: KeyTest;
}

export interface KeyTest {
  engine: string;
  secrets: Readonly<Record<string, string>>;
}

export type EngineResult =
  | { engine: string; ok: true; output: unknown; cached: boolean; ms: number; confidence?: number; tokens?: number }
  | { engine: string; ok: false; error: CallError; ms: number };

export interface InvokeResult {
  ok: boolean;
  strategy: Strategy;
  contract: string;
  /** The engine whose output is `output`. */
  engine?: string;
  output?: unknown;
  cached?: boolean;
  /** 0–1: the engine's reported confidence, or for vote the agreeing share. */
  confidence?: number;
  /** When nothing succeeded: the last error (each engine's own error is in results). */
  error?: CallError;
  /** Every settled engine, in engine order (race: cancelled engines are left out). */
  results: EngineResult[];
  /** "还没填 Key…" when the preferred engine was skipped (R5.7). */
  notice?: string;
}

export interface UsageRecord {
  at: number;
  engine: string;
  contract: string;
  ms: number;
  cached: boolean;
  ok: boolean;
  errorType?: ErrorType;
  /** Only when the service reported it (an output `usage`). */
  tokens?: number;
}

export interface PreferredEngines {
  /** Engines to use, preferred first, then every other ready engine. */
  engines: string[];
  /** The chosen engine, when one is set and usable. */
  preferred?: string;
  /** The engine that will be tried first. */
  using?: string;
  notice?: string;
}

export interface InvokerDeps {
  rules: () => Resolved;
  secrets: SecretStore;
  /** Default host dialog (R7.4); without one, unconfirmed hosts fail with hostUnconfirmed. */
  confirmHost?: ConfirmHost;
  /** The engine chosen for a capability on the 通用 page (R5.7). */
  preferred?: (capability: string) => string | undefined;
  builtins?: Readonly<Record<string, BuiltinAdapter>>;
  cacheSize?: number;
  now?: () => number;
}

interface Job {
  contract: string;
  input: unknown;
  stream: boolean;
  cache: boolean;
  opts: InvokeOptions;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function confidenceOf(output: unknown): number | undefined {
  const c = isObject(output) ? num(output.confidence) : undefined;
  return c === undefined ? undefined : Math.min(1, Math.max(0, c));
}

/** Total tokens from an output `usage` (OpenAI chat or Responses shapes, or a plain number). */
function tokensOf(output: unknown): number | undefined {
  const u = isObject(output) ? output.usage : undefined;
  if (num(u) !== undefined) return u as number;
  if (!isObject(u)) return undefined;
  const total = num(u.total_tokens) ?? num(u.totalTokens) ?? num(u.total);
  if (total !== undefined) return total;
  const a = num(u.input_tokens) ?? num(u.prompt_tokens);
  const b = num(u.output_tokens) ?? num(u.completion_tokens);
  return a !== undefined && b !== undefined ? a + b : undefined;
}

/** A controller that also aborts when `outer` does, until unlinked. */
function linked(outer?: AbortSignal): { ctrl: AbortController; unlink(): void } {
  const ctrl = new AbortController();
  const follow = () => ctrl.abort(outer!.reason);
  if (outer?.aborted) ctrl.abort(outer.reason);
  else outer?.addEventListener("abort", follow, { once: true });
  return { ctrl, unlink: () => outer?.removeEventListener("abort", follow) };
}

export function createInvoker(deps: InvokerDeps) {
  const now = deps.now ?? Date.now;
  const cache = createResultCache(deps.cacheSize);
  const stepCache = createStepCache(now);
  const limiters = new Map<string, Limiter>();
  const asking = new Map<string, Promise<boolean>>();
  const log: UsageRecord[] = [];

  const limiterOf = (ref: string) => {
    let l = limiters.get(ref);
    if (!l) limiters.set(ref, (l = createLimiter(now)));
    return l;
  };
  const providerOf = (ref: string) => deps.rules().providers.find((p) => p.ref === ref);
  const needsKey = (p: ResolvedProvider) => (p.def.secrets?.length ?? 0) > 0;
  const hasKey = (p: ResolvedProvider) => !needsKey(p) || deps.secrets.lookup(p.ref).missing.length === 0;
  /** The candidate keys when this call tests `ref`'s key (R7.2). */
  const testing = (ref: string, job: Job) => (job.opts.keyTest?.engine === ref ? job.opts.keyTest.secrets : undefined);
  const secretsOf = (p: ResolvedProvider, job: Job) => {
    const candidate = testing(p.ref, job);
    return Object.fromEntries(
      (p.def.secrets ?? []).map((s) => [s.name, candidate && Object.hasOwn(candidate, s.name) ? candidate[s.name] : deps.secrets.get(p.ref, s.name)]),
    );
  };

  /** Why the engine cannot run at all (disabled, missing key), before anything else happens. */
  function check(ref: string, contract: string, job: Job): ResolvedProvider {
    const p = providerOf(ref);
    if (!p) throw new CallError("disabled", `引擎「${ref}」不存在`);
    if (!p.enabled) throw new CallError("disabled", `引擎「${p.def.name}」的规则有错误，已停用`);
    const reason = unavailableReason(p, contract, deps.builtins);
    if (reason) throw new CallError("disabled", reason);
    // Before the disabled flag: deleting a key also stops the engine (R7.3), and the card must
    // still offer 「填 Key」 for it (R10.5).
    const candidate = testing(ref, job);
    const missing = deps.secrets.lookup(ref).missing.filter((n) => !candidate || !Object.hasOwn(candidate, n));
    if (needsKey(p) && missing.length) {
      const title = p.def.secrets?.find((s) => s.name === missing[0])?.title ?? missing[0];
      throw new CallError("missingKey", `还没有填写「${title}」`);
    }
    if (!candidate && deps.secrets.isDisabled(ref)) throw new CallError("disabled", `引擎「${p.def.name}」已停用`);
    return p;
  }

  /**
   * Asks the user about `hosts` (one dialog per engine at a time). Allowing records them as
   * confirmed; refusing disables the engine (R7.4). No hook, or a failing hook, just says no.
   */
  function ask(p: ResolvedProvider, hosts: string[], job: Job, signal?: AbortSignal): Promise<boolean> {
    const hook = job.opts.confirmHost ?? deps.confirmHost;
    if (!hook) return Promise.resolve(false);
    let pending = asking.get(p.ref);
    if (!pending) {
      pending = (async () => {
        let ok: boolean;
        try {
          ok = (await hook({ provider: p, hosts, confirmed: deps.secrets.hostsConfirmed(p.ref) })) === true;
        } catch {
          return false;
        }
        if (ok) deps.secrets.confirmHosts(p.ref, hosts);
        else deps.secrets.setDisabled(p.ref, true);
        return ok;
      })().finally(() => asking.delete(p.ref));
      asking.set(p.ref, pending);
    }
    return abortable(pending, signal);
  }

  /** R7.4/R7.5: a keyed engine's unconfirmed hosts must be allowed before anything is sent. */
  async function confirmHosts(p: ResolvedProvider, options: Record<string, unknown>, job: Job, signal?: AbortSignal) {
    // a key test: the user is entering this key for these hosts right now
    if (!needsKey(p) || testing(p.ref, job)) return;
    const fresh = (await resolveHosts(p, options)).filter((h) => !deps.secrets.isHostConfirmed(p.ref, h));
    if (fresh.length && !(await ask(p, fresh, job, signal))) {
      throw new CallError("hostUnconfirmed", `${fresh.join("、")} 还没有确认，已暂停发送`, { host: fresh[0] });
    }
  }

  /** Runs the engine under its limits, retrying the listed error types. */
  async function execute(p: ResolvedProvider, job: Job, signal?: AbortSignal): Promise<unknown> {
    const limits = p.def.limits ?? {};
    const retry = limits.retry;
    for (let attempt = 1; ; attempt++) {
      const release = await limiterOf(p.ref).acquire(limits, signal);
      let full = "";
      try {
        return await executeImpl(p, job.contract, job.input, {
          rules: deps.rules(),
          secrets: secretsOf(p, job),
          stepCache,
          confirmHost: async (host, prov) =>
            !needsKey(prov) || !!testing(prov.ref, job) || deps.secrets.isHostConfirmed(prov.ref, host) || ask(prov, [host], job, signal),
          onTrace: job.opts.onTrace && ((e) => job.opts.onTrace!(p.ref, e)),
          onDelta:
            job.stream && job.opts.onDelta
              ? (d) => job.opts.onDelta!({ engine: p.ref, text: d.text, full: (full += d.text), attempt })
              : undefined,
          signal,
          timeoutMs: limits.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          builtins: deps.builtins,
        });
      } catch (e) {
        // R6.3 fixes which types can be retried at all; the rule's limits.retry.on picks among them
        if (!isCallError(e) || signal?.aborted || !retry || attempt > retry.max || !e.retry || !retry.on.includes(e.type)) throw e;
      } finally {
        release();
      }
      await sleep(RETRY_DELAY_MS * 2 ** (attempt - 1), signal);
    }
  }

  function finish(job: Job, r: EngineResult): EngineResult {
    const rec: UsageRecord = { at: now(), engine: r.engine, contract: job.contract, ms: r.ms, cached: r.ok && r.cached, ok: r.ok };
    if (!r.ok) rec.errorType = r.error.type;
    else if (r.tokens !== undefined) rec.tokens = r.tokens;
    log.push(rec);
    if (log.length > USAGE_LIMIT) log.shift();
    job.opts.onResult?.(r);
    return r;
  }

  /** One engine through the pipeline. Rejects only when cancelled (or on a non-CallError bug). */
  async function runEngine(ref: string, job: Job, signal?: AbortSignal): Promise<EngineResult> {
    const started = now();
    try {
      const p = check(ref, job.contract, job);
      // An engine's option values are local-pack overrides of its declared defaults (R5.5).
      const options = effectiveOptions(p);
      await confirmHosts(p, options, job, signal);
      const key = job.cache && job.contract === CACHED_CONTRACT ? cacheKey(ref, options, job.input) : undefined;
      const hit = key === undefined ? undefined : cache.get(key);
      const output = hit ? hit.value : await execute(p, job, signal);
      const r: EngineResult = { engine: ref, ok: true, output, cached: !!hit, ms: now() - started };
      const confidence = confidenceOf(output);
      if (confidence !== undefined) r.confidence = confidence;
      const tokens = hit ? undefined : tokensOf(output);
      if (tokens !== undefined) r.tokens = tokens;
      if (key !== undefined && !hit) cache.set(key, output);
      return finish(job, r);
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      if (!isCallError(e)) throw e;
      return finish(job, { engine: ref, ok: false, error: e, ms: now() - started });
    }
  }

  /** Runs engines in parallel; `stop` ends early (cancelling the rest) once it returns true. */
  function parallel(engines: string[], job: Job, stop?: (r: EngineResult) => boolean) {
    return new Promise<{ results: EngineResult[]; last?: CallError }>((resolve, reject) => {
      const outer = job.opts.signal;
      const links = engines.map(() => linked(outer));
      const results: (EngineResult | undefined)[] = engines.map(() => undefined);
      let last: CallError | undefined;
      let left = engines.length;
      let over = false;
      const cancel = (reason: unknown) => {
        over = true;
        for (const { ctrl, unlink } of links) {
          unlink();
          if (!ctrl.signal.aborted) ctrl.abort(reason);
        }
      };
      engines.forEach((ref, i) => {
        runEngine(ref, job, links[i]!.ctrl.signal).then(
          (r) => {
            if (over) return;
            results[i] = r;
            if (!r.ok) last = r.error;
            if (--left === 0 || stop?.(r)) {
              cancel(new DOMException("cancelled", "AbortError"));
              resolve({ results: results.filter((x): x is EngineResult => x !== undefined), last });
            }
          },
          (e: unknown) => {
            if (over) return;
            cancel(e);
            reject(outer?.aborted ? outer.reason : e);
          },
        );
      });
    });
  }

  function preferredEngines(contract: string): PreferredEngines {
    const usable = deps
      .rules()
      .providers.filter((p) => p.enabled && !deps.secrets.isDisabled(p.ref) && unavailableReason(p, contract, deps.builtins) === null);
    const want = deps.preferred?.(contract);
    const chosen = want === undefined ? undefined : usable.find((p) => p.ref === want);
    const ready = (chosen ? [chosen, ...usable.filter((p) => p !== chosen)] : usable).filter(hasKey);
    const out: PreferredEngines = { engines: ready.map((p) => p.ref) };
    if (chosen) out.preferred = chosen.ref;
    if (ready[0]) out.using = ready[0].ref;
    if (chosen && !hasKey(chosen)) {
      out.notice = ready[0] ? `还没填 Key，现在先用「${ready[0].def.name}」` : "还没填 Key";
      if (!ready.length) out.engines = [chosen.ref];
    }
    return out;
  }

  function inputProblem(contract: string, input: unknown): CallError | undefined {
    const c = deps.rules().contracts.find((x) => x.id === contract);
    if (!c) return new CallError("disabled", `契约「${contract}」不存在`);
    if (!c.enabled) return new CallError("disabled", `契约「${contract}」已停用`);
    const bad = schemaProblem(c.def.input, input);
    return bad ? new CallError("badInput", `输入不符合契约「${contract}」：${bad}`) : undefined;
  }

  async function invoke(req: InvokeRequest, opts: InvokeOptions = {}): Promise<InvokeResult> {
    const strategy = req.strategy ?? "first";
    if (opts.signal?.aborted) throw opts.signal.reason;
    let engines = typeof req.engines === "string" ? [req.engines] : [...(req.engines ?? [])];
    const base: Pick<InvokeResult, "strategy" | "contract" | "notice"> = { strategy, contract: req.contract };
    if (!engines.length) {
      const pref = preferredEngines(req.contract);
      engines = pref.engines;
      if (pref.notice) base.notice = pref.notice;
    }
    if (!engines.length) {
      return { ...base, ok: false, error: new CallError("disabled", `没有可用的「${req.contract}」引擎`), results: [] };
    }
    const job: Job = { contract: req.contract, input: req.input, stream: req.stream === true, cache: req.cache !== false, opts };

    let results: EngineResult[];
    let last: CallError | undefined;
    const bad = inputProblem(req.contract, req.input);
    if (bad) {
      results = engines.map((engine) => finish(job, { engine, ok: false, error: bad, ms: 0 }));
      last = bad;
    } else if (strategy === "first") {
      results = [];
      for (const ref of engines) {
        const r = await runEngine(ref, job, opts.signal);
        results.push(r);
        if (r.ok) break;
        last = r.error;
      }
    } else {
      ({ results, last } = await parallel(engines, job, strategy === "race" ? (r) => r.ok : undefined));
    }

    const ok = results.filter((r): r is Extract<EngineResult, { ok: true }> => r.ok);
    if (!ok.length) return { ...base, ok: false, error: last, results };
    let winner = ok[0]!;
    let confidence = winner.confidence;
    if (strategy === "vote") {
      const t = tally(req.contract, ok.map((r) => r.output))!;
      winner = ok[t.winner]!;
      confidence = t.share;
    }
    const out: InvokeResult = { ...base, ok: true, engine: winner.engine, output: winner.output, cached: winner.cached, results };
    if (confidence !== undefined) out.confidence = confidence;
    return out;
  }

  return {
    invoke,
    preferredEngines,
    cacheStats: (): CacheStats => cache.stats(),
    clearCache: () => cache.clear(),
    /** Recent usage records, oldest first (R6.5; for try-run and debugging). */
    usage: (): UsageRecord[] => [...log],
  };
}

export type Invoker = ReturnType<typeof createInvoker>;
