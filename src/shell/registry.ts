/**
 * Self-registration seam. Each src/pages/<name>/register.tsx and src/features/<name>/register.tsx
 * default-exports definePage(...) / defineFeature(...) (or an array of them); main.tsx collects
 * them with import.meta.glob (eager) and hands them to mount(). Tests pass fakes the same way.
 */
import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { ResolvedFeature } from "../core/rules/types";
import type { ShellServices } from "./services";

/** 「功能」: pages for rule-provided features. 「陪伴猫」: the shell's own pages. */
export type NavGroup = "features" | "companion";

/** The three fixed slots of the 「陪伴猫」 group, in this order (R1.5). */
export const BUILTIN_PAGES = ["engines", "rules", "general"] as const;
export type BuiltinPage = (typeof BUILTIN_PAGES)[number];

export interface PageProps {
  /** Set for 「功能」 pages: the feature being shown. */
  feature?: ResolvedFeature;
  narrow: boolean;
  /** The nav target the window was opened at, e.g. `engine:<provider ref>` for the engines page. */
  target?: string;
}

export interface PageRegistration {
  kind: "page";
  /**
   * group "companion": "engines" | "rules" | "general" fill the built-in slots (label/icon come
   * from the shell); any other id appends a page after them and needs label (and icon).
   * group "features": the renderer used for every rule feature (label/icon come from the rule).
   */
  id: string;
  group: NavGroup;
  label?: string;
  icon?: LucideIcon;
  component: ComponentType<PageProps>;
}

/** One thing a feature can do on demand: a bubble button (quick), a hotkey and a ScriptCat menu item, all running `run`. */
export interface Command {
  id: string;
  title: string;
  /** A key combination such as `Alt+A` (see matchHotkey). */
  hotkey?: string;
  /** Show as a button in the bubble. */
  quick?: boolean;
  run(): void;
  /** Re-evaluated when the bubble renders and when the command runs; true greys the button and blocks the run. */
  disabled?(): boolean;
}

export interface CommandApi {
  /** Returns the unregister function. Registering an id again replaces the command. */
  register(cmd: Command): () => void;
}

export interface ToastSpec {
  text: string;
  /** Clicking a link runs onClick and closes the toast. */
  links?: { label: string; onClick: () => void }[];
  /** Time before it goes away on its own; default 5000. Not counted while hovered or focused. */
  ms?: number;
}

export interface RuntimeContext {
  root: ShadowRoot;
  /** Container inside the shadow root for anything the feature puts on the page. */
  layer: HTMLElement;
  hostname: string;
  services: ShellServices;
  /**
   * The corner cat opens its eyes while any feature has it set (paw or card showing, R1.3).
   * label is shown next to the cat while given (R2.1), also with `on` false — the cat then sleeps on
   * with the label (对照中); with several features the latest label wins, and each feature clears only its own.
   */
  setAwake(on: boolean, label?: string): void;
  /** A toast near the cat (R2.2). Returns a function that dismisses it. Always present in the shell; optional so test fakes need not stub it. */
  toast?(t: ToastSpec): () => void;
  commands: CommandApi;
  /** Open the settings window, optionally at a nav target (see ShellApi.openSettings). */
  openSettings(to?: string): void;
}

export interface FeatureRegistration {
  kind: "feature";
  id: string;
  /** Runs once after mount; the returned function runs on unmount. */
  start?(ctx: RuntimeContext): void | (() => void);
  /** Rendered inside the bubble (when rules exist). Use useShell() for context. */
  quick?: ComponentType;
  /** Rendered inside the shell's React tree (in the shadow root), always. */
  overlay?: ComponentType;
}

export type Registration = PageRegistration | FeatureRegistration;

export const definePage = (p: Omit<PageRegistration, "kind">): PageRegistration => ({ kind: "page", ...p });
export const defineFeature = (f: Omit<FeatureRegistration, "kind">): FeatureRegistration => ({ kind: "feature", ...f });

const isRegistration = (v: unknown): v is Registration =>
  !!v && typeof v === "object" && ((v as Registration).kind === "page" || (v as Registration).kind === "feature");

/** Flattens import.meta.glob results (eager) into registrations, ordered by module path. */
export function collect(...globs: Record<string, unknown>[]): Registration[] {
  return globs.flatMap((glob) =>
    Object.keys(glob)
      .sort()
      .flatMap((path) => {
        const def = (glob[path] as { default?: unknown } | undefined)?.default;
        const list = Array.isArray(def) ? def : [def];
        if (!list.length || !list.every(isRegistration))
          throw new Error(`${path} must default-export definePage(...) / defineFeature(...)`);
        return list;
      }),
  );
}

/** Shown instead of running a disabled command. */
export const PAUSED_NOTICE = "这个网站的自动化已暂停";

export interface CommandRegistryOptions {
  /** Called once per command id, the first time it is registered (menu items cannot be removed). */
  onMenu?: (title: string, run: () => void) => void;
  /** Called when a disabled command is run. */
  onBlocked?: (message: string) => void;
}

/** Commands of one mounted shell. `version` changes whenever the list changes (for useSyncExternalStore). */
export function createCommandRegistry(o: CommandRegistryOptions = {}) {
  const commands = new Map<string, Command>();
  const menuSeen = new Set<string>();
  const subs = new Set<() => void>();
  let version = 0;
  const changed = () => {
    version++;
    subs.forEach((cb) => cb());
  };
  const run = (id: string) => {
    const cmd = commands.get(id);
    if (!cmd) return;
    if (cmd.disabled?.()) o.onBlocked?.(PAUSED_NOTICE);
    else cmd.run();
  };
  return {
    version: () => version,
    subscribe(cb: () => void) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    list: () => [...commands.values()],
    run,
    api: {
      register(cmd: Command) {
        commands.set(cmd.id, cmd);
        if (!menuSeen.has(cmd.id)) {
          menuSeen.add(cmd.id);
          o.onMenu?.(cmd.title, () => run(cmd.id));
        }
        changed();
        return () => {
          if (commands.get(cmd.id) !== cmd) return;
          commands.delete(cmd.id);
          changed();
        };
      },
    } satisfies CommandApi,
  };
}

export type CommandRegistry = ReturnType<typeof createCommandRegistry>;
