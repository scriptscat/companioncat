import { useEffect, useRef } from "react";
import type { ResolvedEntry } from "../../core/rules/types";
import { type ActionMode, type ActionRecord, createAutomationPrefs } from "../../core/stores";
import { Btn, cn, Section } from "../../ui";
import { useStores } from "./hooks";

const card = "rounded-[18px] border-[1.5px] border-line bg-fur";
const LOG = "cc:auto:log:";
const ALWAYS = "cc:auto:always:";

const MODE: Record<ActionMode, string> = {
  auto: "自动",
  "asked-yes": "问过你",
  "asked-no": "问过你，没点",
  hint: "只提示",
  skip: "没点",
  "not-applicable": "不是广告",
  failed: "没做成",
};
const ACTION: Record<string, string> = { click: "点击", fill: "填写", check: "勾选", select: "选择", scroll: "滚动到", focus: "聚焦到", wait: "等待" };
/** Actions that really happened, so 「点错了」 applies (R2.4). */
const PERFORMED: ActionMode[] = ["auto", "asked-yes"];

const pad = (n: number) => String(n).padStart(2, "0");
const when = (t: number) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Hostnames that have stored data under `prefix`. */
const sitesOf = (keys: string[], prefix: string) => keys.map((k) => k.slice(prefix.length));

/**
 * The automation parts of a feature page for one entry: the sites where it always acts (R2.3, with 撤销)
 * and its full action log across sites (R3.7). `focusLog` scrolls the log into view (the bubble's 「全部」).
 */
export function AutomationLog({ entry, focusLog }: { entry: ResolvedEntry; focusLog?: boolean }) {
  const { storage } = useStores(); // re-renders on any storage change, so log and prefs stay current
  const prefs = createAutomationPrefs(storage);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusLog) logRef.current?.scrollIntoView({ block: "start" });
  }, [focusLog]);

  const always = sitesOf(storage.keys(ALWAYS), ALWAYS).filter((site) => prefs.isAlwaysDo(site, entry.ref));
  const records = sitesOf(storage.keys(LOG), LOG)
    .flatMap((site) => storage.get<ActionRecord[]>(LOG + site) ?? [])
    .filter((r) => r.entry === entry.ref)
    .sort((a, b) => b.time - a.time);

  return (
    <>
      <Section title="这个网站以后都照做">
        <div className={cn(card, "px-4 py-1")}>
          {always.length ? (
            <ul>
              {always.map((site) => (
                <li key={site} className="flex items-center gap-3 border-b border-line py-2.5 text-[13.5px] last:border-b-0">
                  <span className="flex-1">{site}</span>
                  <Btn variant="plain" size="sm" aria-label={`撤销 ${site}`} onClick={() => prefs.setAlwaysDo(site, entry.ref, false)}>
                    撤销
                  </Btn>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-3 text-[13px] text-ink-3">还没有网站设为以后都照做</p>
          )}
        </div>
      </Section>

      <div ref={logRef}>
        <Section title="动作记录">
          <div className={cn(card, "px-4 py-1")}>
            {records.length ? (
              <ul data-log>
                {records.map((r) => (
                  <li key={`${r.site}:${r.id}`} className="flex items-start gap-3 border-b border-line py-2.5 text-[13px] last:border-b-0">
                    <div className="min-w-0 flex-1">
                      <p className="text-ink">
                        <span className="text-ink-3">{when(r.time)}</span> · {r.site}
                      </p>
                      <p className="text-ink">
                        {r.mode === "not-applicable" ? "没" : ""}
                        {ACTION[r.action] ?? r.action}
                        {r.target}
                      </p>
                      <p className="text-[12px] text-ink-3">
                        {MODE[r.mode] ?? r.mode}
                        {r.confidence !== undefined && ` · ${Math.round(r.confidence * 100)}%`}
                        {r.failure && ` · ${r.failure}`}
                      </p>
                    </div>
                    {r.wrong ? (
                      <span className="text-[12px] text-ink-3">已标为点错了</span>
                    ) : (
                      PERFORMED.includes(r.mode) && (
                        <Btn variant="plain" size="sm" onClick={() => prefs.markWrong(r.site, entry.ref, r.id)}>
                          点错了
                        </Btn>
                      )
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-3 text-[13px] text-ink-3">还没有动作记录</p>
            )}
          </div>
        </Section>
      </div>
    </>
  );
}
