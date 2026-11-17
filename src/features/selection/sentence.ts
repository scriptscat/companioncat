/** R9.7 `selection.sentence`: the whole sentence around the selection, at most this many characters. */
export const MAX_SENTENCE = 500;

const END = /[。！？!?；;\n]|\.(?=\s|$)/g;

/** The sentence of `block` that holds `[start, end)`; a window around the selection when it is too long. */
export function sentenceAround(block: string, start: number, end: number): string {
  let from = 0;
  let to = block.length;
  for (const m of block.matchAll(END)) {
    const i = m.index;
    if (i < start) from = i + 1;
    else if (i >= end - 1) {
      to = i + 1;
      break;
    }
    // terminators inside the selection belong to it
  }
  const raw = block.slice(from, to);
  const s = raw.trim();
  if (s.length <= MAX_SENTENCE) return s;
  const lead = raw.length - raw.trimStart().length;
  const selStart = Math.max(0, start - from - lead);
  const selLen = Math.min(end - start, MAX_SENTENCE);
  const at = Math.max(0, Math.min(selStart - Math.floor((MAX_SENTENCE - selLen) / 2), s.length - MAX_SENTENCE));
  return s.slice(at, at + MAX_SENTENCE).trim();
}
