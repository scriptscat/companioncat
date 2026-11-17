import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isCallError, ERROR_TYPES, type CallError } from "../../../core/errors";
import { createStepCache, executeImpl, type TraceEvent } from "../../../core/impl";
import { masker } from "../../../core/impl/mask";
import { useShell } from "../../../shell/context";
import { renderView } from "../../../views";
import { Btn, Dot, Segments, cn } from "../../../ui";
import { createConfirmHost } from "../confirm";
import type { TracePanelProps } from "../slot";
import { failedStep, groupSteps, type TraceStep } from "./steps";

/** Raw responses longer than this are cut until the user expands them (R12.2). */
export const RAW_PREVIEW = 2000;

const pretty = (v: unknown) => (typeof v === "string" ? v : (JSON.stringify(v, null, 2) ?? String(v)));
const code = "cc-scroll mt-2 overflow-x-auto rounded-xl bg-sunken p-3 font-code text-[11px] leading-[1.6] text-ink-2 whitespace-pre-wrap break-all";

interface Run {
  events: TraceEvent[];
  ok: boolean;
  ms: number;
  output?: unknown;
  error?: CallError;
  /** Set when the run never reached the engine. */
  problem?: string;
}

/** Used when the engine declares no limits.timeoutMs (same as the call pipeline). */
const TIMEOUT_MS = 30_000;

/**
 * The trial run calls executeImpl directly instead of invoke, so it never reads or writes the result
 * cache (R12.1). Each run has a fresh step cache: a token step is requested and shown, not hidden.
 */
export function TracePanel({ provider, contracts, secrets }: TracePanelProps) {
  const shell = useShell();
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const [id, setId] = useState(contracts[0]?.id ?? "");
  const contract = contracts.find((c) => c.id === id) ?? contracts[0];
  const sampleOf = (c?: { def: { sample?: unknown } }) => JSON.stringify(c?.def.sample ?? {}, null, 2);
  const [text, setText] = useState(() => sampleOf(contract));
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const seq = useRef(0);

  if (!contract) return <p className="text-[12.5px] text-ink-3">这个引擎没有可以试运行的契约。</p>;

  const pick = (next: string) => {
    setId(next);
    setText(sampleOf(contracts.find((c) => c.id === next)));
    setRun(null);
  };

  const start = async () => {
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch (e) {
      setRun({ events: [], ok: false, ms: 0, problem: `输入不是合法的 JSON：${(e as Error).message}` });
      return;
    }
    const mine = ++seq.current;
    abort.current?.abort();
    const ctl = (abort.current = new AbortController());
    setBusy(true);
    const events: TraceEvent[] = [];
    const started = Date.now();
    const finish = (r: Omit<Run, "events" | "ms">) => mine === seq.current && setRun({ events, ms: Date.now() - started, ...r });
    const values: Record<string, string | undefined> = {};
    for (const s of provider.def.secrets ?? []) values[s.name] = secrets.get(provider.ref, s.name);
    const keyed = Object.keys(values).length > 0;
    // the app's dialog knows which pack versions changed (R7.4); tests and bare shells fall back to a plain one
    const ask = shell.services.confirmHost ?? createConfirmHost(shell.layer);
    try {
      const output = await executeImpl(provider, contract.id, input, {
        rules: shell.services.rules.get(),
        secrets: values,
        stepCache: createStepCache(),
        // Same rule as invoke (R7.4): keyless engines need no confirmation; a keyed engine's host must
        // be confirmed already or allowed in the dialog, and refusing stops the engine.
        confirmHost: async (host, prov) => {
          if (!keyed || secrets.isHostConfirmed(prov.ref, host)) return true;
          if (await ask({ provider: prov, hosts: [host], confirmed: secrets.hostsConfirmed(prov.ref) })) {
            secrets.confirmHosts(prov.ref, [host]);
            return true;
          }
          secrets.setDisabled(prov.ref, true);
          return false;
        },
        onTrace: (ev) => void events.push(ev),
        signal: ctl.signal,
        timeoutMs: provider.def.limits?.timeoutMs ?? TIMEOUT_MS,
      });
      finish({ ok: true, output });
    } catch (e) {
      finish(isCallError(e) ? { ok: false, error: e } : { ok: false, problem: (e as Error).message });
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {contracts.length > 1 && (
        <Segments label="契约" value={contract.id} onChange={pick} options={contracts.map((c) => ({ value: c.id, label: c.id }))} />
      )}
      <textarea
        aria-label="输入"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(10, text.split("\n").length + 1)}
        className="cc-scroll w-full rounded-xl border-[1.5px] border-line bg-sunken p-3 font-code text-[11.5px] leading-[1.6] text-ink outline-none focus-visible:border-ginger"
      />
      <div>
        <Btn disabled={busy} onClick={start}>
          用样例试运行
        </Btn>
      </div>
      {run && <Result run={run} contract={contract} provider={provider} secrets={secrets} />}
    </div>
  );
}

function Result({ run, contract, provider, secrets }: { run: Run; contract: TracePanelProps["contracts"][number]; provider: TracePanelProps["provider"]; secrets: TracePanelProps["secrets"] }) {
  // The engine masks keys before emitting; masking again here keeps a leak from ever reaching the screen.
  const mask = useMemo(() => {
    const values: Record<string, string | undefined> = {};
    for (const s of provider.def.secrets ?? []) values[s.name] = secrets.get(provider.ref, s.name);
    return masker(values);
  }, [provider, secrets]);
  const events = useMemo(() => mask(run.events), [mask, run.events]);
  const steps = groupSteps(events);
  const err = run.error && isCallError(run.error) ? run.error : undefined;
  const expr = err?.detail.expr;
  const bad = run.ok ? -1 : failedStep(steps, err?.detail.step, !!expr);
  const output = run.ok ? mask(run.output) : undefined;
  const shell = useShell();
  const views = Object.fromEntries(shell.services.rules.get().views.map((v) => [v.ref, v.def]));

  return (
    <div className="overflow-hidden rounded-[18px] border-[1.5px] border-line bg-fur text-[12.5px]">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <Dot tone={run.ok ? "leaf" : "berry"} />
        <span className="font-semibold">{run.ok ? "成功" : "失败"}</span>
        <span className="text-ink-3">用时 {(run.ms / 1000).toFixed(2)} 秒</span>
        <span className="ml-auto font-code text-[11.5px] text-ink-3">{contract.id}</span>
      </div>
      {steps.length > 0 && (
        <ol className="flex flex-col">
          {steps.map((s, i) => (
            <StepView key={i} n={i + 1} step={s} failed={i === bad} />
          ))}
        </ol>
      )}
      {!run.ok && <Failure run={run} err={err} stepNo={bad >= 0 ? bad + 1 : undefined} mask={mask} />}
      {run.ok && (
        <section aria-label="输出" className="border-t border-line bg-paper px-4 py-3">
          <p className="mb-1.5 text-ink-3">输出</p>
          {renderView(
            (contract.def.view as Record<string, unknown> | undefined) ?? null,
            { result: output, output },
            () => {},
            { outputSchema: contract.def.output, views },
          )}
        </section>
      )}
    </div>
  );
}

function Failure({ run, err, stepNo, mask }: { run: Run; err?: CallError; stepNo?: number; mask: <T>(v: T) => T }) {
  const info = err ? ERROR_TYPES[err.type] : undefined;
  const expr = err?.detail.expr;
  return (
    <div role="alert" className="border-t border-line bg-paper px-4 py-3">
      <p className="font-semibold text-berry">
        {info?.title ?? "出错了"}
        {stepNo !== undefined && <span className="font-normal text-ink-3">，在第 {stepNo} 步</span>}
      </p>
      <p className="mt-1 text-ink-2">{mask(err?.message ?? run.problem ?? "")}</p>
      {expr && (
        <div className="mt-2">
          <p className="text-ink-3">
            {expr.position}，第 {expr.start}–{expr.end} 个字符
          </p>
          <pre className={code}>
            {"{{ "}
            <mark className="rounded-sm bg-berry/20 px-0.5 text-ink">{expr.source}</mark>
            {" }}"}
          </pre>
          <p className="mt-1 text-berry">{expr.message}</p>
        </div>
      )}
    </div>
  );
}

function StepView({ n, step, failed }: { n: number; step: TraceStep; failed: boolean }) {
  const title = step.bridge
    ? `${step.bridge.from} 由「${step.bridge.bridge}」桥接到 ${step.bridge.to}`
    : step.request
      ? `${step.id}：${step.request.method} ${step.request.url}`
      : step.cached
        ? `${step.id}：使用缓存`
        : "准备";
  return (
    <li aria-label={`第 ${n} 步`} data-failed={failed ? "true" : undefined} className={cn("border-b border-line px-4 py-3 last:border-b-0", failed && "bg-berry/10")}>
      <p className="flex items-center gap-2 font-semibold">
        <span className="flex size-5 items-center justify-center rounded-full bg-patch text-[11px] text-on-patch">{n}</span>
        <span className="break-all">{title}</span>
      </p>
      {step.request && (
        <pre className={code}>
          {Object.entries(step.request.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n")}
          {step.request.body !== undefined && `\n${step.request.body}`}
        </pre>
      )}
      {step.response && <Response r={step.response} />}
      {step.exprs.length > 0 && (
        <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 font-code text-[11.5px]">
          {step.exprs.map((e, i) => (
            <Expr key={i} e={e} />
          ))}
        </dl>
      )}
    </li>
  );
}

function Expr({ e }: { e: TraceStep["exprs"][number] }): ReactNode {
  const failed = e.error !== undefined;
  return (
    <div className={cn("contents", failed && "text-berry")} {...(failed ? { "data-failed-expr": "true" } : {})}>
      <dt className="col-span-2 truncate text-ink-3">{e.position}</dt>
      <dd className="min-w-0 break-all text-ink-2">{pretty(e.template)}</dd>
      <dd className={cn("text-right break-all", failed ? "text-berry" : "text-leaf")}>{failed ? e.error : (JSON.stringify(e.value) ?? "undefined")}</dd>
    </div>
  );
}

function Response({ r }: { r: NonNullable<TraceStep["response"]> }) {
  const [open, setOpen] = useState(false);
  const long = r.body.length > RAW_PREVIEW;
  return (
    <div className="mt-2">
      <p className="text-ink-3">
        {r.status}，用时 {r.ms} ms，{r.chunks} 段
      </p>
      <pre data-testid="raw-response" className={code}>
        {long && !open ? r.body.slice(0, RAW_PREVIEW) : r.body}
      </pre>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-[12px] font-semibold text-ginger-ink hover:underline">
          {open ? "收起" : `展开全部（共 ${r.body.length} 个字符）`}
        </button>
      )}
    </div>
  );
}
