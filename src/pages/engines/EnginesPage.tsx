import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { effectiveOptions, resolveHosts, unavailableReason } from "../../core/impl";
import { LOCAL_PACK_ID } from "../../core/rules";
import type { Resolved, ResolvedProvider } from "../../core/rules/types";
import type { SecretStore } from "../../core/stores";
import { engineOfTarget, useShell } from "../../shell";
import { Btn, Cat, cn, Dot, Monogram, Section, SettingRow, Tag, Toggle } from "../../ui";
import { contractsOf } from "./keys";
import { KeyPanel, card } from "./KeyPanel";
import { OptionsSection } from "./OptionsForm";
import { engineServices } from "./services";
import { EngineTraceSlot } from "./slot";
import { useAsync } from "./useAsync";

type Status = "ok" | "needKey" | "problem";

/** Why the engine cannot run anything at all: rule errors (R2.6), or only unsupported builtins (R5.4). */
function problemsOf(p: ResolvedProvider): string[] {
  if (!p.enabled) return p.problems.length ? p.problems.map((d) => d.message) : ["规则有错误"];
  const contracts = Object.keys(p.def.implements ?? {});
  const reasons = contracts.map((c) => unavailableReason(p, c));
  return contracts.length && reasons.every((r) => r !== null) ? [...new Set(reasons as string[])] : [];
}

function statusOf(p: ResolvedProvider, secrets: SecretStore): Status {
  if (problemsOf(p).length) return "problem";
  return secrets.lookup(p.ref).missing.length ? "needKey" : "ok";
}

const GROUPS: { status: Status; title: string }[] = [
  { status: "ok", title: "可以用" },
  { status: "needKey", title: "填上 API Key 就能用" },
  { status: "problem", title: "有问题" },
];

const sourceOf = (p: ResolvedProvider) => (p.pack === LOCAL_PACK_ID ? "你的本地规则" : `规则包「${p.pack}」`);

function subtitle(p: ResolvedProvider, status: Status, secrets: SecretStore, r: Resolved): string {
  if (status === "problem") return problemsOf(p)[0]!;
  const lookup = secrets.lookup(p.ref);
  if (status === "needKey") {
    const label = p.def.secrets?.find((s) => s.helpLabel)?.helpLabel;
    return label ? `去 ${label} 申请` : "还没有填 Key";
  }
  if (lookup.inherited) return `和 ${nameOf(lookup.from, r)} 共用 Key`;
  if (!p.def.secrets?.length) return p.def.description ?? "免费，不用 Key";
  const model = p.def.options?.model?.default;
  return typeof model === "string" ? model : (p.def.description ?? "");
}

/** "甲"、"甲和乙"、"甲、乙和丙". */
const listNames = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join("、")}和${names.at(-1)}` : (names[0] ?? ""));

/** A rule with errors may lack its name (R2.6): fall back to the id so the page still renders. */
const titleOf = (p: ResolvedProvider) => p.def.name || p.id;
const nameOf = (ref: string, r: Resolved) => {
  const p = r.providers.find((x) => x.ref === ref);
  return p ? titleOf(p) : (ref.split("/").pop() ?? ref);
};

export function EnginesPage({ narrow, target }: { narrow?: boolean; target?: string }) {
  const shell = useShell();
  const { storage } = shell.services;
  const resolved = shell.resolved;
  const { secrets } = engineServices(shell.services);
  const [selected, setSelected] = useState<string | undefined>(() => engineOfTarget(target));
  // opened (again) at `engine:<ref>`, e.g. from a card's 「填 Key」 (R10.5)
  useEffect(() => {
    const ref = engineOfTarget(target);
    if (ref) setSelected(ref);
  }, [target]);
  const [, bump] = useState(0);
  useEffect(() => storage.onChange(() => bump((n) => n + 1)), [storage]);

  const chosen = resolved.providers.find((p) => p.ref === selected);
  const list = (
    <div className="cc-scroll h-full overflow-y-auto px-3 pb-4">
      {GROUPS.map((g) => {
        const items = resolved.providers.filter((p) => statusOf(p, secrets) === g.status);
        if (!items.length) return null;
        return (
          <div key={g.status} role="group" aria-label={g.title} className="mb-3">
            <h3 className="px-3 pt-2 pb-1.5 text-[12.5px] font-semibold text-ink-3">{g.title}</h3>
            {items.map((p) => (
              <button
                key={p.ref}
                type="button"
                aria-current={selected === p.ref || undefined}
                onClick={() => setSelected(p.ref)}
                className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors", selected === p.ref ? "bg-fur ring-[1.5px] ring-ink" : "hover:bg-sunken")}
              >
                <Monogram letter={titleOf(p).slice(0, 1)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold">{titleOf(p)}</span>
                  <span className="block truncate text-[12.5px] text-ink-3">{subtitle(p, g.status, secrets, resolved)}</span>
                </span>
                <Dot tone={g.status === "ok" ? (secrets.isDisabled(p.ref) ? "off" : "leaf") : g.status === "needKey" ? "ginger" : "berry"} />
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );

  // R13.4 首次打开 (mockup v5 firstRun): free engines work, no key is filled anywhere yet
  const keyed = resolved.providers.filter((p) => (p.def.secrets?.length ?? 0) > 0 || secrets.lookup(p.ref).inherited);
  const free = resolved.providers.filter((p) => statusOf(p, secrets) === "ok" && !keyed.includes(p));
  const toFill = keyed.find((p) => statusOf(p, secrets) === "needKey");
  const firstRun = free.length > 0 && !!toFill && keyed.every((p) => statusOf(p, secrets) !== "ok");

  const detail = chosen ? (
    <EngineDetail key={chosen.ref} provider={chosen} onSelect={setSelected} />
  ) : firstRun ? (
    <div className="flex h-full flex-col items-center justify-center px-10 pb-10 text-center">
      <Cat size={120} zzz />
      <p className="mt-4 text-[18px] font-bold">选中网页上的文字，就能翻译</p>
      <p className="mt-2 max-w-[340px] text-[13.5px] leading-relaxed text-ink-2">
        {listNames(free.map(titleOf))}现在就能用。想要更通顺的译文，给一个大模型填上 API Key。
      </p>
      <Btn className="mt-5" onClick={() => setSelected(toFill.ref)}>
        给 {titleOf(toFill)} 填 Key
      </Btn>
    </div>
  ) : (
    <div className="flex h-full flex-col items-center justify-center px-10 pb-10 text-center">
      <Cat size={120} zzz />
      <p className="mt-4 text-[18px] font-bold">选一个引擎查看设置</p>
      <p className="mt-2 max-w-[340px] text-[13.5px] leading-relaxed text-ink-2">没有 Key 的引擎先填上 API Key，测试通过就能用了。</p>
    </div>
  );

  if (narrow)
    return chosen ? (
      <div className="flex h-full flex-col">
        <button type="button" onClick={() => setSelected(undefined)} className="flex h-11 shrink-0 items-center gap-0.5 px-3 text-[14px] text-ink-2">
          <ChevronLeft className="size-[18px]" />
          全部引擎
        </button>
        <div className="min-h-0 flex-1">{detail}</div>
      </div>
    ) : (
      <div className="h-full pt-2">{list}</div>
    );

  return (
    <div className="flex h-full">
      <div className="w-[292px] shrink-0">{list}</div>
      <div className="min-w-0 flex-1 border-l border-line">{detail}</div>
    </div>
  );
}

function EngineDetail({ provider: p, onSelect }: { provider: ResolvedProvider; onSelect: (ref: string) => void }) {
  const shell = useShell();
  const { storage } = shell.services;
  const resolved = shell.resolved;
  const { secrets, invoker } = engineServices(shell.services);
  const status = statusOf(p, secrets);
  const lookup = secrets.lookup(p.ref);
  const contracts = contractsOf(p, resolved.contracts);
  const hosts = useAsync(() => resolveHosts(p, effectiveOptions(p)), [p]);
  const stopped = secrets.isDisabled(p.ref);
  const parent = p.ancestors[0];
  const declaresSecrets = (p.def.secrets?.length ?? 0) > 0;
  const shared = lookup.inherited ? resolved.providers.find((x) => x.ref === lookup.from) : undefined;

  return (
    <div className="cc-scroll relative h-full overflow-y-auto px-6 pt-1 pb-8">
      <div className="flex items-center gap-3.5">
        <Monogram letter={titleOf(p).slice(0, 1)} size={48} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[20px] font-bold tracking-tight">{titleOf(p)}</h3>
            {status === "problem" ? <Tag tone="berry">有问题</Tag> : status === "needKey" ? <Tag tone="ginger">还没填 Key</Tag> : stopped ? <Tag tone="plain">已停用</Tag> : <Tag tone="leaf">可以用</Tag>}
          </div>
          <p className="mt-0.5 text-[13px] text-ink-3">来自{sourceOf(p)}</p>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-6">
        {status === "problem" && (
          <div className="rounded-[18px] bg-berry-soft px-4 py-3 text-[13.5px] leading-relaxed text-berry">
            {p.enabled ? `${problemsOf(p).join("；")}。` : `${problemsOf(p).join("；")}。订阅需要的规则包，或者在本地规则里改掉这条继承。`}
          </div>
        )}

        {contracts.length > 0 && (
          <section aria-label="能做什么">
            <Section title="能做什么">
              <ul className="flex flex-wrap gap-2">
                {contracts.map((c) => {
                  const impl = p.def.implements[c.id];
                  const viaLlm = (Array.isArray(impl) ? impl : [impl]).some((i) => i?.via !== undefined);
                  return (
                    <li key={c.id} className="inline-flex h-8 items-center gap-1.5 rounded-full border-[1.5px] border-line bg-fur px-3 text-[13px]">
                      <span className="font-semibold">{c.def.name ?? c.id}</span>
                      {viaLlm && <span className="text-ink-3">由大模型完成</span>}
                    </li>
                  );
                })}
              </ul>
            </Section>
          </section>
        )}

        {status !== "problem" && (declaresSecrets || lookup.inherited) && (
          <Section title="API Key">
            {/* an abstract parent has no page of its own: its children fill the shared key here */}
            {shared ? (
              <div className={cn(card, "p-4")}>
                <p className="text-[13.5px] leading-relaxed text-ink-2">
                  这个引擎基于「{nameOf(lookup.from, resolved)}」，直接用「{nameOf(lookup.from, resolved)}」的 Key，不用再填。
                  <button type="button" onClick={() => onSelect(shared.ref)} className="ml-1 font-semibold text-ginger-ink underline decoration-ginger/50 underline-offset-[3px]">
                    改 {titleOf(shared)} 的 Key
                  </button>
                </p>
              </div>
            ) : (
              <KeyPanel provider={p} secrets={secrets} invoker={invoker} contracts={resolved.contracts} />
            )}
          </Section>
        )}

        {status !== "problem" && <OptionsSection provider={p} storage={storage} />}

        {status !== "problem" && (
          <div className={cn(card, "px-4")}>
            <SettingRow label="启用" hint="关掉后，所有功能都不会用它">
              <Toggle aria-label="启用" checked={!stopped && status === "ok"} disabled={status !== "ok"} onCheckedChange={(on) => secrets.setDisabled(p.ref, !on)} />
            </SettingRow>
          </div>
        )}

        {status === "ok" && (
          <Section title="试运行">
            <EngineTraceSlot provider={p} contracts={contracts} invoker={invoker} secrets={secrets} />
          </Section>
        )}

        <section aria-label="规则详情">
          <Section title="规则详情">
            <dl className={cn(card, "divide-y divide-line px-4 text-[13px]")}>
              <Row k="引擎 id">{p.ref}</Row>
              {parent && <Row k="继承自">{parent}</Row>}
              <Row k="请求地址">{hosts?.length ? hosts.map((h) => <span key={h} className="block">{h}</span>) : "（没有）"}</Row>
            </dl>
          </Section>
        </section>
      </div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-2.5">
      <dt className="w-16 shrink-0 text-ink-3">{k}</dt>
      <dd className="min-w-0 font-code break-all">{children}</dd>
    </div>
  );
}
