import { useRef, useState, type Ref } from "react";
import { Cat, type CatBreed } from "../ui/cat";
import { cn } from "../ui/ui";
import type { CatPos } from "./prefs";

/** Mockup v5: right-3 bottom-1. */
export const DEFAULT_CAT_POS: CatPos = { right: 12, bottom: 4 };
/** 78px cat + p-1. */
export const CAT_BOX = 86;
const DRAG_SLOP = 4;

const clamp = (v: number, max: number) => Math.round(Math.min(Math.max(v, 0), Math.max(max, 0)));
const fit = (p: CatPos): CatPos => ({
  right: clamp(p.right, window.innerWidth - CAT_BOX),
  bottom: clamp(p.bottom, window.innerHeight - CAT_BOX),
});

/** 角落里睡觉的小猫：没有圆底，就是一只猫趴在网页角落；可以拖动（R1.3）。 */
export function CornerCat({
  breed,
  awake,
  pos,
  expanded,
  onToggle,
  onMoved,
  buttonRef,
}: {
  breed: CatBreed;
  awake: boolean;
  pos: CatPos;
  expanded: boolean;
  onToggle: () => void;
  onMoved: (p: CatPos) => void;
  buttonRef: Ref<HTMLButtonElement>;
}) {
  const [live, setLive] = useState<CatPos | null>(null);
  const drag = useRef<{ x: number; y: number; start: CatPos; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const at = fit(live ?? pos);

  const next = (d: NonNullable<typeof drag.current>, e: { clientX: number; clientY: number }) =>
    fit({ right: d.start.right - (e.clientX - d.x), bottom: d.start.bottom - (e.clientY - d.y) });

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label="陪伴猫"
      aria-expanded={expanded}
      title="陪伴猫（可以拖动）"
      data-awake={awake}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        swallowClick.current = false;
        drag.current = { x: e.clientX, y: e.clientY, start: at, moved: false };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_SLOP) return;
        d.moved = true;
        setLive(next(d, e));
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d?.moved) return;
        swallowClick.current = true;
        setLive(null);
        onMoved(next(d, e));
      }}
      onPointerCancel={() => {
        drag.current = null;
        setLive(null);
      }}
      onClick={() => {
        if (swallowClick.current) {
          swallowClick.current = false;
          return;
        }
        onToggle();
      }}
      className={cn("cc group fixed z-20 touch-none rounded-2xl p-1 transition-transform hover:-translate-y-0.5", live && "transition-none")}
      style={{ right: at.right, bottom: at.bottom, filter: "drop-shadow(0 6px 10px rgb(42 36 33 / .22))" }}
    >
      <Cat breed={breed} size={78} awake={awake} zzz={!awake} className={cn(!awake && "cc-breathe")} />
    </button>
  );
}
