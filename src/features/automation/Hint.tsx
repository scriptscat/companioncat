/**
 * R5.3 / R2.2: marks that live in the shell's layer next to page elements — never restyling the
 * elements themselves. A marker is anchored to its target and follows scroll and resize.
 */
import { elementOf, type ElementHandle } from "../../core/expr";
import { anchor as anchorEl, around, fitBox, union, viewOf, type Anchored, type Box, type Spot } from "../../ui/anchor";
import type { Hint, HintSuggestion } from "./acts";

const percent = (n: number) => `${Math.round(n * 100)}%`;
const GAP = 12;
const MARGIN = 8;

const isChoice = (el: Element): el is HTMLInputElement => el.tagName === "INPUT" && ((el as HTMLInputElement).type === "radio" || (el as HTMLInputElement).type === "checkbox");

/** Something on the page with a box: an element, or a range over a stem's text. */
type Part = Pick<Element, "getBoundingClientRect">;
const boxOf = (parts: readonly Part[]): Box => union(parts.map((p) => p.getBoundingClientRect()));

/** For a radio or checkbox: its whole group (same name and form, in document order); else the element itself. */
function groupOf(el: Element): Element[] {
  if (!isChoice(el) || !el.name) return [el];
  const group = Array.from(el.ownerDocument.querySelectorAll<HTMLInputElement>(`input[type="${el.type}"]`)).filter((i) => i.name === el.name && i.form === el.form);
  return group.length ? group : [el]; // not in the document (any more)
}

/** The input together with its labels: what a person sees as the option. */
const optionParts = (el: Element): Element[] => [el, ...(isChoice(el) ? Array.from(el.labels ?? []) : [])];

/** The box of what a person sees as the option (the input with its labels); the parts are found once, later calls only measure. */
export const optionBox = (el: Element): (() => Box) => {
  const parts = optionParts(el);
  return () => boxOf(parts);
};

/** optionBox for each other option of a radio or checkbox's group (none for any other field). */
export const otherOptions = (el: Element): (() => Box)[] => groupOf(el).filter((o) => o !== el).map(optionBox);

/** anchor() for an element handle (the target of an act). */
export const anchor = (
  layer: HTMLElement,
  target: ElementHandle,
  node: HTMLElement,
  place: (r: Box, node: HTMLElement) => Spot,
  box?: (el: Element) => Box,
): Anchored => anchorEl(layer, elementOf(target), node, place, box);

const FIELDS = 'input:not([type="hidden"]), textarea, select';
/** Text in these is never shown as a question's stem. */
const UNSEEN = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

/**
 * What makes up the question a target belongs to: its options together with the stem — the nearest
 * text before the first option, looked for among the earlier siblings of the option's ancestors, one
 * level at a time, up to the first ancestor that also holds another question's field (where stems and
 * options sit side by side, an earlier sibling holding another field ends the search). Only the stem
 * is added, not the container around it, so a page wrapper never becomes the question. Falls back to
 * the options alone. Each node is looked at once at most, so the cost stays linear on deep pages; the
 * parts are found once and only measured on scroll.
 */
export function questionParts(el: Element): Part[] {
  const doc = el.ownerDocument;
  const group = groupOf(el);
  const own: Part[] = group.flatMap(optionParts);
  const labels = group.flatMap((i) => optionParts(i).slice(1));
  const mine = (n: Node) => labels.some((l) => l.contains(n));
  const foreign = (n: Node) =>
    n.nodeType === 1 && [n as Element, ...Array.from((n as Element).querySelectorAll(FIELDS))].some((f) => f.matches(FIELDS) && !group.includes(f));
  const isStem = (t: Node) => !!t.nodeValue?.trim() && !mine(t);
  // text only, never inside a script or style
  const filter = (n: Node) => (n.nodeType === 3 ? 1 : UNSEEN.has((n as Element).tagName) ? 2 : 3); // ACCEPT, REJECT, SKIP
  const hasStem = (n: Node): boolean => {
    if (n.nodeType === 3) return isStem(n);
    if (n.nodeType !== 1 || UNSEEN.has((n as Element).tagName)) return false;
    const texts = doc.createTreeWalker(n, 1 | 4 /* NodeFilter.SHOW_ELEMENT | SHOW_TEXT */, filter);
    for (let t = texts.nextNode(); t; t = texts.nextNode()) if (isStem(t)) return true;
    return false;
  };
  const partOf = (n: Node, up: Element): Part => {
    if (n.nodeType === 1) return n as Element;
    const range = doc.createRange();
    range.selectNode(n);
    return typeof range.getBoundingClientRect === "function" ? range : up;
  };
  const top = (n: Element | null) => !n || n === doc.body || n === doc.documentElement;
  let c: Node = group[0]!;
  for (let up = c.parentElement; !top(up); c = up!, up = up!.parentElement) {
    for (let prev = c.previousSibling; prev; prev = prev.previousSibling) {
      if (foreign(prev)) return own; // the question before this one: no stem of our own in between
      if (hasStem(prev)) return [...own, partOf(prev, up!)];
    }
    for (let next = c.nextSibling; next; next = next.nextSibling) if (foreign(next)) return own; // a container of several questions
  }
  return own;
}

/**
 * Just above the question (its stem and options stay uncovered), else beside the question when
 * there is room, else below it; inside the viewport while the question is on screen.
 */
function aboveOrBeside(r: Box, node: HTMLElement): { top: number; left: number } {
  const view = viewOf(node);
  const w = node.offsetWidth;
  const h = node.offsetHeight || 34;
  if (r.top - h - 6 >= MARGIN) return fitBox(r.left, r.top - h - 6, w, h, view, MARGIN, r);
  if (r.right + GAP + w <= view.width - MARGIN) return fitBox(r.right + GAP, r.top, w, h, view, MARGIN, r);
  return fitBox(r.left, r.bottom + 6, w, h, view, MARGIN, r);
}

/** A dashed frame over a suggested target, like the ask-first outline (R2.1). */
function frame(layer: HTMLElement, target: ElementHandle): Anchored {
  const node = document.createElement("div");
  node.dataset.ccHintTarget = "";
  node.setAttribute("aria-hidden", "true");
  node.className = "pointer-events-none box-border rounded-md border-2 border-dashed border-ginger";
  return anchor(layer, target, node, around(3), optionBox(elementOf(target)));
}

export interface HintOptions {
  layer: HTMLElement;
  /** 「就选 X」: performs the suggested act on the target. */
  perform(target: ElementHandle, suggestion: HintSuggestion): void | Promise<void>;
}

interface Open {
  /** The question (group) the marker stands for, and what it suggests. */
  key: string;
  group: Element | Document;
  marker: Anchored;
  targets: { target: ElementHandle; s: HintSuggestion; frame: Anchored }[];
}

/**
 * The Hint port (acts.ts): 「小猫建议 B（61%），没到门槛 80%，没替你选」 with 「就选 B」 and 「我自己来」
 * beside the question's options, and a dashed frame on each suggested option. Suggestions for several
 * options of one question (a set of a multiple choice) share one marker; 「就选」 performs all of them.
 * `stop()` removes every marker left.
 */
export function createHint({ layer, perform }: HintOptions): Hint & { stop(): void } {
  const open = new Set<Open>();
  const close = (o: Open) => {
    o.marker.remove();
    for (const t of o.targets) t.frame.remove();
    open.delete(o);
  };
  const hint: Hint = (target, s) => {
    const what = s.value !== undefined && s.value !== null ? String(s.value) : (s.describe ?? "");
    const el = elementOf(target);
    const group = isChoice(el) && el.name ? (el.form ?? el.ownerDocument) : el;
    const key = `${isChoice(el) ? el.name : ""}|${what}`;
    const same = [...open].find((o) => o.group === group && o.key === key);
    if (same) {
      same.targets.push({ target, s, frame: frame(layer, target) });
      return;
    }
    const marker = document.createElement("div");
    marker.dataset.ccHint = "";
    marker.setAttribute("role", "group");
    marker.setAttribute("aria-label", "小猫的建议");
    marker.className =
      "cc cc-pop z-20 flex max-w-[420px] items-center gap-2 rounded-xl border-[1.5px] border-dashed border-ginger bg-ginger-soft py-1.5 pr-1.5 pl-3 text-[12.5px] leading-snug text-ink shadow-md";
    const text = document.createElement("span");
    text.className = "min-w-0 flex-1";
    const sure = s.confidence !== undefined ? `（${percent(s.confidence)}）` : "";
    text.textContent = `小猫建议 ${what}${sure}${s.minConfidence !== undefined ? `，没到门槛 ${percent(s.minConfidence)}` : ""}，没替你选`;
    const entry: Open = { key, group, marker: undefined as unknown as Anchored, targets: [] };
    const pick = button(`就选 ${what}`.trim(), "rounded-full bg-ginger px-2.5 py-1 font-bold text-on-ginger hover:bg-ginger-hover", () => {
      const all = entry.targets.map((t) => [t.target, t.s] as const);
      close(entry);
      void (async () => {
        for (const [t, sug] of all) await perform(t, sug);
      })();
    });
    const mine = button("我自己来", "rounded-full px-2.5 py-1 font-semibold text-ink-2 hover:bg-fur", () => close(entry));
    marker.append(text, pick, mine);
    const question = questionParts(el); // found once; scrolling only measures it
    entry.marker = anchor(layer, target, marker, aboveOrBeside, () => boxOf(question));
    entry.targets.push({ target, s, frame: frame(layer, target) });
    open.add(entry);
  };
  return Object.assign(hint, {
    stop() {
      for (const o of [...open]) close(o);
    },
  });
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `shrink-0 whitespace-nowrap text-[12.5px] ${className}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
