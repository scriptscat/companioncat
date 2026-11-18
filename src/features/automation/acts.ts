/**
 * R1.2 / R1.3 / R1.6 / R2.3 / R2.4: performs one act step on one element — the only code that
 * changes the host page on a rule's behalf. Below the threshold it asks, hints or skips; a target
 * that left the page is skipped. Every outcome is an ActRecord for the action log, which never
 * carries a filled value. What an act may target is the user's decision: there are no guards.
 */
import { elementOf, type ElementHandle } from "../../core/expr";
import type { ActKind, ActStep } from "../../core/rules/types";
import type { ActCtx, ActOutcome, StepError } from "./run";
import { ACT_VERBS } from "./steps";

/** auto: performed (at the threshold, without one, or always-do); asked-*: you answered; failed: it could not be done. */
export type ActMode = "auto" | "asked-yes" | "asked-no" | "hint" | "skip" | "failed";

/** Restores a filled field's previous value (R2.4). Opaque: the value is not enumerable or serialised. */
export class FillUndo {
  readonly #el: Element;
  readonly #previous: string;
  constructor(el: Element, previous: string) {
    this.#el = el;
    this.#previous = previous;
  }
  restore(): void {
    setValue(this.#el, this.#previous);
  }
}

/** One act's outcome, for the run report (as an ActOutcome) and the action log. Never holds the fill value. */
export interface ActRecord extends ActOutcome {
  mode: ActMode;
  act: ActKind;
  site: string;
  rule: string;
  summary: string;
  describe?: string;
  confidence?: number;
  minConfidence?: number;
  /** fill only: brings the field back to what it was. */
  undo?: FillUndo;
}

/** What the ask-first bubble (R2.1) shows. */
export interface AskPrompt {
  target: ElementHandle;
  act: ActKind;
  site: string;
  rule: string;
  describe?: string;
  confidence?: number;
  minConfidence?: number;
  signal?: AbortSignal;
}

/** Ask-first (R2.1): resolves true for 「点吧」, false for 「不用」, a timeout, a vanished target or navigation. */
export type AskUser = (prompt: AskPrompt) => Promise<boolean>;

export interface HintSuggestion {
  act: ActKind;
  /** fill/select/check: what it would have entered. */
  value?: unknown;
  describe?: string;
  confidence?: number;
  minConfidence?: number;
}

/** Marks the suggestion next to the target without acting (below: hint). */
export type Hint = (target: ElementHandle, suggestion: HintSuggestion) => void;

/** The per-site automation prefs (kept outside the rule, R2.3). */
export interface ActPrefs {
  /** 「这个网站以后都照做」 is on for this rule on this site. */
  isAlwaysDo(site: string, rule: string): boolean | Promise<boolean>;
  /** R2.4: marks the act 「点错了」 and turns the rule on this site back to asking first. */
  markWrong(record: ActRecord): void | Promise<void>;
}

/** The run's ActCtx plus who and where: the site and the rule (entry ref) the act belongs to. */
export interface PerformCtx extends ActCtx {
  site: string;
  rule: string;
  askUser: AskUser;
  hint: Hint;
  prefs: Pick<ActPrefs, "isAlwaysDo">;
}

const GONE = "目标已经不在了";
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

class ActFailure extends Error {
  constructor(
    message: string,
    readonly type: StepError["type"] = "rule",
    readonly stop = false,
  ) {
    super(message);
  }
}

export async function performAct(step: ActStep, handle: ElementHandle | undefined, ctx: PerformCtx): Promise<ActRecord> {
  const verb = ACT_VERBS[step.act];
  const what = ctx.describe ? `：${ctx.describe}` : "";
  const base = {
    act: step.act,
    site: ctx.site,
    rule: ctx.rule,
    ...(ctx.describe !== undefined && { describe: ctx.describe }),
    ...(ctx.confidence !== undefined && { confidence: ctx.confidence }),
    ...(ctx.minConfidence !== undefined && { minConfidence: ctx.minConfidence }),
  };
  const rec = (mode: ActMode, summary: string, extra: Partial<ActRecord> = {}): ActRecord => ({ mode, summary, ...base, ...extra });

  const run = async (mode: "auto" | "asked-yes", summary: string): Promise<ActRecord> => {
    // discarded (navigation, pause) while it waited for always-do or for your answer
    if (ctx.signal?.aborted) return rec("skip", "这次运行已中止", { stop: true });
    const el = step.act === "wait" ? undefined : present(handle);
    if (step.act !== "wait" && !el) return rec("skip", GONE);
    try {
      if (step.act === "wait") {
        const ended = await wait(ctx);
        return ended === "aborted" ? rec("skip", "等待被中止", { stop: true }) : rec(mode, summary);
      }
      const undo = perform(step.act, el!, ctx);
      return rec(mode, summary, undo ? { undo } : {});
    } catch (e) {
      const f = e instanceof ActFailure ? e : new ActFailure(e instanceof Error ? e.message : String(e));
      return rec("failed", f.message, { error: { type: f.type, message: f.message }, ...(f.stop && { stop: true }) });
    }
  };

  if (step.act !== "wait" && !present(handle)) return rec("skip", GONE);
  const belowThreshold = ctx.minConfidence !== undefined && !((ctx.confidence ?? 0) >= ctx.minConfidence);
  if (!belowThreshold || (await ctx.prefs.isAlwaysDo(ctx.site, ctx.rule))) return run("auto", `${verb}${what}`);

  const target = handle!;
  switch (ctx.below ?? "ask") {
    case "hint":
      ctx.hint(target, {
        act: step.act,
        ...(ctx.value !== undefined && { value: ctx.value }),
        ...(ctx.describe !== undefined && { describe: ctx.describe }),
        ...(ctx.confidence !== undefined && { confidence: ctx.confidence }),
        minConfidence: ctx.minConfidence,
      });
      return rec("hint", `把握不够，标出了建议${what}`);
    case "skip":
      return rec("skip", `把握不够，没有${verb}${what}`);
    case "ask": {
      let yes = false;
      try {
        yes = await ctx.askUser({ target, ...base, ...(ctx.signal && { signal: ctx.signal }) });
      } catch {
        yes = false;
      }
      return yes ? run("asked-yes", `问过你，${verb}${what}`) : rec("asked-no", `你说不用，没有${verb}${what}`);
    }
  }
}

/** R2.4 撤销: a fill goes back to its previous value; any other performed act is marked wrong. */
export async function undo(record: ActRecord, prefs: Pick<ActPrefs, "markWrong">): Promise<"restored" | "marked" | "none"> {
  if (record.mode !== "auto" && record.mode !== "asked-yes") return "none";
  if (record.undo) {
    record.undo.restore();
    return "restored";
  }
  await prefs.markWrong(record);
  return "marked";
}

/** The handle's element while it is still in its document. */
function present(handle: ElementHandle | undefined): Element | undefined {
  if (!handle) return undefined;
  const el = elementOf(handle);
  return el.isConnected ? el : undefined;
}

function perform(act: Exclude<ActKind, "wait">, el: Element, ctx: ActCtx): FillUndo | undefined {
  switch (act) {
    case "click":
      click(el);
      return;
    case "fill": {
      if (!isTextField(el)) throw new ActFailure("这个元素不能填写文字");
      const snapshot = new FillUndo(el, el.value);
      setValue(el, ctx.value === undefined || ctx.value === null ? "" : String(ctx.value));
      return snapshot;
    }
    case "check": {
      if (!(el instanceof view(el).HTMLInputElement) || (el.type !== "checkbox" && el.type !== "radio")) throw new ActFailure("这个元素不能勾选");
      const want = ctx.value !== false && ctx.value !== "false";
      if (el.checked === want) return;
      click(el);
      if (el.checked !== want) {
        // the page swallowed the click (or a radio is to be cleared): set it and tell the page
        setProp(el, "checked", want);
        fire(el, "input");
        fire(el, "change");
      }
      return;
    }
    case "select": {
      if (!(el instanceof view(el).HTMLSelectElement)) throw new ActFailure("这个元素不是下拉框");
      const want = String(ctx.value ?? "");
      const options = [...el.options];
      const option = options.find((o) => o.value === want) ?? options.find((o) => o.label.trim() === want.trim() || o.text.trim() === want.trim());
      if (!option) throw new ActFailure("下拉框里没有这一项");
      setProp(el, "value", option.value);
      fire(el, "input");
      fire(el, "change");
      return;
    }
    case "scroll":
      el.scrollIntoView({ block: "center", inline: "nearest" });
      return;
    case "focus":
      (el as HTMLElement).focus();
      return;
  }
}

/** wait: `ms`, or until `selector` matches (stop with a timeout error after `timeoutMs`). */
function wait(ctx: ActCtx): Promise<"done" | "aborted"> {
  const { signal, selector } = ctx;
  if (signal?.aborted) return Promise.resolve("aborted");
  if (selector !== undefined && document.querySelector(selector)) return Promise.resolve("done");
  const ms = selector !== undefined ? (ctx.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS) : (ctx.ms ?? 0);
  return new Promise((resolve, reject) => {
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      observer?.disconnect();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => settle(() => resolve("aborted"));
    const timer = setTimeout(
      () => settle(() => (selector === undefined ? resolve("done") : reject(new ActFailure(`等了 ${ms} 毫秒，页面上还没有出现 ${selector}`, "timeout", true)))),
      ms,
    );
    const observer =
      selector === undefined
        ? undefined
        : new MutationObserver(() => {
            if (document.querySelector(selector)) settle(() => resolve("done"));
          });
    observer?.observe(document, { childList: true, subtree: true, attributes: true });
    signal?.addEventListener("abort", onAbort);
  });
}

type TextField = HTMLInputElement | HTMLTextAreaElement;

function isTextField(el: Element): el is TextField {
  const w = view(el);
  return el instanceof w.HTMLTextAreaElement || (el instanceof w.HTMLInputElement && !["checkbox", "radio", "file", "button", "submit", "reset", "image"].includes(el.type));
}

/** The element's own window, so events and prototypes come from the page's realm. */
const view = (el: Element): typeof globalThis => (el.ownerDocument.defaultView ?? globalThis) as typeof globalThis;

/** A real click: pointer and mouse down/up at the element's centre, then click. */
function click(el: Element): void {
  const w = view(el);
  const r = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  const Pointer = w.PointerEvent ?? w.MouseEvent;
  el.dispatchEvent(new Pointer("pointerdown", { ...at, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new w.MouseEvent("mousedown", { ...at, buttons: 1, detail: 1 }));
  el.dispatchEvent(new Pointer("pointerup", { ...at, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new w.MouseEvent("mouseup", { ...at, buttons: 0, detail: 1 }));
  el.dispatchEvent(new w.MouseEvent("click", { ...at, buttons: 0, detail: 1 }));
}

/** Sets a field's value through the native setter (so React/Vue value trackers notice), then input and change. */
function setValue(el: Element, value: string): void {
  setProp(el, "value", value);
  const w = view(el);
  el.dispatchEvent(new w.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
  fire(el, "change");
}

/** Calls the prototype's setter, bypassing any instance-level override a framework installed. */
function setProp(el: Element, prop: "value" | "checked", value: unknown): void {
  for (let proto = Object.getPrototypeOf(el); proto; proto = Object.getPrototypeOf(proto)) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc?.set) {
      desc.set.call(el, value);
      return;
    }
  }
  (el as unknown as Record<string, unknown>)[prop] = value;
}

function fire(el: Element, type: "input" | "change"): void {
  el.dispatchEvent(new (view(el).Event)(type, { bubbles: true }));
}
