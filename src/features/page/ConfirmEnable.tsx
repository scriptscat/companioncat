import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Send } from "lucide-react";
import { effectiveOptions, resolveHosts } from "../../core/impl";
import { LOCAL_PACK_ID } from "../../core/rules";
import { isAutomationEntry } from "../../core/rules/automation";
import type { ActKind, EntryDef, FeatureDef, Resolved, ResolvedEntry, ResolvedFeature } from "../../core/rules/types";
import { createSettingsStore } from "../../core/stores";
import type { PackVersions } from "../../pages/engines/confirm";
import { coreServices, type ShellServices } from "../../shell";
import { Btn, Cat, deepActive } from "../../ui";
import { entryMatch } from "../selection/match";
import { type DescribeCtx, actsOf, describeEntry, sendsOf } from "./describe";
import { consentKey, enableWithConsent, enabledKey, fingerprint } from "./enabled";

/** What the dialog needs from the shell: where to render, the stores and the current site. */
export interface ConsentCtx {
  layer: HTMLElement;
  services: Pick<ShellServices, "storage" | "rules"> & Partial<ShellServices>;
  hostname: string;
}

/** The engines that go first per capability (通用): where an ask without a chosen engine sends (R3.2, R5.1). */
export const preferredOf =
  (services: Pick<ShellServices, "storage" | "rules"> & Partial<ShellServices>) =>
  (contract: string): readonly string[] => {
    try {
      return coreServices(services as ShellServices).invoker.preferredEngines(contract).engines;
    } catch {
      return [];
    }
  };

/** Where app.ts keeps the pack version log (PACK_VERSIONS_KEY); read from storage, as ShellServices does not carry `versions`. */
const PACK_VERSIONS_KEY = "cc:app:pack-versions";

export const packVersions = (storage: ShellServices["storage"]): PackVersions => (id) =>
  storage.get<Record<string, { from?: string; to?: string }>>(PACK_VERSIONS_KEY)?.[id];

/** Every engine's hosts after rendering its templates (resolveHosts), by provider ref. */
export async function providerHosts(resolved: Resolved): Promise<Record<string, string[]>> {
  return Object.fromEntries(await Promise.all(resolved.providers.map(async (p) => [p.ref, await resolveHosts(p, effectiveOptions(p))] as const)));
}

/** The user's current values of the feature's and the entry's settings, by name. */
export function settingValues(storage: ShellServices["storage"], feature: ResolvedFeature, entry: ResolvedEntry, hostname: string): Record<string, unknown> {
  const settings = createSettingsStore(storage);
  const values: Record<string, unknown> = {};
  for (const [owner, defs] of [[feature.ref, feature.def.settings], [entry.ref, entry.def.settings]] as const)
    for (const [name, def] of Object.entries(defs ?? {})) values[name] = settings.get(owner, name, def, def.scope === "site" ? hostname : undefined);
  return values;
}

/** Whether the entry comes from the local pack (R3.4); the resolved entry itself carries no flag. */
export const isLocalEntry = (entry: Pick<ResolvedEntry, "pack">) => entry.pack === LOCAL_PACK_ID;

const ACT_LABEL: Record<ActKind, string> = {
  click: "点击",
  fill: "填写",
  check: "勾选",
  select: "选择",
  scroll: "滚动",
  focus: "聚焦",
  wait: "等待",
};

const ALL_SITES = new Set(["*://*/*", "<all_urls>"]);

function whereText(feature: Pick<FeatureDef, "match">, entry: EntryDef): string {
  const match = entryMatch(feature, entry);
  const all = match.some((m) => ALL_SITES.has(m));
  const hosts = [...new Set(match.map((m) => /^[^:]+:\/\/([^/]+)/.exec(m)?.[1] ?? m))].join("、");
  const perSite = Object.values(entry.settings ?? {}).some((s) => s.type === "boolean" && s.scope === "site");
  return `${all ? "所有网站都能用" : `在 ${hosts} 上生效`}${perSite ? "，但每个网站要在小猫气泡里单独打开" : ""}`;
}

const parts = (fp: string) => {
  const m = /^acts:(.*)\|hosts:(.*)$/.exec(fp);
  return { acts: m?.[1] ?? "", hosts: m?.[2] ?? "" };
};

/** The dialog title: a first time, or what an update changed (R3.3). */
function titleOf(name: string, before: string | undefined, now: string): string {
  if (before === undefined) return `打开「${name}」之前，先看看它会做什么`;
  const a = parts(before);
  const b = parts(now);
  const what = [a.acts !== b.acts && "动作", a.hosts !== b.hosts && "发送地址"].filter(Boolean).join("和");
  return `「${name}」更新后${what || "内容"}变了，要再确认一次`;
}

interface DialogProps {
  feature: ResolvedFeature;
  entry: ResolvedEntry;
  ctx: DescribeCtx;
  before: string | undefined;
  fp: string;
  version: string | undefined;
  done: (ok: boolean) => void;
}

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="flex gap-3 border-t border-line px-4 py-3 first:border-t-0">
    <dt className="w-[70px] shrink-0 pt-px text-[12.5px] whitespace-nowrap text-ink-3">{k}</dt>
    <dd className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-ink">{children}</dd>
  </div>
);

function Dialog({ feature, entry, ctx, before, fp, version, done }: DialogProps) {
  const no = useRef<HTMLButtonElement>(null);
  useEffect(() => no.current?.focus(), []);
  const acts = actsOf(entry.def);
  const doing = describeEntry(feature.def, entry.def, ctx).filter((d) => /\.act\b|minConfidence/.test(d.detail));
  const sends = sendsOf(entry.def, ctx);
  return (
    <div
      className="cc fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // keeps the shell from also closing the window (it ignores a handled Esc)
          e.preventDefault();
          e.stopPropagation();
          done(false);
        } else if (e.key === "Tab") {
          const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
          const at = buttons.indexOf(e.target as HTMLButtonElement);
          const next = buttons[(at + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length];
          if (next) {
            e.preventDefault();
            next.focus();
          }
        }
      }}
    >
      <div role="alertdialog" aria-modal="true" aria-labelledby="ec-t" aria-describedby="ec-d" className="cc-pop sticker w-full max-w-[470px] rounded-[28px] bg-fur p-6">
        <Cat size={64} awake />
        <h2 id="ec-t" className="mt-2 text-[19px] leading-snug font-bold">
          {titleOf(entry.def.name, before, fp)}
        </h2>
        <p id="ec-d" className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
          这是订阅来的自动化，会在网页上替你动手。你同意之前，它什么都不会做。
        </p>
        <dl className="mt-4 overflow-hidden rounded-2xl border-[1.5px] border-line">
          <Row k="会做的动作">
            {acts.length === 0 && "不会点击或填写任何东西"}
            <span className="flex flex-wrap gap-1.5">
              {acts.map((a) => (
                <span key={a} className="rounded-full bg-ginger-soft px-2.5 py-0.5 text-[12.5px] font-semibold text-ginger-ink">
                  {ACT_LABEL[a]}
                </span>
              ))}
            </span>
            {doing.map((d) => (
              <span key={d.detail} className="mt-1 block text-[13px] text-ink-2">
                {d.what}
              </span>
            ))}
          </Row>
          <Row k="会发出去">
            {sends.length === 0
              ? "不会把网页内容发给任何引擎"
              : sends.map((s) => (
                  <span key={s.path} className="mb-1.5 block last:mb-0">
                    {s.what}
                    <span className="mt-1 flex items-center gap-1.5 text-[13px] text-ink-2">
                      <Send className="size-3.5 shrink-0 text-ink-3" />
                      发给 {s.engines.join("、") || "你选的引擎"}：
                      {s.hosts.length ? s.hosts.map((h) => <span key={h} className="font-code font-semibold break-all text-ink">{h}</span>) : "（还没选引擎）"}
                    </span>
                  </span>
                ))}
          </Row>
          <Row k="在哪里">{whereText(feature.def, entry.def)}</Row>
          <Row k="来自">
            规则包「{entry.pack}」{version ? ` v${version}` : ""}
          </Row>
        </dl>
        <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">打开后可以在小猫气泡里随时暂停，最近 20 次动作都有记录。规则更新后，动作或发送地址变了会再问你。</p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Btn ref={no} variant="plain" onClick={() => done(false)}>
            先不打开
          </Btn>
          <Btn onClick={() => done(true)}>打开</Btn>
        </div>
      </div>
    </div>
  );
}

/**
 * Turns an entry on, asking first when it needs it (R3.2, R3.3). Resolves true once the entry is on:
 * at once for non-automation and local entries and for consent that still matches, else after the user
 * presses 「打开」 (which stores the fingerprint via enableWithConsent). 「先不打开」 and Esc resolve false and
 * change nothing; so does an unknown ref. The feature page switch, the bubble and the automation runtime
 * (on the next trigger of a paused entry) all call this.
 */
export async function requestConsent(ctx: ConsentCtx, ref: string): Promise<boolean> {
  const { storage, rules } = ctx.services;
  const resolved = rules.get();
  const feature = resolved.features.find((f) => f.entries.some((e) => e.ref === ref));
  const entry = feature?.entries.find((e) => e.ref === ref);
  if (!feature || !entry) return false;
  if (!isAutomationEntry(entry.def) || isLocalEntry(entry)) {
    storage.delete(enabledKey(ref));
    return true;
  }
  const describe: DescribeCtx = {
    providers: resolved.providers,
    values: settingValues(storage, feature, entry, ctx.hostname),
    hosts: await providerHosts(resolved),
    preferred: preferredOf(ctx.services),
  };
  const fp = fingerprint(entry.def, describe);
  const stored = storage.get(consentKey(ref));
  const before = typeof stored === "string" ? stored : undefined;
  if (before === fp) {
    storage.delete(enabledKey(ref));
    return true;
  }
  const version = packVersions(storage)(entry.pack)?.to;
  return new Promise<boolean>((resolve) => {
    const doc = ctx.layer.ownerDocument;
    const host = doc.createElement("div");
    ctx.layer.append(host);
    const root = createRoot(host);
    const back = deepActive(doc);
    const done = (ok: boolean) => {
      if (ok) enableWithConsent(storage, ref, fp);
      root.unmount();
      host.remove();
      // focus goes back where it was before the dialog took it (R9.3)
      if (back instanceof HTMLElement && back.isConnected) back.focus();
      resolve(ok);
    };
    root.render(<Dialog feature={feature} entry={entry} ctx={describe} before={before} fp={fp} version={version} done={done} />);
  });
}
