/** The real `@radix-ui/react-dismissable-layer`, which ./dismissable-layer.ts wraps (see ./aliases.ts). */
declare module "cc-real-dismissable-layer" {
  import type { ComponentType, RefAttributes } from "react";
  export const DismissableLayer: ComponentType<Record<string, unknown> & RefAttributes<HTMLDivElement>>;
  export const DismissableLayerBranch: ComponentType<Record<string, unknown>>;
  export const useDismissableLayerSurface: (...args: unknown[]) => unknown;
}
