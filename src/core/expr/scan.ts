import { ExprError } from "./errors";

export type TemplatePart =
  | { kind: "text"; text: string }
  /** `start` is the offset of `source` inside the template string. */
  | { kind: "expr"; source: string; start: number };

const isIdentChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);

/** Index just past the CEL string literal whose opening quote is at `i`. */
function skipString(s: string, i: number): number {
  const q = s[i]!;
  const triple = s.startsWith(q.repeat(3), i);
  const close = triple ? q.repeat(3) : q;
  // r"…" / br"…" literals have no escapes.
  const prev = s[i - 1];
  const raw = (prev === "r" || prev === "R") && (!isIdentChar(s[i - 2]) || /[bB]/.test(s[i - 2]!));
  let j = i + close.length;
  while (j < s.length) {
    if (!raw && s[j] === "\\") {
      j += 2;
      continue;
    }
    if (s.startsWith(close, j)) return j + close.length;
    if (!triple && s[j] === "\n") break;
    j++;
  }
  return -1;
}

/**
 * Splits a template into literal text and `{{ }}` expressions. A `}}` that
 * closes a map literal or sits inside a string literal does not end the expression.
 */
export function scanTemplate(s: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let text = "";
  let i = 0;
  while (i < s.length) {
    if (!s.startsWith("{{", i)) {
      text += s[i++];
      continue;
    }
    const open = i;
    const start = i + 2;
    let depth = 0;
    let j = start;
    let end = -1;
    while (j < s.length) {
      const c = s[j]!;
      if (c === '"' || c === "'") {
        const next = skipString(s, j);
        if (next < 0) break;
        j = next;
      } else if (c === "{") {
        depth++;
        j++;
      } else if (c === "}") {
        if (depth === 0 && s[j + 1] === "}") {
          end = j;
          break;
        }
        depth = Math.max(0, depth - 1);
        j++;
      } else {
        j++;
      }
    }
    if (end < 0) {
      throw new ExprError("syntax", "表达式缺少结尾的 }}", s.slice(start), open, s.length);
    }
    if (text) parts.push({ kind: "text", text });
    text = "";
    parts.push({ kind: "expr", source: s.slice(start, end), start });
    i = end + 2;
  }
  if (text) parts.push({ kind: "text", text });
  return parts;
}
