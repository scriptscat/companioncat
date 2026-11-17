/** R9.7: what a selection trigger hands to the steps as `selection`. */
import { detectLang, type DetectedLang } from "../../core/languages";
import type { Box } from "./place";
import { MAX_SENTENCE, sentenceAround } from "./sentence";

export interface Rect extends Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectionContext {
  /** Trimmed. */
  text: string;
  lang: DetectedLang;
  /** The sentence around the selection, at most MAX_SENTENCE characters. */
  sentence: string;
  /** Viewport coordinates. */
  rect: Rect;
}

const BLOCK =
  "p,div,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,pre,dd,dt,section,article,aside,header,footer,main,figcaption,caption,summary,body";

const ZERO: Rect = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };

function plain(r: DOMRect | undefined): Rect {
  if (!r) return ZERO;
  return { x: r.left, y: r.top, width: r.width, height: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

export const rangeRect = (range: Range): Rect =>
  plain(typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : undefined);

/** The last line box of the selection (where the paw goes). */
export function endRect(range: Range): Rect {
  const rects = typeof range.getClientRects === "function" ? range.getClientRects() : undefined;
  const last = rects && rects.length ? rects[rects.length - 1] : undefined;
  return last ? plain(last) : rangeRect(range);
}

export const elementOf = (n: Node | null): Element | null => (!n ? null : n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement);

const SKIP = "script,style,noscript,template";

/**
 * Builds rendered prose: whitespace runs (source line breaks included) collapse to one space.
 * Pieces are collected in an array and the last character tracked, so a whole-page block stays
 * linear (indexing a string built with += would flatten it on every piece).
 */
function prose() {
  const parts: string[] = [];
  let length = 0;
  let last = "";
  const raw = (s: string) => {
    if (!s) return;
    parts.push(s);
    length += s.length;
    last = s[s.length - 1]!;
  };
  return {
    get length() {
      return length;
    },
    get last() {
      return last;
    },
    /** `s` verbatim (inside <pre>). */
    raw,
    text(s: string) {
      for (const part of s.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s/.test(part)) {
          if (length > 0 && last !== " " && last !== "\n") raw(" ");
        } else raw(part);
      }
    },
    /** A block boundary: a line break (a sentence end) in place of a trailing space. */
    lineBreak() {
      if (length === 0 || last === "\n") return;
      if (last === " ") {
        parts[parts.length - 1] = parts[parts.length - 1]!.slice(0, -1);
        length--;
      }
      raw("\n");
    },
    toString: () => parts.join(""),
  };
}

/**
 * The block's text as read: whitespace collapsed outside <pre>, a line break between blocks (a
 * sentence end), and where the range starts and ends in it.
 */
function readable(block: Element, range: Range): { text: string; start: number; end: number } {
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const out = prose();
  let start = -1;
  let end = -1;
  let lastBlock: Element | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const parent = n.parentElement;
    if (parent?.closest(SKIP)) continue;
    const own = parent?.closest(BLOCK) ?? null;
    if (lastBlock && own !== lastBlock) out.lineBreak();
    lastBlock = own;
    const add = parent?.closest("pre") ? out.raw : out.text;
    // the range's boundaries inside this node (offsets), or where the node lies relative to it
    const cuts: number[] = [];
    if (start < 0) {
      if (n === range.startContainer) cuts.push(range.startOffset);
      else if (range.comparePoint(n, 0) >= 0) start = out.length;
    }
    if (end < 0) {
      if (n === range.endContainer) cuts.push(range.endOffset);
      else if (range.comparePoint(n, 0) > 0) end = out.length;
    }
    let at = 0;
    for (const cut of cuts) {
      add(n.data.slice(at, cut));
      at = cut;
      if (n === range.startContainer && start < 0 && cut === range.startOffset) start = out.length;
      else if (n === range.endContainer) end = out.length;
    }
    add(n.data.slice(at));
  }
  const text = out.toString();
  if (start < 0) start = text.length;
  if (end < 0) end = text.length;
  while (start < end && (text[start] === " " || text[start] === "\n")) start++;
  while (end > start && (text[end - 1] === " " || text[end - 1] === "\n")) end--;
  return { text, start, end };
}

export function selectionContext(range: Range): SelectionContext {
  const text = range.toString().trim();
  let sentence = text.slice(0, MAX_SENTENCE);
  const el = elementOf(range.commonAncestorContainer);
  const block = el?.closest(BLOCK) ?? el;
  if (block) {
    const r = readable(block, range);
    sentence = sentenceAround(r.text, r.start, r.end);
  }
  return { text, lang: detectLang(text), sentence, rect: rangeRect(range) };
}
