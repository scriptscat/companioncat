import { defineFeature, type RuntimeContext } from "../../shell";
import { draftSlots } from "./Draft";
import { closeTeachPanel, openTeachPanel, type TeachHandle } from "./Panel";
import { discardUnsaved, loadUnsaved } from "./store";

/** How long 「接着上次没写完的」 stays up: until the person deals with it, in practice. */
const STRIP_MS = 24 * 60 * 60 * 1000;

/** The shell context the entry points open the panel with; set while the feature is started. */
let current: RuntimeContext | undefined;

/**
 * Opens the teach panel (R6.1) from the bubble, the rules page and the feature page, always with the
 * draft pane and the per-turn footer. A no-op before the feature has started.
 */
export function openTeach(opts: { featureId?: string; resume?: boolean } = {}): TeachHandle | undefined {
  return current && openTeachPanel(current, { ...draftSlots, ...opts });
}

/**
 * The panel mounts in the shell's layer on demand. The feature adds the bubble command, offers the
 * conversation left unsaved by a reload (R6.9), and cleans up when the shell goes away.
 */
export default defineFeature({
  id: "teach",
  start: (ctx) => {
    current = ctx;
    const unregister = ctx.commands.register({ id: "teach", title: "教小猫做件事", quick: true, run: () => void openTeach() });
    if (loadUnsaved(ctx.services.storage)) {
      ctx.toast?.({
        text: "接着上次没写完的",
        ms: STRIP_MS,
        links: [
          { label: "继续", onClick: () => void openTeach({ resume: true }) },
          { label: "丢掉", onClick: () => discardUnsaved(ctx.services.storage) },
        ],
      });
    }
    return () => {
      unregister();
      closeTeachPanel(ctx.layer);
      if (current === ctx) current = undefined;
    };
  },
});
