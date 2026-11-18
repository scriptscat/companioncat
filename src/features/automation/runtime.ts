/**
 * The automation runtime (R1.1, R1.6, R3.1–R3.6): wires every automation entry that applies to the
 * page to its triggers (page-load, appear, command), checks consent, the site pause and the
 * trigger's `enabled` each time one fires, runs the steps (one run per entry at a time; a
 * re-trigger while running is dropped), and logs every act. Navigation discards unfinished runs.
 */
import type { InvokeResult } from "../../core/invoke";
import { describeElement, elementHandle, elementOf, isElementHandle, renderTemplate, type ElementHandle, type Scope } from "../../core/expr";
import { isAutomationEntry } from "../../core/rules/automation";
import type { ActStep, CommandTrigger, Resolved, RunStepDef, TriggerDef } from "../../core/rules/types";
import { POSITIONS } from "../../core/rules/positions";
import { createActionLog, createAutomationPrefs, createSettingsStore, type ActionRecord, type ActionRecordInput, type AutomationPrefs } from "../../core/stores";
import { featureTarget, type Command, type RuntimeContext } from "../../shell";
import { actsOf } from "../page/describe";
import { disable, gateOf, type Gate } from "../page/enabled";
import { isLocalEntry, preferredOf, providerHosts, requestConsent as askConsent, settingValues } from "../page/ConfirmEnable";
import { invokerFor, type CallPort } from "../selection/services";
import { settingsOf, siteOf } from "../selection/triggers";
import { performAct, type ActPrefs, type ActRecord, type AskUser, type Hint, type HintSuggestion } from "./acts";
import { createAskUser, type AskPromptWithEngine } from "./AskBubble";
import { badge, showActFeedback } from "./Feedback";
import { createHint } from "./Hint";
import { NO_QUESTIONS, questionFinders } from "./questions";
import { presentAutomation } from "./Result";
import { runAutomation, type ActCtx, type AutoEnv, type Finder, type RunReport, type StepPath, type StepReport } from "./run";
import { afterLoad, automationEntries, DEFAULT_DEBOUNCE_MS, triggerAllows, watchAppear, type AutoEntry } from "./triggers";

/** The cat's label while an ask-first bubble waits (R2.1). */
export const ASKING = "等你回答";

/** One logged act, for the feedback port (R2.2, R2.4). */
export interface ActEvent {
  record: ActRecord;
  /** The element acted on (none for wait). */
  target?: ElementHandle;
  /** The action-log record written for it. */
  logged: ActionRecord;
  /** markWrong flags `logged` and turns always-do off for the rule on this site. */
  prefs: ActPrefs;
}

/** The UI ports. Each defaults to the real one (AskBubble, Hint, Feedback); tests inject fakes. */
export interface AutomationPorts {
  askUser?: AskUser;
  /** Default: a marker whose 「就选」 performs the act anyway. */
  hint?: Hint & { stop?(): void };
  /** After each act is logged. Default: the auto-act toast with 撤销 / 记录. */
  onAct?(e: ActEvent): void;
}

export interface AutomationDeps extends AutomationPorts {
  /** Consent for a command whose entry needs it (R3.2, R3.3). Default: the ConfirmEnable dialog. */
  requestConsent?(ref: string): Promise<boolean>;
  /** Added to questionFinders. */
  finders?: Readonly<Record<string, Finder>>;
}

/** Adapts the stored prefs to performAct/undo: markWrong needs the logged record's id. */
export function actPrefsFor(prefs: Pick<AutomationPrefs, "isAlwaysDo" | "markWrong">, idOf: (r: ActRecord) => string | undefined): ActPrefs {
  return {
    isAlwaysDo: (site, rule) => prefs.isAlwaysDo(site, rule),
    markWrong: (r) => prefs.markWrong(r.site, r.rule, idOf(r)),
  };
}

/** What the action log keeps of an act (never its value): the rule by its name (R3.6), the entry by its ref. */
function logInput(r: ActRecord, ruleName: string): ActionRecordInput {
  const failure = r.error?.message ?? (r.mode === "skip" ? r.summary : undefined);
  return {
    site: r.site,
    rule: ruleName,
    entry: r.rule,
    action: r.act,
    target: r.describe ?? "",
    mode: r.mode,
    ...(r.confidence !== undefined && { confidence: r.confidence }),
    ...(failure !== undefined && { failure }),
  };
}

/** The step at `path` of a run (e.g. [2, "then", 0]). */
function stepAt(steps: readonly RunStepDef[], path: StepPath): RunStepDef | undefined {
  let cur: unknown = steps;
  for (const p of path) cur = (cur as Record<string | number, unknown> | undefined)?.[p];
  return cur as RunStepDef | undefined;
}

/** Acts that put an answer into the page: with a result card, a 「小猫填的 N%」 badge says so instead of a toast each. */
const ANSWER_ACTS = new Set(["fill", "check", "select"]);

/** A call's output with the name of the engine(s) that answered, so a rule can show who answered. */
function withEngineName(res: InvokeResult, nameOf: (ref: string) => string | undefined): InvokeResult {
  if (!res.ok || !res.output || typeof res.output !== "object" || Array.isArray(res.output)) return res;
  const refs = [...new Set(res.results.flatMap((r) => (r.ok ? [r.engine] : [])))];
  if (!refs.length && res.engine) refs.push(res.engine);
  if (!refs.length) return res;
  return { ...res, output: { ...res.output, engine: refs.map((r) => nameOf(r) ?? r).join("、") } };
}

const REWIRE_KEYS = ["cc:on:", "cc:set:"];
/** Most re-runs after failed asks (R5.6); each run adds at least one row or the chain ends. */
const MAX_CONTINUE = 50;

export function startAutomation(ctx: RuntimeContext, deps: AutomationDeps = {}): () => void {
  const { services, hostname } = ctx;
  const { storage } = services;
  const doc = ctx.root.host.ownerDocument;
  const win = doc.defaultView ?? window;
  const settings = createSettingsStore(storage);
  const prefs = createAutomationPrefs(storage);
  const log = createActionLog(storage);
  const invoker = invokerFor(services);
  const finders = { ...questionFinders, ...deps.finders };
  const consent = deps.requestConsent ?? ((ref: string) => askConsent({ layer: ctx.layer, services, hostname }, ref));
  const askUser = deps.askUser ?? createAskUser({ layer: ctx.layer, prefs, setAwake: ctx.setAwake });
  const loggedIds = new WeakMap<ActRecord, string>();
  const actPrefs = actPrefsFor(prefs, (r) => loggedIds.get(r));
  const nameOf = (ref: string) => services.rules.get().providers.find((p) => p.ref === ref)?.def.name;

  /** Unfinished runs by entry ref (a fired trigger counts from the moment it fires). */
  const running = new Map<string, AbortController>();
  /** Hint markers and answer badges of each entry's latest run (removers). */
  const marks = new Map<string, (() => void)[]>();
  const addMark = (ref: string, remove: () => void) => marks.set(ref, [...(marks.get(ref) ?? []), remove]);
  const clearMarks = (ref: string) => {
    for (const remove of marks.get(ref) ?? []) remove();
    marks.delete(ref);
  };
  /** Result cards on the page, by entry ref. */
  const cards = new Map<string, () => void>();
  /** Page-load triggers that already ran (a rule change does not run them again). */
  const loaded = new Set<string>();
  let active = 0;
  let disposed = false;

  const own = (el: Element) => el === ctx.root.host || ctx.root.host.contains(el);
  const pageOf = () => ({ url: win.location.href, title: doc.title });
  /** The page's address without its fragment: a hash change is not a navigation. */
  const address = () => win.location.href.replace(/#.*$/, "");
  /** Where every unfinished run and marker started (synced when a trigger fires); pushState moves the page away from it. */
  let at = address();
  /** Navigation discards unfinished runs; a single-page app moves without pagehide or popstate. */
  const moved = () => {
    if (address() === at) return false;
    onNavigate();
    return true;
  };

  async function gate({ feature, entry }: AutoEntry, resolved: Resolved): Promise<Gate> {
    const local = isLocalEntry(entry);
    if (local || !isAutomationEntry(entry.def)) return gateOf(storage, entry, { local });
    const describe = { providers: resolved.providers, values: settingValues(storage, feature, entry, hostname), hosts: await providerHosts(resolved), preferred: preferredOf(services) };
    return gateOf(storage, entry, { describe });
  }

  function report(rec: ActRecord, target: ElementHandle | undefined, { feature, entry }: AutoEntry) {
    const logged = log.append(logInput(rec, feature.def.name));
    loggedIds.set(rec, logged.id);
    const ev: ActEvent = { record: rec, target, logged, prefs: actPrefs };
    if (deps.onAct) deps.onAct(ev);
    else if (rec.mode === "auto" && target && entry.def.present && ANSWER_ACTS.has(rec.act) && rec.confidence !== undefined)
      addMark(rec.rule, badge(target, rec.confidence, ctx.layer));
    else if (rec.mode === "auto" && target)
      showActFeedback(ctx, rec, { target, prefs: actPrefs, onOpenLog: () => ctx.openSettings(featureTarget(feature)) });
  }

  /** `keep`: a re-run of part of the entry (R5.6) leaves the earlier run's markers where they are. */
  async function execute(t: AutoEntry, scope: Scope, signal: AbortSignal, keep = false): Promise<RunReport> {
    const { entry } = t;
    if (!keep) clearMarks(entry.ref);
    /** 「就选」 on a hint marker: the act of that suggestion, without its threshold. */
    const pending = new WeakMap<HintSuggestion, () => Promise<void>>();
    const hint: Hint & { stop?(): void } =
      deps.hint ?? createHint({ layer: ctx.layer, perform: (_target, s) => pending.get(s)?.() });
    addMark(entry.ref, () => hint.stop?.());
    let engine: string | undefined;
    const port: CallPort = {
      preferredEngines: (c) => invoker.preferredEngines(c),
      invoke: async (...a) => {
        const res = await invoker.invoke(...a);
        if (res.engine) engine = res.engine;
        return withEngineName(res, nameOf);
      },
    };
    const ask: AskUser = async (prompt) => {
      ctx.setAwake(true, ASKING);
      const name = engine && (nameOf(engine) ?? engine);
      try {
        return await askUser({ ...prompt, ruleName: t.feature.def.name, ...(name && { engine: name }) } as AskPromptWithEngine);
      } finally {
        // the bubble clears the cat itself; the run goes on
        if (active > 0) ctx.setAwake(true);
      }
    };
    let acted = false;
    const perform = async (step: ActStep, target: ElementHandle | undefined, c: ActCtx, h: Hint) => {
      acted = true;
      // R3.6: an act without its own describe is named by describe() of its target
      const describe = c.describe ?? (target && elementOf(target).isConnected ? describeElement(target) : undefined);
      const rec = await performAct(step, target, { ...c, ...(describe !== undefined && { describe }), site: hostname, rule: entry.ref, askUser: ask, hint: h, prefs: actPrefs });
      report(rec, target, t);
      return rec;
    };
    const env: AutoEnv = {
      invoker: port,
      signal,
      finders,
      confirmHost: services.confirmHost,
      nameOf,
      // checked right before the page is changed: the page may have moved in place while the run waited
      act: (step, target, c) =>
        moved()
          ? undefined
          : perform(step, target, c, (el, s) => {
              // 「就选」 is your own click, after the run: it does not inherit the run's signal
              const { signal: _run, ...mine } = c;
              pending.set(s, async () => void (moved() || (await perform(step, el, { ...mine, minConfidence: undefined }, () => {}))));
              hint(el, s);
            }),
      log: (s: StepReport) => {
        // R5.2: a page without questions says so
        if (s.kind === "find" && s.found?.length === 0 && stepAt(entry.def.run, s.path)?.find === "auto:questions") ctx.toast?.({ text: NO_QUESTIONS });
        // R1.6: a failed ask is written to the action log with its reason
        if (s.kind === "ask" && s.error)
          log.append({ site: hostname, rule: t.feature.def.name, entry: entry.ref, action: "ask", target: s.send?.contract ?? "", mode: "failed", failure: s.error.message });
      },
    };
    if (active++ === 0) ctx.setAwake(true);
    try {
      const done = await runAutomation(entry.def.run, scope, env);
      if (!acted && !signal.aborted) notApplicable(t, scope, done);
      return done;
    } finally {
      if (--active === 0) ctx.setAwake(false);
    }
  }

  /**
   * R4.2 / R3.6: a run started by a new element (appear) that asked an engine and then did nothing is
   * logged as 不是广告 — the engine judged that the element is not what the rule acts on.
   */
  function notApplicable({ feature, entry }: AutoEntry, scope: Scope, done: RunReport) {
    if (done.end === "error" || done.end === "aborted") return;
    const element = (scope.trigger as { element?: unknown } | undefined)?.element;
    const asks = done.steps.filter((s) => s.kind === "ask" && !s.error);
    if (!isElementHandle(element) || !elementOf(element).isConnected || !asks.length) return;
    const last = stepAt(entry.def.run, asks[asks.length - 1]!.path);
    const answer = done.vars[(last?.ask !== undefined && last.as) || "result"] as { confidence?: unknown } | undefined;
    const confidence = typeof answer?.confidence === "number" ? answer.confidence : undefined;
    log.append({
      site: hostname,
      rule: feature.def.name,
      entry: entry.ref,
      action: actsOf(entry.def)[0] ?? "ask",
      target: describeElement(element),
      mode: "not-applicable",
      ...(confidence !== undefined && { confidence }),
    });
  }

  async function fire(t: AutoEntry, trig: TriggerDef, trigger: Record<string, unknown>) {
    const key = t.entry.ref;
    // the page moved since the runs on it started: they and their markers go before this one starts
    moved();
    if (disposed || running.has(key)) return; // R1.6: still running → drop this trigger
    const ctrl = new AbortController();
    running.set(key, ctrl);
    try {
      if (prefs.isPaused(hostname)) return;
      const resolved = services.rules.get();
      const page = pageOf();
      if (!automationEntries(resolved, storage, page.url).some((x) => x.entry.ref === key)) return;
      const g = await gate(t, resolved).catch((): Gate => "off");
      if (ctrl.signal.aborted || g === "off") return;
      // R3.1: a page-load or appear entry never consented to stays off without asking
      if (g === "needs-consent" && trig.on !== "command") return;
      const scope = { settings: settingsOf(settings, t.feature, t.entry, hostname), site: siteOf(resolved, key, page.url), page, trigger };
      if (!(await triggerAllows(trig, scope)) || ctrl.signal.aborted || prefs.isPaused(hostname)) return;
      if (g !== "on") {
        // R3.2 / R3.3: a command asks first; an entry paused by an update asks again on its next trigger
        const ok = await consent(key);
        if (!ok && trig.on !== "command") disable(storage, key); // 「先不打开」: stays off, and the next trigger does not ask again
        if (!ok || ctrl.signal.aborted || prefs.isPaused(hostname)) return;
      }
      let done = await execute(t, scope, ctrl.signal);
      done = await continueAfterFailure(t, scope, done, ctrl.signal);
      if (!ctrl.signal.aborted && !disposed) showResult(t, scope, done);
    } catch (e) {
      console.error("[陪伴猫] automation run failed", e);
    } finally {
      if (running.get(key) === ctrl) running.delete(key);
    }
  }

  /**
   * R5.6 with R1.6: a failed ask still ends its run, but in an entry with a result card the items the
   * run never reached are not affected by it — the entry runs again with the rows so far (trigger.rows),
   * so the rule goes on with the items it has not tried. Stops when a run adds no row.
   */
  async function continueAfterFailure(t: AutoEntry, scope: Scope, first: RunReport, signal: AbortSignal): Promise<RunReport> {
    let latest = first;
    for (let i = 0; i < MAX_CONTINUE && t.entry.def.present && latest.end === "error" && !signal.aborted && !disposed; i++) {
      const rows = latest.vars.rows;
      if (!Array.isArray(rows)) break;
      const next = await execute(t, { ...scope, trigger: { on: "command", rows } }, signal, true);
      const grew = Array.isArray(next.vars.rows) && next.vars.rows.length > rows.length;
      if (signal.aborted || (next.end !== "done" && next.end !== "error")) break;
      latest = next;
      if (!grew) break;
    }
    return latest;
  }

  /** R5.5 / R5.6: the entry's result card after a run; 重试 on a question runs the entry again for what is not answered yet. */
  function showResult(t: AutoEntry, scope: Scope, first: RunReport) {
    const { ref, def } = t.entry;
    cards.get(ref)?.();
    cards.delete(ref);
    if (!def.present || (first.end !== "done" && first.end !== "error")) return;
    let latest = first;
    const retry = async (id: string): Promise<RunReport | undefined> => {
      if (disposed || running.has(ref) || prefs.isPaused(hostname)) return;
      const ctrl = new AbortController();
      running.set(ref, ctrl);
      try {
        const next = await execute(t, { ...scope, trigger: { on: "command", retry: id, rows: latest.vars.rows } }, ctrl.signal, true);
        if (ctrl.signal.aborted || (next.end !== "done" && next.end !== "error")) return;
        return (latest = next);
      } catch (e) {
        console.error("[陪伴猫] automation retry failed", e);
      } finally {
        if (running.get(ref) === ctrl) running.delete(ref);
      }
    };
    cards.set(ref, presentAutomation(ctx, t, first, { retry }));
  }

  const abortAll = () => {
    for (const c of running.values()) c.abort();
    running.clear();
  };

  // ---- wiring: rebuilt when the rules or the switches/settings change
  let unwire: (() => void)[] = [];
  let commands: { cmd: Command; off: () => void }[] = [];
  let generation = 0;

  async function commandOf(t: AutoEntry, trig: CommandTrigger, i: number): Promise<Command> {
    const page = pageOf();
    const scope = { settings: settingsOf(settings, t.feature, t.entry, hostname), site: siteOf(services.rules.get(), t.entry.ref, page.url), page };
    let { title, hotkey } = trig;
    try {
      const r = (await renderTemplate({ title, hotkey }, scope, POSITIONS.autoTrigger)) as { title?: unknown; hotkey?: unknown };
      if (typeof r.title === "string") title = r.title;
      hotkey = typeof r.hotkey === "string" && r.hotkey ? r.hotkey : undefined;
    } catch {
      hotkey = undefined;
    }
    return {
      id: `automation:${t.entry.ref}:${i}`,
      title,
      ...(hotkey && { hotkey }),
      ...(trig.quick !== undefined && { quick: trig.quick }),
      run: () => void fire(t, trig, { on: "command" }),
      disabled: () => prefs.isPaused(hostname),
    };
  }

  async function wire() {
    const mine = ++generation;
    for (const off of unwire) off();
    unwire = [];
    const list = automationEntries(services.rules.get(), storage, pageOf().url);
    const next: Command[] = [];
    for (const t of list) {
      t.entry.def.triggers.forEach((trig, i) => {
        const key = `${t.entry.ref}:${i}`;
        if (trig.on === "page-load" && !loaded.has(key)) {
          unwire.push(
            afterLoad(win, () => {
              loaded.add(key);
              void fire(t, trig, { on: "page-load" });
            }),
          );
        } else if (trig.on === "appear") {
          unwire.push(watchAppear(doc, trig.selector, trig.debounceMs ?? DEFAULT_DEBOUNCE_MS, own, (el) => void fire(t, trig, { on: "appear", element: elementHandle(el) })));
        }
      });
    }
    for (const t of list) for (const [i, trig] of t.entry.def.triggers.entries()) if (trig.on === "command") next.push(await commandOf(t, trig, i));
    if (mine !== generation || disposed) return;
    for (const c of commands) c.off();
    commands = next.map((cmd) => ({ cmd, off: ctx.commands.register(cmd) }));
  }

  /** The shell re-reads disabled() only when the command list changes: re-register on pause changes (R3.6). */
  function reregister() {
    for (const c of commands) {
      c.off();
      c.off = ctx.commands.register(c.cmd);
    }
  }

  function onNavigate() {
    at = address();
    abortAll();
    for (const ref of [...marks.keys()]) clearMarks(ref);
    for (const close of cards.values()) close();
    cards.clear();
  }
  const nav = (win as Window & { navigation?: EventTarget }).navigation;
  const onEntryChange = () => void moved();
  let paused = prefs.isPaused(hostname);
  const unsubPrefs = prefs.subscribe(() => {
    const now = prefs.isPaused(hostname);
    if (now === paused) return;
    paused = now;
    if (now) abortAll();
    reregister();
  });
  const unsubRules = services.rules.subscribe(() => void wire());
  const unsubStorage = storage.onChange((k) => {
    if (REWIRE_KEYS.some((p) => k.startsWith(p))) void wire();
  });
  win.addEventListener("pagehide", onNavigate);
  win.addEventListener("popstate", onNavigate);
  // where there is a Navigation API, an in-place navigation also clears the markers and cards at once
  nav?.addEventListener("currententrychange", onEntryChange);
  void wire();

  return () => {
    disposed = true;
    generation++;
    unsubPrefs();
    unsubRules();
    unsubStorage();
    win.removeEventListener("pagehide", onNavigate);
    win.removeEventListener("popstate", onNavigate);
    nav?.removeEventListener("currententrychange", onEntryChange);
    for (const off of unwire) off();
    unwire = [];
    for (const c of commands) c.off();
    commands = [];
    onNavigate();
    if (active > 0) ctx.setAwake(false);
  };
}
