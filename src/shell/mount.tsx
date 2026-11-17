import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import STYLES from "../ui/styles.css?inline";
import { adoptStyles, shadowSafe } from "../ui/css";
import { deepActive } from "../ui/dom";
import type { Registration } from "./registry";
import type { ShellServices } from "./services";
import { Shell } from "./Shell";
import { createUiStore } from "./store";

export const HOST_TAG = "companion-cat";

export interface MountOptions {
  services: ShellServices;
  /** Pages and features (main.tsx passes the import.meta.glob result through collect()). */
  registrations?: Registration[];
  /** Current site, for per-site prefs and the bubble; defaults to location.hostname. */
  hostname?: string;
  /** Stylesheet text; defaults to src/ui/styles.css compiled by the build. */
  css?: string;
  /** Where the shadow host goes; defaults to <html> (survives pages that replace <body>). */
  target?: Element;
  version?: string;
}

export interface ShellHandle {
  host: HTMLElement;
  root: ShadowRoot;
  /** Same as useShell().openSettings. */
  openSettings(to?: string): void;
  closeSettings(): void;
  /** The cat is awake while any reason is on. */
  setAwake(reason: string, on: boolean): void;
  unmount(): void;
}

/** Renders the whole UI inside one shadow root (R1.2) and starts the registered feature runtimes. */
export function mount(o: MountOptions): ShellHandle {
  const doc = document;
  const host = doc.createElement(HOST_TAG);
  const root = host.attachShadow({ mode: "open" });
  adoptStyles(root, shadowSafe(o.css ?? STYLES));
  const app = doc.createElement("div");
  const layer = doc.createElement("div");
  layer.dataset.ccLayer = "";
  root.append(app, layer);
  (o.target ?? doc.documentElement).append(host);

  const hostname = o.hostname ?? location.hostname;
  const registrations = o.registrations ?? [];
  const store = createUiStore();
  const focusReturn: { el: Element | null } = { el: null };

  const openSettings = (to?: string) => {
    if (store.get().settings === null) {
      const active = deepActive(doc);
      focusReturn.el = active && active !== doc.body ? active : null;
    }
    store.set({ settings: to ?? "engines", bubble: false });
  };

  const reactRoot = createRoot(app);
  flushSync(() =>
    reactRoot.render(
      <Shell
        store={store}
        services={o.services}
        registrations={registrations}
        hostname={hostname}
        host={host}
        root={root}
        layer={layer}
        version={o.version}
        openSettings={openSettings}
        focusReturn={focusReturn}
      />,
    ),
  );

  const stops: (() => void)[] = [];
  for (const r of registrations) {
    if (r.kind !== "feature" || !r.start) continue;
    try {
      const stop = r.start({
        root,
        layer,
        hostname,
        services: o.services,
        setAwake: (on) => store.setAwake(r.id, on),
        openSettings,
      });
      if (stop) stops.push(stop);
    } catch (e) {
      console.error(`[陪伴猫] feature ${r.id} failed to start`, e);
    }
  }

  return {
    host,
    root,
    openSettings,
    closeSettings: () => store.set({ settings: null }),
    setAwake: store.setAwake,
    unmount() {
      for (const stop of stops.splice(0)) {
        try {
          stop();
        } catch (e) {
          console.error("[陪伴猫] a feature failed to stop", e);
        }
      }
      reactRoot.unmount();
      host.remove();
    },
  };
}
