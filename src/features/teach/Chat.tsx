// 「教小猫做件事」面板的左半边：多轮对话、输入框、点选元素（R6.1–R6.4、R6.9、R6.11）。
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronRight,
  CircleAlert,
  Crosshair,
  Info,
  Send,
  Square,
  X,
} from "lucide-react";
import { ERROR_TYPES } from "../../core/errors";
import { Btn, Cat, cn } from "../../ui";
import type { ConversationState, Turn } from "./conversation";
import {
  describePicked,
  openPicker,
  removeAttachment,
  type Attachment,
} from "./Picker";

/** The chat engine the conversation will use, as far as the panel knows (R6.2). */
export type EngineInfo =
  | {
      status: "ready";
      name: string;
      /** undefined until the hosts are resolved. */ hosts?: string[];
    }
  | { status: "missing" };

export interface ChatProps {
  state: ConversationState;
  engine: EngineInfo;
  /** The one-time first-use notice is still to be shown. */
  showNotice: boolean;
  layer: HTMLElement;
  onSend(text: string, attachments: readonly string[]): void;
  onStop(): void;
  onRetry(): void;
  /** 「草稿 vN 看右边」: show that version in the draft side. */
  onViewDraft(version: number): void;
  onOpenEngines(): void;
  /** Extra controls under a cat reply (the draft side's 「让小猫再试」 / 「自己改」). */
  turnFooter?: (turn: Turn) => ReactNode;
}

/** A short chip text for an outline the user picked: `<a …>下一页</a>` → a 「下一页」. */
function outlineChip(outline: string): { tag: string; text: string } {
  const tag = /^\s*<([a-zA-Z][\w-]*)/.exec(outline)?.[1] ?? "";
  const text = outline
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { tag, text: text.length > 20 ? `${text.slice(0, 20)}…` : text };
}

function Chip({
  label,
  tag,
  onRemove,
}: {
  label: string;
  tag?: string;
  onRemove?: () => void;
}) {
  return (
    <span className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border-[1.5px] border-line bg-fur pr-1 pl-2 text-[11.5px]">
      <Crosshair className="size-3 shrink-0 text-ginger-ink" />
      {tag && (
        <span className="truncate font-code text-[10.5px] text-ink-2">
          {tag}
        </span>
      )}
      <span className="truncate text-ink">{label}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`去掉 ${label}`}
          onClick={onRemove}
          className="flex size-4 items-center justify-center rounded-full text-ink-3 hover:bg-sunken"
        >
          <X className="size-3" />
        </button>
      ) : (
        <span className="w-1" />
      )}
    </span>
  );
}

function Notice({
  engine,
}: {
  engine: Extract<EngineInfo, { status: "ready" }>;
}) {
  return (
    <div className="rounded-2xl bg-ginger-soft px-3.5 py-3 text-[12.5px] leading-relaxed">
      <p className="flex items-center gap-1.5 font-semibold text-ginger-ink">
        <Info className="size-3.5" />
        第一次用，先说清楚
      </p>
      <p className="mt-1 text-ink-2">
        小猫不会自己读网页。它只看得到：你写的话、你点选的元素的精简结构（不含输入框里的内容）、这个网页的地址和标题。这些连同当前草稿、规则格式说明和一个范例，每轮都会发给你的对话引擎{" "}
        {engine.name}
        {engine.hosts?.length ? (
          <>
            （
            <span className="font-code font-semibold text-ink">
              {engine.hosts.join("、")}
            </span>
            ）
          </>
        ) : null}
        。
      </p>
    </div>
  );
}

function Missing({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="rounded-2xl bg-berry-soft px-3.5 py-3 text-[12.5px] leading-relaxed">
      <p className="flex items-center gap-1.5 font-semibold text-berry">
        <CircleAlert className="size-3.5" />
        还没有可用的对话引擎
      </p>
      <p className="mt-1 text-ink-2">
        小猫要靠对话引擎才能帮你写规则。先去引擎页给一个对话引擎填上
        Key，再回来。
      </p>
      <Btn size="xs" variant="soft" className="mt-2" onClick={onOpen}>
        去引擎页填 Key
      </Btn>
    </div>
  );
}

function Problems({ turn }: { turn: Turn }) {
  const check = turn.check;
  if (!check || check.found.length === 0) return null;
  const left = check.remaining;
  return (
    <div className="mt-2 rounded-xl border-[1.5px] border-line bg-fur px-3 py-2 text-[12.5px]">
      <p
        className={cn(
          "flex items-center gap-1.5",
          left.length ? "text-berry" : "text-leaf",
        )}
      >
        {left.length
          ? `校验发现 ${check.found.length} 处问题，还剩 ${left.length} 处没修好`
          : `校验发现 ${check.found.length} 处问题，已修好`}
      </p>
      {left.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1 rounded-lg bg-berry-soft px-2.5 py-2">
          {left.map((p) => (
            <li
              key={`${p.path}|${p.message}`}
              className="leading-snug text-ink"
            >
              <code className="block font-code text-[11px] font-semibold text-berry">
                {p.path || "（整个草稿）"}
              </code>
              {p.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface CatProps {
  turn: Turn;
  last: boolean;
  pending: boolean;
  onSay(text: string): void;
  onPick(): void;
  onRetry(): void;
  onViewDraft(version: number): void;
  footer?: ReactNode;
}

function CatMessage({
  turn,
  last,
  pending,
  onSay,
  onPick,
  onRetry,
  onViewDraft,
  footer,
}: CatProps) {
  const reply = turn.reply;
  let body: ReactNode = null;
  if (turn.status === "pending") {
    body = (
      <span className="flex items-center gap-2 text-[12.5px] text-ink-3">
        <span className="cc-dots inline-flex gap-1" aria-hidden="true">
          <i className="size-1.5 rounded-full bg-ink-3" />
          <i className="size-1.5 rounded-full bg-ink-3" />
          <i className="size-1.5 rounded-full bg-ink-3" />
        </span>
        小猫在想，写好后会先自己校验
      </span>
    );
  } else if (turn.status === "stopped") {
    body = <p className="text-[12.5px] text-ink-3">已停下</p>;
  } else if (turn.status === "failed") {
    const type = turn.error?.type;
    body = (
      <div role="alert" className="text-[13px]">
        <p className="flex items-center gap-1.5 font-semibold text-berry">
          <CircleAlert className="size-3.5 shrink-0" />
          {type ? ERROR_TYPES[type].title : "出错了"}
        </p>
        <p className="mt-0.5 text-ink-2">{turn.error?.message}</p>
        {last && !pending && (
          <Btn size="xs" className="mt-2" onClick={onRetry}>
            重试
          </Btn>
        )}
      </div>
    );
  } else if (reply) {
    body = (
      <>
        {reply.message && (
          <p className="whitespace-pre-wrap">{reply.message}</p>
        )}
        {reply.questions && reply.questions.length > 0 && (
          <ol className="mt-2 flex flex-col gap-2.5">
            {reply.questions.map((q, i) => (
              <li key={q.text} className="rounded-xl bg-fur px-3 py-2">
                <p className="text-[13px] font-semibold">
                  {i + 1}. {q.text}
                </p>
                {q.quickReplies && q.quickReplies.length > 0 && (
                  <span className="mt-1.5 flex flex-wrap gap-1.5">
                    {q.quickReplies.map((t) => (
                      <Btn
                        key={t}
                        size="xs"
                        variant="outline"
                        disabled={pending}
                        onClick={() => onSay(t)}
                      >
                        {t}
                      </Btn>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
        {reply.askPick && (
          <div className="mt-2 rounded-xl bg-fur px-3 py-2">
            <p className="text-[13px] font-semibold">{reply.askPick.text}</p>
            <Btn
              size="xs"
              variant="soft"
              className="mt-1.5"
              disabled={pending}
              onClick={onPick}
            >
              <Crosshair />
              去点选
            </Btn>
          </div>
        )}
        <Problems turn={turn} />
        {turn.version !== undefined && (
          <button
            type="button"
            onClick={() => onViewDraft(turn.version!)}
            className="mt-2 flex w-full items-center gap-1.5 rounded-xl border-[1.5px] border-line bg-fur px-3 py-2 text-left text-[12.5px] font-semibold text-ink hover:text-ginger-ink"
          >
            草稿 v{turn.version}
            <span className="font-normal text-ink-3">看右边</span>
            <ChevronRight className="ml-auto size-3.5 text-ink-3" />
          </button>
        )}
      </>
    );
  }
  return (
    <div className="flex gap-2 pr-6">
      <Cat size={28} awake className="-mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-paper px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink">
        {body}
        {footer}
      </div>
    </div>
  );
}

export function Chat({
  state,
  engine,
  showNotice,
  layer,
  onSend,
  onStop,
  onRetry,
  onViewDraft,
  onOpenEngines,
  turnFooter,
}: ChatProps) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Attachment[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const missing = engine.status === "missing";
  const pending = state.pending;

  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.turns]);

  /** The open picker: one at a time, and it closes with the panel. */
  const picker = useRef<AbortController | null>(null);
  useEffect(() => () => picker.current?.abort(), []);
  const pick = async () => {
    picker.current?.abort();
    const ctrl = (picker.current = new AbortController());
    const handles = await openPicker({ layer, signal: ctrl.signal });
    if (picker.current === ctrl) picker.current = null;
    const added = await describePicked(handles);
    if (added.length)
      setPicked((cur) => [
        ...cur,
        ...added.filter((a) => !cur.some((c) => c.handle === a.handle)),
      ]);
  };
  const canSend =
    !missing && !pending && (text.trim() !== "" || picked.length > 0);
  const send = () => {
    if (!canSend) return;
    onSend(
      text.trim(),
      picked.map((a) => a.outline),
    );
    setText("");
    setPicked([]);
  };
  const lastIndex = state.turns.length - 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={list}
        className="cc-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        <div className="flex flex-col gap-3">
          {missing && <Missing onOpen={onOpenEngines} />}
          {!missing && showNotice && <Notice engine={engine} />}
          {state.turns.length === 0 && !missing && (
            <div className="flex gap-2 pr-6">
              <Cat size={28} awake className="-mt-0.5 shrink-0" />
              <p className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-paper px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink">
                想让我在这个网站帮你做什么？说一句话就行。我不会自己读网页，需要我看哪个元素，你点给我。
              </p>
            </div>
          )}
          {state.turns.map((t, i) => (
            <div key={t.id} className="flex flex-col gap-3">
              {t.kind === "message" && (
                <div className="flex flex-col items-end gap-1 pl-10">
                  {t.text && (
                    <p className="rounded-2xl rounded-tr-md bg-patch px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-on-patch">
                      {t.text}
                    </p>
                  )}
                  {t.attachments.length > 0 && (
                    <span className="flex flex-wrap justify-end gap-1">
                      {t.attachments.map((o, j) => {
                        const c = outlineChip(o);
                        return (
                          <Chip
                            key={j}
                            tag={c.tag}
                            label={c.text ? `「${c.text}」` : "元素"}
                          />
                        );
                      })}
                    </span>
                  )}
                </div>
              )}
              <CatMessage
                turn={t}
                last={i === lastIndex}
                pending={pending}
                onSay={(s) => onSend(s, [])}
                onPick={() => void pick()}
                onRetry={onRetry}
                onViewDraft={onViewDraft}
                footer={
                  i === lastIndex && t.status !== "pending"
                    ? turnFooter?.(t)
                    : undefined
                }
              />
            </div>
          ))}
        </div>
      </div>
      <div className="shrink-0 border-t border-line px-3 pt-2.5 pb-3">
        {picked.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {picked.map((a, i) => (
              <Chip
                key={i}
                label={a.label}
                onRemove={() =>
                  setPicked((cur) => removeAttachment(cur, a.handle))
                }
              />
            ))}
          </div>
        )}
        <textarea
          aria-label="和小猫说"
          value={text}
          disabled={missing}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder="说说想让小猫做什么，或者回答它的问题"
          className="w-full resize-none rounded-2xl border-[1.5px] border-line bg-fur px-3 py-2 text-[13.5px] leading-relaxed text-ink placeholder:text-ink-3 hover:border-line-strong focus:border-ink focus:outline-none disabled:opacity-60"
        />
        <div className="mt-2 flex items-center gap-2">
          <Btn
            size="xs"
            variant="outline"
            disabled={missing || pending}
            onClick={() => void pick()}
          >
            <Crosshair />
            点选元素
          </Btn>
          <span className="flex-1 truncate text-[11.5px] text-ink-3">
            {pending ? "小猫在写，可以随时停下" : "小猫只看你写的和你点选的"}
          </span>
          {pending ? (
            <Btn size="sm" variant="outline" onClick={onStop}>
              <Square className="fill-current" />
              停下
            </Btn>
          ) : (
            <Btn size="sm" disabled={!canSend} onClick={send}>
              <Send />
              发送
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}
