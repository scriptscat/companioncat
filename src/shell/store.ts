/** Transient UI state of one mounted shell, driven both by React and by the mount() handle. */

export interface UiState {
  /** Nav target of the open settings window, or null when closed. */
  settings: string | null;
  bubble: boolean;
  /** Reasons the cat is awake (feature ids). */
  awake: ReadonlySet<string>;
  /** 「让小猫先躲起来」: hidden until the page reloads. */
  hidden: boolean;
}

export function createUiStore() {
  let state: UiState = { settings: null, bubble: false, awake: new Set(), hidden: false };
  const subs = new Set<() => void>();
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
    setAwake(reason: string, on: boolean) {
      if (state.awake.has(reason) === on) return;
      const awake = new Set(state.awake);
      if (on) awake.add(reason);
      else awake.delete(reason);
      set({ awake });
    },
  };
}

export type UiStore = ReturnType<typeof createUiStore>;
