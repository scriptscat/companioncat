import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Btn, Cat, deepActive } from "../../ui";
import type { ConfirmHost, HostConfirmRequest } from "../../core/invoke";

/** Optionally says which versions a pack went from and to, for the dialog text (R7.4). */
export type PackVersions = (packId: string) => { from?: string; to?: string } | undefined;

function Dialog({ req, versions, done }: { req: HostConfirmRequest; versions?: PackVersions; done: (allow: boolean) => void }) {
  const stop = useRef<HTMLButtonElement>(null);
  useEffect(() => stop.current?.focus(), []);
  const { provider } = req;
  const v = versions?.(provider.pack);
  return (
    <div
      // fixed: the shadow host has no size, the overlay must cover the viewport
      className="cc fixed inset-0 z-40 flex items-center justify-center bg-scrim p-4"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          done(false);
        } else if (e.key === "Tab") {
          // focus stays in the dialog (R13.3)
          const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
          const at = buttons.indexOf(e.target as HTMLButtonElement);
          const next = buttons[(at + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length];
          if (next) {
            e.preventDefault();
            next.focus();
          }
        }
      }}
    >
      <div role="alertdialog" aria-modal="true" aria-labelledby="dc-t" aria-describedby="dc-d" className="cc-pop sticker w-full max-w-[430px] rounded-[28px] bg-fur p-6">
        <Cat size={68} awake />
        <h2 id="dc-t" className="mt-2 text-[19px] leading-snug font-bold">
          {provider.def.name} 要把你的 API Key 发到一个新地址
        </h2>
        <p id="dc-d" className="mt-2 text-[14px] leading-relaxed text-ink-2">
          规则包「{provider.pack}」
          {v?.to ? `刚${v.from ? `从 v${v.from} ` : ""}更新到 v${v.to}` : "更新后"}，这个引擎的请求地址跟着变了。你同意之前，陪伴猫不会用它发出任何请求。
        </p>
        <dl className="mt-4 overflow-hidden rounded-2xl border-[1.5px] border-line text-[13.5px]">
          <div className="flex gap-3 px-4 py-2.5">
            <dt className="w-8 shrink-0 text-ink-3">以前</dt>
            <dd className="text-ink-3 line-through">
              {req.confirmed.length ? req.confirmed.map((h) => <span key={h} className="block">{h}</span>) : "（还没有确认过）"}
            </dd>
          </div>
          <div className="flex gap-3 border-t border-line bg-berry-soft px-4 py-2.5">
            <dt className="w-8 shrink-0 text-ink-3">现在</dt>
            <dd className="font-semibold break-all text-berry">
              {req.hosts.map((h) => <span key={h} className="block">{h}</span>)}
            </dd>
          </div>
        </dl>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Btn variant="plain" onClick={() => done(true)}>
            我认识这个地址，允许
          </Btn>
          <Btn ref={stop} onClick={() => done(false)}>
            先停用这个引擎
          </Btn>
        </div>
      </div>
    </div>
  );
}

/**
 * The R7.4 dialog as a `confirmHost` for invoke: renders into the shell's in-page layer and
 * resolves true (allow) or false (stop the engine; Esc counts as this). It only answers: invoke
 * itself records the hosts or disables the engine.
 */
export function createConfirmHost(layer: HTMLElement, versions?: PackVersions): ConfirmHost {
  return (req) =>
    new Promise<boolean>((resolve) => {
      const doc = layer.ownerDocument;
      const host = doc.createElement("div");
      layer.append(host);
      const root = createRoot(host);
      const back = deepActive(doc);
      const done = (allow: boolean) => {
        root.unmount();
        host.remove();
        // focus goes back where it was before the dialog took it (R13.3)
        if (back instanceof HTMLElement && back.isConnected) back.focus();
        resolve(allow);
      };
      root.render(<Dialog req={req} versions={versions} done={done} />);
    });
}
