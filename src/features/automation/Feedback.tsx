/**
 * R2.2 / R2.4 / R5.3: feedback around acts — the auto-act toast with 撤销 and 记录, the fading
 * highlight over the target, and the 「小猫填的 N%」 badge. All drawn in the shell's layer.
 */
import { elementOf, type ElementHandle } from "../../core/expr";
import type { RuntimeContext } from "../../shell/registry";
import { undo, type ActPrefs, type ActRecord } from "./acts";
import { fitBox, viewOf, type Box, type Spot } from "../../ui/anchor";
import { anchor, optionBox, otherOptions } from "./Hint";

const DONE: Record<ActRecord["act"], string> = {
  click: "点了",
  fill: "填了",
  check: "勾选了",
  select: "选了",
  scroll: "滚动到了",
  focus: "聚焦了",
  wait: "等了",
};
const HIGHLIGHT_MS = 1500;

export interface FeedbackDeps {
  /** The element the act was performed on. */
  target: ElementHandle;
  prefs: Pick<ActPrefs, "markWrong">;
  /** 「记录」: opens the action log. */
  onOpenLog(): void;
}

export function showActFeedback(ctx: Pick<RuntimeContext, "layer" | "toast">, record: ActRecord, deps: FeedbackDeps): void {
  // describe() already quotes the name (「跳过广告」按钮); a rule's own plain describe gets the quotes here
  const name = !record.describe ? "" : /[「」]/.test(record.describe) ? record.describe : `「${record.describe}」`;
  const sure = record.confidence !== undefined ? `（${Math.round(record.confidence * 100)}%）` : "";
  const say = (text: string) => ctx.toast?.({ text });
  ctx.toast?.({
    text: `小猫帮你${DONE[record.act]}${name}${sure}`,
    links: [
      {
        label: "撤销",
        onClick: async () => {
          const r = await undo(record, deps.prefs);
          if (r === "restored") say("已经恢复原来的内容");
          else if (r === "marked") say("记下了，这个网站下次先问你");
        },
      },
      { label: "记录", onClick: deps.onOpenLog },
    ],
  });
  highlight(ctx.layer, deps.target);
}

/** A box over the target that fades out by itself; the page element is not touched. */
function highlight(layer: HTMLElement, target: ElementHandle): void {
  const el = elementOf(target);
  if (!el.isConnected) return;
  const r = el.getBoundingClientRect();
  const box = document.createElement("div");
  box.dataset.ccHighlight = "";
  Object.assign(box.style, {
    position: "fixed",
    top: `${r.top}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    pointerEvents: "none",
    outline: "2px solid currentColor",
    transition: `opacity ${HIGHLIGHT_MS / 2}ms ease-out`,
    opacity: "1",
  });
  layer.append(box);
  requestAnimationFrame?.(() => (box.style.opacity = "0"));
  setTimeout(() => box.remove(), HIGHLIGHT_MS);
}

/** 「小猫填的 N%」 next to a filled answer. Returns the function that removes it. */
export function badge(target: ElementHandle, confidence: number, layer: HTMLElement): () => void {
  const node = document.createElement("span");
  node.dataset.ccBadge = "";
  node.className = "cc pointer-events-none z-10 rounded-full bg-leaf-soft px-2 py-0.5 text-[11.5px] leading-[18px] font-bold whitespace-nowrap text-leaf";
  const fullText = `小猫填的 ${Math.round(confidence * 100)}%`;
  const compact = `${Math.round(confidence * 100)}%`;
  const show = (text: string) => {
    if (node.textContent === text) return;
    node.textContent = text;
    // the compact form keeps the full wording for the title and screen readers
    if (text === fullText) {
      node.removeAttribute("title");
      node.removeAttribute("aria-label");
    } else {
      node.title = fullText;
      node.setAttribute("aria-label", fullText);
    }
  };
  show(fullText);
  // both sizes are measured once (the text never changes), so following a scroll only reads the page
  let sizes: { full: number; compact: number; h: number } | undefined;
  const measure = (n: HTMLElement) => {
    if (!sizes) {
      const full = n.offsetWidth || 96;
      show(compact);
      sizes = { full, compact: n.offsetWidth || 40, h: n.offsetHeight || 22 };
      show(fullText);
    }
    return sizes;
  };
  // the option and the other options of its group, found once; on a line they are measured to keep off them
  const el = elementOf(target);
  const own = optionBox(el);
  const others = otherOptions(el);
  // At the end of its own option's line (the option is its input and label, so the badge is never
  // put into another option's line box, nor onto an option beside it on the same line): full size
  // when it fits there inside the viewport, else the compact mark there, else the same on the
  // option's left; only when neither side has room, the compact mark sits at the right end of the
  // option's own box, inside the viewport. The wording changes with the move, after every mark is measured.
  const place = (r: Box, n: HTMLElement): Spot => {
    const view = viewOf(n);
    const { h, ...w } = measure(n);
    const mid = (r.top + r.bottom) / 2 - h / 2;
    const gap = 8;
    // the free stretch of the line: up to the nearest other option on either side
    let lo = gap;
    let hi = view.width - gap;
    for (const box of others) {
      const o = box();
      if (o.top >= r.bottom || o.bottom <= r.top) continue;
      if (o.left >= r.right) hi = Math.min(hi, o.left - gap);
      else if (o.right <= r.left) lo = Math.max(lo, o.right + gap);
    }
    const spots: [string, number, number][] = [
      [fullText, r.right + gap, w.full],
      [compact, r.right + gap, w.compact],
      [fullText, r.left - gap - w.full, w.full],
      [compact, r.left - gap - w.compact, w.compact],
    ];
    const [text, left, width] = spots.find(([, left, width]) => left >= lo && left + width <= hi) ?? [compact, r.right - w.compact, w.compact];
    return { ...fitBox(left, mid, width, h, view, gap, r), apply: () => show(text) };
  };
  return anchor(layer, target, node, place, own).remove;
}
