/**
 * Build-time stand-in for `@radix-ui/react-focus-guards` (aliased in vite.config.ts, see ./aliases.ts).
 * The real one inserts a pair of focus-guard <span>s at the edges of the page's document.body while a
 * Radix menu or select is open — elements of ours outside the shadow root, against R1.2 and hard
 * invariant 4. Focus still stays inside the popup (FocusScope is unaffected).
 */
import type { ReactNode } from "react";

export function FocusGuards(props: { children?: ReactNode }): ReactNode {
  return props.children ?? null;
}
export { FocusGuards as Root };
export function useFocusGuards(): void {}
