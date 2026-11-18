// R6.4 点选元素：顶部提示条、跟着鼠标的高亮框、点一下选中（不触发网页原来的行为）。
// 全部画在陪伴猫的 shadow 层里，不改网页元素的样式；关闭后不留监听器。

import { domHost, elementHandle, renderTemplate, type ElementHandle } from "../../core/expr";
import { POSITIONS } from "../../core/rules/positions";
import { HOST_TAG } from "../../shell/mount";

export interface PickerOptions {
  /** The shadow layer the bar and highlight boxes are drawn in. */
  layer: HTMLElement;
  /** Where page events are caught; the whole document by default. */
  root?: Document | Element;
  /** Closes the picker as if 完成 was pressed (the panel that opened it went away). */
  signal?: AbortSignal;
}

/** Events that would run the page's own behaviour; all swallowed while picking. */
const BLOCKED = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "submit"] as const;

const BAR_CSS =
  "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:12px;padding:6px 6px 6px 16px;border-radius:999px;background:var(--patch,#3a2e24);color:var(--on-patch,#fff);font:600 13.5px var(--font-ui,sans-serif);";
const BOX_CSS = "position:fixed;pointer-events:none;box-sizing:border-box;border:2px solid var(--ginger,#e08a3c);border-radius:4px;z-index:2147483646;";

function make<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, css: string, text?: string): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  el.style.cssText = css;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** The page events' target, or undefined when it is 陪伴猫's own UI (which the picker must leave alone). */
function pageTarget(e: Event, layer: HTMLElement): Element | undefined {
  const path = e.composedPath();
  if (path.includes(layer)) return undefined;
  const target = e.target;
  if (!(target instanceof Element)) return undefined;
  if (target.closest(HOST_TAG) || path.some((n) => n instanceof Element && n.localName === HOST_TAG)) return undefined;
  return target;
}

/** Lets the person click elements on the page; resolves with them (in click order) on Esc or 完成. */
export function openPicker({ layer, root, signal }: PickerOptions): Promise<ElementHandle[]> {
  if (signal?.aborted) return Promise.resolve([]);
  const doc = layer.ownerDocument;
  const scope: Document | Element = root ?? doc;
  const picked: Element[] = [];

  const ui = make(doc, "div", "", undefined);
  ui.dataset.ccPicker = "";
  const bar = make(doc, "div", BAR_CSS);
  bar.dataset.ccPickerBar = "";
  const hint = make(doc, "span", "", "点选相关元素，按 Esc 完成");
  const count = make(doc, "span", "font-weight:400;font-size:12px;opacity:.7;");
  const finish = make(doc, "button", "height:32px;padding:0 14px;border:0;border-radius:999px;background:var(--ginger,#e08a3c);color:var(--on-ginger,#fff);font:inherit;cursor:pointer;", "完成");
  finish.type = "button";
  bar.append(hint, count, finish);
  const hover = make(doc, "div", BOX_CSS);
  hover.dataset.ccPickerHighlight = "";
  hover.hidden = true;
  const marks = make(doc, "div", "");
  ui.append(hover, marks, bar);
  layer.append(ui);

  const place = (box: HTMLElement, el: Element) => {
    const r = el.getBoundingClientRect();
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
  };
  const render = () => {
    count.textContent = `会附在你正在写的消息里 · 已选 ${picked.length} 个`;
    marks.replaceChildren(
      ...picked.map((el) => {
        const m = make(doc, "div", BOX_CSS + "background:color-mix(in srgb,var(--ginger,#e08a3c) 18%,transparent);");
        place(m, el);
        return m;
      }),
    );
  };
  render();

  return new Promise((resolve) => {
    const onHover = (e: Event) => {
      const el = pageTarget(e, layer);
      if (!el) {
        hover.hidden = true;
        return;
      }
      place(hover, el);
      hover.hidden = false;
    };
    const onBlocked = (e: Event) => {
      const el = pageTarget(e, layer);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.type !== "click") return;
      const at = picked.indexOf(el);
      if (at >= 0) picked.splice(at, 1);
      else picked.push(el);
      render();
    };
    const onKey = (e: Event) => {
      if ((e as KeyboardEvent).key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    const onFinish = () => close();

    const target = scope as EventTarget;
    const close = () => {
      for (const t of BLOCKED) target.removeEventListener(t, onBlocked, true);
      target.removeEventListener("mouseover", onHover, true);
      target.removeEventListener("keydown", onKey, true);
      finish.removeEventListener("click", onFinish);
      signal?.removeEventListener("abort", close);
      ui.remove();
      resolve(picked.map((el) => elementHandle(el, domHost)));
    };

    for (const t of BLOCKED) target.addEventListener(t, onBlocked, true);
    target.addEventListener("mouseover", onHover, true);
    target.addEventListener("keydown", onKey, true);
    finish.addEventListener("click", onFinish);
    signal?.addEventListener("abort", close);
  });
}

/** One picked element as the teach panel shows and sends it (R6.4). */
export interface Attachment {
  handle: ElementHandle;
  /** Short human name, e.g. 「跳过广告」按钮. */
  label: string;
  /** Compact markup that never holds what someone typed into a field (R9.2). */
  outline: string;
}

const OUTLINE_MAX = 600;

/** Turns picked handles into attachments, using the same describe/outline an automation rule sees. */
export async function describePicked(handles: ElementHandle[]): Promise<Attachment[]> {
  return Promise.all(
    handles.map(async (handle) => {
      const read = (tpl: string) => renderTemplate(tpl, { trigger: handle }, POSITIONS.autoRun) as Promise<string>;
      return { handle, label: await read("{{ describe(trigger) }}"), outline: await read(`{{ outline(trigger, ${OUTLINE_MAX}) }}`) };
    }),
  );
}

/** The attachments without the one for `handle`; the input list is not changed. */
export function removeAttachment(list: readonly Attachment[], handle: ElementHandle): Attachment[] {
  return list.filter((a) => a.handle !== handle);
}
