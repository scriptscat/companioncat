// 网页对照的行内译文（R7.2、R7.4、R7.5）：每段后面插一个自带 Shadow DOM 的元素，
// 里面是宋体译文、加载占位、失败时的「重试」，或缺 Key / 被停用时去引擎页的链接。
// 用原生 DOM 而不是每段一个 React 根：页面上可能有几百段。收回时移走全部元素并还原原文。

import STYLES from "../../ui/styles.css?inline";
import { shadowSafe } from "../../ui/css";
import type { BatchResult } from "./batch";
import type { Block } from "./blocks";

export const INLINE_TAG = "companion-cat-tr";

/** Layout of one translation; tokens (--font-read, --ginger, ...) come from the phase-1 sheet on :host. */
const LOCAL_CSS = `
:host { all: initial !important; display: block !important; position: static !important; width: auto !important; height: auto !important; z-index: auto !important; }
.tr { display: block; margin: 6px 0 20px; padding-left: 12px; border-left: 3px solid var(--ginger); font-family: var(--font-read); font-size: 16px; line-height: 1.8; color: var(--ink-2); }
.tr[data-only] { margin-top: 0; padding-left: 0; border-left: 0; font-size: 17px; color: var(--ink); }
.tr[data-failed] { border-left-color: var(--berry); }
.note { display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-ui); font-size: 13px; color: var(--ink-3); }
.dots { display: inline-flex; gap: 4px; padding: 8px 0; }
.dots i { width: 6px; height: 6px; border-radius: 999px; background: var(--line-strong); }
button, a { font: inherit; font-size: 12px; color: var(--ginger-ink); cursor: pointer; background: var(--ginger-soft); border: 0; border-radius: 999px; padding: 2px 10px; text-decoration: none; }
`;

export interface InlineOptions {
  /** Open the settings page (the shell's openSettings). */
  openSettings(to?: string): void;
  /** The 重试 of a failed batch was clicked; the caller translates `blocks` again and calls show() with the result. */
  onRetry(batchIndex: number, blocks: Block[]): void;
  /** Start in 只看译文. */
  only?: boolean;
  /** Stylesheet text; defaults to src/ui/styles.css compiled by the build. */
  css?: string;
}

export interface Inline {
  /** Insert a placeholder after each block (or put it back to the placeholder). */
  pending(blocks: readonly Block[]): void;
  /** Render a settled batch: translations, or a failure note per block. */
  show(result: BatchResult): void;
  /** 只看译文: hide the sources without removing them. */
  setOnly(only: boolean): void;
  /** Remove every inserted element and give the sources back exactly as they were. */
  restore(): void;
}

interface Entry {
  block: Block;
  host: HTMLElement;
  body: HTMLElement;
  /** The source's own style attribute before we hid it; undefined when we have not touched it. */
  style?: string | null;
}

function h(tag: string, attrs: Record<string, string> = {}, text?: string): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}

export function createInline(o: InlineOptions): Inline {
  const entries = new Map<Element, Entry>();
  let only = !!o.only;
  let closed = false;
  let sheet: CSSStyleSheet | null | undefined;
  const css = shadowSafe(o.css ?? STYLES) + LOCAL_CSS;

  // one constructed sheet shared by every shadow root; a <style> per root where that is not supported
  function style(root: ShadowRoot) {
    if (sheet === undefined) {
      try {
        sheet = "adoptedStyleSheets" in root ? new CSSStyleSheet() : null;
        sheet?.replaceSync(css);
      } catch {
        sheet = null;
      }
    }
    if (sheet) root.adoptedStyleSheets = [sheet];
    else root.append(h("style", {}, css));
  }

  function entry(block: Block): Entry | undefined {
    let e = entries.get(block.el);
    if (e) return e;
    if (!block.el.isConnected) return undefined;
    const host = document.createElement(INLINE_TAG);
    const root = host.attachShadow({ mode: "open" });
    style(root);
    const body = h("div", { class: "tr" });
    body.classList.add("cc");
    root.append(body);
    block.el.after(host);
    e = { block, host, body };
    entries.set(block.el, e);
    hide(e);
    return e;
  }

  function hide(e: Entry) {
    const el = e.block.el as HTMLElement;
    if (only && e.style === undefined) {
      e.style = el.getAttribute("style");
      el.style.setProperty("display", "none", "important");
    } else if (!only && e.style !== undefined) {
      unhide(e);
    }
    if (only) e.body.setAttribute("data-only", "");
    else e.body.removeAttribute("data-only");
  }

  function unhide(e: Entry) {
    if (e.style === undefined) return;
    if (e.style === null) e.block.el.removeAttribute("style");
    else e.block.el.setAttribute("style", e.style);
    e.style = undefined;
  }

  function placeholder(e: Entry) {
    e.body.removeAttribute("data-failed");
    const dots = h("span", { class: "dots", role: "status", "aria-label": "正在翻译" });
    dots.append(h("i"), h("i"), h("i"));
    e.body.replaceChildren(dots);
  }

  function failure(e: Entry, result: Extract<BatchResult, { ok: false }>) {
    e.body.setAttribute("data-failed", "");
    const note = h("span", { class: "note" });
    const type = result.error.type;
    if (type === "missingKey" || type === "disabled") {
      note.append(type === "missingKey" ? "这个引擎还没有填写 Key " : "这个引擎已停用 ");
      const link = h("a", { href: "#", role: "link" }, "去引擎页");
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        o.openSettings("engines");
      });
      note.append(link);
    } else {
      note.append("这一段没翻译成功 ");
      const retry = h("button", { type: "button" }, "重试");
      retry.addEventListener("click", () => {
        if (closed) return;
        for (const b of result.blocks) {
          const x = entries.get(b.el);
          if (x) placeholder(x);
        }
        o.onRetry(result.index, result.blocks);
      });
      note.append(retry);
    }
    e.body.replaceChildren(note);
  }

  /**
   * Lets go of paragraphs the page dropped together with their translation (a long feed recycles its
   * rows): their source gets its style back and the translation leaves the detached part, so nothing of
   * ours comes back if the page re-inserts it, and the map does not keep removed parts of the page alive.
   */
  function prune() {
    for (const [el, e] of entries) {
      if (el.isConnected || e.host.isConnected) continue;
      unhide(e);
      e.host.remove();
      entries.delete(el);
    }
  }

  return {
    pending(blocks) {
      if (closed) return;
      prune();
      for (const b of blocks) {
        const e = entry(b);
        if (e) placeholder(e);
      }
    },
    show(result) {
      if (closed) return;
      if (result.ok) {
        for (const { block, text } of result.items) {
          const e = entry(block);
          if (e) e.body.removeAttribute("data-failed"), e.body.replaceChildren(text);
        }
      } else {
        for (const b of result.blocks) {
          const e = entry(b);
          if (e) failure(e, result);
        }
      }
    },
    setOnly(v) {
      only = v;
      if (closed) return;
      for (const e of entries.values()) hide(e);
    },
    restore() {
      closed = true;
      for (const e of entries.values()) {
        unhide(e);
        e.host.remove();
      }
      entries.clear();
    },
  };
}
