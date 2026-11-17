import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Copy, FileJson2, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import { checkLocalRules, summarize, type LocalProblem, type PackSummary } from "../../core/rules";
import type { Subscription, SubscriptionManager } from "../../core/subscriptions";
import { Btn, EmptyRules, IconBtn, Menu, Monogram, Section, SettingRow, Tag, TextInput, cn } from "../../ui";
import { useShell } from "../../shell";

/** Where the local rules editor text is kept (one string; empty means no local rules). */
export const LOCAL_RULES_KEY = "cc:rules:local";

export interface Clipboard {
  writeText(text: string): Promise<void> | void;
}

export interface RulesPageProps {
  subscriptions?: SubscriptionManager;
  clipboard?: Clipboard;
}

const card = "rounded-[18px] border-[1.5px] border-line bg-fur";
const nameOf = (s: Subscription) => s.pack.name ?? s.id;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function Scroll({ children, narrow }: { children: ReactNode; narrow: boolean }) {
  return <div className={cn("cc-scroll relative h-full overflow-y-auto pb-8", narrow ? "px-4" : "px-6")}>{children}</div>;
}

function Back({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="-ml-1 inline-flex items-center gap-0.5 self-start text-[14px] text-ink-2 hover:text-ink">
      <ChevronLeft className="size-[18px]" />
      全部规则
    </button>
  );
}

function gives(c: PackSummary["counts"]): string[] {
  return [
    c.features && `${c.features} 个功能（${c.entries} 个入口）`,
    c.providers && `${c.providers} 个引擎`,
    c.settings && `${c.settings} 个设置项`,
    c.quick && `${c.quick} 个气泡开关`,
    c.views && `${c.views} 个视图模板`,
    c.contracts && `${c.contracts} 个契约`,
  ].filter(Boolean) as string[];
}

type View = { kind: "list" } | { kind: "pack"; id: string } | { kind: "local" };

export function RulesPage({ subscriptions, clipboard }: RulesPageProps) {
  const shell = useShell();
  const subs = subscriptions ?? shell.services.subscriptions;
  const [view, setView] = useState<View>({ kind: "list" });
  const [, bump] = useState(0);
  const refresh = useCallback(() => bump((n) => n + 1), []);
  useEffect(() => subs?.onChange(refresh), [subs, refresh]);

  if (view.kind === "local") {
    return <LocalRules subs={subs} onBack={() => setView({ kind: "list" })} />;
  }
  const open = view.kind === "pack" ? subs?.get(view.id) : undefined;
  if (open) return <PackDetail sub={open} narrow={shell.narrow} onBack={() => setView({ kind: "list" })} />;
  return (
    <PackList
      subs={subs}
      clipboard={clipboard ?? (globalThis.navigator?.clipboard as Clipboard | undefined)}
      onChanged={refresh}
      onOpenPack={(id) => setView({ kind: "pack", id })}
      onOpenLocal={() => setView({ kind: "local" })}
    />
  );
}

function PackList({
  subs,
  clipboard,
  onChanged,
  onOpenPack,
  onOpenLocal,
}: {
  subs?: SubscriptionManager;
  clipboard?: Clipboard;
  onChanged: () => void;
  onOpenPack: (id: string) => void;
  onOpenLocal: () => void;
}) {
  const shell = useShell();
  const list = subs?.list() ?? [];
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const hasLocal = !!shell.services.storage.get<string>(LOCAL_RULES_KEY);

  async function add() {
    if (!subs || !url.trim()) return;
    setBusy(true);
    setError(null);
    const r = await subs.subscribe(url.trim());
    setBusy(false);
    if (r.ok) setUrl("");
    else setError(r.errors?.length ? `${r.message}：${r.errors.map((e) => `${e.path} ${e.message}`).join("；")}` : r.message);
    onChanged();
  }
  const check = async (id: string) => {
    await subs?.refresh(id);
    onChanged();
  };
  async function copy(s: Subscription) {
    try {
      await clipboard?.writeText(s.urls[0] ?? "");
      setNotice("已复制订阅地址");
    } catch {
      setNotice("复制失败，请手动复制");
    }
  }

  return (
    <Scroll narrow={shell.narrow}>
      <div className="flex max-w-[640px] flex-col gap-6">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <TextInput placeholder="粘贴规则订阅地址" aria-label="规则订阅地址" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!subs} />
          <Btn type="submit" disabled={!subs || busy || !url.trim()}>
            订阅
          </Btn>
        </form>
        {error && (
          <p role="alert" className="rounded-xl bg-berry-soft px-3 py-2 text-[13px] text-berry">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-[12.5px] text-ink-3">
            {notice}
          </p>
        )}

        {list.length ? (
          <Section
            title="已订阅，排在上面的优先"
            aside={
              <button
                type="button"
                onClick={() => void Promise.all(list.map((s) => subs?.refresh(s.id))).then(onChanged)}
                className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-ginger-ink hover:underline"
              >
                <RefreshCw className="size-3" />
                全部检查更新
              </button>
            }
          >
            <div className="flex flex-col gap-2">
              {list.map((s, i) => {
                const parts = gives(summarize(s.pack).counts);
                return (
                  <div key={s.id} data-testid="pack-row" className={cn(card, "flex items-start gap-3 p-4")}>
                    <button type="button" aria-label={`查看 ${nameOf(s)} 详情`} onClick={() => onOpenPack(s.id)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
                      <Monogram letter={nameOf(s)[0] ?? "?"} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="text-[14.5px] font-semibold">{nameOf(s)}</span>
                          {s.official && <Tag tone="patch">官方</Tag>}
                        </span>
                        <span className="mt-0.5 block text-[12.5px] text-ink-3">
                          {day(s.goodAt)} 更新到 {s.goodVersion ?? s.pack.version}
                        </span>
                        <span className="mt-2 flex flex-wrap gap-1.5">
                          {parts.map((t) => (
                            <Tag key={t} tone="plain">
                              {t}
                            </Tag>
                          ))}
                        </span>
                        {s.error && (
                          <span className="mt-2.5 block rounded-xl bg-ginger-soft px-3 py-2 text-[12.5px] leading-relaxed text-ginger-ink">
                            最近一次更新失败（{s.error.message}），先继续用 {day(s.goodAt)} 的 {s.goodVersion ?? s.pack.version} 版本。
                          </span>
                        )}
                      </span>
                    </button>
                    <Menu
                      trigger={<IconBtn icon={MoreHorizontal} label={`${nameOf(s)} 的更多操作`} />}
                      items={[
                        { label: s.error ? "重试更新" : "检查更新", icon: RefreshCw, onSelect: () => void check(s.id) },
                        { label: "调高优先级", icon: ArrowUp, disabled: i === 0, onSelect: () => (subs?.move(s.id, -1), onChanged()) },
                        { label: "调低优先级", icon: ArrowDown, disabled: i === list.length - 1, onSelect: () => (subs?.move(s.id, 1), onChanged()) },
                        { label: "复制订阅地址", icon: Copy, onSelect: () => void copy(s) },
                        "sep",
                        { label: "取消订阅", icon: Trash2, danger: true, onSelect: () => (subs?.unsubscribe(s.id), onChanged()) },
                      ]}
                    />
                  </div>
                );
              })}
            </div>
          </Section>
        ) : (
          <div className={card}>
            <EmptyRules
              title="还没有订阅任何规则"
              body="陪伴猫本身只是一个外壳。功能、引擎、设置项都来自规则，先订阅官方规则试试。"
              onSubscribe={() => shell.subscribe.run()}
              disabled={!shell.subscribe.available || shell.subscribe.busy}
            />
          </div>
        )}

        <Section title="本地规则">
          <button type="button" onClick={onOpenLocal} className={cn(card, "flex w-full items-center gap-3 p-4 text-left hover:border-line-strong")}>
            <span className="flex size-[34px] items-center justify-center rounded-full bg-sunken text-ink-2">
              <FileJson2 className="size-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14.5px] font-semibold">编辑本地规则</span>
              <span className="block text-[12.5px] text-ink-3">{hasLocal ? "已有本地规则" : "还没有内容"}</span>
            </span>
            <ChevronRight className="size-4 text-ink-3" />
          </button>
        </Section>
      </div>
    </Scroll>
  );
}

function PackDetail({ sub, narrow, onBack }: { sub: Subscription; narrow: boolean; onBack: () => void }) {
  const sum = summarize(sub.pack);
  const List = ({ title, children }: { title: string; children: ReactNode }) => (
    <Section title={title}>
      <div className={cn(card, "px-4")}>{children}</div>
    </Section>
  );
  return (
    <Scroll narrow={narrow}>
      <div className="flex max-w-[680px] flex-col gap-5">
        <Back onClick={onBack} />
        <div className="flex items-center gap-3">
          <Monogram letter={nameOf(sub)[0] ?? "?"} size={44} />
          <div>
            <p className="flex items-center gap-1.5 text-[18px] font-bold">
              {nameOf(sub)}
              {sub.official && <Tag tone="patch">官方</Tag>}
            </p>
            <p className="font-code text-[12px] text-ink-3">
              {sub.id}，{sub.goodVersion ?? sub.pack.version}
            </p>
          </div>
        </div>
        {sum.features.length > 0 && (
          <List title={`功能（${sum.counts.features}）`}>
            {sum.features.map((f) => (
              <div key={f.id}>
                <SettingRow label={f.name} hint={`${f.id}，含 ${f.entries.length} 个入口`}>
                  <span />
                </SettingRow>
                {f.entries.map((e) => (
                  <SettingRow key={e.id} label={e.name} hint={`入口 ${f.id}.${e.id}`}>
                    <span />
                  </SettingRow>
                ))}
              </div>
            ))}
          </List>
        )}
        {sum.providers.length > 0 && (
          <List title={`引擎（${sum.counts.providers}）`}>
            {sum.providers.map((p) => (
              <SettingRow key={p.id} label={p.name} hint={p.id}>
                <span />
              </SettingRow>
            ))}
          </List>
        )}
        {sum.settings.length > 0 && (
          <List title={`设置项（${sum.counts.settings}）`}>
            {sum.settings.map((s) => (
              <SettingRow key={`${s.feature}/${s.entry ?? ""}/${s.key}`} label={s.title} hint={`${s.feature}${s.entry ? `.${s.entry}` : ""} · ${s.key}${s.quick ? " · 放进气泡" : ""}`}>
                <span />
              </SettingRow>
            ))}
          </List>
        )}
        {sum.views.length > 0 && (
          <List title={`视图模板（${sum.counts.views}）`}>
            {sum.views.map((v) => (
              <SettingRow key={v.id} label={v.id} hint={v.description}>
                <span />
              </SettingRow>
            ))}
          </List>
        )}
        {sum.contracts.length > 0 && (
          <List title={`契约（${sum.counts.contracts}）`}>
            {sum.contracts.map((c) => (
              <SettingRow key={c.id} label={c.name ?? c.id} hint={c.id}>
                <span />
              </SettingRow>
            ))}
          </List>
        )}
        <Section title="规则原文">
          <pre data-testid="raw-rules" className="cc-scroll max-h-[420px] overflow-auto rounded-[18px] border-[1.5px] border-line bg-fur p-4 font-code text-[11.5px] leading-[1.65] text-ink-2">
            {JSON.stringify(sub.pack, null, 2)}
          </pre>
        </Section>
      </div>
    </Scroll>
  );
}

function ProblemItem({ p }: { p: LocalProblem }) {
  const warn = p.severity === "warning";
  return (
    <li data-testid="problem" className={cn("rounded-xl px-3 py-2 text-[13px] leading-relaxed", warn ? "bg-ginger-soft text-ginger-ink" : "bg-berry-soft text-berry")}>
      <span className="font-semibold">第 {p.line} 行</span>
      {p.path && <span className="font-code text-[12px]"> · {p.path}</span>}
      <span> · {p.message}</span>
      {p.expr && (
        <>
          <pre data-testid="problem-expr" className="mt-1 overflow-x-auto font-code text-[12px]">{p.expr.template}</pre>
          <pre data-testid="problem-caret" className="overflow-x-auto font-code text-[12px]">
            {" ".repeat(p.expr.start) + "^".repeat(Math.max(1, p.expr.end - p.expr.start))}
          </pre>
        </>
      )}
    </li>
  );
}

function LocalRules({ subs, onBack }: { subs?: SubscriptionManager; onBack: () => void }) {
  const shell = useShell();
  const storage = shell.services.storage;
  const [text, setText] = useState(() => storage.get<string>(LOCAL_RULES_KEY) ?? "");
  const [problems, setProblems] = useState<LocalProblem[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = text.split("\n");

  function save() {
    if (!text.trim()) {
      storage.delete(LOCAL_RULES_KEY);
      setProblems([]);
      setStatus("已保存，本地规则已清空");
      return;
    }
    const r = checkLocalRules(text, subs?.sources() ?? []);
    setProblems(r.problems);
    if (!r.canSave) {
      setStatus("没有保存：先改正下面的错误");
      return;
    }
    storage.set(LOCAL_RULES_KEY, text);
    const errors = r.problems.filter((p) => p.severity === "error").length;
    setStatus(errors ? `已保存。${errors} 处有问题的条目已停用，其他照常生效` : "已保存");
  }
  function format() {
    try {
      setText(JSON.stringify(JSON.parse(text), null, 2));
      setProblems([]);
      setStatus(null);
    } catch {
      setProblems(checkLocalRules(text, subs?.sources() ?? []).problems);
      setStatus("没有整理：JSON 有语法错误");
    }
  }

  return (
    <Scroll narrow={shell.narrow}>
      <div className="flex max-w-[680px] flex-col gap-4">
        <Back onClick={onBack} />
        <p className="text-[13.5px] leading-relaxed text-ink-2">本地规则优先级最高，订阅更新不会覆盖它。API Key 不要写在这里，在引擎页面填写。</p>
        <div className="flex rounded-[18px] border-[1.5px] border-line bg-fur focus-within:border-ink">
          <div
            ref={gutter}
            data-testid="line-numbers"
            aria-hidden="true"
            className="w-10 shrink-0 select-none overflow-hidden whitespace-pre py-4 pr-2 text-right font-code text-[12px] leading-[1.7] text-ink-3"
            style={{ height: "calc(18 * 1.7 * 12px + 32px)" }}
          >
            {lines.map((_, i) => i + 1).join("\n")}
          </div>
          <textarea
            aria-label="本地规则 JSON"
            value={text}
            wrap="off"
            spellCheck={false}
            rows={18}
            onChange={(e) => setText(e.target.value)}
            onScroll={(e) => gutter.current && (gutter.current.scrollTop = e.currentTarget.scrollTop)}
            className="cc-scroll min-w-0 flex-1 resize-none bg-transparent py-4 pr-4 font-code text-[12px] leading-[1.7] whitespace-pre text-ink focus:outline-none"
          />
        </div>
        {status && (
          <p role="status" className="text-[13px] font-semibold text-ink-2">
            {status}
          </p>
        )}
        {problems.length > 0 && (
          <ul className="flex flex-col gap-2">
            {problems.map((p, i) => (
              <ProblemItem key={i} p={p} />
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Btn size="sm" onClick={save}>
            检查并保存
          </Btn>
          <Btn size="sm" variant="plain" onClick={format}>
            整理格式
          </Btn>
        </div>
      </div>
    </Scroll>
  );
}
