import * as builtinSnapshot from "virtual:builtin-packs";
import type { ConfirmHost } from "../core/invoke";
import type { BuiltinSnapshot, FetchFn } from "../core/subscriptions";
import { createConfirmHost } from "../pages/engines/confirm";
import { boot, type BootOptions } from "../shell/boot";
import type { ShellHandle } from "../shell/mount";
import { composeApp, type App } from "./app";
import { gmFetch } from "./fetch";

export interface StartOptions extends Omit<BootOptions, "wire"> {
  /** Defaults to GM_xmlhttpRequest. */
  fetch?: FetchFn;
  /** Defaults to the packs baked in at build time. */
  builtin?: BuiltinSnapshot;
}

/**
 * Boots the userscript with every service wired: storage over GM, the subscription-backed rules,
 * one shared invoker whose host dialog renders into the shell's in-page layer (R7.4), then starts
 * the R2.3 update check. Returns null in iframes (R1.1).
 */
export function startApp(o: StartOptions = {}): { handle: ShellHandle; app: App } | null {
  let app: App | undefined;
  // The layer only exists once the shell is mounted; a call that needs the dialog before then waits for it.
  let open!: (c: ConfirmHost) => void;
  const dialog = new Promise<ConfirmHost>((resolve) => (open = resolve));
  const confirmHost: ConfirmHost = async (req) => (await dialog)(req);

  const handle = boot({
    ...o,
    wire: (storage) => {
      app = composeApp({ storage, fetch: o.fetch ?? gmFetch, builtin: o.builtin ?? builtinSnapshot, confirmHost });
      return app.services;
    },
  });
  if (!handle || !app) return null;
  const layer = handle.root.querySelector<HTMLElement>("[data-cc-layer]");
  if (!layer) throw new Error("陪伴猫: shell layer missing");
  open(createConfirmHost(layer, app.versions));
  void app.start();
  return { handle, app };
}
