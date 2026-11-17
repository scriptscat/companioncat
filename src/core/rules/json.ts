/** JSON parsing that remembers where every value sits, so problems can name a line (R3.2). */

export interface TextPosition {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

export class JsonSyntaxError extends Error {
  override readonly name = "JsonSyntaxError";
  constructor(
    message: string,
    readonly offset: number,
    readonly position: TextPosition,
  ) {
    super(message);
  }
}

/** Rules never need deeper JSON; deeper input is refused before anything recurses into it. */
const MAX_NESTING = 64;
export const NESTING_MESSAGE = `嵌套超过 ${MAX_NESTING} 层`;

/** Whether arrays/objects in `value` nest more than MAX_NESTING levels (checked without recursion). */
export function nestedTooDeep(value: unknown): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length > 0) {
    const [v, d] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (d >= MAX_NESTING) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, d + 1]);
  }
  return false;
}

export interface LocatedJson {
  value: unknown;
  /** Position of the field at `pointer`, or of its nearest existing ancestor. */
  locate(pointer: string): TextPosition;
}

/** Assigns an own property even for "__proto__", like JSON.parse does. */
export function setOwn(obj: Record<string, unknown>, key: string, v: unknown): void {
  Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
}

export function escapePointer(segment: string | number): string {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

export function pointer(path: readonly (string | number)[]): string {
  return path.map((s) => `/${escapePointer(s)}`).join("");
}

function positionAt(lineStarts: number[], offset: number): TextPosition {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo]! + 1 };
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;

/** Parses strict JSON; throws JsonSyntaxError with the offending position. */
export function parseLocated(text: string): LocatedJson {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const offsets = new Map<string, number>();
  let i = 0;

  const fail = (message: string, at = i): never => {
    const pos = positionAt(lineStarts, at);
    throw new JsonSyntaxError(`JSON 格式错误（第 ${pos.line} 行第 ${pos.column} 列）：${message}`, at, pos);
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const unexpected = (): never => (i >= text.length ? fail("内容不完整") : fail(`这里不该出现 ${JSON.stringify(text[i])}`));
  const expect = (ch: string, what: string) => {
    ws();
    if (text[i] !== ch) fail(`这里应该是 ${what}`);
    i++;
  };
  const string = (): string => {
    STRING.lastIndex = i;
    const m = STRING.exec(text);
    if (!m) return fail("字符串写得不对");
    i += m[0].length;
    return JSON.parse(m[0]) as string;
  };

  let depth = 0;
  const value = (ptr: string, at?: number): unknown => {
    ws();
    offsets.set(ptr, at ?? i);
    const ch = text[i];
    if ((ch === "{" || ch === "[") && depth >= MAX_NESTING) fail(NESTING_MESSAGE);
    depth++;
    try {
      return container(ch, ptr);
    } finally {
      depth--;
    }
  };
  const container = (ch: string | undefined, ptr: string): unknown => {
    if (ch === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        const keyAt = i;
        if (text[i] !== '"') fail("这里应该是用双引号括起来的字段名");
        const key = string();
        expect(":", "冒号 :");
        setOwn(obj, key, value(`${ptr}/${escapePointer(key)}`, keyAt));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        fail("这里应该是逗号 , 或 }");
      }
    }
    if (ch === "[") {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(`${ptr}/${arr.length}`));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail("这里应该是逗号 , 或 ]");
      }
    }
    if (ch === '"') return string();
    for (const [word, v] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (m) {
      i += m[0].length;
      return Number(m[0]);
    }
    return unexpected();
  };

  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const result = value("");
  ws();
  if (i < text.length) unexpected();

  return {
    value: result,
    locate(ptr) {
      let p = ptr;
      for (;;) {
        const at = offsets.get(p);
        if (at !== undefined) return positionAt(lineStarts, at);
        if (p === "") return { line: 1, column: 1 };
        p = p.slice(0, p.lastIndexOf("/"));
      }
    },
  };
}
