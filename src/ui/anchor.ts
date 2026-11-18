/** A box in viewport coordinates. */
export interface Box {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** Where an anchored node goes; width and height when it is sized from the target too. */
export interface Spot {
  top: number;
  left: number;
  width?: number;
  height?: number;
  /** Any other change to the node (its wording), made with the move: after every mark is measured. */
  apply?: () => void;
}

/** The viewport size placements are fitted into. */
export interface View {
  width: number;
  height: number;
}

/** The viewport of `node`'s window (a sane default when there is none). */
export const viewOf = (node: Element): View => {
  const w = node.ownerDocument.defaultView;
  return { width: w?.innerWidth ?? 1024, height: w?.innerHeight ?? 768 };
};

/**
 * Moves a `width` x `height` node at (`left`, `top`) the least needed to lie inside the viewport minus
 * `margin`. Vertically only while `along` (the box the node belongs to) is on screen: when it has been
 * scrolled away the node goes with it instead of sticking to the viewport's edge.
 */
export function fitBox(left: number, top: number, width: number, height: number, view: View, margin: number, along: Box): { top: number; left: number } {
  const clamp = (v: number, size: number, max: number) => Math.max(margin, Math.min(v, max - size - margin));
  const away = along.bottom <= 0 || along.top >= view.height;
  return { left: clamp(left, width, view.width), top: away ? top : clamp(top, height, view.height) };
}

export interface Anchored {
  node: HTMLElement;
  remove(): void;
}

/** A frame `pad` px outside the target's box (hint frames, dry-run markers). */
export const around =
  (pad = 3) =>
  (r: Box): Spot => ({ top: r.top - pad, left: r.left - pad, width: r.right - r.left + 2 * pad, height: r.bottom - r.top + 2 * pad });

/** Whether a box has no size at all — what an element that is not rendered (display:none, detached) reports. */
const isEmpty = (r: Box) => r.right === r.left && r.bottom === r.top;

/** The box around `rects`, leaving out the ones that are not rendered (unless none is). */
export function union(rects: readonly Box[]): Box {
  const shown = rects.filter((r) => !isEmpty(r));
  return (shown.length ? shown : rects).reduce((a, r) => ({
    top: Math.min(a.top, r.top),
    left: Math.min(a.left, r.left),
    right: Math.max(a.right, r.right),
    bottom: Math.max(a.bottom, r.bottom),
  }));
}

interface Mark {
  el: Element;
  node: HTMLElement;
  place: (r: Box, node: HTMLElement) => Spot;
  box: (el: Element) => Box;
  remove(): void;
}

/** Every live mark of a window, followed by one scroll and one resize listener. */
const live = new Map<Window, { marks: Set<Mark>; follow: () => void }>();

/** Where a mark goes now; undefined when its target left the page or its placement failed (it stays put). */
function measure(m: Mark): Spot | null | undefined {
  if (!m.el.isConnected) return null;
  try {
    return m.place(m.box(m.el), m.node);
  } catch {
    return undefined;
  }
}

function move(node: HTMLElement, { top, left, width, height, apply }: Spot): void {
  apply?.();
  node.style.top = `${top}px`;
  node.style.left = `${left}px`;
  if (width !== undefined) node.style.width = `${width}px`;
  if (height !== undefined) node.style.height = `${height}px`;
}

/**
 * Puts `node` in `layer` at the spot `place` picks from the target's box (`box`, default its own
 * rect) and keeps it there on scroll/resize; the page element itself is never touched. It goes away
 * by itself when the target has left the page. One implementation for every mark the cat draws next
 * to a page element (hint markers, badges, dry-run markers). All marks of a window share one scroll
 * and one resize listener, and on each event all of them are measured before any is moved, so many
 * marks cost one layout per event instead of one each.
 */
export function anchor(
  layer: HTMLElement,
  el: Element,
  node: HTMLElement,
  place: (r: Box, node: HTMLElement) => Spot,
  box: (el: Element) => Box = (e) => e.getBoundingClientRect(),
): Anchored {
  const win = el.ownerDocument.defaultView ?? window;
  node.style.position = "fixed";
  layer.append(node);
  let all = live.get(win);
  if (!all) {
    const marks = new Set<Mark>();
    const follow = () => {
      const now = [...marks];
      const spots = now.map(measure);
      now.forEach((m, i) => {
        const at = spots[i];
        if (at === null) m.remove();
        else if (at) move(m.node, at);
      });
    };
    all = { marks, follow };
    live.set(win, all);
    win.addEventListener("scroll", follow, true);
    win.addEventListener("resize", follow);
  }
  const { marks, follow } = all;
  const mark: Mark = {
    el,
    node,
    place,
    box,
    remove() {
      node.remove();
      if (!marks.delete(mark) || marks.size) return;
      win.removeEventListener("scroll", follow, true);
      win.removeEventListener("resize", follow);
      live.delete(win);
    },
  };
  marks.add(mark);
  const at = measure(mark);
  if (at === null) mark.remove();
  else if (at) move(node, at);
  return { node, remove: () => mark.remove() };
}
