import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PortalContainer, TipProvider } from "../ui/ui";
import { ShellCtx, type ShellApi } from "./context";
import { Bubble } from "./Bubble";
import { CornerCat, DEFAULT_CAT_POS } from "./CornerCat";
import { PREF_PREFIX, readPrefs, writePref, type Theme } from "./prefs";
import type { FeatureRegistration, PageRegistration, Registration } from "./registry";
import { isBare, type ShellServices } from "./services";
import { Settings } from "./Settings";
import type { UiStore } from "./store";

export interface ShellProps {
  store: UiStore;
  services: ShellServices;
  registrations: Registration[];
  hostname: string;
  host: HTMLElement;
  root: ShadowRoot;
  layer: HTMLElement;
  version?: string;
  openSettings: (to?: string) => void;
  /** Filled by the shell: where focus goes when the settings window closes. */
  focusReturn: { el: Element | null };
}

/** Below this viewport width the layout goes narrow: full-screen settings (R1.5), a near-full-width card (R9.9). */
export const NARROW = 640;
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Re-renders on resize: the narrow layout (R1.5) and keeping the dragged cat inside the viewport. */
function useViewport() {
  const read = () => `${window.innerWidth}x${window.innerHeight}`;
  const [size, setSize] = useState(read);
  useEffect(() => {
    const on = () => setSize(read());
    window.addEventListener("resize", on);
    on();
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}

function useSystemDark() {
  const mq = () => (typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null);
  const [dark, setDark] = useState(() => !!mq()?.matches);
  useEffect(() => {
    const m = mq();
    if (!m) return;
    const on = () => setDark(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return dark;
}

const resolveTheme = (theme: Theme, systemDark: boolean) => (theme === "system" ? systemDark : theme === "dark");

export function Shell(p: ShellProps) {
  const { store, services, hostname } = p;
  const ui = useSyncExternalStore(store.subscribe, store.get);
  const { rules } = services;
  const resolved = useSyncExternalStore(
    useCallback((cb: () => void) => rules.subscribe(cb), [rules]),
    useCallback(() => rules.get(), [rules]),
  );
  const [prefs, setPrefs] = useState(() => readPrefs(services.storage, hostname));
  useViewport();
  const narrow = window.innerWidth < NARROW;
  const systemDark = useSystemDark();
  const catRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // R1.8: prefs written in this or another tab
  useEffect(
    () =>
      services.storage.onChange((key) => {
        if (key.startsWith(PREF_PREFIX)) setPrefs(readPrefs(services.storage, hostname));
      }),
    [services.storage, hostname],
  );

  const dark = resolveTheme(prefs.theme, systemDark);
  useLayoutEffect(() => {
    p.host.classList.toggle("dark", dark);
  }, [dark, p.host]);

  const settingsOpen = ui.settings !== null;
  // Esc closes the settings window (R1.5); popups inside it handle Esc first and preventDefault.
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        store.set({ settings: null });
      }
    };
    const doc = p.root.ownerDocument;
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
  }, [settingsOpen, store, p.root]);

  const pages = useMemo(() => p.registrations.filter((r): r is PageRegistration => r.kind === "page"), [p.registrations]);
  const features = useMemo(() => p.registrations.filter((r): r is FeatureRegistration => r.kind === "feature"), [p.registrations]);

  const runSubscribe = useCallback(() => {
    const go = services.subscribeOfficial;
    if (!go) return;
    setBusy(true);
    setError(null);
    let pending: unknown;
    try {
      pending = go();
    } catch (e) {
      pending = Promise.reject(e);
    }
    Promise.resolve(pending)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [services]);

  const api: ShellApi = {
    services,
    resolved,
    bare: isBare(resolved),
    hostname,
    prefs,
    setPref: (key, value) => writePref(services.storage, hostname, key, value),
    openSettings: p.openSettings,
    closeSettings: () => store.set({ settings: null }),
    closeBubble: () => store.set({ bubble: false }),
    subscribe: { run: runSubscribe, busy, error, available: !!services.subscribeOfficial },
    narrow,
    root: p.root,
    layer: p.layer,
  };

  const catPos = prefs.catPos ?? DEFAULT_CAT_POS;
  const showCat = prefs.showCat && !prefs.catOffHere && !ui.hidden;
  const quick = api.bare ? [] : features.flatMap((f) => (f.quick ? [<f.quick key={f.id} />] : []));

  return (
    <ShellCtx.Provider value={api}>
      <PortalContainer value={p.layer}>
        <TipProvider delayDuration={300}>
          {showCat && (
            <CornerCat
              buttonRef={catRef}
              breed={prefs.breed}
              awake={ui.awake.size > 0 || ui.bubble}
              pos={catPos}
              expanded={ui.bubble}
              onToggle={() => store.set({ bubble: !store.get().bubble })}
              onMoved={(pos) => api.setPref("catPos", pos)}
            />
          )}
          {showCat && ui.bubble && (
            <Bubble
              cat={catPos}
              quick={quick.length ? quick : null}
              onClose={() => {
                store.set({ bubble: false });
                catRef.current?.focus();
              }}
              onHide={() => store.set({ bubble: false, hidden: true })}
            />
          )}
          {features.map((f) => f.overlay && <f.overlay key={f.id} />)}
          {ui.settings !== null && (
            <Settings
              target={ui.settings}
              pages={pages}
              breed={prefs.breed}
              version={p.version}
              onNavigate={(to) => store.set({ settings: to })}
              onClose={() => store.set({ settings: null })}
              onUnmount={() => {
                const el = p.focusReturn.el as HTMLElement | null;
                p.focusReturn.el = null;
                if (el?.isConnected && typeof el.focus === "function") el.focus();
                else catRef.current?.focus();
              }}
            />
          )}
        </TipProvider>
      </PortalContainer>
    </ShellCtx.Provider>
  );
}
