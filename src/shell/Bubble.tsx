import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { Btn, cn } from "../ui/ui";
import { CAT_BOX } from "./CornerCat";
import type { CatPos } from "./prefs";
import { useShell } from "./context";
import { SubscribeEmpty } from "./SubscribeEmpty";

const WIDTH = 318;
/** Room the bubble needs above the cat before it flips below. */
const ABOVE = 340;

/** Bubble anchored to the cat: above it (mockup v5 right-4 bottom-[96px]), or below when the cat sits high. */
function place(cat: CatPos) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const right = Math.min(Math.max(cat.right + 4, 8), Math.max(vw - WIDTH - 8, 8));
  // tail points at the cat's head (left part of the drawing)
  const tail = Math.min(Math.max(cat.right + 58 - right - 8, 18), WIDTH - 34);
  const catTop = vh - cat.bottom - CAT_BOX;
  const below = catTop < ABOVE && catTop < vh / 2;
  return { right, tail, below, offset: below ? catTop + CAT_BOX + 6 : cat.bottom + 92 };
}

/** 点小猫：对话气泡。内容来自各个功能里标了 quick 的设置项（功能注册的 quick 组件）。 */
export function Bubble({
  cat,
  quick,
  commands,
  onRunCommand,
  onClose,
  onHide,
}: {
  cat: CatPos;
  quick: ReactNode;
  /** Quick commands, shown as buttons above the quick settings. `disabled` greys the button; running it explains why. */
  commands: { id: string; title: string; hotkey?: string; disabled: boolean }[];
  onRunCommand: (id: string) => void;
  /** Close and give focus back to the cat. */
  onClose: () => void;
  onHide: () => void;
}) {
  const shell = useShell();
  const ref = useRef<HTMLDivElement>(null);
  const at = place(cat);

  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="陪伴猫"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        onClose();
      }}
      className="cc cc-pop sticker fixed z-30 w-[318px] rounded-[24px] bg-fur p-4 focus:outline-none"
      style={{
        right: at.right,
        ...(at.below ? { top: at.offset } : { bottom: at.offset }),
        transformOrigin: at.below ? "top right" : "bottom right",
      }}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute size-4 rotate-45 border-outline bg-fur",
          at.below ? "-top-[9px] border-t-[1.5px] border-l-[1.5px]" : "-bottom-[9px] border-r-[1.5px] border-b-[1.5px]",
        )}
        style={{ right: at.tail }}
      />

      {shell.bare ? (
        <div className="py-1">
          <SubscribeEmpty
            compact
            title="陪伴猫还什么都不会"
            body="功能都来自规则。订阅官方规则后，选中文字就能翻译。"
          />
        </div>
      ) : (
        <>
          <p className="truncate text-[12.5px] text-ink-3">{shell.hostname}</p>
          {commands.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              {commands.map((c) => (
                <Btn
                  key={c.id}
                  size="sm"
                  aria-disabled={c.disabled || undefined}
                  className={cn("w-full justify-between", c.disabled && "opacity-50")}
                  onClick={() => onRunCommand(c.id)}
                >
                  <span>{c.title}</span>
                  {c.hotkey && <kbd className="font-mono text-[11px] opacity-80">{c.hotkey}</kbd>}
                </Btn>
              ))}
            </div>
          )}
          {quick && <div className="mt-2 flex flex-col gap-2.5">{quick}</div>}
        </>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Btn size="sm" variant="outline" onClick={() => shell.openSettings()}>
          <Settings2 />
          打开设置
        </Btn>
        <span className="flex-1" />
        <Btn size="sm" variant="plain" onClick={onHide}>
          让小猫先躲起来
        </Btn>
      </div>
    </div>
  );
}
