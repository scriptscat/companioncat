import type { ToastSpec } from "./registry";

/** Transient UI state of one mounted shell, driven both by React and by the mount() handle. */

export interface UiState {
  /** Nav target of the open settings window, or null when closed. */
  settings: string | null;
  bubble: boolean;
  /** Reasons the cat is awake (feature ids). */
  awake: ReadonlySet<string>;
  /** Labels of awake reasons, oldest first: the last one is shown. */
  labels: ReadonlyArray<{ reason: string; label: string }>;
  toasts: ReadonlyArray<{ id: number; spec: ToastSpec }>;
  /** 「让小猫先躲起来」: hidden until the page reloads. */
  hidden: boolean;
}

export function createUiStore() {
  let state: UiState = { settings: null, bubble: false, awake: new Set(), labels: [], toasts: [], hidden: false };
  const subs = new Set<() => void>();
  let toastId = 0;
  const dismiss = (id: number) => {
    if (state.toasts.some((t) => t.id === id)) set({ toasts: state.toasts.filter((t) => t.id !== id) });
  };
  const set = (patch: Partial<UiState>) => {
    state = { ...state, ...patch };
    subs.forEach((cb) => cb());
  };
  return {
    get: () => state,
    subscribe(cb: () => void) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    set,
    /** `label` shows next to the cat while given, awake or not (对照中 keeps the cat asleep); no label clears it. */
    setAwake(reason: string, on: boolean, label?: string) {
      const labels = state.labels.filter((l) => l.reason !== reason);
      if (label) labels.push({ reason, label });
      const same = state.labels.length === labels.length && state.labels.every((l, i) => l === labels[i]);
      if (state.awake.has(reason) === on && same) return;
      const awake = new Set(state.awake);
      if (on) awake.add(reason);
      else awake.delete(reason);
      set({ awake, labels });
    },
    toast(spec: ToastSpec) {
      const id = ++toastId;
      set({ toasts: [...state.toasts, { id, spec }] });
      return () => dismiss(id);
    },
    dismissToast: (id: number) => dismiss(id),
  };
}

export type UiStore = ReturnType<typeof createUiStore>;
