import { ERROR_TYPES, type CallError } from "../../core/errors";
import { effectiveOptions, resolveHosts } from "../../core/impl";
import type { Invoker } from "../../core/invoke";
import type { ResolvedContract, ResolvedProvider } from "../../core/rules/types";
import type { SecretStore } from "../../core/stores";

export type TestOutcome =
  | { ok: true; ms: number; contract: string; input: unknown; output: unknown }
  | { ok: false; message: string };

export const errorText = (e: CallError): string => {
  const status = e.detail.status ? `（服务商返回 ${e.detail.status}）` : "";
  return `${ERROR_TYPES[e.type].title}：${e.message}${status}`;
};

/** The contracts an engine implements, in declaration order. */
export const contractsOf = (p: ResolvedProvider, all: ResolvedContract[]): ResolvedContract[] =>
  Object.keys(p.def.implements ?? {}).map((id) => all.find((c) => c.id === id) ?? ({ id, ref: id, def: { id, input: true, output: true } } as unknown as ResolvedContract));

interface Deps {
  secrets: SecretStore;
  invoker: Invoker;
  contracts: ResolvedContract[];
}

/** Keeps the key, confirms the hosts it is for (R7.4) and enables the engine. Returns those hosts. */
export async function saveKey(p: ResolvedProvider, values: Record<string, string>, d: Deps, signal?: AbortSignal): Promise<string[]> {
  const hosts = await resolveHosts(p, effectiveOptions(p));
  // a stopped test stores nothing, also when it is stopped while the hosts are looked up
  signal?.throwIfAborted();
  const own = d.secrets.lookup(p.ref).from;
  for (const [name, value] of Object.entries(values)) d.secrets.set(own, name, value, hosts);
  d.secrets.setDisabled(p.ref, false);
  return hosts;
}

/**
 * R7.2: calls the first implemented contract's `sample` with the new key. The key goes to the
 * pipeline as a candidate for this one call; it is stored (with its confirmed hosts, and the
 * engine enabled) only once the test passes, so a failing or unfinished test changes nothing.
 * Aborting `signal` (the panel went away) stops the request and keeps the test from saving.
 */
export async function testAndSave(p: ResolvedProvider, values: Record<string, string>, d: Deps, signal?: AbortSignal): Promise<TestOutcome> {
  const contract = contractsOf(p, d.contracts)[0];
  if (!contract) return { ok: false, message: "这个引擎没有实现任何契约，没法测试" };
  const input = contract.def.sample ?? {};
  const started = Date.now();
  try {
    // Never from the result cache: the cached answer came with whatever key was there before.
    const res = await d.invoker.invoke({ contract: contract.id, input, engines: [p.ref], cache: false }, {
      keyTest: { engine: p.ref, secrets: values },
      signal,
    });
    if (!res.ok) return { ok: false, message: res.error ? errorText(res.error) : "测试没通过" };
    const hosts = await saveKey(p, values, d, signal);
    // the test just sent this key to these hosts with the user's go-ahead
    d.secrets.confirmHosts(p.ref, hosts);
    return { ok: true, ms: Date.now() - started, contract: contract.id, input, output: res.output };
  } catch {
    // stopped, or anything but a CallError (a rule bug, a host lookup failing): nothing was stored
    return { ok: false, message: signal?.aborted ? "测试已停止" : "测试时出了意外错误" };
  }
}
