import { useEffect, useReducer, useState } from "react";
import { unavailableReason } from "../../core/impl";
import type { Invoker } from "../../core/invoke";
import type { ResolvedProvider } from "../../core/rules/types";
import type { Storage } from "../../platform/storage";
import { useShell, type Theme } from "../../shell";
import { Picker, Section, SettingRow, Segments, Btn, Toggle, cn } from "../../ui";
import { autoUpdateEnabled, preferredEngine, setAutoUpdate, setPreferredEngine } from "./prefs";

/** The invoker methods this page uses; task 16 wires `services.invoker = createInvoker(...)`. */
export type GeneralInvoker = Pick<Invoker, "preferredEngines" | "cacheStats" | "clearCache">;

const CAPABILITIES = [
  { id: "translate", label: "翻译" },
  { id: "chat", label: "对话" },
  { id: "choose", label: "选择和判断" },
] as const;

const AUTO = "__auto__";
const card = "rounded-[18px] border-[1.5px] border-line bg-fur";
const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Re-render on any storage change, from this tab or another (R1.8). */
function useStorageRevision(storage: Storage) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => storage.onChange(() => bump()), [storage]);
}

function EnginePicker({ storage, invoker, capability, label, providers }: {
  storage: Storage;
  invoker?: GeneralInvoker;
  capability: string;
  label: string;
  providers: ResolvedProvider[];
}) {
  const options = providers.filter((p) => p.enabled && unavailableReason(p, capability) === null);
  const stored = preferredEngine(storage)(capability);
  // A choice whose engine is gone is ignored by the invoker, so the picker shows automatic.
  const shown = stored !== undefined && options.some((p) => p.ref === stored) ? stored : AUTO;
  const notice = invoker?.preferredEngines(capability).notice;
  return (
    <div className="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0">
      <span className="w-24 shrink-0 text-[14px]">{label}</span>
      <div className="min-w-0 flex-1">
        <Picker
          label={`${label}先用`}
          value={shown}
          onValueChange={(v) => setPreferredEngine(storage, capability, v === AUTO ? undefined : v)}
          options={[{ value: AUTO, label: "自动（按规则顺序）" }, ...options.map((p) => ({ value: p.ref, label: p.def.name }))]}
        />
        {notice && <p className="mt-1 text-[12px] text-ginger-ink">{notice}</p>}
      </div>
    </div>
  );
}

const NO_CACHE = { entries: 0, bytes: 0 };

function CacheSection({ invoker }: { invoker?: GeneralInvoker }) {
  const read = () => invoker?.cacheStats() ?? NO_CACHE;
  const [stats, setStats] = useState(read);
  const clear = () => {
    invoker?.clearCache();
    setStats(read());
  };
  return (
    <Section title="缓存">
      <div className={cn(card, "flex items-center gap-3 p-4")}>
        <div className="min-w-0 flex-1">
          <p className="text-[14px]">已缓存 {stats.entries} 条结果，约 {formatBytes(stats.bytes)}</p>
          <p className="mt-0.5 text-[12.5px] text-ink-3">超过 5,000 条时，先删最久没用到的</p>
        </div>
        <Btn size="sm" variant="danger" disabled={!invoker || stats.entries === 0} onClick={clear}>
          清空
        </Btn>
      </div>
    </Section>
  );
}

export function GeneralPage() {
  const shell = useShell();
  const { storage } = shell.services;
  const invoker = shell.services.invoker;
  useStorageRevision(storage);
  const providers = shell.resolved.providers;

  return (
    <div className={cn("cc-scroll relative h-full overflow-y-auto pb-8", shell.narrow ? "px-4" : "px-6")}>
      <div className="flex max-w-[640px] flex-col gap-6">
        <Section title="每种能力先用谁">
          {providers.length > 0 ? (
            <div className={cn(card, "px-4")}>
              {CAPABILITIES.map((c) => (
                <EnginePicker key={c.id} storage={storage} invoker={invoker} capability={c.id} label={c.label} providers={providers} />
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-ink-3">还没有引擎。订阅规则后，可以在这里为每种能力选一个先用的引擎。</p>
          )}
          <p className="mt-2 text-[12.5px] text-ink-3">功能没有指定引擎时用这里的选择；先用的出错时，自动换下一个能做这件事的引擎。</p>
        </Section>

        <Section title="角落里的小猫">
          <div className={cn(card, "px-4")}>
            <SettingRow label="在所有网站显示" hint="关掉后，可以从脚本猫菜单打开陪伴猫">
              <Toggle aria-label="在所有网站显示小猫" checked={shell.prefs.showCat} onCheckedChange={(v) => shell.setPref("showCat", v)} />
            </SettingRow>
          </div>
        </Section>

        <Section title="外观">
          <Segments label="外观" value={shell.prefs.theme} onChange={(v) => shell.setPref("theme", v)} options={THEMES} />
        </Section>

        <Section title="规则包">
          <div className={cn(card, "px-4")}>
            <SettingRow label="自动更新规则包" hint="打开网页时，超过 24 小时没检查的规则包会在后台检查更新">
              <Toggle aria-label="自动更新规则包" checked={autoUpdateEnabled(storage)()} onCheckedChange={(v) => setAutoUpdate(storage, v)} />
            </SettingRow>
          </div>
        </Section>

        <CacheSection invoker={invoker} />
      </div>
    </div>
  );
}
