/**
 * The headless teach conversation (R6.3, R6.5, R6.6, R6.11): turns with the user's `chat` engine,
 * automatic validation with up to 3 repair rounds, draft versions with rollback, stop and retry.
 * The panel renders `snapshot()`; `toJSON()` / `fromJSON()` let the conversation be stored with its rule.
 */
import { CallError, isCallError, type ErrorType } from "../../core/errors";
import type { Invoker } from "../../core/invoke";
import { checkLocalRules, LOCAL_PACK_ID, type PackSource } from "../../core/rules";
import {
  type ChatMessage,
  type DraftProblem,
  historyAssistant,
  historyUser,
  type PageInfo,
  repairPrompt,
  retryPrompt,
  systemPrompt,
  turnPrompt,
} from "./prompt";
import { parseReply, type Reply } from "./reply";

export type { ChatMessage, DraftProblem, PageInfo } from "./prompt";
export type { Question, Reply } from "./reply";

/** Repair rounds asked of the AI before giving up on a draft (R6.5). */
export const REPAIR_ROUNDS = 3;

export type TurnStatus = "pending" | "done" | "failed" | "stopped";

/** What validation found in this turn's draft and how the repair went. */
export interface DraftCheck {
  /** Problems in the AI's first draft of the turn; empty when it passed straight away. */
  found: DraftProblem[];
  /** Repair rounds asked of the AI (0–3). */
  rounds: number;
  /** How many of `found` are gone from the final draft (「校验发现 2 处问题，已修好」). */
  fixed: number;
  /** Problems still in the final draft; non-empty means the draft was rejected. */
  remaining: DraftProblem[];
}

export interface TurnError {
  /** The R6.3 error type when the call failed with a CallError. */
  type?: ErrorType;
  message: string;
}

export interface Turn {
  id: string;
  at: number;
  /** "retry": 「让小猫再试」 on the previous turn's rejected draft; it has no user text. */
  kind: "message" | "retry";
  text: string;
  /** Element outlines picked by the user (never input values). */
  attachments: string[];
  /** The version this turn continued from (0 = no draft yet). */
  base: number;
  status: TurnStatus;
  /** The AI's reply, its draft left out (an accepted draft is in `versions`). */
  reply?: Reply;
  /** The version this turn's draft became. */
  version?: number;
  check?: DraftCheck;
  /** The last draft when every repair round failed (for 「自己改」). */
  rejected?: unknown;
  error?: TurnError;
}

export interface Version {
  /** 1-based: v1, v2, … */
  n: number;
  /** The rule feature JSON; it passed validation. */
  draft: unknown;
  /** Id of the turn that produced it. */
  turn: string;
  at: number;
}

export interface ConversationState {
  turns: readonly Turn[];
  versions: readonly Version[];
  /** The version being viewed and continued from; 0 before the first draft. */
  current: number;
  /** A turn is in flight. */
  pending: boolean;
  /** Problems left in the latest turn's rejected draft. */
  errors: readonly DraftProblem[];
}

export interface SavedConversation {
  v: 1;
  turns: Turn[];
  versions: Version[];
  current: number;
}

export interface ConversationOptions {
  invoker: Pick<Invoker, "invoke">;
  /** The chat engine to use; absent = the preferred one. */
  engine?: string;
  /** The rule schema sent to the AI. */
  schema: unknown;
  /** One example feature sent to the AI. */
  example: unknown;
  /** Validation errors of a draft feature; usually `(d) => validateDraft(d, subscriptions)`. */
  validate: (draft: unknown) => DraftProblem[] | Promise<DraftProblem[]>;
  now?: () => number;
  /** The page the panel is on; defaults to the current location and title. */
  page?: () => PageInfo;
}

export interface Conversation {
  snapshot(): ConversationState;
  subscribe(listener: () => void): () => void;
  readonly versions: readonly Version[];
  readonly current: number;
  /** Sends a user message; resolves when the turn is done, failed or stopped. */
  send(text: string, attachments?: readonly string[]): Promise<void>;
  /** Retries the last turn: a failed call again, or 「让小猫再试」 after the repair rounds ran out. */
  retry(): Promise<void>;
  /** Abandons the in-flight turn; the draft stays at the previous version. */
  stop(): void;
  /** Rolls back (or forward) to version n; the next message continues from it. */
  select(n: number): void;
  toJSON(): SavedConversation;
}

/** Turns a JSON pointer under the wrapped feature into `entries[0].run[1].target`. */
function fieldPath(pointer: string): string {
  const prefix = "/features/0";
  if (pointer !== prefix && !pointer.startsWith(prefix + "/")) return pointer;
  let out = "";
  for (const raw of pointer.slice(prefix.length).split("/").slice(1)) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    out += /^\d+$/.test(seg) ? `[${seg}]` : out ? `.${seg}` : seg;
  }
  return out;
}

/**
 * Validates a draft feature with the phase-1 local rules check (schema, expressions with the
 * automation positions, inheritance) by wrapping it as the only feature of a local pack.
 */
export function validateDraft(draft: unknown, subscriptions: readonly PackSource[] = []): DraftProblem[] {
  const pack = { schema: 1, id: LOCAL_PACK_ID, features: [draft] };
  return checkLocalRules(JSON.stringify(pack), subscriptions)
    .problems.filter((p) => p.severity === "error")
    .map((p) => ({ path: fieldPath(p.path), message: p.message }));
}

const RETRY_TEXT = "让小猫再试：请修好上一轮没通过校验的草稿。";
const sameProblem = (a: DraftProblem, b: DraftProblem) => a.path === b.path && a.message === b.message;

function currentPage(): PageInfo {
  const g = globalThis as { location?: { href: string }; document?: { title: string } };
  return { url: g.location?.href ?? "", title: g.document?.title ?? "" };
}

/** Raised when a call ends because the turn was stopped. */
const STOPPED = Symbol("stopped");

export function createConversation(opts: ConversationOptions, saved?: SavedConversation): Conversation {
  const now = opts.now ?? Date.now;
  const page = opts.page ?? currentPage;
  const listeners = new Set<() => void>();
  let state: ConversationState = {
    turns: saved?.turns ?? [],
    versions: saved?.versions ?? [],
    current: saved?.current ?? 0,
    pending: false,
    errors: [],
  };
  state = { ...state, errors: latestErrors(state.turns) };
  let inFlight: AbortController | undefined;

  function latestErrors(turns: readonly Turn[]): DraftProblem[] {
    const last = turns[turns.length - 1];
    return last?.status === "done" ? (last.check?.remaining ?? []) : [];
  }

  function set(patch: Partial<ConversationState>): void {
    const next = { ...state, ...patch };
    state = { ...next, errors: latestErrors(next.turns) };
    for (const l of [...listeners]) l();
  }

  function setTurn(id: string, turn: Turn, extra: Partial<ConversationState> = {}): void {
    set({ ...extra, turns: state.turns.map((t) => (t.id === id ? turn : t)) });
  }

  const draftOf = (n: number) => (n ? { n, draft: state.versions[n - 1]!.draft } : undefined);

  /** System prompt plus every answered turn before `index`; failed and stopped turns are left out. */
  function history(index: number): ChatMessage[] {
    const out: ChatMessage[] = [{ role: "system", content: systemPrompt(opts.schema, opts.example) }];
    for (const t of state.turns.slice(0, index)) {
      if (t.status !== "done" || !t.reply) continue;
      const user = t.kind === "retry" ? RETRY_TEXT : historyUser(t.text, t.attachments);
      out.push({ role: "user", content: user }, { role: "assistant", content: historyAssistant(t.reply, t.version) });
    }
    return out;
  }

  async function chat(messages: ChatMessage[], signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw STOPPED;
    let result;
    try {
      result = await opts.invoker.invoke(
        { contract: "chat", input: { messages }, ...(opts.engine ? { engines: opts.engine } : {}) },
        { signal },
      );
    } catch (e) {
      if (signal.aborted) throw STOPPED;
      throw e;
    }
    if (signal.aborted) throw STOPPED;
    if (!result.ok) throw result.error ?? new CallError("disabled");
    const text = (result.output as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string") throw new CallError("badOutput");
    return text;
  }

  /** Validates the turn's draft, asking the AI to repair it up to REPAIR_ROUNDS times. */
  async function check(messages: ChatMessage[], raw: string, first: unknown, signal: AbortSignal) {
    let draft = first;
    let problems = await opts.validate(draft);
    const found = problems;
    let rounds = 0;
    while (problems.length && rounds < REPAIR_ROUNDS) {
      rounds++;
      const fixText = await chat(
        [...messages, { role: "assistant", content: raw }, { role: "user", content: repairPrompt(problems) }],
        signal,
      );
      const fix = parseReply(fixText).draft;
      // A reply without a draft fixes nothing; the next round asks again for the same problems.
      if (fix === undefined) continue;
      raw = fixText;
      draft = fix;
      problems = await opts.validate(draft);
    }
    if (signal.aborted) throw STOPPED;
    const fixed = found.filter((p) => !problems.some((q) => sameProblem(p, q))).length;
    return { draft, check: { found, rounds, fixed, remaining: problems } satisfies DraftCheck };
  }

  async function run(id: string): Promise<void> {
    const controller = new AbortController();
    inFlight = controller;
    const { signal } = controller;
    const index = state.turns.findIndex((t) => t.id === id);
    const start: Turn = { ...state.turns[index]!, status: "pending", base: state.current };
    delete start.reply;
    delete start.version;
    delete start.check;
    delete start.rejected;
    delete start.error;
    setTurn(id, start, { pending: true });

    let turn = start;
    try {
      const messages = history(index);
      if (turn.kind === "retry") {
        const source = state.turns[index - 1]!;
        messages.push({ role: "user", content: retryPrompt(page(), source.rejected, source.check?.remaining ?? []) });
      } else {
        const prompt = turnPrompt({ page: page(), draft: draftOf(turn.base), text: turn.text, attachments: turn.attachments });
        messages.push({ role: "user", content: prompt });
      }
      const raw = await chat(messages, signal);
      const { draft, ...reply } = parseReply(raw);
      turn = { ...turn, reply };
      if (draft === undefined) {
        setTurn(id, { ...turn, status: "done" }, { pending: false });
        return;
      }
      const result = await check(messages, raw, draft, signal);
      turn = { ...turn, status: "done", check: result.check };
      if (result.check.remaining.length) {
        setTurn(id, { ...turn, rejected: result.draft }, { pending: false });
        return;
      }
      const n = state.versions.length + 1;
      const version: Version = { n, draft: result.draft, turn: id, at: now() };
      setTurn(id, { ...turn, version: n }, { pending: false, versions: [...state.versions, version], current: n });
    } catch (e) {
      if (e === STOPPED || signal.aborted) return;
      const error: TurnError = isCallError(e) ? { type: e.type, message: e.message } : { message: String((e as Error)?.message ?? e) };
      setTurn(id, { ...turn, status: "failed", error }, { pending: false });
    } finally {
      if (inFlight === controller) inFlight = undefined;
    }
  }

  function addTurn(turn: Omit<Turn, "id" | "at" | "base" | "status">): string {
    if (state.pending) throw new Error("上一轮还没结束");
    const id = `t${state.turns.length + 1}`;
    set({ pending: true, turns: [...state.turns, { id, at: now(), base: state.current, status: "pending", ...turn }] });
    return id;
  }

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get versions() {
      return state.versions;
    },
    get current() {
      return state.current;
    },
    async send(text, attachments = []) {
      const trimmed = text.trim();
      if (!trimmed && !attachments.length) throw new Error("消息是空的");
      await run(addTurn({ kind: "message", text: trimmed, attachments: [...attachments] }));
    },
    async retry() {
      if (state.pending) throw new Error("上一轮还没结束");
      const last = state.turns[state.turns.length - 1];
      if (last?.status === "failed") return run(last.id);
      if (last?.status === "done" && last.check?.remaining.length) return run(addTurn({ kind: "retry", text: "", attachments: [] }));
      throw new Error("上一轮没有失败，不需要重试");
    },
    stop() {
      const controller = inFlight;
      if (!controller) return;
      inFlight = undefined;
      controller.abort();
      set({
        pending: false,
        turns: state.turns.map((t) => (t.status === "pending" ? { ...t, status: "stopped" } : t)),
      });
    },
    select(n) {
      if (!Number.isInteger(n) || n < 1 || n > state.versions.length) throw new RangeError(`没有草稿 v${n}`);
      set({ current: n });
    },
    toJSON: () => ({
      v: 1,
      turns: state.turns.map((t) => (t.status === "pending" ? { ...t, status: "stopped" } : t)),
      versions: [...state.versions],
      current: state.current,
    }),
  };
}

const STATUSES: readonly string[] = ["pending", "done", "failed", "stopped"];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isTurn(v: unknown): v is Turn {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.at === "number" &&
    (v.kind === "message" || v.kind === "retry") &&
    typeof v.text === "string" &&
    Array.isArray(v.attachments) &&
    v.attachments.every((a) => typeof a === "string") &&
    typeof v.base === "number" &&
    typeof v.status === "string" &&
    STATUSES.includes(v.status)
  );
}

/** Restores a conversation saved with toJSON(); throws when the data is not one. */
export function fromJSON(data: unknown, opts: ConversationOptions): Conversation {
  const ok =
    isRecord(data) &&
    data.v === 1 &&
    Array.isArray(data.turns) &&
    data.turns.every(isTurn) &&
    Array.isArray(data.versions) &&
    data.versions.every((v, i) => isRecord(v) && v.n === i + 1 && typeof v.turn === "string" && "draft" in v) &&
    Number.isInteger(data.current) &&
    (data.current as number) >= 0 &&
    (data.current as number) <= data.versions.length;
  if (!ok) throw new TypeError("不是有效的对话记录");
  const saved = data as unknown as SavedConversation;
  return createConversation(opts, {
    v: 1,
    turns: saved.turns.map((t) => (t.status === "pending" ? { ...t, status: "stopped" } : t)),
    versions: saved.versions,
    current: saved.current,
  });
}
