/**
 * Build-time stand-in for `react-remove-scroll-bar` (aliased in vite.config.ts, see ./aliases.ts).
 * The real one sets `data-scroll-locked` on the page's <body> and pads it for the hidden
 * scrollbar while a Radix Select is open — a write to the host page's DOM, against R1.2.
 * react-remove-scroll's wheel/touch blocking is unaffected.
 */
export const RemoveScrollBar = (_props: { noRelative?: boolean; noImportant?: boolean; gapMode?: string }) => null;
export const zeroRightClassName = "right-scroll-bar-position";
export const fullWidthClassName = "width-before-scroll-bar";
export const noScrollbarsClassName = "with-scroll-bars-hidden";
export const removedBarSizeVariable = "--removed-body-scroll-bar-size";
export const getGapWidth = () => ({ left: 0, top: 0, right: 0, gap: 0 });
