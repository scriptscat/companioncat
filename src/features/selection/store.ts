/** The runtime's UI state (paw and cards), shared with the overlay through useSyncExternalStore. */
import type { ComponentDef, ViewUseDef } from "../../core/rules/types";
import type { Box } from "./place";
import type { CallRecord, StepScope, Vars } from "./steps";

export interface PawState {
  title: string;
  anchor: Box;
  /** The selection ends in right-to-left text: the paw goes on its left. */
  rtl?: boolean;
  go(): void;
}

export interface CardState {
  id: number;
  title: string;
  view: ViewUseDef | ComponentDef;
  scope: StepScope;
  vars: Vars;
  /** Temporary vars from a rerun (R10.4); they win over `set`. */
  overrides: Vars;
  calls: CallRecord[];
  error?: string;
  pinnable: boolean;
  closeOn: readonly string[];
  pinned: boolean;
  anchor: Box;
}

export interface UiState {
  paw: PawState | null;
  cards: CardState[];
}

export function createStore() {
  let state: UiState = { paw: null, cards: [] };
  const subs = new Set<() => void>();
  return {
    get: () => state,
    subscribe(cb: () => void) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    set(patch: Partial<UiState>) {
      state = { ...state, ...patch };
      subs.forEach((cb) => cb());
    },
    card: (id: number) => state.cards.find((c) => c.id === id),
    patchCard(id: number, patch: Partial<CardState>) {
      if (!state.cards.some((c) => c.id === id)) return;
      state = { ...state, cards: state.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
      subs.forEach((cb) => cb());
    },
  };
}

export type Store = ReturnType<typeof createStore>;
