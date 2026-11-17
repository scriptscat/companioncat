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

export interface RuntimeContext {
  root: ShadowRoot;
  /** Container inside the shadow root for anything the feature puts on the page. */
  layer: HTMLElement;
  hostname: string;
  services: ShellServices;
  /** The corner cat opens its eyes while any feature has it set (paw or card showing, R1.3). */
  setAwake(on: boolean): void;
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
