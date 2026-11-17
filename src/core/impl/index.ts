/**
 * Runs one provider implementation for one contract (R4.3, R5.1–R5.4): contract schema checks,
 * keys, implementation choice (`when`, builtin availability), then `http`, `via` or `builtin`.
 * Routing, strategies, caching of results, rate limits and retries belong to the call pipeline.
 */
import { renderTemplate } from "../expr";
import { CallError } from "../errors";
import { POSITIONS, type ImplementationDef, type ResolvedProvider } from "../rules";
import { effectiveOptions } from "./hosts";
import { executeHttp } from "./http";
import { masker } from "./mask";
import { fail, trace, type BuiltinAdapter, type ImplContext, type Run, type StepCache } from "./run";
import { schemaProblem } from "./schema";
import { executeVia } from "./via";

export { effectiveOptions, resolveHosts } from "./hosts";
export { masker } from "./mask";
export type { BuiltinAdapter, ImplContext, StepCache } from "./run";
export type { Delta, TraceEvent } from "./trace";

export const BUILTIN_UNSUPPORTED = "这个版本的陪伴猫不支持这个内置适配器";

/** Code adapters for `builtin` implementations. Phase 1 has none (R5.4). */
export const BUILTINS: Readonly<Record<string, BuiltinAdapter>> = Object.freeze({});

const variants = (provider: ResolvedProvider, contract: string): ImplementationDef[] | undefined => {
  const entry = provider.def.implements[contract];
  return entry === undefined ? undefined : Array.isArray(entry) ? entry : [entry];
};

/**
 * Why `provider` cannot run `contract` regardless of options, or null when it can:
 * not implemented, or only builtin adapters this build does not have.
 */
export function unavailableReason(
  provider: ResolvedProvider,
  contract: string,
  builtins: Readonly<Record<string, BuiltinAdapter>> = BUILTINS,
): string | null {
  const list = variants(provider, contract);
  if (!list?.length) return `引擎没有实现「${contract}」`;
  return list.every((v) => v.builtin !== undefined && !builtins[v.builtin]) ? BUILTIN_UNSUPPORTED : null;
}

/** An in-memory StepCache with expiry; keep one per session and pass it in every context. */
export function createStepCache(now: () => number = Date.now, max = 256): StepCache {
  const entries = new Map<string, { value: unknown; expires: number }>();
  return {
    get(key) {
      const e = entries.get(key);
      if (!e) return undefined;
      if (e.expires <= now()) {
        entries.delete(key);
        return undefined;
      }
      return { value: e.value };
    },
    set(key, value, ttlSeconds) {
      entries.delete(key);
      entries.set(key, { value, expires: now() + ttlSeconds * 1000 });
      if (entries.size > max) entries.delete(entries.keys().next().value!);
    },
    delete(key) {
      entries.delete(key);
    },
  };
}

async function pick(run: Run, contract: string): Promise<ImplementationDef> {
  const list = variants(run.provider, contract);
  if (!list?.length) throw fail(run, "disabled", `引擎没有实现「${contract}」`);
  const builtins = run.ctx.builtins ?? BUILTINS;
  let reason = "没有满足条件的实现";
  for (const impl of list) {
    if (impl.when !== undefined) {
      let on: unknown = false;
      try {
        on = await renderTemplate(impl.when, { options: run.options }, POSITIONS.when);
        trace(run, { type: "expr", position: POSITIONS.when.name, template: impl.when, value: on });
      } catch (e) {
        trace(run, { type: "expr", position: POSITIONS.when.name, template: impl.when, error: (e as Error).message });
      }
      if (on !== true) continue;
    }
    if (impl.builtin !== undefined && !builtins[impl.builtin]) {
      reason = BUILTIN_UNSUPPORTED;
      continue;
    }
    return impl;
  }
  throw fail(run, "disabled", reason);
}

async function call(run: Run, contract: string, input: unknown): Promise<unknown> {
  try {
    const c = run.ctx.rules.contracts.find((x) => x.id === contract);
    if (!c) throw fail(run, "disabled", `契约「${contract}」不存在`);
    if (!c.enabled) throw fail(run, "disabled", `契约「${contract}」已停用`);
    const impl = await pick(run, contract);

    const badIn = schemaProblem(c.def.input, input);
    if (badIn) throw fail(run, "badInput", `输入不符合契约「${contract}」：${badIn}`);
    for (const s of run.provider.def.secrets ?? []) {
      if (!run.secret[s.name]) throw fail(run, "missingKey", `还没有填写「${s.title}」`);
    }

    let output: unknown;
    if (impl.http) output = await executeHttp(run, impl.http, input);
    else if (impl.via !== undefined) output = await executeVia(run, contract, impl.via, input, call);
    else {
      const adapter = (run.ctx.builtins ?? BUILTINS)[impl.builtin!]!;
      output = await adapter(contract, input, { options: run.options, secret: run.secret, signal: run.ctx.signal });
    }

    const badOut = schemaProblem(c.def.output, output);
    if (badOut) throw fail(run, "badOutput", `返回不符合契约「${contract}」：${badOut}`, { raw: run.shared.lastRaw });
    trace(run, { type: "output", contract, output });
    return output;
  } catch (e) {
    if (e instanceof CallError) {
      trace(run, { type: "error", contract, errorType: e.type, message: e.message, detail: e.detail });
    }
    throw e;
  }
}

/**
 * Executes `provider`'s implementation of `contract` once. Resolves to the contract output;
 * rejects with a CallError (R6.3 type) or the signal's abort reason. Streamed text goes to
 * ctx.onDelta, every step to ctx.onTrace (keys masked).
 */
export function executeImpl(provider: ResolvedProvider, contract: string, input: unknown, ctx: ImplContext): Promise<unknown> {
  const secret: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.secrets ?? {})) if (typeof v === "string" && v.trim()) secret[k] = v.trim();
  const run: Run = {
    ctx,
    provider,
    options: effectiveOptions(provider, ctx.options),
    secret,
    mask: masker(secret),
    shared: { confirmed: new Set() },
    depth: 0,
    onDelta: ctx.onDelta,
  };
  return call(run, contract, input);
}
