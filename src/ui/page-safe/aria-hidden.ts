/**
 * Build-time stand-in for `aria-hidden` (aliased in vite.config.ts, see ./aliases.ts). Radix
 * Select and modal menus call `hideOthers(content)`, which walks the page's document.body and
 * marks every child `aria-hidden` (our host hangs off <html>, so the whole page would vanish for
 * screen readers) — a write to the host page's DOM, against R1.2. The popups stay inside the
 * shadow root; nothing outside it is touched.
 */
type Undo = () => void;
const none: Undo = () => {};
export const hideOthers = (_target: Element | Element[], _parent?: HTMLElement, _marker?: string): Undo => none;
export const inertOthers = hideOthers;
export const suppressOthers = hideOthers;
export const supportsInert = () => false;
