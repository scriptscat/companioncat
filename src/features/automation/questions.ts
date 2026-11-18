/**
 * R5.2 question recognition behind `find: "auto:questions"`: single choice (a radio group sharing a
 * name), multiple choice (a checkbox group sharing a name) and blanks (a text input or textarea
 * with stem text before it). Generic on purpose: it reads structure (fieldset/legend, lists,
 * tables, labels, text above), not any one site's classes. Returns plain data plus ElementHandles,
 * so the value can go straight into CEL (handles stay opaque, everything else is copied).
 */
import { elementHandle, type ElementHandle, type PageHost } from "../../core/expr";

/** What the rule and the runtime show when `auto:questions` finds nothing (R5.2). */
export const NO_QUESTIONS = "这一页没找到题目";

export interface QuestionOption {
  /** "A", "B", … by position: unique even when the page's own values are empty or repeated. */
  id: string;
  /** The option's label text. */
  text: string;
  /** The radio/checkbox input, the target of a `check` act. */
  handle: ElementHandle;
}

/** One answer a choose engine can pick: a single option, or for multiple choice a set of options. */
export interface QuestionChoice {
  /** "B", or the option ids joined with 、 ("A、C") for a set. */
  id: string;
  /** The options' texts joined with ；. */
  text: string;
  /** The inputs to check. */
  handles: ElementHandle[];
}

export interface Question {
  /** The question number the page shows, or from an ordered list's position; absent if none. */
  no?: number;
  /** The text before the options, number and kind badge removed, capped at STEM_MAX. */
  stem: string;
  kind: "single" | "multiple" | "blank";
  /** Empty for blanks. */
  options: QuestionOption[];
  /**
   * What `choose` picks from (R5.3): the options of a single choice; for multiple choice every
   * non-empty set of options (up to MULTI_MAX options, else the single options). Empty for blanks.
   */
  choices: QuestionChoice[];
  /** The text field of a blank. */
  input?: ElementHandle;
  /** The question's container. */
  handle: ElementHandle;
}

/** Most options of a multiple-choice question whose sets are offered (2^6 - 1 = 63 choices). */
export const MULTI_MAX = 6;

/** Single options, or every non-empty set of them in order of size then position. */
export function choicesOf(kind: Question["kind"], options: readonly QuestionOption[]): QuestionChoice[] {
  const one = (o: QuestionOption): QuestionChoice => ({ id: o.id, text: o.text, handles: [o.handle] });
  if (kind !== "multiple" || options.length > MULTI_MAX) return options.map(one);
  const sets: QuestionOption[][] = [];
  for (let mask = 1; mask < 1 << options.length; mask++) sets.push(options.filter((_, i) => mask & (1 << i)));
  sets.sort((a, b) => a.length - b.length);
  return sets.map((set) => ({ id: set.map((o) => o.id).join("、"), text: set.map((o) => o.text).join("；"), handles: set.map((o) => o.handle) }));
}

/** Most characters of a stem (the engines get the rest of the page through other steps if needed). */
export const STEM_MAX = 200;

/** The cat's own UI: the shadow host (when it is a light-DOM ancestor) and its layers. */
const OWN_UI = "companion-cat, [data-cc-layer], [data-cc-card], [data-cc-paw]";
const TEXT_INPUT = 'textarea, input:not([type]), input[type="text"], input[type="number"], input[type=""]';
const CHOICE_INPUT = 'input[type="radio"], input[type="checkbox"]';
const INLINE = new Set(["SPAN", "B", "STRONG", "I", "EM", "U", "A", "SUP", "SUB", "CODE", "SMALL", "FONT", "MARK", "ABBR", "LABEL"]);
const SKIPPED_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "OPTION"]);

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const NUMBERS = [
  /^第\s*(\d+)\s*题\s*[.、)）:：]?\s*/,
  /^(?:Question|Q)\s*(\d+)\s*[.、)）:：]?\s*/i,
  /^[（(]\s*(\d+)\s*[)）]\s*/,
  /^(\d+)\s*[.、)）:：]\s*/,
];
const BADGE = /^[[【(（]?\s*(?:单选题?|多选题?|填空题?|判断题?)\s*[\]】)）]?\s*/;

/** Splits "第1题 单选 …" into the number and the rest of the stem. */
function parseStem(text: string): { no?: number; stem: string } {
  let rest = collapse(text);
  let no: number | undefined;
  for (const re of NUMBERS) {
    const m = re.exec(rest);
    if (m) {
      no = Number(m[1]);
      rest = rest.slice(m[0].length);
      break;
    }
  }
  return { no, stem: rest.replace(BADGE, "") };
}

type Field = HTMLInputElement | HTMLTextAreaElement;

interface Found {
  /** First element of the question in document order. */
  anchor: Element;
  question: Question;
}

export function findQuestions(root: ParentNode, host: PageHost): Question[] {
  const doc = (root as Node).ownerDocument ?? (root as Document);
  const ours = (el: Element) => el.closest(OWN_UI) !== null;
  const shown = (el: Element) => !ours(el) && host.visible(el);

  const labelsOf = (input: HTMLInputElement): HTMLLabelElement[] => Array.from(input.labels ?? []);
  const choiceShown = (input: HTMLInputElement) => !input.disabled && !ours(input) && (host.visible(input) || labelsOf(input).some((l) => host.visible(l)));

  // ---- candidates: every field that could belong to a question
  const choices = Array.from(root.querySelectorAll<HTMLInputElement>(CHOICE_INPUT)).filter((i) => i.name && choiceShown(i));
  const blanks = Array.from(root.querySelectorAll<Field>(TEXT_INPUT)).filter((f) => !f.disabled && shown(f) && !f.closest("label")?.querySelector(CHOICE_INPUT));

  const groups = new Map<string, HTMLInputElement[]>();
  const formIds = new Map<Element | null, number>();
  for (const input of choices) {
    if (!formIds.has(input.form)) formIds.set(input.form, formIds.size);
    const key = `${formIds.get(input.form)}|${input.type}|${input.name}`;
    const list = groups.get(key);
    if (list) list.push(input);
    else groups.set(key, [input]);
  }
  const real = Array.from(groups.values()).filter((g) => g.length >= 2);
  const owner = new Map<Element, object>(); // field → its question group
  for (const g of real) for (const i of g) owner.set(i, g);
  for (const b of blanks) owner.set(b, b);

  /** Text inside an option's label is not stem text. */
  const optionLabels = new Set<Element>();
  for (const g of real) for (const i of g) for (const l of labelsOf(i)) optionLabels.add(l);

  const foreign = (el: Element, own: object) => {
    for (const [f, o] of owner) if (o !== own && el.contains(f)) return true;
    return false;
  };
  const canClimb = (el: Element | null, own: object): el is Element =>
    !!el && el !== root && el.tagName !== "BODY" && el.tagName !== "HTML" && root.contains(el) && !foreign(el, own);

  /** The last block of text before `unit` inside `c`. */
  const stemBefore = (c: Element, unit: Node): string => {
    const blocks = new Map<Element, string>();
    const walker = doc.createTreeWalker(c, 4 /* SHOW_TEXT */);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!(unit.compareDocumentPosition(n) & 2 /* PRECEDING */) || unit.contains(n)) continue;
      const parent = n.parentElement;
      const label = parent?.closest("label");
      if (!parent || SKIPPED_TEXT.has(parent.tagName) || (label && optionLabels.has(label))) continue;
      if (!shown(parent)) continue;
      let block: Element = parent;
      while (INLINE.has(block.tagName) && block !== c && block.parentElement) block = block.parentElement;
      blocks.set(block, (blocks.get(block) ?? "") + (n.nodeValue ?? ""));
    }
    const texts = Array.from(blocks.values())
      .map(collapse)
      .filter(Boolean);
    let last = texts.pop() ?? "";
    // a number on its own line ("第1题" heading) belongs with the text before/after it
    if (last && parseStem(last).stem === "" && texts.length) last = `${last} ${texts.pop()!}`;
    return last;
  };

  /** Text of the nearest earlier sibling (climbing) that holds no other question's field. */
  const stemAbove = (from: Element, own: object): string => {
    for (let n: Element | null = from; n && n !== root && n.tagName !== "BODY"; n = n.parentElement) {
      for (let prev = n.previousElementSibling; prev; prev = prev.previousElementSibling) {
        if (foreign(prev, own) || prev.querySelector(CHOICE_INPUT) || prev.querySelector(TEXT_INPUT)) return "";
        if (SKIPPED_TEXT.has(prev.tagName) || !shown(prev)) continue;
        const text = collapse(host.text(prev));
        if (text) return text;
      }
    }
    return "";
  };

  /** Finds the container and stem of a question starting from `start`, whose first part is `unit`. */
  const locate = (start: Element, unit: Node, own: object) => {
    let c = start;
    for (;;) {
      const stem = stemBefore(c, unit);
      if (stem) return { container: c, stem };
      const p = c.parentElement;
      if (!canClimb(p, own)) break;
      c = p;
    }
    return { container: c, stem: stemAbove(c, own) };
  };

  const earliest = (nodes: Node[]) => nodes.reduce((a, b) => (a.compareDocumentPosition(b) & 2 ? b : a));
  const lowestCommon = (els: Element[]): Element => {
    let c: Element = els[0]!;
    while (!els.every((e) => c.contains(e))) c = c.parentElement!;
    return c;
  };

  const optionText = (input: HTMLInputElement, group: HTMLInputElement[]): string => {
    const labels = labelsOf(input);
    if (labels.length) return collapse(host.text(labels[0]!));
    // no label: the widest ancestor that holds only this option's input (a list item, a table row)
    let el: Element = input;
    while (el.parentElement && group.filter((g) => el.parentElement!.contains(g)).length === 1) el = el.parentElement;
    if (el !== input) return collapse(host.text(el));
    // inline options: the text after the input up to the next input or line break
    let text = "";
    for (let n = input.nextSibling; n && !(n instanceof Element && (n.matches(CHOICE_INPUT) || n.tagName === "BR" || n.querySelector(CHOICE_INPUT))); n = n.nextSibling) {
      text += n instanceof Element ? host.text(n) : (n.nodeValue ?? "");
    }
    return collapse(text);
  };

  const found: Found[] = [];
  const finish = (anchor: Element, container: Element, stemText: string, rest: Omit<Question, "no" | "stem" | "handle" | "choices">) => {
    const parsed = parseStem(stemText);
    let no = parsed.no;
    if (no === undefined && container.tagName === "LI" && container.parentElement?.tagName === "OL") {
      const ol = container.parentElement as HTMLOListElement;
      no = ol.start + Array.from(ol.children).filter((e) => e.tagName === "LI").indexOf(container);
    }
    const question: Question = { ...(no === undefined ? {} : { no }), stem: clip(parsed.stem, STEM_MAX), ...rest, choices: choicesOf(rest.kind, rest.options), handle: elementHandle(container, host) };
    found.push({ anchor, question });
  };

  for (const group of real) {
    const units = group.flatMap((i) => [i, ...labelsOf(i)]);
    const { container, stem } = locate(lowestCommon(group), earliest(units), group);
    finish(group[0]!, container, stem, {
      kind: group[0]!.type === "radio" ? "single" : "multiple",
      options: group.map((i, n) => ({ id: String.fromCharCode(65 + n), text: optionText(i, group), handle: elementHandle(i, host) })),
    });
  }

  for (const field of blanks) {
    // an input straight under the root has no container of its own: look above it
    const parent = field.parentElement;
    const start = parent && parent !== root && parent.tagName !== "BODY" && parent.tagName !== "HTML" ? parent : field;
    const { container, stem } = locate(start, field, field);
    if (!stem) continue; // not "near a question stem": a search box, a login field
    finish(field, container, stem, { kind: "blank", options: [], input: elementHandle(field, host) });
  }

  found.sort((a, b) => (a.anchor.compareDocumentPosition(b.anchor) & 4 /* FOLLOWING */ ? -1 : 1));
  return found.map((f) => f.question);
}

/** Plugs into AutoEnv.finders: `find: "auto:questions"` (with `as`) gives the list of questions. */
export const questionFinders = {
  "auto:questions": (root: ParentNode, host: PageHost): Question[] => findQuestions(root, host),
};
