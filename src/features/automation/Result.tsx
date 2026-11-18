/**
 * R5.5 / R5.6: the result card of an automation entry (its `present`, surface `page-card`): a fixed
 * card near the cat inside the shell layer, drawn by the declarative views. It stays until closed
 * (its own close action, Escape, or the returned function); one card per entry, and a newer run
 * replaces it.
 *
 * The runtime calls `presentAutomation(ctx, entry, report, { retry })` after a run whose entry has
 * `present`, with the run's RunReport; `report.vars` is the view's `vars`, `result` is `{end}`.
 */
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ViewTemplateDef } from "../../core/rules/types";
import type { RuntimeContext } from "../../shell/registry";
import { deepActive } from "../../ui";
import { renderView, type ViewAction } from "../../views";
import type { RunReport } from "./run";
import type { AutoEntry } from "./triggers";

export interface PresentOptions {
  /** Re-runs one question (the id of the result-list item whose 重试 was clicked); resolves to the new report, which replaces the card's content. */
  retry?(id: string): Promise<RunReport | void> | RunReport | void;
  /** View templates by ref; default: the resolved rules' views. */
  views?: Readonly<Record<string, ViewTemplateDef>>;
}

interface Open {
  host: HTMLElement;
  close(): void;
}

const open = new WeakMap<HTMLElement, Map<string, Open>>();

const viewsOf = (ctx: Pick<RuntimeContext, "services">): Record<string, ViewTemplateDef> =>
  Object.fromEntries(ctx.services.rules.get().views.map((v) => [v.ref, v.def]));

/** Shows the entry's result card for `report`, replacing the entry's earlier one. Returns a function that closes it. */
export function presentAutomation(ctx: Pick<RuntimeContext, "layer" | "services">, entry: AutoEntry, report: RunReport, opts: PresentOptions = {}): () => void {
  const { ref, def } = entry.entry;
  const cards = open.get(ctx.layer) ?? open.set(ctx.layer, new Map()).get(ctx.layer)!;
  cards.get(ref)?.close();
  const present = def.present;
  if (!present) return () => {};

  // R9.3: the card takes the focus when it appears and gives it back when it closes
  const back = deepActive(document);
  const host = document.createElement("div");
  host.dataset.ccResult = ref;
  host.tabIndex = -1;
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-label", def.name);
  host.className = "cc-pop fixed z-30 outline-none w-[352px] max-w-[calc(100vw-20px)] overflow-y-auto rounded-[24px] shadow-lg";
  Object.assign(host.style, { right: "16px", bottom: "96px", maxHeight: "calc(100% - 108px)", overscrollBehavior: "contain" });
  ctx.layer.append(host);
  const root = createRoot(host);
  let current = report;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    removeEventListener("keydown", onKey, true);
    if (cards.get(ref)?.host === host) cards.delete(ref);
    const focused = deepActive(document);
    const hadFocus = focused !== null && (focused === host || host.contains(focused));
    flushSync(() => root.render(null));
    root.unmount();
    host.remove();
    if (hadFocus && back instanceof HTMLElement && back.isConnected) back.focus();
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  addEventListener("keydown", onKey, true);
  cards.set(ref, { host, close });

  const draw = () => {
    if (closed) return;
    const scope = { vars: current.vars, result: { end: current.end } };
    const onAction = (a: ViewAction) => {
      if ("surface" in a && a.surface === "close") close();
      else if ("retry" in a) {
        void Promise.resolve(opts.retry?.(a.retry)).then(
          (next) => {
            if (next && !closed) {
              current = next;
              draw();
            }
          },
          () => {},
        );
      }
    };
    root.render(renderView(present.view as never, scope, onAction, { views: opts.views ?? viewsOf(ctx) }));
  };
  flushSync(draw);
  host.focus({ preventScroll: true });
  return close;
}
