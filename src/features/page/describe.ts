import type { EntryDef, FeatureDef, RunStepDef, SettingDef } from "../../core/rules/types";
import { entryMatch } from "../selection/match";

export interface Does {
  /** The plain sentence. */
  what: string;
  /** The rule fields it came from. */
  detail: string;
}

const ALL_SITES = new Set(["*://*/*", "<all_urls>"]);

function where(match: readonly string[]): string {
  if (match.some((m) => ALL_SITES.has(m))) return "在所有网站上";
  const hosts = match.map((m) => /^[^:]+:\/\/([^/]+)/.exec(m)?.[1] ?? m);
  return `在 ${[...new Set(hosts)].join("、")} 上`;
}

const SETTING_REF = /settings\.(\w+)/;

function target(step: RunStepDef, settings: Record<string, SettingDef>): string {
  const e = Array.isArray(step.engines) ? step.engines[0] : step.engines;
  if (e === undefined) return "交给引擎处理";
  const type = typeof e === "string" ? settings[SETTING_REF.exec(e)?.[1] ?? ""]?.type : undefined;
  if (type === "engines") return "发给你勾选的引擎";
  if (type === "engine") return "发给你选的引擎";
  return "发给指定的引擎";
}

const SURFACE: Record<string, string> = {
  "near-selection": "在选中文字旁边显示结果卡片",
  bubble: "在小猫气泡里显示结果",
  "inline-after": "在每段原文下面显示译文",
};

/** R9.2: what an entry does, from its match, triggers, run and present. */
export function describeEntry(feature: Pick<FeatureDef, "match" | "settings">, entry: EntryDef): Does[] {
  const match = entryMatch(feature, entry);
  const settings = { ...feature.settings, ...entry.settings };
  const place = where(match);
  const out: Does[] = [];

  entry.triggers.forEach((t, i) => {
    const detail = `match = ${match.join(", ")}；triggers[${i}].on = ${t.on}`;
    if (t.on === "selection") out.push({ what: `${place}留意你选中的文字`, detail });
    else if (t.on === "command")
      out.push({ what: `${place}提供「${t.title ?? entry.name}」${t.hotkey ? `，快捷键 ${t.hotkey}` : ""}`, detail });
    else out.push({ what: `${place}打开网页时自动开始`, detail });
  });

  entry.run.forEach((step, i) => {
    if (!step.call) return;
    const subject = step.batch === "blocks" ? "把网页里的段落" : "把选中的文字";
    out.push({
      what: `${subject}${target(step, settings)}`,
      detail: `run[${i}].call = ${step.call}${step.strategy ? `；strategy = ${step.strategy}` : ""}`,
    });
  });

  const surface = entry.present.surface.type;
  out.push({ what: SURFACE[surface] ?? "显示结果", detail: `present.surface.type = ${surface}` });
  return out;
}
