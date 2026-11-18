/**
 * R2.1 / R2.3 / R9.3: the ask-first bubble — the real AskUser port. It sits next to the target
 * (flipped and clamped inside the viewport, following scroll), outlines the target with a dashed
 * frame drawn in the layer (the page element is never styled) and wakes the cat with 「等你回答」.
 * Not answering within 30 s, the target leaving the page, the signal aborting (navigation) and Esc
 * all count as 不用. One ask shows at a time; the rest wait their turn.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { elementOf } from "../../core/expr";
import type { ActKind } from "../../core/rules/types";
import type { AutomationPrefs } from "../../core/stores/automation";
import { Btn, Tick, deepActive } from "../../ui";
import type { AskPrompt, AskUser } from "./acts";

export const ASK_TIMEOUT_MS = 30_000;
const WIDTH = 300;
const FALLBACK_HEIGHT = 150;
const GAP = 10;
const MARGIN = 8;

/** The engine that judged and the rule's name, when the caller knows them (the port's prompt does not require them). */
export type AskPromptWithEngine = AskPrompt & { engine?: string; ruleName?: string };

const VERB: Record<ActKind, string> = { click: "点", fill: "填", check: "勾", select: "选", scroll: "滚到这里", focus: "聚焦", wait: "等" };

const percent = (v: number) => `${Math.round(v * 100)}%`;

export function questionText(p: AskPrompt): string {
  const what = p.describe ?? (p.act === "click" ? "这个按钮" : "这个元素");
  const conf = p.confidence !== undefined ? `（${percent(p.confidence)}）` : "";
  return `小猫觉得是${what}${conf}，要${VERB[p.act] ?? "做"}吗？`;
}

export function detailText(p: AskPromptWithEngine): string {
  return [p.ruleName ?? p.rule, p.engine && `${p.engine} 判断`, p.minConfidence !== undefined && `门槛 ${percent(p.minConfidence)}`].filter(Boolean).join(" · ");
}

interface Place {
  rect: { left: number; top: number; width: number; height: number };
  left: number;
  top: number;
}

/** Below the target; above when it does not fit; clamped so the bubble stays inside the viewport. */
export function placeBubble(r: Place["rect"], width: number, height: number, vw: number, vh: number): { left: number; top: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  let top = r.top + r.height + GAP;
  if (top + height > vh - MARGIN && r.top - GAP - height >= MARGIN) top = r.top - GAP - height;
  return { left: clamp(r.left, MARGIN, Math.max(MARGIN, vw - width - MARGIN)), top: clamp(top, MARGIN, Math.max(MARGIN, vh - height - MARGIN)) };
}

function AskView({ prompt, onAnswer }: { prompt: AskPromptWithEngine; onAnswer: (yes: boolean, always: boolean) => void }) {
  const el = elementOf(prompt.target);
  const bubble = useRef<HTMLDivElement>(null);
  const yes = useRef<HTMLButtonElement>(null);
  const [always, setAlways] = useState(false);
  const measure = (): Place => {
    const b = el.getBoundingClientRect();
    const rect = { left: b.left, top: b.top, width: b.width, height: b.height };
    return { rect, ...placeBubble(rect, WIDTH, bubble.current?.offsetHeight || FALLBACK_HEIGHT, window.innerWidth, window.innerHeight) };
  };
  const [place, setPlace] = useState<Place>(measure);

  useLayoutEffect(() => {
    const update = () => setPlace(measure());
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el]);

  useEffect(() => {
    yes.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onAnswer(false, false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onAnswer]);

  const { rect } = place;
  const detail = detailText(prompt);
  return (
    <>
      <div
        data-cc-outline=""
        aria-hidden="true"
        style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width, height: rect.height, borderWidth: 2, borderStyle: "dashed", borderColor: "#e8912d", borderRadius: 6, pointerEvents: "none", boxSizing: "border-box" }}
      />
      <div
        ref={bubble}
        data-cc-ask=""
        role="dialog"
        aria-label="小猫想问你"
        className="cc-pop fixed z-[2147483647] flex flex-col gap-2 rounded-2xl border border-line bg-fur p-3 text-[13px] text-ink shadow-lg"
        style={{ left: place.left, top: place.top, width: WIDTH }}
      >
        <p className="m-0 font-semibold">{questionText(prompt)}</p>
        {detail && <p className="m-0 text-[12px] text-ink-3">{detail}</p>}
        <div className="flex gap-2">
          <Btn ref={yes} size="sm" onClick={() => onAnswer(true, always)}>
            点吧
          </Btn>
          <Btn size="sm" variant="outline" onClick={() => onAnswer(false, false)}>
            不用
          </Btn>
        </div>
        <label className="flex items-center gap-2 text-[12px]">
          <Tick checked={always} onCheckedChange={(v) => setAlways(v === true)} aria-label="这个网站以后都照做" />
          这个网站以后都照做
        </label>
      </div>
    </>
  );
}

export interface AskUserOptions {
  /** A node inside the shadow root (R1.2); the bubble and the outline are drawn here. */
  layer: HTMLElement;
  prefs: Pick<AutomationPrefs, "setAlwaysDo">;
  /** ctx.setAwake from the shell. */
  setAwake: (on: boolean, label?: string) => void;
  /** Answer deadline; defaults to 30 s (R2.1). */
  timeoutMs?: number;
}

export function createAskUser({ layer, prefs, setAwake, timeoutMs = ASK_TIMEOUT_MS }: AskUserOptions): AskUser {
  let tail: Promise<unknown> = Promise.resolve();

  const show = (prompt: AskPromptWithEngine) =>
    new Promise<boolean>((resolve) => {
      if (prompt.signal?.aborted) return resolve(false);
      const el = elementOf(prompt.target);
      if (!el.isConnected) return resolve(false);
      const previous = deepActive(document) as HTMLElement | null;
      const host = document.createElement("div");
      layer.append(host);
      const root = createRoot(host);
      const cleanups: Array<() => void> = [];
      let done = false;

      const finish = (yes: boolean, always = false) => {
        if (done) return;
        done = true;
        cleanups.forEach((c) => c());
        if (yes && always) prefs.setAlwaysDo(prompt.site, prompt.rule, true);
        flushSync(() => root.render(null));
        root.unmount();
        host.remove();
        setAwake(false);
        if (previous?.isConnected) previous.focus();
        resolve(yes);
      };

      const timer = setTimeout(() => finish(false), timeoutMs);
      cleanups.push(() => clearTimeout(timer));
      const onAbort = () => finish(false);
      prompt.signal?.addEventListener("abort", onAbort);
      cleanups.push(() => prompt.signal?.removeEventListener("abort", onAbort));
      const watch = new MutationObserver(() => {
        if (!el.isConnected) finish(false);
      });
      watch.observe(document, { childList: true, subtree: true });
      cleanups.push(() => watch.disconnect());

      setAwake(true, "等你回答");
      flushSync(() => root.render(<AskView prompt={prompt} onAnswer={finish} />));
    });

  return (prompt) => {
    const turn = tail;
    let left = false;
    let leave = () => {};
    const run = new Promise<boolean>((resolve) => {
      leave = () => {
        left = true;
        resolve(false);
      };
      // A queued ask whose signal aborts answers 不用 at once and never shows.
      prompt.signal?.addEventListener("abort", leave, { once: true });
      void turn.then(() => {
        prompt.signal?.removeEventListener("abort", leave);
        if (!left) void show(prompt).then(resolve, () => resolve(false));
      });
    });
    // The next ask starts when this one's turn is over, not when it merely resolved.
    tail = turn.then(() => (left ? undefined : run.then(() => undefined)));
    return run;
  };
}
