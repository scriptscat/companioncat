import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveRules } from "../../core/rules";
import type { Resolved, SettingDef } from "../../core/rules/types";
import { createSettingsStore, createSecretStore } from "../../core/stores";
import { definePage, featureTarget } from "../../shell";
import { FeaturePage } from "./FeaturePage";
import { setup, unmountAll } from "../../shell/testing";
import registrations from "./register";
import compare from "../compare/register";
import { enabledKey } from "./enabled";

const read = (n: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "rules/packs", `${n}.json`), "utf8"));
const official = (): Resolved =>
  resolveRules([
    { pack: read("official-translate"), official: true },
    { pack: read("official-llm"), official: true },
  ]);

const FEATURE = "official-translate/translate";
const SELECTION = "official-translate/translate.selection";
const HOST = "example-blog.dev";

beforeAll(() => {
  // Radix Select/Checkbox need these in jsdom
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(unmountAll);

function openPage(resolved = official()) {
  const s = setup({ resolved, registrations: [...(registrations as never[])] });
  act(() => s.handle.openSettings(featureTarget(resolved.features[0]!)));
  const dialog = s.q.getByRole("dialog", { name: "陪伴猫设置" });
  return { ...s, dialog: within(dialog), settings: createSettingsStore(s.storage), resolved };
}

/** Replace the feature's shared settings (and drop the entries) to exercise the setting types. */
function synthetic(settings: Record<string, SettingDef>): Resolved {
  const r = official();
  const f = r.features[0]!;
  f.def = { ...f.def, settings };
  f.entries = [];
  return r;
}

describe("feature page (R9.1)", () => {
  it("shows the description and the feature switch, on by default", async () => {
    const { dialog, storage } = openPage();
    expect(dialog.getByText("选中文字就能翻译；以后还能把整个网页对照翻译。")).toBeTruthy();
    const sw = dialog.getByRole("switch", { name: "启用翻译" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(sw);
    expect(storage.get(enabledKey(FEATURE))).toBe(false);
    expect(dialog.getByRole("switch", { name: "启用翻译" }).getAttribute("aria-checked")).toBe("false");
    await userEvent.click(dialog.getByRole("switch", { name: "启用翻译" }));
    expect(storage.get(enabledKey(FEATURE))).toBeUndefined();
  });

  it("has a 共用 group with the feature settings and one group per entry", async () => {
    const { dialog, settings, resolved } = openPage();
    expect(dialog.getByText("共用")).toBeTruthy();
    expect(dialog.getByText("划词翻译")).toBeTruthy();
    expect(dialog.getByText("网页对照翻译")).toBeTruthy();
    const swap = dialog.getByRole("switch", { name: "中英互译" });
    expect(swap.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(swap);
    const def = resolved.features[0]!.def.settings!.swapIfSame!;
    expect(settings.get(FEATURE, "swapIfSame", def)).toBe(false);
  });

  it("toggles an entry and stores its own settings under the entry", async () => {
    const { dialog, storage, settings, resolved } = openPage();
    await userEvent.click(dialog.getByRole("switch", { name: "启用划词翻译" }));
    expect(storage.get(enabledKey(SELECTION))).toBe(false);
    await userEvent.click(dialog.getByRole("radio", { name: "直接翻译" }));
    const entry = resolved.features[0]!.entries[0]!;
    expect(settings.get(SELECTION, "confirm", entry.def.settings!.confirm!)).toBe("none");
  });

  it("stores site-scoped settings per hostname", async () => {
    const { dialog, storage } = openPage();
    expect(dialog.getAllByText(`只对当前网站 ${HOST} 生效`).length).toBeGreaterThan(0);
    await userEvent.click(dialog.getByRole("switch", { name: "在这个网站划词翻译" }));
    expect(storage.get(`cc:set:${SELECTION}/siteEnabled@${HOST}`)).toBe(false);
  });
});

describe("它会做什么 (R9.2)", () => {
  it("describes the selection entry in plain words with the rule fields below each line", () => {
    const { dialog } = openPage();
    for (const line of ["在所有网站上留意你选中的文字", "把选中的文字发给你勾选的引擎", "在选中文字旁边显示结果卡片"])
      expect(dialog.getByText(line)).toBeTruthy();
    expect(dialog.getByText("match = *://*/*；triggers[0].on = selection")).toBeTruthy();
    expect(dialog.getByText("run[1].call = translate；strategy = all")).toBeTruthy();
    expect(dialog.getByText("present.surface.type = near-selection")).toBeTruthy();
  });

  it("names the sites when the entry limits where it runs", () => {
    const r = official();
    r.features[0]!.entries[0]!.def.match = ["https://a.example/*", "https://b.example/*"];
    const { dialog } = openPage(r);
    expect(dialog.getByText("在 a.example、b.example 上留意你选中的文字")).toBeTruthy();
  });
});

describe("它会做什么: where it runs matches the runtime", () => {
  it("an empty entry match reads as the feature's match", () => {
    const r = official();
    r.features[0]!.def.match = ["https://a.example/*"];
    r.features[0]!.entries[0]!.def.match = [];
    const { dialog } = openPage(r);
    expect(dialog.getByText("在 a.example 上留意你选中的文字")).toBeTruthy();
  });
});

describe("setting renderers (R9.3)", () => {
  const all: Record<string, SettingDef> = {
    flag: { type: "boolean", title: "开关项", default: true },
    mode: { type: "enum", title: "模式项", default: "a", options: { a: "甲", b: "乙" } },
    lang: { type: "language", title: "语言项", default: "zh-CN" },
    one: { type: "engine", title: "单引擎项", capability: "translate", default: "official-translate/google" },
    many: { type: "engines", title: "多引擎项", capability: "translate", default: ["official-translate/google"], max: 2 },
    text: { type: "string", title: "文字项", default: "hi", placeholder: "写点什么" },
    num: { type: "number", title: "数字项", default: 3, min: 1, max: 5 },
  };

  it("boolean: a switch that persists", async () => {
    const { dialog, settings } = openPage(synthetic(all));
    const sw = dialog.getByRole("switch", { name: "开关项" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(sw);
    expect(settings.get(FEATURE, "flag", all.flag!)).toBe(false);
  });

  it("enum: segments that persist", async () => {
    const { dialog, settings } = openPage(synthetic(all));
    expect(dialog.getByRole("radio", { name: "甲" }).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(dialog.getByRole("radio", { name: "乙" }));
    expect(settings.get(FEATURE, "mode", all.mode!)).toBe("b");
  });

  it("language: a picker listing the languages", async () => {
    const { dialog, q, settings } = openPage(synthetic(all));
    const trigger = dialog.getByRole("combobox", { name: "语言项" });
    expect(trigger.textContent).toContain("简体中文");
    await userEvent.click(trigger);
    await userEvent.click(await q.findByRole("option", { name: "日本語" }));
    expect(settings.get(FEATURE, "lang", all.lang!)).toBe("ja");
  });

  it("engine: a picker of ready engines implementing the contract (no key missing, not disabled)", async () => {
    const r = synthetic(all);
    const { dialog, q, settings, storage } = openPage(r);
    createSecretStore(storage, () => r).setDisabled("official-translate/microsoft", true);
    const trigger = dialog.getByRole("combobox", { name: "单引擎项" });
    await userEvent.click(trigger);
    const names = (await q.findAllByRole("option")).map((o) => o.textContent);
    expect(names).toEqual(["Google 翻译"]);
    await userEvent.click(q.getByRole("option", { name: "Google 翻译" }));
    expect(settings.get(FEATURE, "one", all.one!)).toBe("official-translate/google");
  });

  it("engines: checklist; keyless engines shown but not selectable; max respected; order marks the main one", async () => {
    const { dialog, settings, storage } = openPage(synthetic(all));
    const google = dialog.getByRole("checkbox", { name: /Google 翻译/ });
    const ms = dialog.getByRole("checkbox", { name: /微软翻译/ });
    const deepseek = dialog.getByRole("checkbox", { name: /DeepSeek/ });
    expect(google.getAttribute("aria-checked")).toBe("true");
    expect(dialog.getByText("主结果")).toBeTruthy();
    expect(deepseek.hasAttribute("disabled") || deepseek.getAttribute("data-disabled") !== null).toBe(true);
    expect(dialog.getByText("DeepSeek（还没填 Key）")).toBeTruthy();
    expect(dialog.queryByRole("checkbox", { name: /Jev/ })).toBeNull(); // implements only choose
    await userEvent.click(ms);
    expect(storage.get(`cc:set:${FEATURE}/many`)).toEqual(["official-translate/google", "official-translate/microsoft"]);
    expect(settings.get(FEATURE, "many", all.many!)).toHaveLength(2);
    await userEvent.click(google);
    expect(storage.get(`cc:set:${FEATURE}/many`)).toEqual(["official-translate/microsoft"]);
  });

  it("engines: at max the unchecked boxes are locked but a checked one can still be removed", () => {
    const { dialog } = openPage(synthetic({ many: { ...all.many!, max: 1 } }));
    expect(dialog.getByRole("checkbox", { name: /微软翻译/ }).hasAttribute("disabled")).toBe(true);
    expect(dialog.getByRole("checkbox", { name: /Google 翻译/ }).hasAttribute("disabled")).toBe(false);
  });

  it("engines: max and the main badge count only the engines shown", () => {
    const r = synthetic({ many: { ...all.many!, max: 2 } });
    const s = setup({ resolved: r, registrations: [...(registrations as never[])] });
    act(() => {
      const secrets = createSecretStore(s.storage, () => r);
      secrets.setDisabled("official-translate/google", true);
      secrets.set("official-llm/deepseek", "apiKey", "k");
      createSettingsStore(s.storage).set(FEATURE, "many", all.many!, ["official-translate/google", "official-translate/microsoft"]);
    });
    act(() => s.handle.openSettings(featureTarget(r.features[0]!)));
    const dialog = within(s.q.getByRole("dialog", { name: "陪伴猫设置" }));
    expect(dialog.queryByRole("checkbox", { name: /Google 翻译/ })).toBeNull();
    expect(dialog.getByText("主结果").closest("label")?.textContent).toContain("微软翻译");
    expect(dialog.getByRole("checkbox", { name: /DeepSeek/ }).hasAttribute("disabled")).toBe(false);
  });

  it("string: a text input that persists", () => {
    const { dialog, settings } = openPage(synthetic(all));
    const input = dialog.getByPlaceholderText("写点什么") as HTMLInputElement;
    expect(input.value).toBe("hi");
    fireEvent.change(input, { target: { value: "你好" } });
    expect(settings.get(FEATURE, "text", all.text!)).toBe("你好");
  });

  it("number: a number input within min/max", () => {
    const { dialog, settings } = openPage(synthetic(all));
    const input = dialog.getByLabelText("数字项") as HTMLInputElement;
    expect(input.value).toBe("3");
    expect(input.min).toBe("1");
    expect(input.max).toBe("5");
    fireEvent.change(input, { target: { value: "4" } });
    expect(settings.get(FEATURE, "num", all.num!)).toBe(4);
    fireEvent.change(input, { target: { value: "9" } });
    expect(settings.get(FEATURE, "num", all.num!)).toBe(4); // out of range: not stored
  });
});

describe("hotkey and percent renderers (R7.1, R4.1)", () => {
  const hk: SettingDef = { type: "hotkey", title: "快捷键", default: "Alt+A" };
  const pct: SettingDef = { type: "number", title: "多有把握", default: 0.85, min: 0.5, max: 0.99, step: 0.01, format: "percent" };
  const defs = { hk, pct };

  it("hotkey: shows the default combo; a click records the next key combination", async () => {
    const { dialog, settings } = openPage(synthetic(defs));
    const button = dialog.getByRole("button", { name: "快捷键" });
    expect(button.textContent).toContain("Alt + A");
    await userEvent.click(button);
    expect(button.textContent).toContain("按下快捷键");
    fireEvent.keyDown(button, { code: "ControlLeft", key: "Control", ctrlKey: true });
    fireEvent.keyDown(button, { code: "KeyK", key: "K", ctrlKey: true, shiftKey: true });
    expect(settings.get(FEATURE, "hk", hk)).toBe("Ctrl+Shift+K");
    expect(dialog.getByRole("button", { name: "快捷键" }).textContent).toContain("Ctrl + Shift + K");
  });

  it("hotkey: a key without a modifier is refused and recording goes on", async () => {
    const { dialog, settings } = openPage(synthetic(defs));
    const button = dialog.getByRole("button", { name: "快捷键" });
    await userEvent.click(button);
    fireEvent.keyDown(button, { code: "KeyA", key: "a" });
    expect(settings.get(FEATURE, "hk", hk)).toBe("Alt+A");
    expect(button.textContent).toContain("按下快捷键");
    expect(button.textContent).toContain("需要");
  });

  it("hotkey: Esc cancels recording and keeps the old combo", async () => {
    const { dialog, settings } = openPage(synthetic(defs));
    const button = dialog.getByRole("button", { name: "快捷键" });
    await userEvent.click(button);
    fireEvent.keyDown(button, { code: "Escape", key: "Escape" });
    expect(settings.get(FEATURE, "hk", hk)).toBe("Alt+A");
    expect(button.textContent).toContain("Alt + A");
    expect(button.textContent).not.toContain("按下快捷键");
  });

  it("hotkey: clear stores the empty string, meaning none", async () => {
    const { dialog, settings } = openPage(synthetic(defs));
    await userEvent.click(dialog.getByRole("button", { name: "清除快捷键" }));
    expect(settings.get(FEATURE, "hk", hk)).toBe("");
    expect(dialog.getByRole("button", { name: "快捷键" }).textContent).toContain("未设置");
  });

  it("percent: shows 85 as 85% and stores what is typed as a fraction", () => {
    const { dialog, settings } = openPage(synthetic(defs));
    const input = dialog.getByLabelText("多有把握") as HTMLInputElement;
    expect(input.value).toBe("85");
    expect(input.min).toBe("50");
    expect(input.max).toBe("99");
    expect(input.step).toBe("1");
    fireEvent.change(input, { target: { value: "70" } });
    expect(settings.get(FEATURE, "pct", pct)).toBe(0.7);
    fireEvent.change(input, { target: { value: "100" } });
    expect(settings.get(FEATURE, "pct", pct)).toBe(0.7); // above max: not stored
    fireEvent.change(input, { target: { value: "49" } });
    expect(settings.get(FEATURE, "pct", pct)).toBe(0.7); // below min: not stored
  });
});

describe("broken rules (R2.6)", () => {
  it("an entry stopped because its feature has an error names that error", () => {
    const r = official();
    const f = r.features[0]!;
    const broken = {
      ...r,
      features: [
        {
          ...f,
          enabled: false,
          problems: [{ severity: "error", message: "继承的 community/base 找不到" }],
          entries: f.entries.map((e) => ({ ...e, enabled: false, problems: [] })),
        },
      ],
    } as unknown as Resolved;
    const { dialog } = openPage(broken);
    const notes = dialog.getAllByText(/规则有问题，已停用：/);
    expect(notes[0]!.textContent).toContain("继承的 community/base 找不到");
  });
});

describe("page entry (round-2 R7.1)", () => {
  it("shows the 网页对照翻译 group with its settings and a switch that can be toggled", async () => {
    const { dialog, storage } = openPage();
    expect(dialog.queryByText("这个版本的陪伴猫还不支持这个入口")).toBeNull();
    const sw = dialog.getByRole("switch", { name: "启用网页对照翻译" });
    expect(sw.hasAttribute("disabled")).toBe(false);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(storage.get(enabledKey(`${FEATURE}.page`))).toBe(false);
  });

  it("lists 用哪个引擎, 显示方式, per-site auto (off) and 快捷键 (Alt + A) in the entry, without the R10.8 note", () => {
    const { dialog } = openPage();
    const group = within(dialog.getByRole("switch", { name: "启用网页对照翻译" }).closest("section")!);
    expect(group.queryByText(/还不支持/)).toBeNull();
    expect(group.getByText("用哪个引擎")).toBeTruthy();
    expect(group.getByText("显示方式")).toBeTruthy();
    expect(group.getByRole("switch", { name: "打开这个网站时自动对照" }).getAttribute("aria-checked")).toBe("false");
    expect(group.getByRole("button", { name: "快捷键" }).textContent).toContain("Alt + A");
  });

  it("leaves the selection entry fully usable", () => {
    const { dialog } = openPage();
    expect(dialog.getByRole("switch", { name: "启用划词翻译" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("bubble quick items (R9.5)", () => {
  function openBubble(resolved = official()) {
    const s = setup({ resolved, registrations: [...(registrations as never[])] });
    act(() => s.cat().click());
    return { ...s, bubble: within(s.q.getByRole("dialog", { name: "陪伴猫" })), settings: createSettingsStore(s.storage), resolved };
  }

  it("shows the hostname, quick settings as compact controls, and engines:first as the main engine", async () => {
    const { bubble, q, settings, resolved } = openBubble();
    expect(bubble.getByText(HOST)).toBeTruthy();
    expect(bubble.getByRole("combobox", { name: "翻译成" }).textContent).toContain("简体中文");
    expect(bubble.getByRole("switch", { name: "在这个网站划词翻译" }).getAttribute("aria-checked")).toBe("true");
    const main = bubble.getByRole("combobox", { name: "卡片里显示哪些引擎" });
    expect(main.textContent).toContain("Google 翻译");
    // non-quick settings stay out
    expect(bubble.queryByRole("switch", { name: "中英互译" })).toBeNull();
    expect(bubble.queryByRole("radio")).toBeNull();
    // choosing a main engine puts it first and keeps the rest
    await userEvent.click(main);
    await userEvent.click(await q.findByRole("option", { name: "微软翻译" }));
    const def = resolved.features[0]!.entries[0]!.def.settings!.engines!;
    expect(settings.get(SELECTION, "engines", def)).toEqual(["official-translate/microsoft", "official-translate/google"]);
  });

  it("shows 对照翻译这个网页 with its hotkey Alt+A as a bubble button (round-2 R7.2)", async () => {
    const s = setup({ resolved: official(), registrations: [...(registrations as never[]), compare] });
    act(() => s.cat().click());
    const bubble = within(s.q.getByRole("dialog", { name: "陪伴猫" }));
    const button = await bubble.findByRole("button", { name: /对照翻译这个网页/ });
    expect(button.textContent).toContain("Alt+A");
  });

  it("shows the page entry's quick items like any entry", () => {
    const { bubble } = openBubble();
    expect(bubble.getByRole("combobox", { name: "显示方式" })).toBeTruthy();
  });

  it("hides the quick items of a feature that is switched off", () => {
    const s = setup({ resolved: official(), registrations: [...(registrations as never[])] });
    act(() => s.storage.set(enabledKey(FEATURE), false));
    act(() => s.cat().click());
    expect(within(s.q.getByRole("dialog", { name: "陪伴猫" })).queryByRole("combobox", { name: "翻译成" })).toBeNull();
  });

  it("counts engines without a key and 去填 opens the first such engine (R9.5)", async () => {
    const Engines = ({ target }: { target?: string }) => <p>引擎页：{target}</p>;
    const s = setup({ resolved: official(), registrations: [...(registrations as never[]), definePage({ id: "engines", group: "companion", component: Engines })] });
    act(() => s.cat().click());
    const bubble = within(s.q.getByRole("dialog", { name: "陪伴猫" }));
    const link = bubble.getByRole("button", { name: /还有 5 个引擎没填 Key/ });
    await userEvent.click(link);
    await waitFor(() => expect(s.q.getByRole("dialog", { name: "陪伴猫设置" })).toBeTruthy());
    expect(s.q.getByRole("heading", { name: "引擎" })).toBeTruthy();
    expect(s.q.getByText("引擎页：engine:official-llm/deepseek")).toBeTruthy();
  });

  it("does not count engines the user switched off", () => {
    const r = official();
    const s = setup({ resolved: r, registrations: [...(registrations as never[])] });
    act(() => createSecretStore(s.storage, () => r).setDisabled("official-llm/deepseek", true));
    act(() => s.cat().click());
    expect(within(s.q.getByRole("dialog", { name: "陪伴猫" })).getByRole("button", { name: /还有 4 个引擎没填 Key/ })).toBeTruthy();
  });

  it("choosing a main engine keeps the list within max", async () => {
    const r = official();
    const def = r.features[0]!.entries[0]!.def.settings!.engines!;
    def.max = 2;
    const { q, bubble, settings, storage } = openBubble(r);
    act(() => {
      createSecretStore(storage, () => r).set("official-llm/deepseek", "apiKey", "k");
      settings.set(SELECTION, "engines", def, ["official-translate/google", "official-translate/microsoft"]);
    });
    await userEvent.click(bubble.getByRole("combobox", { name: "卡片里显示哪些引擎" }));
    await userEvent.click(await q.findByRole("option", { name: "DeepSeek" }));
    expect(settings.get(SELECTION, "engines", def)).toEqual(["official-llm/deepseek", "official-translate/google"]);
  });

  it("drops the link once every key is filled", () => {
    const r = official();
    const s = setup({ resolved: r, registrations: [...(registrations as never[])] });
    const secrets = createSecretStore(s.storage, () => r);
    act(() => {
      for (const p of r.providers) for (const f of p.def.secrets ?? []) secrets.set(p.ref, f.name, "k");
    });
    act(() => s.cat().click());
    expect(within(s.q.getByRole("dialog", { name: "陪伴猫" })).queryByText(/没填 Key/)).toBeNull();
  });
});

describe("automation entry page (R2.3, R3.7, R4.1)", () => {
  const REF = "local/skip-ads.auto";
  const provider = {
    ref: "vid/deepseek",
    id: "deepseek",
    pack: "vid",
    source: 0,
    enabled: true,
    problems: [],
    def: { id: "deepseek", name: "DeepSeek", hosts: ["api.deepseek.com"], implements: { choose: {} } },
  };
  const settings: Record<string, SettingDef> = {
    siteEnabled: { type: "boolean", title: "在这个网站跳过广告", scope: "site", default: false },
    engine: { type: "engine", title: "用哪个引擎判断", capability: "choose", default: "vid/deepseek" },
    threshold: { type: "number", title: "多有把握才直接点", format: "percent", min: 0, max: 1, default: 0.85 },
    below: { type: "enum", title: "低于门槛时", default: "ask", options: { ask: "先问你", hint: "只提示", skip: "不做" } },
  };
  function world(): Resolved {
    const entry = {
      ref: REF,
      id: "auto",
      pack: "local",
      source: 0,
      enabled: true,
      problems: [],
      def: {
        id: "auto",
        name: "自动跳过广告",
        settings,
        triggers: [{ on: "appear", selector: "button" }],
        run: [
          { find: "button", as: "b" },
          { act: "click", target: "{{ vars.b }}", describe: "「跳过广告」按钮", minConfidence: "{{ settings.threshold }}", below: "{{ settings.below }}" },
        ],
      },
    };
    const feature = {
      ref: "local/skip-ads",
      id: "skip-ads",
      pack: "local",
      source: 0,
      enabled: true,
      problems: [],
      def: { id: "skip-ads", name: "跳过广告", icon: "languages", match: ["*://*/*"] },
      entries: [entry],
    };
    return { features: [feature], providers: [provider], views: [], bridges: [], contracts: [], sites: [], diagnostics: [] } as unknown as Resolved;
  }
  const rec = (over: Record<string, unknown>) => ({
    id: "r",
    time: new Date(2026, 10, 17, 10, 5).getTime(),
    site: HOST,
    rule: "跳过广告",
    entry: REF,
    action: "click",
    target: "「跳过广告」按钮",
    mode: "auto",
    confidence: 0.93,
    ...over,
  });

  it("R4.1: engine, threshold percent, below and the per-site switch render through the generic renderer", async () => {
    const { dialog, settings: store, resolved } = openPage(world());
    const def = resolved.features[0]!.entries[0]!.def.settings!;
    expect(dialog.getByRole("switch", { name: "在这个网站跳过广告" }).getAttribute("aria-checked")).toBe("false");
    expect(dialog.getByRole("combobox", { name: "用哪个引擎判断" }).textContent).toContain("DeepSeek");
    expect((dialog.getByRole("spinbutton", { name: "多有把握才直接点" }) as HTMLInputElement).value).toBe("85");
    expect(dialog.getByRole("radio", { name: "先问你" }).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(dialog.getByRole("radio", { name: "只提示" }));
    expect(store.get(REF, "below", def.below!)).toBe("hint");
    await userEvent.click(dialog.getByRole("switch", { name: "在这个网站跳过广告" }));
    expect(store.get(REF, "siteEnabled", def.siteEnabled!, HOST)).toBe(true);
  });

  it("R3.7: lists this entry's actions across sites, newest first, with time, site, action and target, mode and confidence", () => {
    const t = openPage(world());
    act(() => {
      t.storage.set("cc:auto:log:" + HOST, [rec({ id: "a", time: new Date(2026, 10, 17, 10, 5).getTime() })]);
      t.storage.set("cc:auto:log:other.example", [
        rec({ id: "b", site: "other.example", time: new Date(2026, 10, 17, 11, 30).getTime(), mode: "asked-yes", confidence: 0.6 }),
        rec({ id: "x", site: "other.example", entry: "vid/else.auto", target: "别的入口" }),
      ]);
    });
    const items = t.dialog.getAllByRole("listitem").filter((li) => li.closest("[data-log]"));
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/11:30.*other\.example.*点击「跳过广告」按钮.*问过你.*60%/),
      expect.stringMatching(/10:05.*example-blog\.dev.*点击「跳过广告」按钮.*自动.*93%/),
    ]);
    expect(t.dialog.queryByText("别的入口")).toBeNull();
  });

  it("shows an empty note without records, and the failure reason of a failed one", () => {
    const t = openPage(world());
    expect(t.dialog.getByText("还没有动作记录")).toBeTruthy();
    act(() => t.storage.set("cc:auto:log:" + HOST, [rec({ mode: "failed", failure: "找不到按钮", confidence: undefined })]));
    expect(t.dialog.getByText(/找不到按钮/)).toBeTruthy();
    expect(t.dialog.queryByRole("button", { name: "点错了" })).toBeNull();
  });

  it("R2.4: 点错了 on a performed record flags it and puts the rule back to asking", async () => {
    const t = openPage(world());
    act(() => {
      t.storage.set("cc:auto:log:" + HOST, [rec({ id: "a" }), rec({ id: "n", mode: "asked-no" })]);
      t.storage.set("cc:auto:always:" + HOST, [REF]);
    });
    expect(t.dialog.getAllByRole("button", { name: "点错了" })).toHaveLength(1); // only the performed one
    await userEvent.click(t.dialog.getByRole("button", { name: "点错了" }));
    const list = t.storage.get<{ id: string; wrong?: boolean }[]>("cc:auto:log:" + HOST)!;
    expect(list.find((r) => r.id === "a")!.wrong).toBe(true);
    expect(list.find((r) => r.id === "n")!.wrong).toBeUndefined();
    expect(t.storage.get("cc:auto:always:" + HOST)).toBeUndefined();
    expect(t.dialog.queryByRole("button", { name: "点错了" })).toBeNull();
    expect(t.dialog.getByText("已标为点错了")).toBeTruthy();
  });

  it("R2.3: lists the sites that always do this rule, and 撤销 clears only that site's setting", async () => {
    const t = openPage(world());
    expect(t.dialog.getByText("还没有网站设为以后都照做")).toBeTruthy();
    act(() => {
      t.storage.set("cc:auto:always:" + HOST, [REF, "vid/other.auto"]);
      t.storage.set("cc:auto:always:b.example", [REF]);
      t.storage.set("cc:auto:always:c.example", ["vid/other.auto"]);
    });
    expect(t.dialog.getByText("b.example")).toBeTruthy();
    expect(t.dialog.queryByText("c.example")).toBeNull();
    await userEvent.click(t.dialog.getByRole("button", { name: "撤销 b.example" }));
    expect(t.storage.get("cc:auto:always:b.example")).toBeUndefined();
    expect(t.storage.get("cc:auto:always:" + HOST)).toEqual([REF, "vid/other.auto"]);
    expect(t.storage.get("cc:auto:always:c.example")).toEqual(["vid/other.auto"]);
    expect(t.dialog.queryByText("b.example")).toBeNull();
  });

  it("non-automation entries get neither section", () => {
    const { dialog } = openPage();
    expect(dialog.queryByText("动作记录")).toBeNull();
    expect(dialog.queryByText("这个网站以后都照做")).toBeNull();
  });

  it("anchor=log scrolls the 动作记录 section into view", () => {
    const calls: Element[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      calls.push(this);
    };
    try {
      const r = world();
      const s = setup({
        resolved: r,
        registrations: [definePage({ id: "feature", group: "features", component: (p) => <FeaturePage {...p} anchor="log" /> }) as never],
      });
      act(() => s.handle.openSettings(featureTarget(r.features[0]!)));
      expect(calls.some((el) => el.textContent?.includes("动作记录"))).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
});
