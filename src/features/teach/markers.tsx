// R6.5 试运行的字母标记：画在陪伴猫的 shadow 层里，跟着元素的位置走；不改网页元素的样式，清掉后不留监听器。
import { useEffect } from "react";
import { anchor, around } from "../../ui/anchor";

export interface Marker {
  el: Element;
  /** A, B, 1, 2… — the same label the draft side shows next to the step. */
  label: string;
  /** What the run would do to it, e.g. 会点击这个. */
  note?: string;
}

const BOX_CSS =
  "position:fixed;pointer-events:none;box-sizing:border-box;border:2px solid var(--ginger,#e08a3c);border-radius:8px;z-index:2147483645;";
const TAG_CSS =
  "position:absolute;left:calc(100% + 6px);top:50%;transform:translateY(-50%);white-space:nowrap;padding:1px 8px;border-radius:999px;background:var(--ginger,#e08a3c);color:var(--on-ginger,#fff);font:700 11px/18px var(--font-ui,sans-serif);";

/** Draws `marks` in `layer` and keeps them over their elements while the page scrolls or resizes. Returns clear. */
export function drawMarkers(layer: HTMLElement, marks: readonly Marker[]): () => void {
  if (!marks.length) return () => {};
  const doc = layer.ownerDocument;
  const box = doc.createElement("div");
  box.dataset.ccMarkers = "";
  layer.append(box);
  const placed = marks.map((m) => {
    const frame = doc.createElement("div");
    frame.style.cssText = BOX_CSS;
    frame.dataset.ccMark = m.label;
    const tag = doc.createElement("span");
    tag.style.cssText = TAG_CSS;
    tag.textContent = m.note ? `${m.label} · ${m.note}` : m.label;
    frame.append(tag);
    return anchor(box, m.el, frame, around(3));
  });
  return () => {
    for (const p of placed) p.remove();
    box.remove();
  };
}

/** Shows `marks` while mounted; redraws when they change and clears on unmount (version switch, panel closed). */
export function useMarkers(layer: HTMLElement, marks: readonly Marker[]): void {
  useEffect(() => drawMarkers(layer, marks), [layer, marks]);
}
