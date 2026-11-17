import { createStorage, type GmStorageApi, type Storage } from "../platform/storage";
import { mount, type ShellHandle } from "./mount";
import type { Registration } from "./registry";
import { staticRules, type ShellServices } from "./services";

export interface GmApi extends GmStorageApi {
  GM_registerMenuCommand(name: string, fn: () => void): unknown;
}

export const MENU_OPEN_SETTINGS = "打开陪伴猫设置";

export interface BootOptions {
  gm?: GmApi;
  /** Defaults to window.top === window.self; the userscript never runs in iframes (R1.1). */
  top?: boolean;
  registrations?: Registration[];
  /**
   * Builds the services that live in other modules (rules from subscriptions, 「订阅官方规则」, ...)
   * on top of the shared storage. Defaults to no rules.
   */
  wire?: (storage: Storage) => Partial<Omit<ShellServices, "storage">>;
  hostname?: string;
  version?: string;
  css?: string;
}

/** Userscript start: storage over GM, the shell in its shadow root, and the ScriptCat menu entry (R1.4). */
export function boot(o: BootOptions = {}): ShellHandle | null {
  const top = o.top ?? window.top === window.self;
  if (!top) return null;
  const gm = o.gm ?? (globalThis as unknown as GmApi);
  const storage = createStorage(gm);
  const wired = o.wire?.(storage) ?? {};
  const handle = mount({
    services: { rules: staticRules(), ...wired, storage },
    registrations: o.registrations,
    hostname: o.hostname,
    version: o.version,
    css: o.css,
  });
  // Always registered, so settings stay reachable when the cat is hidden.
  gm.GM_registerMenuCommand(MENU_OPEN_SETTINGS, () => handle.openSettings());
  return handle;
}
