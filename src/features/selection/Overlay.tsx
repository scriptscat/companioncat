/** The paw (confirm: paw) and the near-selection cards, rendered in the shadow root (mockup v5). */
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ViewTemplateDef } from "../../core/rules/types";
import { Paw, cn } from "../../ui";
import { renderView, type ViewAction } from "../../views";
import { placeCard, placePaw } from "./place";
import type { CardState, Store } from "./store";

export interface OverlayProps {
  store: Store;
  views: () => Readonly<Record<string, ViewTemplateDef>>;
  onAction(card: CardState, action: ViewAction): void;
}

function PawButton({ title, anchor, rtl, go }: { title: string; anchor: CardState["anchor"]; rtl?: boolean; go(): void }) {
  const p = placePaw(anchor, window.innerWidth, window.innerHeight, rtl);
  return (
    <span data-cc-paw="" className="cc fixed z-20" style={{ left: `${p.left}px`, top: `${p.top}px` }}>
      <button
        type="button"
        aria-label={`${title}选中的文字`}
        title={title}
        // keep the page selection while clicking
        onMouseDown={(e) => e.preventDefault()}
        onClick={go}
        className="cc-pop sticker flex size-[34px] items-center justify-center rounded-full bg-fur transition-transform hover:scale-110"
      >
        <Paw size={20} />
      </button>
    </span>
  );
}

function Card({ card, views, onAction }: { card: CardState; views: OverlayProps["views"]; onAction: OverlayProps["onAction"] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setHeight(el.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const p = placeCard(card.anchor, height, window.innerWidth, window.innerHeight);
  const scope = { ...card.scope, vars: card.vars };
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`${card.title}结果`}
      data-cc-card=""
      data-side={p.side}
      data-pinned={String(card.pinned)}
      className={cn("cc cc-pop sticker fixed z-20 rounded-[24px] bg-fur", card.pinned && "outline-2 outline-offset-2 outline-ginger")}
      style={{ left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, transformOrigin: p.side === "below" ? "top left" : "bottom left" }}
    >
      {/* 尾巴指向选区 */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute size-4 rotate-45 border-outline bg-fur",
          p.side === "below" ? "-top-[9px] border-t-[1.5px] border-l-[1.5px]" : "-bottom-[9px] border-r-[1.5px] border-b-[1.5px]",
        )}
        style={{ left: `${p.tail}px` }}
      />
      <div className="cc-scroll relative overflow-x-hidden overflow-y-auto rounded-[22px]" style={{ maxHeight: `${p.maxHeight}px` }}>
        {renderView(card.view as never, scope, (a) => onAction(card, a), { views: views() })}
        {card.error && (
          <p role="alert" className="px-4 pb-3 text-[13px] text-berry">
            {card.error}
          </p>
        )}
      </div>
    </div>
  );
}

export function Overlay({ store, views, onAction }: OverlayProps) {
  const ui = useSyncExternalStore(store.subscribe, store.get);
  return (
    <>
      {ui.paw && <PawButton title={ui.paw.title} anchor={ui.paw.anchor} rtl={ui.paw.rtl} go={ui.paw.go} />}
      {ui.cards.map((c) => (
        <Card key={c.id} card={c} views={views} onAction={onAction} />
      ))}
    </>
  );
}
