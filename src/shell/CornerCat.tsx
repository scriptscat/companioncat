import { X } from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";
import { Cat, type CatBreed } from "../ui/cat";
import { cn } from "../ui/ui";
import type { CatPos } from "./prefs";
import type { ToastSpec } from "./registry";
import type { UiState } from "./store";

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

const TOAST_MS = 5000;

function ToastCard({ spec, onDone }: { spec: ToastSpec; onDone: () => void }) {
  const [held, setHeld] = useState({ hover: false, focus: false });
  const hold = held.hover || held.focus;
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (hold) return;
    const t = setTimeout(() => done.current(), spec.ms ?? TOAST_MS);
    return () => clearTimeout(t);
  }, [hold, spec.ms]);
  return (
    <div
      role="status"
      aria-live="polite"
      onPointerEnter={() => setHeld((h) => ({ ...h, hover: true }))}
      onPointerLeave={() => setHeld((h) => ({ ...h, hover: false }))}
      onFocus={() => setHeld((h) => ({ ...h, focus: true }))}
      onBlur={() => setHeld((h) => ({ ...h, focus: false }))}
      className="cc cc-pop sticker flex max-w-[360px] items-center gap-3 rounded-full bg-fur py-2 pr-2 pl-4 text-[13.5px] text-ink"
    >
      <span className="min-w-0">{spec.text}</span>
      {spec.links?.map((l) => (
        <button
          key={l.label}
          type="button"
          className="shrink-0 cursor-pointer rounded-[4px] px-0.5 text-[13px] font-bold whitespace-nowrap text-ginger-ink focus-visible:outline-2"
          onClick={() => {
            l.onClick();
            onDone();
          }}
        >
          {l.label}
        </button>
      ))}
      <button
        type="button"
        aria-label="关闭"
        className="grid size-6 cursor-pointer place-items-center rounded-full text-ink-3 hover:bg-sunken focus-visible:outline-2"
        onClick={onDone}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** 小猫旁边的反馈：醒着时的标签（R2.1）在最下面，提示（R2.2）往上叠；Esc 收起最新的一条。 */
export function CatFeedback({
  pos,
  label,
  toasts,
  onDismiss,
}: {
  pos: CatPos;
  label?: string;
  toasts: UiState["toasts"];
  onDismiss: (id: number) => void;
}) {
  const newest = toasts[toasts.length - 1]?.id;
  useEffect(() => {
    if (newest === undefined) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onDismiss(newest);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [newest, onDismiss]);
  if (!label && !toasts.length) return null;
  const at = fit(pos);
  return (
    <div
      className="cc fixed z-50 flex flex-col-reverse items-end gap-2"
      style={{ right: at.right + CAT_BOX + 4, bottom: at.bottom + 20 }}
    >
      {label && (
        <span className="cc-pop sticker rounded-full bg-fur px-3.5 py-1.5 text-[13px] font-bold text-ink">{label}</span>
      )}
      {toasts.map((t) => (
        <ToastCard key={t.id} spec={t.spec} onDone={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}
