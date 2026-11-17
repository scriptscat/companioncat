/** Where the paw and the near-selection card go (R9.6, R9.9). All coordinates are viewport pixels. */
import { NARROW } from "../../shell/Shell";

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const MARGIN = 8;
/** Space between the selection and the card. */
export const GAP = 10;
export const CARD_WIDTH = 388;
export const PAW_SIZE = 34;
const NARROW_INSET = 10;
const TAIL = 16;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export interface CardPlacement {
  left: number;
  top: number;
  width: number;
  side: "below" | "above";
  /** Tail offset from the card's left edge, pointing at the selection. */
  tail: number;
  /** The room on its side: a taller card scrolls inside instead of running off the screen. */
  maxHeight: number;
}

/** Smallest height a card is ever squeezed to, even on a tiny viewport. */
const MIN_HEIGHT = 120;

/** Below the selection unless it only fits above; never past the left or right edge. */
export function placeCard(anchor: Box, height: number, vw: number, vh: number): CardPlacement {
  const narrow = vw < NARROW;
  const width = narrow ? vw - 2 * NARROW_INSET : Math.min(CARD_WIDTH, vw - 2 * MARGIN);
  const left = narrow ? NARROW_INSET : clamp(anchor.left, MARGIN, vw - width - MARGIN);
  const below = vh - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const side = height <= below || below >= above ? "below" : "above";
  const maxHeight = Math.max(MIN_HEIGHT, side === "below" ? below : above);
  const shown = Math.min(height, maxHeight);
  const top = side === "below" ? anchor.bottom + GAP : Math.max(MARGIN, anchor.top - GAP - shown);
  const center = (anchor.left + anchor.right) / 2;
  const tail = clamp(center - left - TAIL / 2, TAIL + 2, width - TAIL * 2 - 2);
  return { left, top, width, side, tail, maxHeight };
}

/** Just after the end of the selection (its left in right-to-left text), centred on its last line, inside the viewport. */
export function placePaw(end: Box, vw: number, vh: number, rtl = false): { left: number; top: number } {
  const mid = (end.top + end.bottom) / 2;
  return {
    left: clamp(rtl ? end.left - 4 - PAW_SIZE : end.right + 4, MARGIN, vw - PAW_SIZE - MARGIN),
    top: clamp(mid - PAW_SIZE / 2, MARGIN, vh - PAW_SIZE - MARGIN),
  };
}
