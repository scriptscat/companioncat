/**
 * Build-time stand-in for `@radix-ui/react-dismissable-layer` (aliased in vite.config.ts, see
 * ./aliases.ts): the real layer, never with `disableOutsidePointerEvents`. Radix Select always asks
 * for it, and the real layer then sets `pointer-events: none` on the page's <body> while the select is
 * open — a write to the host page's styles, against R1.2 and hard invariant 4. A click outside still
 * closes the popup (as the non-modal menu already does).
 */
import { createElement, forwardRef } from "react";
import * as Real from "cc-real-dismissable-layer";

export const DismissableLayer = forwardRef<HTMLDivElement, Record<string, unknown>>(function DismissableLayer(props, ref) {
  return createElement(Real.DismissableLayer, { ...props, disableOutsidePointerEvents: false, ref });
});
export const Root = DismissableLayer;
export const DismissableLayerBranch = Real.DismissableLayerBranch;
export const Branch = Real.DismissableLayerBranch;
export const useDismissableLayerSurface = Real.useDismissableLayerSurface;
