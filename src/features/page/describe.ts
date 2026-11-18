import type { ActKind, EntryDef, FeatureDef, ResolvedProvider, RunStepDef, SelectDef, SettingDef } from "../../core/rules/types";
import { entryMatch } from "../selection/match";

export interface Does {
  /** The plain sentence. */
  what: string;
  /** The rule fields it came from. */
  detail: string;
}

/** What the page knows beyond the rule: the engines, the user's setting values and resolved hosts. */
export interface DescribeCtx {
  providers?: readonly Pick<ResolvedProvider, "ref" | "id" | "def">[];
  /** Setting name → current value (falls back to the setting's default). */
  values?: Readonly<Record<string, unknown>>;
  /** Provider ref → hosts after rendering its templates (resolveHosts); else the plain ones it declares. */
  hosts?: Readonly<Record<string, readonly string[]>>;
  /** The engines that go first for a capability (通用), used when a step names none (R3.2, R5.1). */
  preferred?: (contract: string) => readonly string[];
}

/** One ask step: what leaves the page and where it goes (R1.5, R3.2). */
export interface Send {
  /** Where the step sits in `run`, e.g. `run[2]` or `run[1].then[0]`. */
  path: string;
  ask: string;
  /** Engine names; empty when no engine is chosen yet. */
  engines: string[];
  what: string;
  hosts: string[];
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

const KIND: Record<ActKind, string> = {
  click: "点击",
  fill: "填写",
  check: "勾选",
  select: "选择",
  scroll: "滚动到",
  focus: "聚焦到",
  wait: "等待",
};

const BELOW: Record<string, string> = { ask: "先问你", hint: "只提示", skip: "不做" };

const isTemplate = (v: unknown): v is string => typeof v === "string" && v.includes("{{");

/** A setting named by a `{{ settings.x }}` template: the user's value, else the default. */
function settingValue(v: unknown, settings: Record<string, SettingDef>, ctx: DescribeCtx): unknown {
  if (!isTemplate(v)) return v;
  const name = SETTING_REF.exec(v)?.[1];
  return name === undefined ? undefined : (ctx.values?.[name] ?? settings[name]?.default);
}

function enginesOf(step: { ask?: string; engine?: string; engines?: string[] | string }, settings: Record<string, SettingDef>, ctx: DescribeCtx) {
  const raw = settingValue(step.engine ?? step.engines, settings, ctx);
  let refs = (Array.isArray(raw) ? raw : [raw]).filter((x): x is string => typeof x === "string" && x !== "");
  // no engine chosen: the run asks the engine that goes first for the capability (planAsk)
  if (!refs.length && step.ask !== undefined) refs = [...(ctx.preferred?.(step.ask) ?? [])];
  return refs.flatMap((r) => ctx.providers?.filter((p) => p.ref === r || p.id === r) ?? []);
}

const hostsOf = (p: Pick<ResolvedProvider, "ref" | "def">, ctx: DescribeCtx) =>
  [...(ctx.hosts?.[p.ref] ?? (p.def.hosts ?? []).filter((h) => !isTemplate(h)))];

const INPUT_LABEL: Record<string, string> = {
  question: "问题",
  options: "候选项",
  state: "页面状态",
  context: "周围页面结构",
  text: "文字",
  messages: "对话内容",
};

function sendWhat(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "这一步的输入内容";
  return Object.entries(input)
    .map(([k, v]) => {
      const n = typeof v === "string" ? /outline\([^)]*?,\s*(\d+)\s*\)/.exec(v)?.[1] : undefined;
      return `${INPUT_LABEL[k] ?? k}${n ? `（约 ${n} 字）` : ""}`;
    })
    .join("、");
}

type Walk = (step: RunStepDef, path: string) => void;

/** Visits every step in order, nested ones included, with their `run[i].then[j]` path. */
function walk(steps: readonly RunStepDef[], path: string, visit: Walk): void {
  steps.forEach((step, i) => {
    const here = `${path}[${i}]`;
    visit(step, here);
    if (step.if !== undefined) {
      walk(step.then, `${here}.then`, visit);
      if (step.else) walk(step.else, `${here}.else`, visit);
    } else if (step.repeat !== undefined) walk(step.steps, `${here}.steps`, visit);
  });
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

function actSentence(step: Extract<RunStepDef, { act: ActKind }>, settings: Record<string, SettingDef>, ctx: DescribeCtx) {
  if (step.act === "wait") {
    if (step.selector) return `等待「${step.selector}」出现`;
    const ms = settingValue(step.ms, settings, ctx);
    return typeof ms === "number" ? `等待 ${ms} 毫秒` : "等一会儿";
  }
  const desc = step.describe && !isTemplate(step.describe) ? step.describe : "目标元素";
  const base = `${KIND[step.act]}${desc}`;
  if (step.minConfidence === undefined) return base;
  const min = settingValue(step.minConfidence, settings, ctx);
  const below = settingValue(step.below, settings, ctx);
  return `把握 ${typeof min === "number" ? pct(min) : "设定的门槛"} 以上就${base}，没到就${typeof below === "string" ? (BELOW[below] ?? below) : "按你的设置处理"}`;
}

function stepSentence(step: RunStepDef, settings: Record<string, SettingDef>, ctx: DescribeCtx): { what: string; field: string } | undefined {
  if (step.find !== undefined)
    return { what: `在页面里找${step.all ? "所有" : ""}「${step.find}」${step.within ? "（只在指定范围里）" : ""}`, field: "find" };
  if (step.ask !== undefined) {
    const names = enginesOf(step, settings, ctx).map((p) => p.def.name);
    const q = typeof step.input === "object" && step.input !== null ? (step.input as { question?: unknown }).question : undefined;
    return { what: `问 ${names.join("、") || "你选的引擎"}${typeof q === "string" && !isTemplate(q) ? `：${q}` : ""}`, field: "ask" };
  }
  if (step.act !== undefined)
    return { what: actSentence(step, settings, ctx), field: step.minConfidence === undefined ? "act" : "minConfidence" };
  if (step.stop) return { what: "到这里就停下", field: "stop" };
  return undefined;
}

/** R9.2, R1.5: what an entry does, from its match, triggers, run and present. */
export function describeEntry(feature: Pick<FeatureDef, "match" | "settings">, entry: EntryDef, ctx: DescribeCtx = {}): Does[] {
  const match = entryMatch(feature, entry);
  const settings = { ...feature.settings, ...entry.settings };
  const place = where(match);
  const out: Does[] = [];

  entry.triggers.forEach((t, i) => {
    let detail = `match = ${match.join(", ")}；triggers[${i}].on = ${t.on}`;
    // a trigger switched by a per-site setting runs only where you turned that setting on
    const gate = t.on !== "selection" && isTemplate(t.enabled) ? settings[SETTING_REF.exec(t.enabled)?.[1] ?? ""] : undefined;
    const at = gate ? (gate.scope === "site" ? `在你打开了「${gate.title}」的网站上` : `${place}，打开了「${gate.title}」时`) : place;
    if (gate) detail += `；triggers[${i}].enabled`;
    if (t.on === "selection") out.push({ what: `${place}留意你选中的文字`, detail });
    else if (t.on === "appear") out.push({ what: `${at}，有新的「${t.selector}」出现时自动开始`, detail: `${detail}；triggers[${i}].selector` });
    else if (t.on === "command") {
      const key = settingValue(t.hotkey, settings, ctx);
      out.push({ what: `${place}提供「${t.title ?? entry.name}」${typeof key === "string" && key ? `，快捷键 ${key}` : ""}`, detail });
    } else out.push({ what: `${gate ? `${at}，` : place}打开网页时自动开始`, detail });
  });

  if (entry.select) out.push(selectSentence(entry.select));

  walk(entry.run, "run", (step, path) => {
    if (step.call) {
      const subject = step.batch === "blocks" ? "把网页里的段落分批" : "把选中的文字";
      out.push({
        what: `${subject}${target(step, settings)}`,
        detail: `${path}.call = ${step.call}${step.strategy ? `；strategy = ${step.strategy}` : ""}${step.batch ? `；batch = ${step.batch}` : ""}`,
      });
    } else if (step.if !== undefined) {
      out.push({ what: "如果条件成立：", detail: `${path}.if = ${String(step.if)}` });
    } else if (step.repeat !== undefined) {
      out.push(
        step.repeat === true
          ? { what: `重复，直到条件成立，最多 ${step.max} 次：`, detail: `${path}.repeat = true；until；max` }
          : { what: "对列表里的每一项：", detail: `${path}.repeat = ${step.repeat}` },
      );
    } else {
      const s = stepSentence(step, settings, ctx);
      if (s) out.push({ what: s.what, detail: `${path}.${s.field}${s.field === "minConfidence" ? "；below" : ""}` });
      // R1.5: a step that sends page content says what and to which domain
      if (step.ask !== undefined) {
        const send = sendOf(step, path, settings, ctx);
        const to = send.hosts.length ? `发到 ${send.hosts.join("、")}（${send.engines.join("、")}）` : "发给引擎（还没选引擎）";
        out.push({ what: `会把${send.what}${to}`, detail: `${path}.input` });
      }
    }
    if (step.if !== undefined && step.else) out.push({ what: "否则：", detail: `${path}.else` });
  });

  const surface = entry.present?.surface.type;
  if (surface) out.push({ what: SURFACE[surface] ?? "显示结果", detail: `present.surface.type = ${surface}` });
  if (entry.toggle) out.push({ what: "再执行一次就收回译文，恢复原样", detail: "toggle = true" });
  return out;
}

/** The page-compare `select` (R7.3): which paragraphs, which are skipped, and when they are translated. */
function selectSentence(sel: SelectDef): Does {
  const b = sel.blocks;
  const blocks =
    b === undefined || b === "auto" ? "自动识别正文段落" : isTemplate(b) ? "有网站规则时用它的选择器，否则自动识别正文段落" : `用「${Array.isArray(b) ? b.join("、") : b}」找段落`;
  const parts = [`找出网页里的段落（${blocks}）`];
  if (sel.exclude?.length) parts.push(`跳过 ${sel.exclude.join("、")}`);
  if (sel.lazy === "viewport") parts.push("只翻译滚动到眼前的部分");
  if (sel.watch === "mutations") parts.push("页面新增的内容也接着翻译");
  const detail = ["select.blocks", sel.exclude?.length && "select.exclude", sel.lazy && `select.lazy = ${sel.lazy}`, sel.watch && `select.watch = ${sel.watch}`].filter(Boolean).join("；");
  return { what: parts.join("，"), detail };
}

/** One ask step's Send. */
function sendOf(step: Extract<RunStepDef, { ask: string }>, path: string, settings: Record<string, SettingDef>, ctx: DescribeCtx): Send {
  const providers = enginesOf(step, settings, ctx);
  return {
    path,
    ask: step.ask,
    engines: providers.map((p) => p.def.name),
    what: sendWhat(step.input),
    hosts: [...new Set(providers.flatMap((p) => hostsOf(p, ctx)))],
  };
}

/** R1.5: per ask step, what is sent and to which host(s). */
export function sendsOf(entry: EntryDef, ctx: DescribeCtx = {}): Send[] {
  const settings = entry.settings ?? {};
  const out: Send[] = [];
  walk(entry.run, "run", (step, path) => {
    if (step.ask === undefined) return;
    out.push(sendOf(step, path, settings, ctx));
  });
  return out;
}

/** The distinct action kinds the entry can perform (input to the R3.3 fingerprint), sorted. */
export function actsOf(entry: EntryDef): ActKind[] {
  const kinds = new Set<ActKind>();
  walk(entry.run, "run", (step) => {
    if (step.act !== undefined) kinds.add(step.act);
  });
  return [...kinds].sort();
}
