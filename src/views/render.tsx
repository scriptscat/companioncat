import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { elementOf, isElementHandle, renderTemplate, type Scope } from "../core/expr";
import { POSITIONS, withVars } from "../core/rules/positions";
import type { Position } from "../core/expr";
import { engineTarget } from "../shell/targets";
import { Btn, IconBtn, Picker, TipProvider, cn } from "../ui";
import { AutoView } from "./auto";
import { iconFor } from "./icons";
import type { Node, OnAction, ResultItem, ViewAction, ViewOptions } from "./types";
import { useRendered } from "./useRendered";

const MAX_DEPTH = 12;

const act = (ctx: Ctx, action: unknown, extra?: Scope) => ctx.run(action, ctx.scope, ctx.pos, extra);

interface Ctx {
  scope: Scope;
  pos: Position;
  opts: ViewOptions;
  run: (action: unknown, scope: Scope, pos: Position, extra?: Scope) => void;
  depth: number;
}

async function defaultClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const gm = (globalThis as { GM_setClipboard?: (t: string) => void }).GM_setClipboard;
  if (!gm) throw new Error("no clipboard");
  gm(text);
}

const asArray = (v: unknown): Node[] => (Array.isArray(v) ? (v as Node[]) : v ? [v as Node] : []);

function ViewError({ message }: { message: string }) {
  return (
    <p role="alert" className="text-[12.5px] text-berry">
      {message}
    </p>
  );
}

function Children({ nodes, ctx }: { nodes: Node[]; ctx: Ctx }) {
  return nodes.map((n, i) => <NodeView key={i} node={n} ctx={ctx} />);
}

function toOptions(v: unknown): { value: string; label: string }[] {
  if (Array.isArray(v)) return v.map((o) => (typeof o === "object" && o ? { value: String((o as Node).value), label: String((o as Node).label ?? (o as Node).value) } : { value: String(o), label: String(o) }));
  if (v && typeof v === "object") return Object.entries(v).map(([value, label]) => ({ value, label: String(label) }));
  return [];
}

function Leaf({ node, ctx }: { node: Node; ctx: Ctx }) {
  const type = node.type as string;
  const r = useRendered<Node>({ value: node.value, style: node.style, label: node.label, options: node.options }, ctx.scope, ctx.pos);
  const v = r.value ?? {};
  const label = v.label === undefined ? "" : String(v.label);
  switch (type) {
    case "text": {
      const style = v.style === undefined ? undefined : String(v.style);
      const tone = (node.tone as string | undefined) ?? "default";
      return (
        <span
          data-part="text"
          data-tone={tone}
          data-style={style}
          data-expr-error={r.error?.message}
          className={cn(
            "text-[13px]",
            tone === "muted" && "text-ink-3",
            tone === "danger" && "text-berry",
            tone === "success" && "text-leaf",
            tone === "default" && "text-ink",
            style === "reading" && "font-read text-[14.5px] leading-[1.7]",
            style === "reading-lg" && "font-read text-[17px] leading-[1.75]",
          )}
        >
          {v.value === undefined || v.value === null ? "" : node.format === "percent" && typeof v.value === "number" ? `${Math.round(v.value * 100)}%` : String(v.value)}
        </span>
      );
    }
    case "icon": {
      const Icon = iconFor(node.name);
      return <Icon className="size-3.5 text-ink-3" aria-hidden="true" />;
    }
    case "icon-button":
      return <IconBtn icon={iconFor(node.icon)} size={30} label={label} onClick={() => act(ctx, node.action)} />;
    case "button": {
      const Icon = node.icon ? iconFor(node.icon) : null;
      const open = Boolean((node.action as Node | undefined)?.open);
      return (
        <Btn size="xs" variant={open ? "soft" : "plain"} onClick={() => act(ctx, node.action)}>
          {Icon && <Icon />}
          {label}
        </Btn>
      );
    }
    case "select": {
      const options = toOptions(v.options);
      return (
        <Picker
          compact
          label={label || "选择"}
          value={v.value === undefined ? "" : String(v.value)}
          options={options}
          onValueChange={(value) => act(ctx, node.onChange, { value })}
        />
      );
    }
  }
  return null;
}

function Dots() {
  return (
    <span className="cc-dots flex gap-1 py-2" aria-label="正在加载" data-part="dots">
      <i className="size-1.5 rounded-full bg-ink-3" />
      <i className="size-1.5 rounded-full bg-ink-3" />
      <i className="size-1.5 rounded-full bg-ink-3" />
    </span>
  );
}

/** The built-in item states, for rules that leave out `item` views (R9.11). */
function ItemBody({ item, primary, node, ctx }: { item: ResultItem; primary: boolean; node: Node; ctx: Ctx }) {
  const views = (node.item ?? {}) as Record<string, Node | undefined>;
  const showLoading = item.state === "loading" || (item.state === "streaming" && item.output === undefined);
  const view = showLoading ? views.loading : item.state === "streaming" ? views.ok : views[item.state];
  if (view) return <NodeView node={view} ctx={ctx} />;
  if (showLoading) return <Dots />;
  if (item.state === "error")
    return (
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-[13px] text-berry">{item.error?.message ?? "出错了"}</p>
        <Btn size="xs" variant="plain" onClick={() => act(ctx, { retry: item.engine })}>
          重试
        </Btn>
      </div>
    );
  if (item.state === "needKey")
    return (
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-[13px] text-ink-3">还没填 API Key</p>
        <Btn size="xs" variant="soft" onClick={() => act(ctx, { open: engineTarget(item.engine) })}>
          填 Key
        </Btn>
      </div>
    );
  return (
    <div className={primary ? "font-read text-[17px] leading-[1.75]" : "text-[14px]"}>
      <AutoView value={item.output} />
    </div>
  );
}

function ResultItemView({ item, primary, node, ctx }: { item: ResultItem; primary: boolean; node: Node; ctx: Ctx }) {
  const itemCtx: Ctx = {
    ...ctx,
    pos: withVars(ctx.pos, "item"),
    scope: { ...ctx.scope, item: { ...item, engineName: item.engineName ?? item.engine, cached: item.cached ?? false, primary } },
  };
  const done = item.state === "ok" || item.state === "streaming";
  const actions = (node.itemActions ?? []) as Node[];
  const extras = useRendered<{ meta: unknown[]; labels: unknown[] }>(
    { meta: node.meta ?? [], labels: actions.map((a) => a.label) },
    itemCtx.scope,
    itemCtx.pos,
  ).value;
  const meta = (extras?.meta ?? []).map(String).filter(Boolean);
  const showFooter = done && (meta.length > 0 || actions.length > 0);
  return (
    <div
      data-part="result-item"
      data-engine={item.engine}
      data-state={item.state}
      data-primary={String(primary)}
      aria-busy={item.state === "loading" || item.state === "streaming" ? true : undefined}
      className={primary ? "px-4 pb-3" : "px-4 py-2.5"}
    >
      {!primary && (item.engineName ?? item.engine) !== "" && <p className="mb-0.5 text-[12.5px] text-ink-3">{item.engineName ?? item.engine}</p>}
      <ItemBody item={item} primary={primary} node={node} ctx={itemCtx} />
      {showFooter && (
        <div className="mt-1 flex items-center gap-2 text-[12.5px] text-ink-3">
          {meta.map((m, i) => (
            <span key={i} className={i === 0 ? "font-semibold text-ink-2" : undefined}>
              {m}
            </span>
          ))}
          <span className="flex-1" />
          {actions.map((a, i) => (
            <IconBtn key={i} icon={iconFor(a.icon)} size={28} label={String(extras?.labels[i] ?? "")} onClick={() => act(itemCtx, a.action)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ResultList({ node, ctx }: { node: Node; ctx: Ctx }) {
  const list = useRendered<unknown>(node.from, ctx.scope, ctx.pos).value;
  const items = Array.isArray(list) ? (list as ResultItem[]) : [];
  const primaryFirst = node.primary !== "none";
  const [first, ...rest] = items;
  return (
    <div data-part="result-list">
      {primaryFirst && first && <ResultItemView item={first} primary node={node} ctx={ctx} />}
      {(primaryFirst ? rest : items).length > 0 && (
        <div className={cn("pt-1 pb-3", primaryFirst && "border-t border-line bg-paper")}>
          {(primaryFirst ? rest : items).map((it) => (
            <ResultItemView key={it.engine} item={it} primary={false} node={node} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A row; with an `action` the whole row is a button (a quiz row scrolls to its question), and `style: below` marks a below-threshold row. */
function Row({ node, ctx }: { node: Node; ctx: Ctx }) {
  const style = useRendered<Node>({ style: node.style }, ctx.scope, ctx.pos).value?.style;
  const kind = style === undefined ? undefined : String(style);
  const clickable = Boolean(node.action);
  const kids = <Children nodes={asArray(node.children)} ctx={ctx} />;
  const className = cn("flex w-full items-center gap-2", clickable && "rounded-xl px-2.5 py-2 text-left hover:bg-sunken", kind === "below" && "bg-ginger-soft/70 hover:bg-ginger-soft");
  return clickable ? (
    <button type="button" data-part="row" data-style={kind || undefined} className={className} onClick={() => act(ctx, node.action)}>
      {kids}
    </button>
  ) : (
    <div data-part="row" data-style={kind || undefined} className={className}>
      {kids}
    </div>
  );
}

function UseView({ node, ctx }: { node: Node; ctx: Ctx }) {
  const id = String(node.use);
  const params = useRendered<Node>(node.with ?? {}, ctx.scope, ctx.pos);
  const tpl = ctx.opts.views?.[id] as Node | null | undefined;
  if (ctx.depth >= MAX_DEPTH) return <ViewError message={`视图 ${id} 嵌套太深，可能是循环引用`} />;
  if (!tpl) return <ViewError message={`找不到视图 ${id}`} />;
  if (!params.value) return null;
  const inner: Ctx = { ...ctx, scope: { params: params.value }, pos: POSITIONS.viewTemplate, depth: ctx.depth + 1 };
  return <NodeView node={tpl} ctx={inner} />;
}

function NodeView({ node, ctx }: { node: Node; ctx: Ctx }): ReactNode {
  if ("use" in node) return <UseView node={node} ctx={ctx} />;
  const deeper = { ...ctx, depth: ctx.depth + 1 };
  if (ctx.depth >= MAX_DEPTH) return <ViewError message="视图嵌套太深" />;
  switch (node.type) {
    case "card":
      return (
        <div data-part="card" className="rounded-[24px] bg-fur">
          {asArray(node.header).length > 0 && (
            <div data-part="header" className="relative flex h-12 items-center gap-1 pr-2 pl-4">
              <Children nodes={asArray(node.header)} ctx={deeper} />
            </div>
          )}
          <div data-part="body">
            <Children nodes={asArray(node.body)} ctx={deeper} />
          </div>
        </div>
      );
    case "row":
      return <Row node={node} ctx={deeper} />;
    case "spacer":
      return <span data-part="spacer" className="flex-1" />;
    case "dots":
      return <Dots />;
    case "result-list":
      return <ResultList node={node} ctx={deeper} />;
    default:
      return <Leaf node={node} ctx={deeper} />;
  }
}

function Root({ node, scope, onAction, opts }: { node: Node | null | undefined; scope: Scope; onAction: OnAction; opts: ViewOptions }) {
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const latest = useRef({ onAction, opts });
  latest.current = { onAction, opts };

  const run = useCallback((action: unknown, s: Scope, pos: Position, extra: Scope = {}) => {
    if (!action) return;
    const say = (m: string) => {
      setNotice(m);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setNotice(null), 1800);
    };
    // Actions are evaluated when triggered, so they always see the current scope and `value`.
    renderTemplate(action, { ...s, ...extra }, withVars(pos, "item", "value")).then(
      async (resolved) => {
        const a = resolved as ViewAction;
        if ("copy" in a) {
          try {
            await (latest.current.opts.clipboard ?? defaultClipboard)(String(a.copy));
            say("已复制");
          } catch {
            say("复制失败");
          }
        }
        if ("scrollTo" in a && isElementHandle(a.scrollTo)) {
          const el = elementOf(a.scrollTo);
          if (el.isConnected) el.scrollIntoView?.({ behavior: "smooth", block: "center" });
        }
        latest.current.onAction(a);
      },
      () => {},
    );
  }, []);

  const ctx: Ctx = { scope, pos: POSITIONS.view, opts, run, depth: 0 };
  return (
    <TipProvider>
      {node ? (
        <NodeView node={node} ctx={ctx} />
      ) : opts.outputSchema !== undefined ? (
        <AutoView value={(scope as { result?: unknown }).result} schema={opts.outputSchema} />
      ) : null}
      {notice && (
        <span role="status" className="text-[12.5px] text-ink-3">
          {notice}
        </span>
      )}
    </TipProvider>
  );
}

/** Renders a view node (or, without one, the auto view of `opts.outputSchema` over `scope.result`). */
export function renderView(node: Node | null | undefined, scope: Scope, onAction: OnAction, opts: ViewOptions = {}): ReactNode {
  return <Root node={node} scope={scope} onAction={onAction} opts={opts} />;
}
