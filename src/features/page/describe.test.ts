import { describe, expect, it } from "vitest";
import type { EntryDef, FeatureDef, ResolvedProvider } from "../../core/rules/types";
import { actsOf, describeEntry, sendsOf, type DescribeCtx } from "./describe";

const feature: Pick<FeatureDef, "match" | "settings"> = {
  match: ["*://*/*"],
  settings: { engine: { type: "engine", title: "引擎", capability: "choose" } },
};

const provider = (ref: string, name: string, hosts: string[]): ResolvedProvider =>
  ({ ref, id: ref.split("/")[1], pack: ref.split("/")[0], source: 0, enabled: true, problems: [], ancestors: [], secretsFrom: ref, def: { id: ref.split("/")[1], name, hosts, implements: {} } }) as ResolvedProvider;

const ctx: DescribeCtx = {
  providers: [provider("official/deepseek", "DeepSeek", ["{{ options.host }}"]), provider("official/jev", "Jev", ["api.jev.test"])],
  values: { engine: "official/deepseek", threshold: 0.85, below: "ask" },
  hosts: { "official/deepseek": ["api.deepseek.com"] },
};

const skip: EntryDef = {
  id: "auto-skip",
  name: "自动跳过广告",
  settings: {
    threshold: { type: "number", title: "门槛", default: 0.85, format: "percent" },
    below: { type: "enum", title: "低于时", default: "ask", options: { ask: "先问你", hint: "只提示", skip: "不做" } },
  },
  triggers: [{ on: "appear", selector: "button, a" }],
  run: [
    { find: "button, a", all: true, as: "candidates" },
    { if: "{{ size(vars.candidates) == 0 }}", then: [{ stop: true }] },
    {
      ask: "choose",
      engine: "{{ settings.engine }}",
      input: { question: "哪个是跳过按钮", options: "{{ vars.candidates }}", context: "{{ outline(trigger.element, 400) }}" },
      as: "pick",
    },
    {
      act: "click",
      target: "{{ vars.candidates[0] }}",
      confidence: "{{ vars.pick.confidence }}",
      minConfidence: "{{ settings.threshold }}",
      below: "{{ settings.below }}",
      describe: "跳过按钮",
    },
  ],
};

const whats = (e: EntryDef, c: DescribeCtx = ctx) => describeEntry(feature, e, c).map((d) => d.what);

describe("describeEntry: new triggers", () => {
  it("appear names the selector", () => {
    const d = describeEntry(feature, skip, ctx)[0]!;
    expect(d.what).toBe("在所有网站上，有新的「button, a」出现时自动开始");
    expect(d.detail).toContain("triggers[0].selector");
  });
  it("page-load and command", () => {
    const e = { ...skip, triggers: [{ on: "page-load" as const }, { on: "command" as const, title: "跳过", hotkey: "Alt+A" }] };
    expect(whats(e).slice(0, 2)).toEqual(["在所有网站上打开网页时自动开始", "在所有网站上提供「跳过」，快捷键 Alt+A"]);
  });
});

describe("describeEntry: steps", () => {
  it("find, if/stop nesting, ask with engine name, act with threshold and below", () => {
    const out = describeEntry(feature, skip, ctx);
    const w = out.map((d) => d.what);
    expect(w).toContain("在页面里找所有「button, a」");
    expect(w).toContain("如果条件成立：");
    expect(w).toContain("到这里就停下");
    expect(w).toContain("问 DeepSeek：哪个是跳过按钮");
    expect(w).toContain("把握 85% 以上就点击跳过按钮，没到就先问你");
    expect(out.find((d) => d.what === "到这里就停下")?.detail).toBe("run[1].then[0].stop");
    expect(out.find((d) => d.what.startsWith("把握"))?.detail).toContain("run[3].minConfidence");
  });
  it("follows the user's settings for below", () => {
    expect(whats(skip, { ...ctx, values: { ...ctx.values, below: "skip", threshold: 0.9 } })).toContain("把握 90% 以上就点击跳过按钮，没到就不做");
  });
  it("act without a threshold, wait, if/else, repeat", () => {
    const e: EntryDef = {
      ...skip,
      run: [
        { act: "fill", target: "{{ el }}", value: "x" },
        { act: "wait", selector: ".done" },
        { if: true, then: [{ act: "wait", ms: 500 }], else: [{ stop: true }] },
        { repeat: "{{ vars.qs }}", steps: [{ act: "check", target: "{{ item }}" }] },
        { repeat: true, until: "{{ true }}", max: 3, steps: [{ act: "scroll", target: "{{ el }}" }] },
      ],
    };
    const w = whats(e);
    expect(w).toEqual(
      expect.arrayContaining(["填写目标元素", "等待「.done」出现", "如果条件成立：", "等待 500 毫秒", "否则：", "对列表里的每一项：", "勾选目标元素", "重复，直到条件成立，最多 3 次：", "滚动到目标元素"]),
    );
  });
  it("unresolved engine falls back to a generic name", () => {
    expect(whats(skip, { providers: [], values: {} })).toContain("问 你选的引擎：哪个是跳过按钮");
  });
  it("selection entries keep the phase-1 sentences", () => {
    const sel: EntryDef = { id: "t", name: "翻译", triggers: [{ on: "selection" }], run: [{ call: "translate", input: {} }], present: { surface: { type: "bubble" }, view: { type: "text" } } };
    expect(describeEntry({ match: ["*://*/*"], settings: {} }, sel).map((d) => d.what)).toEqual([
      "在所有网站上留意你选中的文字",
      "把选中的文字交给引擎处理",
      "在小猫气泡里显示结果",
    ]);
  });
});

describe("sendsOf", () => {
  it("per ask step: what and which host", () => {
    expect(sendsOf(skip, ctx)).toEqual([
      { path: "run[2]", ask: "choose", engines: ["DeepSeek"], what: "问题、候选项、周围页面结构（约 400 字）", hosts: ["api.deepseek.com"] },
    ]);
  });
  it("uses static hosts without a resolved map, none when the engine is unknown", () => {
    const e: EntryDef = { ...skip, run: [{ ask: "choose", engine: "official/jev", input: { question: "q" } }] };
    expect(sendsOf(e, { providers: ctx.providers })[0]).toMatchObject({ engines: ["Jev"], hosts: ["api.jev.test"] });
    expect(sendsOf(skip, { providers: ctx.providers, values: {} })[0]).toMatchObject({ engines: [], hosts: [] });
  });
  it("finds nested asks and is empty without asks", () => {
    const e: EntryDef = { ...skip, run: [{ if: true, then: [{ ask: "chat", engine: "official/jev", input: { text: "x" } }] }] };
    expect(sendsOf(e, ctx).map((s) => s.path)).toEqual(["run[0].then[0]"]);
    expect(sendsOf({ ...skip, run: [{ stop: true }] }, ctx)).toEqual([]);
  });
});

describe("actsOf", () => {
  it("lists the distinct action kinds, nested ones included", () => {
    const e: EntryDef = { ...skip, run: [...skip.run, { if: true, then: [{ act: "fill", target: "{{ a }}", value: "v" }, { act: "click", target: "{{ a }}" }] }] };
    expect(actsOf(e)).toEqual(["click", "fill"]);
    expect(actsOf({ ...skip, run: [] })).toEqual([]);
  });
});

describe("R1.5: conditions, what is sent where, and the page-compare fields", () => {
  const site = { siteEnabled: { type: "boolean" as const, title: "在这个网站跳过广告", scope: "site" as const, default: false } };

  it("a trigger switched by a per-site setting says it runs only where you turned it on", () => {
    const e: EntryDef = { ...skip, settings: { ...skip.settings, ...site }, triggers: [{ on: "appear", selector: "button, a", enabled: "{{ settings.siteEnabled }}" }] };
    expect(whats(e)[0]).toBe("在你打开了「在这个网站跳过广告」的网站上，有新的「button, a」出现时自动开始");
    const load: EntryDef = { ...e, triggers: [{ on: "page-load", enabled: "{{ settings.siteEnabled }}" }] };
    expect(whats(load)[0]).toBe("在你打开了「在这个网站跳过广告」的网站上，打开网页时自动开始");
    expect(describeEntry(feature, load, ctx)[0]!.detail).toContain("triggers[0].enabled");
  });

  it("a command's hotkey taken from a setting shows the setting's value", () => {
    const e: EntryDef = {
      ...skip,
      settings: { hotkey: { type: "hotkey", title: "快捷键", default: "Alt+A" } },
      triggers: [{ on: "command", title: "对照翻译这个网页", hotkey: "{{ settings.hotkey }}" }],
    };
    expect(whats(e, { ...ctx, values: {} })[0]).toBe("在所有网站上提供「对照翻译这个网页」，快捷键 Alt+A");
  });

  it("each ask step says what it sends and to which domain, right after it", () => {
    const out = describeEntry(feature, skip, ctx);
    const i = out.findIndex((d) => d.what === "问 DeepSeek：哪个是跳过按钮");
    expect(out[i + 1]).toEqual({ what: "会把问题、候选项、周围页面结构（约 400 字）发到 api.deepseek.com（DeepSeek）", detail: "run[2].input" });
  });

  it("an ask without a chosen engine uses the engine that goes first for its capability", () => {
    const preferred = (c: string) => (c === "choose" ? ["official/jev"] : []);
    expect(sendsOf(skip, { providers: ctx.providers, values: {}, preferred })[0]).toMatchObject({ engines: ["Jev"], hosts: ["api.jev.test"] });
    expect(whats(skip, { providers: ctx.providers, values: {}, preferred })).toContain("会把问题、候选项、周围页面结构（约 400 字）发到 api.jev.test（Jev）");
  });

  it("the page-compare entry: select, batch and toggle have their own sentences", () => {
    const page: EntryDef = {
      id: "page",
      name: "网页对照翻译",
      triggers: [{ on: "command", title: "对照翻译这个网页" }],
      toggle: true,
      select: { blocks: "{{ has(site.blocks) ? site.blocks : 'auto' }}", exclude: ["pre", "code", "nav", "[translate=no]"], lazy: "viewport", watch: "mutations" },
      run: [{ call: "translate", strategy: "first", engines: ["official/jev"], batch: "blocks", input: {}, as: "results" }],
      present: { surface: { type: "inline-after", target: "block" }, view: { type: "text" } },
    };
    const out = describeEntry({ match: ["*://*/*"], settings: {} }, page, ctx);
    expect(out.map((d) => d.what)).toEqual([
      "在所有网站上提供「对照翻译这个网页」",
      "找出网页里的段落（有网站规则时用它的选择器，否则自动识别正文段落），跳过 pre、code、nav、[translate=no]，只翻译滚动到眼前的部分，页面新增的内容也接着翻译",
      "把网页里的段落分批发给指定的引擎",
      "在每段原文下面显示译文",
      "再执行一次就收回译文，恢复原样",
    ]);
    expect(out[1]!.detail).toBe("select.blocks；select.exclude；select.lazy = viewport；select.watch = mutations");
    expect(out[2]!.detail).toContain("batch = blocks");
    expect(out[4]!.detail).toBe("toggle = true");
  });
});
