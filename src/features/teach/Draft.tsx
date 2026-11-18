// 「教小猫做件事」面板的右边（R6.5–R6.7）：草稿 vN、它会做什么（和上一版比）、在这个网页上试运行、
// 存进本地规则；还有对话里 3 轮返修都没通过时的「让小猫再试」「自己改」。
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, CircleAlert, FileJson2, Send } from "lucide-react";
import { elementOf, isElementHandle } from "../../core/expr";
import { isObject } from "../../core/rules/merge";
import type { EntryDef, FeatureDef, ResolvedProvider, RunStepDef, SettingDef } from "../../core/rules/types";
import { editLocalRules } from "../../pages/rules/RulesPage";
import { useAsync } from "../../pages/engines/useAsync";
import { Btn, Cat, cn, Tag } from "../../ui";
import { runAutomation, type RunReport, type StepPath } from "../automation/run";
import { questionFinders } from "../automation/questions";
import { ACT_VERBS } from "../automation/steps";
import { preferredOf, providerHosts } from "../page/ConfirmEnable";
import { describeEntry, sendsOf, type DescribeCtx, type Does } from "../page/describe";
import { invokerFor } from "../selection/services";
import { validateDraft, type Turn, type Version } from "./conversation";
import { useMarkers, type Marker } from "./markers";
import { closeTeachPanel, type DraftPaneApi, type TeachSlots } from "./Panel";
import { isHandEdited, saveDraft, saveUnsaved, withDraft } from "./store";

// ---------- 它会做什么：和上一版比 ----------

export type Change = "+" | "-" | "~";
export interface Sentence extends Does {
  change?: Change;
  /** For a changed sentence: what it said before. */
  was?: string;
}

const CHANGE: Record<Change, { sign: string; label: string; cls: string }> = {
  "+": { sign: "+", label: "新加", cls: "bg-leaf-soft text-leaf" },
  "-": { sign: "−", label: "删掉", cls: "bg-berry-soft text-berry" },
  "~": { sign: "~", label: "改了", cls: "bg-ginger-soft text-ginger-ink" },
};

/** Field source without step positions, so removing one step does not mark every later one as changed. */
const norm = (detail: string) => detail.replace(/\[\d+\]/g, "[]");
const keyOf = (d: Does) => `${d.what}\u0000${norm(d.detail)}`;
/** What a sentence is about (find, act, if, match…): a removed and an added sentence of one kind are a change. */
function kindOf(d: Does): string {
  const head = norm(d.detail).split("；")[0]!.split(" = ")[0]!;
  const kind = head.slice(head.lastIndexOf(".") + 1);
  return kind === "minConfidence" ? "act" : kind;
}

/** The sentences of `next`, with those removed since `prev` kept in place; marks + / − / ~. */
export function diffSentences(prev: readonly Does[], next: readonly Does[]): Sentence[] {
  const a = prev.map(keyOf);
  const b = next.map(keyOf);
  // longest common subsequence of unchanged sentences
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);

  const out: Sentence[] = [];
  let gone: Does[] = [];
  let added: Does[] = [];
  /** Between two unchanged sentences: a removed and an added one of the same kind are one change. */
  const flush = () => {
    const left = [...gone];
    const was = new Map<Does, Does>();
    for (const d of added) {
      const at = left.findIndex((r) => kindOf(r) === kindOf(d));
      if (at >= 0) was.set(d, left.splice(at, 1)[0]!);
    }
    for (const r of gone) if (left.includes(r)) out.push({ ...r, change: "-" });
    for (const d of added) {
      const old = was.get(d);
      out.push(old ? { ...d, change: "~", was: old.what } : { ...d, change: "+" });
    }
    gone = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      out.push({ ...next[j]! });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) added.push(next[j++]!);
    else gone.push(prev[i++]!);
  }
  flush();
  return out;
}

const entriesOf = (draft: unknown): EntryDef[] =>
  isObject(draft) && Array.isArray(draft.entries) ? (draft.entries as unknown[]).filter((e): e is EntryDef => isObject(e) && typeof e.id === "string") : [];

/** describeEntry, or nothing for an entry it cannot read (a hand edit may be broken). */
function describe(draft: unknown, entry: EntryDef, ctx: DescribeCtx): Does[] {
  try {
    return describeEntry(draft as FeatureDef, entry, ctx);
  } catch {
    return [];
  }
}

interface EntryDiff {
  id: string;
  name: string;
  sentences: Sentence[];
}

function diffDrafts(prev: unknown, next: unknown, ctx: DescribeCtx): EntryDiff[] {
  const before = entriesOf(prev);
  const out: EntryDiff[] = entriesOf(next).map((e) => {
    const old = before.find((x) => x.id === e.id);
    const now = describe(next, e, ctx);
    return { id: e.id, name: e.name, sentences: prev === undefined ? now : diffSentences(old ? describe(prev, old, ctx) : [], now) };
  });
  if (prev !== undefined)
    for (const e of before)
      if (!out.some((x) => x.id === e.id)) out.push({ id: e.id, name: e.name, sentences: describe(prev, e, ctx).map((d) => ({ ...d, change: "-" as const })) });
  return out;
}

function changeSummary(diffs: readonly EntryDiff[], prev: number): string {
  const count = (c: Change) => diffs.reduce((n, d) => n + d.sentences.filter((s) => s.change === c).length, 0);
  const parts = [
    count("+") && `加 ${count("+")} 处`,
    count("~") && `改 ${count("~")} 处`,
    count("-") && `删 ${count("-")} 处`,
  ].filter(Boolean);
  return parts.length ? `比 v${prev}：${parts.join("、")}` : `和 v${prev} 一样`;
}

// ---------- 在这个网页上试运行 ----------

interface TrialRow {
  path: string;
  /** e.g. `act: click`. */
  kind: string;
  summary: string;
  marks: string[];
  /** Contract and engine refs a call/ask would send to. */
  send?: { what: string; engines: string[] };
  error?: string;
}

interface Trial {
  entries: { id: string; name: string; rows: TrialRow[]; end: RunReport["end"] }[];
  marks: Marker[];
  /** The dry run itself broke. */
  error?: string;
}

const pathText = (path: StepPath) => `run${path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("")}`;

function stepAt(run: readonly RunStepDef[], path: StepPath): RunStepDef | undefined {
  let list: unknown = run;
  let step: RunStepDef | undefined;
  for (const seg of path) {
    if (typeof seg === "number") step = Array.isArray(list) ? (list[seg] as RunStepDef | undefined) : undefined;
    else {
      list = (step as Record<string, unknown> | undefined)?.[seg];
      if (!Array.isArray(list)) return step;
    }
  }
  return step;
}

function kindText(step: RunStepDef | undefined, fallback: string): string {
  if (step?.act !== undefined) return `act: ${step.act}`;
  if (step?.ask !== undefined) return `ask: ${step.ask}`;
  if (step?.call !== undefined) return `call: ${step.call}`;
  return fallback;
}

/** The element a found item stands for: a handle itself, or the container of an auto:questions question. */
function elementFrom(item: unknown): Element | undefined {
  if (isElementHandle(item)) return elementOf(item);
  if (isObject(item) && isElementHandle(item.handle)) return elementOf(item.handle);
  return undefined;
}

/** A, B, … Z, AA, AB… */
function letter(n: number): string {
  let s = "";
  for (let k = n + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}

/** Draft settings at their defaults: the draft is not saved, so nobody has set them yet. */
function defaults(draft: unknown, entry: EntryDef): Record<string, unknown> {
  const defs = { ...((isObject(draft) ? draft.settings : undefined) as Record<string, SettingDef> | undefined), ...entry.settings };
  return Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, d.default]));
}

/**
 * Runs every entry of the draft on this page in dry mode: nothing is acted on and no engine is called.
 * Elements a single find found get letters (A, B…), those of a list find numbers (1, 2…).
 */
async function tryOut(draft: unknown, invoker: Parameters<typeof runAutomation>[2]["invoker"], ctx: DescribeCtx, signal: AbortSignal): Promise<Trial> {
  const labels = new Map<Element, string>();
  const notes = new Map<Element, string>();
  let letters = 0;
  let numbers = 0;
  const trial: Trial = { entries: [], marks: [] };
  for (const entry of entriesOf(draft)) {
    const run = Array.isArray(entry.run) ? entry.run : [];
    const report = await runAutomation(
      run,
      { settings: defaults(draft, entry), page: { url: location.href, title: document.title }, site: {} },
      {
        invoker,
        mode: "dry",
        signal,
        // the same auto:* finders the runtime uses
        finders: questionFinders,
        act: () => {
          throw new Error("试运行不会动手");
        },
      },
    );
    const sends = sendsOf(entry, ctx);
    const rows = new Map<string, TrialRow>();
    for (const s of report.steps) {
      const path = pathText(s.path);
      const step = stepAt(run, s.path);
      const els = (s.found ?? []).flatMap((f) => elementFrom(f) ?? []);
      for (const el of els) {
        if (!labels.has(el)) labels.set(el, step?.find !== undefined && step.all ? String(++numbers) : letter(letters++));
        if (step?.act !== undefined) notes.set(el, `会${ACT_VERBS[step.act]}这个`);
      }
      let row = rows.get(path);
      if (!row) {
        row = { path, kind: kindText(step, s.kind), summary: s.summary, marks: [] };
        if (s.send) row.send = { what: sends.find((x) => x.path === path)?.what ?? "这一步的输入内容", engines: s.send.engines };
        rows.set(path, row);
      }
      for (const el of els) if (!row.marks.includes(labels.get(el)!)) row.marks.push(labels.get(el)!);
      if (s.error) row.error = s.error.message;
    }
    trial.entries.push({ id: entry.id, name: entry.name, rows: [...rows.values()], end: report.end });
  }
  trial.marks = [...labels].map(([el, label]) => {
    const note = notes.get(el);
    return note ? { el, label, note } : { el, label };
  });
  return trial;
}

const providerOf = (providers: readonly ResolvedProvider[], ref: string) => providers.find((p) => p.ref === ref || p.id === ref);

function SendLine({ send, providers, hosts }: { send: NonNullable<TrialRow["send"]>; providers: readonly ResolvedProvider[]; hosts?: Record<string, string[]> }) {
  const found = send.engines.flatMap((e) => providerOf(providers, e) ?? []);
  const names = found.map((p) => p.def.name);
  const to = [...new Set(found.flatMap((p) => hosts?.[p.ref] ?? (p.def.hosts ?? []).filter((h) => !h.includes("{{"))))];
  return (
    <p className="mt-1 flex items-start gap-1.5 rounded-xl bg-ginger-soft px-2.5 py-1.5 text-[12px] leading-snug text-ginger-ink">
      <Send className="mt-0.5 size-3 shrink-0" />
      <span>
        会发：{send.what} → {names.length ? `${names.join("、")}（` : ""}
        <span className="font-code font-semibold">{to.length ? to.join("、") : "还没选引擎"}</span>
        {names.length ? "）" : ""}
      </span>
    </p>
  );
}

// ---------- 草稿区 ----------

function Empty() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <Cat size={92} zzz />
      <p className="mt-3 text-[15px] font-bold">草稿会出现在这里</p>
      <p className="mt-1.5 max-w-[300px] text-[12.5px] leading-relaxed text-ink-2">
        小猫每写一版，都会先自己校验、改错，再在这个网页上试运行给你看：只标出会碰到的元素，不点任何东西，也不调用引擎。
      </p>
    </div>
  );
}

function DraftPane({ api }: { api: DraftPaneApi }) {
  const { ctx, conversation, state } = api;
  const { storage } = ctx.services;
  const version: Version | undefined = state.versions[state.current - 1];
  const prev: Version | undefined = state.versions[state.current - 2];
  const resolved = ctx.services.rules.get();
  const hosts = useAsync(() => providerHosts(resolved), [resolved]);
  const describeCtx = useMemo<DescribeCtx>(
    () => ({ providers: resolved.providers, ...(hosts ? { hosts } : {}), preferred: preferredOf(ctx.services) }),
    [resolved, hosts, ctx.services],
  );
  const problems = useMemo(
    () => (version ? validateDraft(version.draft, ctx.services.subscriptions?.sources() ?? []) : []),
    [version, ctx.services.subscriptions],
  );
  const valid = problems.length === 0;
  const diffs = useMemo(() => (version ? diffDrafts(prev?.draft, version.draft, describeCtx) : []), [version, prev, describeCtx]);

  const [trial, setTrial] = useState<Trial | undefined>();
  const invoker = invokerFor(ctx.services);
  useEffect(() => {
    setTrial(undefined);
    if (!version || !valid) return;
    const controller = new AbortController();
    void tryOut(version.draft, invoker, { providers: resolved.providers }, controller.signal).then(
      (t) => !controller.signal.aborted && setTrial(t),
      (e: unknown) => !controller.signal.aborted && setTrial({ entries: [], marks: [], error: e instanceof Error ? e.message : String(e) }),
    );
    return () => controller.abort();
    // the invoker and providers only matter for the next run; rerunning on them would redraw for nothing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, valid]);
  useMarkers(ctx.layer, trial?.marks ?? NO_MARKS);

  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => setSaveError(null), [version]);

  if (!version) return <Empty />;
  const n = version.n;
  const saved = api.featureId !== undefined && api.savedVersion === n;
  const save = () => {
    const r = saveDraft(storage, conversation, version.draft, api.featureId !== undefined ? { featureId: api.featureId } : {});
    if (!r.ok) return setSaveError(r.error);
    setSaveError(null);
    api.markSaved(r.featureId, n);
  };
  const sendsAny = trial?.entries.some((e) => e.rows.some((r) => r.send)) ?? false;
  const many = diffs.length > 1;

  return (
    <section aria-label="草稿" className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="text-[14px] font-bold">草稿 v{n}</span>
        {valid ? <Tag tone="leaf">通过校验</Tag> : <Tag tone="berry">没通过校验</Tag>}
        {isHandEdited(version) && <Tag tone="plain">你手改的</Tag>}
        <span role="radiogroup" aria-label="草稿版本" className="ml-auto flex gap-0.5 rounded-full bg-sunken p-0.5">
          {state.versions.map((v) => (
            <button
              key={v.n}
              type="button"
              role="radio"
              aria-checked={v.n === n}
              onClick={() => conversation.select(v.n)}
              className={cn("h-6 rounded-full px-2.5 text-[12px] font-semibold", v.n === n ? "bg-patch text-on-patch" : "text-ink-2 hover:text-ink")}
            >
              v{v.n}
            </button>
          ))}
        </span>
      </div>

      <div className="cc-scroll min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4">
        {state.errors.length > 0 && (
          <p className="mb-3 rounded-xl bg-berry-soft px-3 py-2 text-[12px] leading-relaxed text-berry">
            小猫最新一版没通过校验，这里还是能用的 v{n}。左边列出了剩下的问题。
          </p>
        )}
        {n < state.versions.length && (
          <p className="mb-3 rounded-xl bg-sunken px-3 py-2 text-[12px] leading-relaxed text-ink-2">
            你在看旧版 v{n}。现在存，存的就是这一版；接着对话，小猫会从这一版改起。
          </p>
        )}

        <section>
          <h4 className="mb-1.5 text-[12.5px] font-semibold text-ink-2">它会做什么</h4>
          {prev && (
            <p className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] leading-snug text-ink-3">
              {changeSummary(diffs, prev.n)}
              <span className="text-[11px] whitespace-nowrap">
                <b className="text-leaf">+</b> 新加 <b className="text-berry">−</b> 删掉 <b className="text-ginger-ink">~</b> 改了
              </span>
            </p>
          )}
          <div className="flex flex-col gap-2">
            {diffs.map((d) => (
              <div key={d.id}>
                {many && <p className="mb-1 text-[12px] font-semibold text-ink-2">{d.name}</p>}
                <ul className="flex flex-col gap-1.5 rounded-2xl bg-sunken/70 px-3 py-2.5 text-[13px]">
                  {d.sentences.map((s, i) => {
                    const c = s.change ? CHANGE[s.change] : undefined;
                    return (
                      <li key={i} className="flex gap-2" title={s.was ? `原来：${s.was}` : undefined}>
                        <span
                          aria-label={c?.label}
                          className={cn(
                            "mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-md font-code text-[12px] font-bold",
                            c ? c.cls : "text-transparent",
                          )}
                        >
                          {c?.sign ?? "·"}
                        </span>
                        <span className={cn("flex min-w-0 flex-col", s.change === "-" && "text-ink-3 line-through decoration-berry/60")}>
                          <span className={s.change === "-" ? "" : "text-ink"}>{s.what}</span>
                          <span className="font-code text-[11px] text-ink-3">{s.detail}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-3.5">
          <h4 className="mb-1.5 text-[12.5px] font-semibold text-ink-2">在这个网页上试运行</h4>
          {!valid ? (
            <p className="rounded-2xl border-[1.5px] border-dashed border-berry/40 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
              没通过校验的草稿不能试运行。
            </p>
          ) : !trial ? (
            <p className="px-1 text-[12.5px] text-ink-3">正在试运行…</p>
          ) : trial.error ? (
            <p role="alert" className="rounded-2xl bg-berry-soft px-3 py-2.5 text-[12.5px] text-berry">
              试运行出错了：{trial.error}
            </p>
          ) : (
            <ol className="overflow-hidden rounded-2xl border-[1.5px] border-line">
              {trial.entries.flatMap((e) => [
                ...(many ? [<li key={`${e.id}-name`} className="border-t border-line bg-sunken/60 px-3 py-1.5 text-[12px] font-semibold text-ink-2 first:border-t-0">{e.name}</li>] : []),
                ...e.rows.map((r) => (
                  <li key={`${e.id}-${r.path}`} className="border-t border-line px-3 py-2 first:border-t-0">
                    <p className="flex items-center gap-2">
                      <code className="font-code text-[11px] text-ink-3">
                        {r.path} {r.kind}
                      </code>
                      {r.marks.length > 0 && <span className="rounded-full bg-ginger px-1.5 text-[10.5px] font-bold text-on-ginger">{r.marks.join("、")}</span>}
                    </p>
                    <p className="text-[13px] text-ink">{r.summary}</p>
                    {r.error && <p className="mt-0.5 text-[12px] text-berry">{r.error}</p>}
                    {r.send && <SendLine send={r.send} providers={resolved.providers} hosts={hosts} />}
                  </li>
                )),
              ])}
              <li className={cn("border-t border-line px-3 py-2 text-[12px]", sendsAny ? "text-ink-3" : "text-leaf")}>
                {sendsAny ? "试运行没有点任何东西，也没有真的调用引擎" : "这一版不会把任何内容发给引擎；试运行没有点任何东西"}
              </li>
            </ol>
          )}
        </section>

        <details className="group mt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink-2">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
            <FileJson2 className="size-3.5" />
            规则详情
          </summary>
          <pre className="cc-scroll mt-1.5 max-h-[240px] overflow-auto rounded-2xl bg-sunken p-3 font-code text-[10.5px] leading-[1.6] text-ink-2">
            {JSON.stringify(version.draft, null, 2)}
          </pre>
        </details>
      </div>

      <div className="flex shrink-0 items-center gap-2.5 border-t border-line px-4 py-3">
        <Btn size="sm" disabled={!valid} onClick={save}>
          存进本地规则
        </Btn>
        <span role={saveError ? "alert" : undefined} className={cn("min-w-0 flex-1 text-[11.5px] leading-snug", valid && !saveError ? "text-ink-3" : "text-berry")}>
          {saveError ??
            (!valid
              ? `v${n} 没通过校验（${problems[0]!.path || "整个草稿"}：${problems[0]!.message}），不能存。${state.versions.length > 1 ? "可以切回别的版本存，或接着让小猫改" : "可以接着让小猫改"}`
              : saved
                ? `v${n} 已存进本地规则`
                : api.featureId !== undefined
                  ? `存 v${n}，只改这一条规则，不动别的`
                  : `存 v${n}，只新增这一条规则，不动别的`)}
        </span>
      </div>
    </section>
  );
}

const NO_MARKS: Marker[] = [];

// ---------- 对话里：3 轮返修都没通过 ----------

function Rejected({ turn, api }: { turn: Turn; api: DraftPaneApi }) {
  const [error, setError] = useState<string | null>(null);
  const { storage } = api.ctx.services;
  const selfEdit = () => {
    const edit = withDraft(storage, turn.rejected, api.featureId);
    if (!edit.ok) return setError(edit.error);
    // the conversation stays for 「接着上次没写完的」; the panel would cover the editor
    saveUnsaved(storage, api.conversation, api.featureId !== undefined ? { featureId: api.featureId } : {});
    editLocalRules(edit.text);
    closeTeachPanel(api.ctx.layer);
    api.ctx.openSettings("rules");
  };
  return (
    <>
      <span className="mt-2 flex flex-wrap gap-1.5">
        <Btn size="xs" disabled={api.state.pending} onClick={() => void api.conversation.retry()}>
          让小猫再试
        </Btn>
        <Btn size="xs" variant="outline" disabled={api.state.pending} onClick={selfEdit}>
          <FileJson2 />
          自己改
        </Btn>
      </span>
      {error && (
        <p role="alert" className="mt-1.5 flex items-center gap-1.5 text-[12px] text-berry">
          <CircleAlert className="size-3.5 shrink-0" />
          {error}
        </p>
      )}
    </>
  );
}

/** The panel's right side (R6.5–R6.7); plug into openTeachPanel's `draftPane`. */
export function draftPane(api: DraftPaneApi): ReactNode {
  return <DraftPane api={api} />;
}

/**
 * Under the cat's last reply: after the repair rounds ran out (its remaining errors are listed by the
 * chat above), 「让小猫再试」 and 「自己改」. Plug into openTeachPanel's `turnFooter`.
 */
export function turnFooter(turn: Turn, api: DraftPaneApi): ReactNode {
  if (turn.status !== "done" || !turn.check?.remaining.length || turn.rejected === undefined) return null;
  return <Rejected turn={turn} api={api} />;
}

/** Both slots, for openTeachPanel(ctx, { ...draftSlots, … }). */
export const draftSlots: Required<TeachSlots> = { draftPane, turnFooter };
