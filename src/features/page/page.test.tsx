import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveRules } from "../../core/rules";
import type { Resolved, SettingDef } from "../../core/rules/types";
import { createSettingsStore, createSecretStore } from "../../core/stores";
import { definePage, featureTarget } from "../../shell";
import { setup, unmountAll } from "../../shell/testing";
import registrations from "./register";
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
    expect(dialog.getByText(`只对当前网站 ${HOST} 生效`)).toBeTruthy();
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

describe("unsupported page entry (R10.8)", () => {
  it("shows the 网页对照翻译 group with a note and a switch that cannot be turned on", async () => {
    const { dialog, storage } = openPage();
    expect(dialog.getByText("这个版本的陪伴猫还不支持这个入口")).toBeTruthy();
    const sw = dialog.getByRole("switch", { name: "启用网页对照翻译" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.hasAttribute("disabled")).toBe(true);
    await userEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(storage.keys("cc:on:")).toEqual([]);
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

  it("does not show quick items of the unsupported page entry", () => {
    const { bubble } = openBubble();
    expect(bubble.queryByRole("combobox", { name: "显示方式" })).toBeNull();
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
