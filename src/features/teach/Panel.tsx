// 「教小猫做件事」面板（R6.1）：左边对话，右边当前草稿。右边由草稿区（draftPane）提供。
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { X } from "lucide-react";
import v1 from "../../../rules/schema/v1.json";
import { effectiveOptions, resolveHosts } from "../../core/impl";
import type { RuntimeContext } from "../../shell";
import { Btn, Cat, cn, deepActive, IconBtn, TipProvider } from "../../ui";
import { invokerFor } from "../selection/services";
import { Chat, type EngineInfo } from "./Chat";
import {
  createConversation,
  fromJSON,
  validateDraft,
  type Conversation,
  type ConversationState,
  type PageInfo,
  type SavedConversation,
  type Turn,
} from "./conversation";
import {
  discardUnsaved,
  loadConversation,
  loadUnsaved,
  saveUnsaved,
} from "./store";

/** The example feature sent to the AI with the schema (R6.2). */
export const EXAMPLE_FEATURE = {
  id: "example-skip",
  name: "自动点掉「跳过」按钮",
  match: ["*://*/*"],
  entries: [
    {
      id: "skip",
      name: "点掉「跳过」按钮",
      triggers: [{ on: "page-load" }],
      run: [
        { find: "button.skip", as: "skip" },
        { act: "click", target: "{{ vars.skip }}" },
      ],
    },
  ],
};

/** The first-use notice has been shown once. */
const NOTICE_KEY = "cc:teach-notice";
const NARROW = 640;

/** What the draft side (the `draftPane` slot) gets to work with. */
export interface DraftPaneApi {
  ctx: RuntimeContext;
  conversation: Conversation;
  state: ConversationState;
  /** The rule this conversation is saved as, if it has been saved. */
  featureId?: string;
  /** The version that is saved as a rule now; null while none is. */
  savedVersion: number | null;
  /** Call after a successful save: the panel then no longer treats the draft as unsaved. */
  markSaved(featureId: string, version: number): void;
}

export interface TeachSlots {
  /** Right side of the panel. Without it a placeholder is shown. */
  draftPane?: (api: DraftPaneApi) => ReactNode;
  /** Controls under the cat's last reply, e.g. 「让小猫再试」 / 「自己改」 after the repair rounds ran out. */
  turnFooter?: (turn: Turn, api: DraftPaneApi) => ReactNode;
}

export interface PanelProps extends TeachSlots {
  ctx: Pick<RuntimeContext, "layer" | "services" | "openSettings">;
  onClose(): void;
  /** The conversation to continue (saved or unsaved); a new one when absent. */
  saved?: SavedConversation;
  featureId?: string;
  /** The version already saved as a rule, when continuing one. */
  savedVersion?: number | null;
  schema?: unknown;
  example?: unknown;
  page?: () => PageInfo;
  now?: () => number;
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < NARROW);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return narrow;
}

/** The preferred chat engine (R6.2): its name now, its hosts once resolved. */
function useEngine(ctx: PanelProps["ctx"]): EngineInfo {
  const { services } = ctx;
  const using = invokerFor(services).preferredEngines("chat").using;
  const provider =
    using === undefined
      ? undefined
      : services.rules.get().providers.find((p) => p.ref === using);
  const [hosts, setHosts] = useState<string[] | undefined>();
  useEffect(() => {
    setHosts(undefined);
    if (!provider) return;
    let live = true;
    void resolveHosts(provider, effectiveOptions(provider)).then(
      (h) => live && setHosts(h),
    );
    return () => void (live = false);
  }, [provider]);
  return useMemo<EngineInfo>(
    () =>
      provider
        ? { status: "ready", name: provider.def.name, hosts }
        : { status: "missing" },
    [provider, hosts],
  );
}

function Placeholder() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <Cat size={92} zzz />
      <p className="mt-3 text-[15px] font-bold">草稿会出现在这里</p>
      <p className="mt-1.5 max-w-[300px] text-[12.5px] leading-relaxed text-ink-2">
        小猫每写一版，都会先自己校验、改错，再在这个网页上试运行给你看。
      </p>
    </div>
  );
}

export function Panel({
  ctx,
  onClose,
  saved,
  featureId: initialFeatureId,
  savedVersion: initialSaved = null,
  schema = v1,
  example = EXAMPLE_FEATURE,
  page,
  now,
  draftPane,
  turnFooter,
}: PanelProps) {
  const { storage } = ctx.services;
  const narrow = useNarrow();
  const engine = useEngine(ctx);
  const [conversation] = useState<Conversation>(() => {
    const opts = {
      invoker: invokerFor(ctx.services),
      schema,
      example,
      validate: (d: unknown) =>
        validateDraft(d, ctx.services.subscriptions?.sources() ?? []),
      ...(page ? { page } : {}),
      ...(now ? { now } : {}),
    };
    return saved ? fromJSON(saved, opts) : createConversation(opts);
  });
  const state = useSyncExternalStore(
    conversation.subscribe,
    conversation.snapshot,
  );
  // a closed panel shows no reply: the turn still out is not left running
  useEffect(() => () => conversation.stop(), [conversation]);
  const [featureId, setFeatureId] = useState(initialFeatureId);
  const [savedVersion, setSavedVersion] = useState<number | null>(initialSaved);
  const [noticeSeen, setNoticeSeen] = useState(
    () => storage.get(NOTICE_KEY) === true,
  );
  const [confirming, setConfirming] = useState(false);
  const [tab, setTab] = useState<"chat" | "draft">("chat");
  const root = useRef<HTMLDivElement>(null);

  // 没存的草稿：有版本，且正在看的版本不是存成规则的那一版
  const unsaved = state.versions.length > 0 && state.current !== savedVersion;

  // R6.9: keep the unsaved record up to date after each turn
  useEffect(() => {
    if (!state.pending && unsaved)
      saveUnsaved(storage, conversation, {
        ...(featureId !== undefined ? { featureId } : {}),
      });
  }, [state, unsaved, featureId, storage, conversation]);

  // R9.3: focus goes into the panel; back into it when the question is answered
  useEffect(() => {
    if (confirming) return;
    const box = root.current;
    const field = box?.querySelector<HTMLTextAreaElement>(
      "textarea:not(:disabled)",
    );
    (field ?? box)?.focus();
  }, [confirming]);

  const api: DraftPaneApi = {
    ctx: ctx as RuntimeContext,
    conversation,
    state,
    ...(featureId !== undefined ? { featureId } : {}),
    savedVersion,
    markSaved(id, version) {
      setFeatureId(id);
      setSavedVersion(version);
      discardUnsaved(storage);
    },
  };

  const requestClose = () => (unsaved ? setConfirming(true) : onClose());
  const send = (text: string, attachments: readonly string[]) => {
    if (!noticeSeen) {
      storage.set(NOTICE_KEY, true);
      setNoticeSeen(true);
    }
    void conversation.send(text, attachments);
  };
  const viewDraft = (version: number) => {
    conversation.select(version);
    setTab("draft");
  };

  const chat = (
    <Chat
      state={state}
      engine={engine}
      showNotice={!noticeSeen}
      layer={ctx.layer}
      onSend={send}
      onStop={() => conversation.stop()}
      onRetry={() => void conversation.retry()}
      onViewDraft={viewDraft}
      onOpenEngines={() => ctx.openSettings("engines")}
      turnFooter={turnFooter && ((t) => turnFooter(t, api))}
    />
  );
  const side = draftPane ? draftPane(api) : <Placeholder />;

  return (
    <TipProvider>
      <div
        ref={root}
        role="dialog"
        aria-label="教小猫做件事"
        tabIndex={-1}
        className={cn(
          "cc cc-pop sticker fixed z-40 flex flex-col bg-fur outline-none",
          narrow
            ? "inset-0 rounded-none"
            : "top-3 right-4 bottom-[96px] w-[min(880px,calc(100vw-32px))] rounded-[24px]",
        )}
        style={{ transformOrigin: "bottom right" }}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          // handled here: keeps the shell from also acting on this Esc
          e.preventDefault();
          e.stopPropagation();
          requestClose();
        }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line py-2 pr-2 pl-3">
          {!narrow && <Cat size={30} awake />}
          <p className="text-[15px] font-bold whitespace-nowrap">
            教小猫做件事
          </p>
          {!narrow && (
            <span className="truncate text-[12px] text-ink-3">
              {featureId ? (unsaved ? "有改动没存" : "已存") : "新规则"}
            </span>
          )}
          <span className="flex-1" />
          {narrow && (
            <span
              role="tablist"
              className="flex gap-0.5 rounded-full bg-sunken p-0.5 text-[12px]"
            >
              {(["chat", "draft"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "h-6 rounded-full px-2.5 font-semibold whitespace-nowrap",
                    tab === t ? "bg-patch text-on-patch" : "text-ink-2",
                  )}
                >
                  {t === "chat"
                    ? "对话"
                    : state.current
                      ? `草稿 v${state.current}`
                      : "草稿"}
                </button>
              ))}
            </span>
          )}
          <IconBtn icon={X} size={30} label="关闭" onClick={requestClose} />
        </div>
        <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-b-[22px]">
          {narrow ? (
            <div className="min-w-0 flex-1">{tab === "chat" ? chat : side}</div>
          ) : (
            <>
              <div className="min-w-0 flex-1">{chat}</div>
              <div className="w-[min(430px,50%)] shrink-0 border-l border-line bg-fur">
                {side}
              </div>
            </>
          )}
          {confirming && (
            <ConfirmClose
              onKeep={() => setConfirming(false)}
              onLeave={() => onClose()}
              onDiscard={() => {
                discardUnsaved(storage);
                onClose();
              }}
            />
          )}
        </div>
      </div>
    </TipProvider>
  );
}

function ConfirmClose({
  onKeep,
  onLeave,
  onDiscard,
}: {
  onKeep(): void;
  onLeave(): void;
  onDiscard(): void;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => keep.current?.focus(), []);
  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-scrim p-4"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onKeep();
        } else if (e.key === "Tab") {
          const buttons = [
            ...e.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
          ];
          const next =
            buttons[
              (buttons.indexOf(e.target as HTMLButtonElement) +
                (e.shiftKey ? buttons.length - 1 : 1)) %
                buttons.length
            ];
          if (next) {
            e.preventDefault();
            next.focus();
          }
        }
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="tc-t"
        className="cc-pop sticker w-full max-w-[380px] rounded-[24px] bg-fur p-5"
      >
        <h2 id="tc-t" className="text-[16px] font-bold">
          要丢掉这次的草稿吗？
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
          这版草稿还没存进本地规则。先留着的话，之后小猫旁边会有「接着上次没写完的」。
        </p>
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Btn variant="danger" size="sm" onClick={onDiscard}>
            丢掉
          </Btn>
          <Btn variant="outline" size="sm" onClick={onLeave}>
            先留着
          </Btn>
          <Btn ref={keep} size="sm" onClick={onKeep}>
            继续写
          </Btn>
        </div>
      </div>
    </div>
  );
}

export interface TeachOptions extends TeachSlots {
  /** Continue this saved rule's conversation (R6.8). */
  featureId?: string;
  /** Reopen the conversation left unsaved (「接着上次没写完的」, R6.9). */
  resume?: boolean;
}

export interface TeachHandle {
  close(): void;
}

const open = new WeakMap<
  HTMLElement,
  { close(restoreFocus: boolean): void; back: Element | null }
>();

/**
 * Opens the panel in the shell's layer; entry points (the bubble, the rules page, the feature page) call this.
 * One panel per layer: opening again replaces it. Focus goes back where it was when the panel closes (R9.3).
 */
export function openTeachPanel(
  ctx: RuntimeContext,
  opts: TeachOptions = {},
): TeachHandle {
  const { layer } = ctx;
  const { storage } = ctx.services;
  const previous = open.get(layer);
  previous?.close(false);
  const doc = layer.ownerDocument;
  const active = deepActive(doc);
  const back =
    previous?.back ?? (active && active !== doc.body ? active : null);

  let saved: SavedConversation | undefined;
  let featureId = opts.featureId;
  let savedVersion: number | null = null;
  if (opts.resume) {
    const record = loadUnsaved(storage);
    if (record) {
      saved = record.conversation;
      featureId = record.featureId ?? featureId;
    }
  } else if (featureId !== undefined) {
    saved = loadConversation(storage, featureId);
    if (saved) savedVersion = saved.current;
    else featureId = undefined;
  }

  const host = doc.createElement("div");
  layer.append(host);
  const reactRoot = createRoot(host);
  let closed = false;
  const entry = {
    back,
    close(restoreFocus: boolean) {
      if (closed) return;
      closed = true;
      if (open.get(layer) === entry) open.delete(layer);
      reactRoot.unmount();
      host.remove();
      if (restoreFocus && back instanceof HTMLElement && back.isConnected)
        back.focus();
    },
  };
  open.set(layer, entry);
  reactRoot.render(
    <Panel
      ctx={ctx}
      onClose={() => entry.close(true)}
      {...(saved ? { saved } : {})}
      {...(featureId !== undefined ? { featureId } : {})}
      savedVersion={savedVersion}
      draftPane={opts.draftPane}
      turnFooter={opts.turnFooter}
    />,
  );
  return { close: () => entry.close(true) };
}

/** Closes the panel in this layer without moving focus (the shell is going away). */
export function closeTeachPanel(layer: HTMLElement): void {
  open.get(layer)?.close(false);
}
