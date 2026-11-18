import { useEffect, useMemo, useState, type ReactNode } from "react";
import { isAutomationEntry } from "../../core/rules/automation";
import type { ResolvedEntry, ResolvedFeature, SettingDef } from "../../core/rules/types";
import { createActionLog, createAutomationPrefs, type ActionMode, type ActionRecord } from "../../core/stores";
import { featureTarget, useShell } from "../../shell";
import { Toggle } from "../../ui";
import { type Gate, disable, gateOf } from "../page/enabled";
import { isLocalEntry, preferredOf, providerHosts, requestConsent, settingValues } from "../page/ConfirmEnable";
import { useStores } from "../page/hooks";
import { entryMatch, matchesAny } from "../selection/match";

interface Row {
  feature: ResolvedFeature;
  entry: ResolvedEntry;
  /** The per-site boolean setting that switches the entry for this site, if it has one. */
  site?: { name: string; def: SettingDef };
  command: boolean;
}

const ACTION: Record<string, string> = { click: "点击", fill: "填写", check: "勾选", select: "选择", scroll: "滚动到", focus: "聚焦到", wait: "等待" };
const MODE: Record<ActionMode, string> = {
  auto: "自动",
  "asked-yes": "问过你",
  "asked-no": "你没同意",
  hint: "只提示",
  skip: "没点",
  "not-applicable": "不是广告",
  failed: "没成功",
};
/** Records shown in the bubble; the feature page keeps the full list (R3.6). */
const SHOWN = 4;

const clock = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

function siteSetting(entry: ResolvedEntry): Row["site"] {
  const found = Object.entries(entry.def.settings ?? {}).find(([, d]) => d.type === "boolean" && d.scope === "site");
  return found && { name: found[0], def: found[1] };
}

function ActionItem({ r }: { r: ActionRecord }) {
  const detail = r.failure && r.mode === "failed" ? `${MODE[r.mode]}：${r.failure}` : MODE[r.mode];
  return (
    <li className="flex items-start gap-2 border-t border-line py-1.5 first:border-t-0">
      <span className="w-9 shrink-0 pt-px font-code text-[11px] text-ink-3">{clock(r.time)}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-ink">
          {r.mode === "not-applicable" ? "没" : ""}
          {ACTION[r.action] ?? r.action} {r.target}
        </span>
        <span className="block text-[11px] text-ink-3">{`${r.rule} · ${detail}`}</span>
      </span>
      {r.confidence !== undefined && (
        <span className={`shrink-0 pt-px font-code text-[11.5px] font-semibold ${r.confidence >= 0.85 ? "text-leaf" : "text-ginger-ink"}`}>
          {Math.round(r.confidence * 100)}%
        </span>
      )}
    </li>
  );
}

/** R3.6: the bubble's 「自动化」 group, shown only where an automation entry matches this page. */
export function Quick(): ReactNode {
  const { hostname, layer, services, openSettings } = useShell();
  const { storage, settings, resolved } = useStores();
  const prefs = useMemo(() => createAutomationPrefs(storage), [storage]);
  const log = useMemo(() => createActionLog(storage), [storage]);
  const [hosts, setHosts] = useState<Record<string, string[]>>();
  useEffect(() => {
    let live = true;
    void providerHosts(resolved).then((h) => live && setHosts(h));
    return () => void (live = false);
  }, [resolved]);

  const url = `${location.protocol}//${hostname}${location.pathname}${location.search}`;
  const rows: Row[] = resolved.features
    .filter((f) => f.enabled && matchesAny(f.def.match, url) && !matchesAny(f.def.exclude, url))
    .flatMap((feature) =>
      feature.entries
        .filter((e) => e.enabled && isAutomationEntry(e.def) && matchesAny(entryMatch(feature.def, e.def), url))
        .map((entry) => ({ feature, entry, site: siteSetting(entry), command: entry.def.triggers.some((t) => t.on === "command") })),
    );
  if (rows.length === 0) return null;

  const paused = prefs.isPaused(hostname);
  const records = log.list(hostname);
  const gate = (r: Row): Gate =>
    gateOf(storage, r.entry, { local: isLocalEntry(r.entry), describe: { providers: resolved.providers, values: settingValues(storage, r.feature, r.entry, hostname), hosts, preferred: preferredOf(services) } });
  const checked = (r: Row, g: Gate) => g === "on" && (!r.site || settings.get(r.entry.ref, r.site.name, r.site.def, hostname) === true);

  async function toggle(r: Row, g: Gate, on: boolean) {
    if (on) {
      if (g !== "on" && !(await requestConsent({ layer, services, hostname }, r.entry.ref))) return;
      if (r.site) settings.set(r.entry.ref, r.site.name, r.site.def, true, hostname);
    } else if (r.site) settings.set(r.entry.ref, r.site.name, r.site.def, false, hostname);
    else disable(storage, r.entry.ref);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-2 pl-1 text-[12px] font-semibold text-ink-3">
        自动化
        {paused && <span className="font-normal text-ginger-ink">已在这个网站暂停</span>}
      </p>
      <div className={`flex flex-col rounded-2xl bg-paper px-1 py-1 ${paused ? "opacity-50" : ""}`}>
        {rows.map((r) => {
          const g = gate(r);
          return (
            <div key={r.entry.ref} className="flex min-h-11 items-center gap-2 py-1 pr-2 pl-3">
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold text-ink">{r.entry.def.name}</span>
                {r.entry.def.description && <span className="block text-[11.5px] text-ink-3">{r.entry.def.description}</span>}
              </span>
              {r.command ? (
                <span className="text-[11.5px] text-ink-3">命令</span>
              ) : (
                <Toggle aria-label={r.entry.def.name} checked={checked(r, g)} disabled={paused} onCheckedChange={(on) => void toggle(r, g, on)} />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex h-10 items-center justify-between rounded-2xl bg-paper pr-2 pl-3">
        <span className="text-[13px] text-ink">在这个网站暂停自动化</span>
        <Toggle aria-label="在这个网站暂停自动化" checked={paused} onCheckedChange={(on) => prefs.setPaused(hostname, on)} />
      </div>
      {records.length > 0 && (
        <div className="rounded-2xl border-[1.5px] border-line px-3 pt-2 pb-1">
          <p className="flex items-center text-[12px] font-semibold text-ink-3">
            最近动作
            <button type="button" onClick={() => openSettings(featureTarget(rows[0]!.feature))} className="ml-auto font-semibold text-ginger-ink hover:underline">
              全部 {records.length} 条
            </button>
          </p>
          <ul className="mt-1">
            {records.slice(0, SHOWN).map((r) => (
              <ActionItem key={r.id} r={r} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
