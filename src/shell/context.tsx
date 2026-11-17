import { createContext, useContext } from "react";
import type { Resolved } from "../core/rules/types";
import type { ShellPrefs } from "./prefs";
import type { ShellServices } from "./services";

/** What pages, quick items and overlays get from useShell(). */
export interface ShellApi {
  services: ShellServices;
  resolved: Resolved;
  /** No rules provide anything yet (R1.6). */
  bare: boolean;
  hostname: string;
  prefs: ShellPrefs;
  setPref<K extends keyof ShellPrefs>(key: K, value: ShellPrefs[K]): void;
  /**
   * Nav targets: "engines" | "rules" | "general" | <extra companion page id> | `feature:<feature ref>`
   * | `engine:<provider ref>` (the engines page with that engine's detail open).
   * Default "engines". Also navigates when already open.
   */
  openSettings(to?: string): void;
  closeSettings(): void;
  closeBubble(): void;
  /** 「订阅官方规则」 with busy/error state. */
  subscribe: { run(): void; busy: boolean; error: string | null; available: boolean };
  narrow: boolean;
  root: ShadowRoot;
  layer: HTMLElement;
}

export const ShellCtx = createContext<ShellApi | null>(null);

export function useShell(): ShellApi {
  const api = useContext(ShellCtx);
  if (!api) throw new Error("useShell() outside the shell");
  return api;
}
