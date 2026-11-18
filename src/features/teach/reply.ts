/**
 * Reading the chat engine's reply (R6.3). The AI is asked for
 * `{message, questions?, askPick?, draft?}`; anything that is not such an object becomes a plain message.
 */

export interface Question {
  text: string;
  /** One-tap answers sent as the user's next message. */
  quickReplies?: string[];
}

export interface Reply {
  message: string;
  questions?: Question[];
  /** The AI asks the user to pick elements (「去点选」). */
  askPick?: { text: string };
  /** A rule feature, not yet validated. */
  draft?: unknown;
}

const REPLY_KEYS = ["message", "questions", "askPick", "draft"];
/** At most this many `{` positions are tried as the start of the reply object. */
const MAX_CANDIDATES = 64;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** End index (exclusive) of the balanced JSON value starting at `i`, or -1. */
function jsonEnd(s: string, i: number): number {
  const stack: string[] = [];
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"') {
      for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === "\\") j++;
    } else if (c === "{" || c === "[") {
      stack.push(c === "{" ? "}" : "]");
    } else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return j + 1;
    }
  }
  return -1;
}

/** The first reply-shaped object in the text, with where it sits. */
function findReply(s: string): { value: Record<string, unknown>; start: number; end: number } | undefined {
  const isReply = (v: unknown): v is Record<string, unknown> => isRecord(v) && REPLY_KEYS.some((k) => k in v);
  try {
    const whole: unknown = JSON.parse(s);
    return isReply(whole) ? { value: whole, start: 0, end: s.length } : undefined;
  } catch {
    // scan for an embedded object
  }
  let tried = 0;
  for (let i = s.indexOf("{"); i >= 0 && tried < MAX_CANDIDATES; i = s.indexOf("{", i + 1)) {
    tried++;
    const end = jsonEnd(s, i);
    if (end < 0) continue;
    try {
      const value: unknown = JSON.parse(s.slice(i, end));
      if (isReply(value)) return { value, start: i, end };
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function question(v: unknown): Question | undefined {
  if (nonEmpty(v)) return { text: v.trim() };
  if (!isRecord(v) || !nonEmpty(v.text)) return undefined;
  const quick = Array.isArray(v.quickReplies) ? v.quickReplies.filter(nonEmpty).map((q) => q.trim()) : [];
  return { text: v.text.trim(), ...(quick.length ? { quickReplies: quick } : {}) };
}

/** Prose around a fenced or embedded reply object, used when the object carries no message. */
function prose(text: string, start: number, end: number): string {
  const strip = (s: string) => s.replace(/```[a-z]*\s*$/i, "").replace(/^\s*```/, "");
  return `${strip(text.slice(0, start))}\n${strip(text.slice(end))}`.trim();
}

export function parseReply(text: string): Reply {
  const found = findReply(text);
  if (!found) return { message: text.trim() };
  const { value: v } = found;
  const questions = Array.isArray(v.questions) ? v.questions.map(question).filter((q) => q !== undefined) : [];
  const pick = nonEmpty(v.askPick) ? v.askPick : isRecord(v.askPick) && nonEmpty(v.askPick.text) ? v.askPick.text : undefined;
  const reply: Reply = { message: typeof v.message === "string" ? v.message.trim() : prose(text, found.start, found.end) };
  if (questions.length) reply.questions = questions;
  if (pick !== undefined) reply.askPick = { text: pick.trim() };
  if (v.draft !== undefined && v.draft !== null) reply.draft = v.draft;
  return reply;
}
