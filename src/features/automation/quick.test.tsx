import { act, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EntryDef, Resolved, ResolvedEntry, ResolvedFeature, ResolvedProvider } from "../../core/rules/types";
import { createActionLog, createAutomationPrefs } from "../../core/stores";
import { defineFeature } from "../../shell";
import { setup, unmountAll } from "../../shell/testing";
import { consentKey } from "../page/enabled";
import pageRegistrations from "../page/register";
import { Quick } from "./Quick";

const HOST = "vidoo.example";
const FP = "acts:click|hosts:api.deepseek.com";

const provider = {
  ref: "vid/deepseek",
  id: "deepseek",
  pack: "vid",
  source: 0,
  enabled: true,
  problems: [],
  def: { id: "deepseek", name: "DeepSeek", hosts: ["api.deepseek.com"], implements: {} },
} as unknown as ResolvedProvider;

const autoDef = (extra: Partial<EntryDef> = {}): EntryDef =>
  ({
    id: "auto",
    name: "跳过广告",
    description: "出现跳过按钮时，把握 85% 以上就点",
    settings: { siteEnabled: { type: "boolean", title: "在这个网站跳过广告", scope: "site", default: false, quick: true } },
    triggers: [{ on: "appear", selector: "button" }],
    run: [
      { find: "button", as: "b" },
      { ask: "choose", engine: "vid/deepseek", input: { question: "哪个是跳过？", options: "{{ vars.b }}" }, as: "r" },
      { act: "click", target: "{{ vars.b }}", describe: "「跳过广告」按钮" },
    ],
    ...extra,
  }) as unknown as EntryDef;

const quizDef = (): EntryDef =>
  ({
    id: "quiz",
    name: "做题",
    description: "你叫它做，不会自己开始",
    triggers: [{ on: "command", title: "帮我做这页的题", quick: true }],
    run: [{ find: "input", as: "q" }, { act: "fill", target: "{{ vars.q }}", value: "x" }],
  }) as unknown as EntryDef;

const plainDef = (): EntryDef =>
  ({ id: "sel", name: "划词翻译", triggers: [{ on: "selection" }], run: [{ call: "translate", as: "t" }], present: { surface: "near-selection", view: { use: "x" } } }) as unknown as EntryDef;

const entry = (pack: string, id: string, def: EntryDef): ResolvedEntry =>
  ({ ref: `${pack}/skip-ads.${id}`, id, pack, source: 0, enabled: true, problems: [], def }) as unknown as ResolvedEntry;

function world(opts: { pack?: string; match?: string[]; defs?: EntryDef[] } = {}): Resolved {
  const pack = opts.pack ?? "vid";
  const defs = opts.defs ?? [autoDef(), quizDef()];
  const feature = {
    ref: `${pack}/skip-ads`,
    id: "skip-ads",
    pack,
    source: 0,
    enabled: true,
    problems: [],
    def: { id: "skip-ads", name: "跳过广告功能", icon: "languages", match: opts.match ?? ["*://vidoo.example/*"] },
    entries: defs.map((d) => entry(pack, d.id, d)),
  } as unknown as ResolvedFeature;
  return { features: [feature], providers: [provider], views: [], bridges: [], contracts: [], sites: [], diagnostics: [] };
}

beforeAll(() => {
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

function openBubble(resolved: Resolved, opts: { page?: boolean; prep?: (s: ReturnType<typeof setup>) => void } = {}) {
  const registrations = [
    ...(opts.page ? (pageRegistrations as never[]) : []),
    defineFeature({
      id: "automation",
      quick: Quick,
      start(ctx) {
        const prefs = createAutomationPrefs(ctx.services.storage);
        // the shell re-reads `disabled` only when the command registry changes, so the registering feature re-registers on a pause change
        const register = () => ctx.commands.register({ id: "quiz", title: "帮我做这页的题", quick: true, run() {}, disabled: () => prefs.isPaused(ctx.hostname) });
        register();
        prefs.subscribe(register);
      },
    }),
  ];
  const s = setup({ resolved, hostname: HOST, registrations });
  opts.prep?.(s);
  act(() => void fireEvent.click(s.cat()));
  return s;
}

describe("bubble 「自动化」 group (R3.6)", () => {
  it("is absent where no automation entry matches, or only non-automation entries exist", () => {
    const other = openBubble(world({ match: ["*://other.example/*"] }));
    expect(other.q.queryByText("自动化")).toBeNull();
    unmountAll();
    const plain = openBubble(world({ defs: [plainDef()] }));
    expect(plain.q.queryByText("自动化")).toBeNull();
  });

  it("lists matching entries: name and description, a switch for per-site ones, 命令 for command ones", async () => {
    const s = openBubble(world({ pack: "local" }));
    expect(s.q.getByText("自动化")).toBeTruthy();
    expect(s.q.getByText("跳过广告")).toBeTruthy();
    expect(s.q.getByText("出现跳过按钮时，把握 85% 以上就点")).toBeTruthy();
    const sw = s.q.getByRole("switch", { name: "跳过广告" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(sw);
    expect(s.storage.get(`cc:set:local/skip-ads.auto/siteEnabled@${HOST}`)).toBe(true);
    await waitFor(() => expect(s.q.getByRole("switch", { name: "跳过广告" }).getAttribute("aria-checked")).toBe("true"));
    expect(s.q.getByText("做题")).toBeTruthy();
    expect(s.q.getByText("命令")).toBeTruthy();
    expect(s.q.queryByRole("switch", { name: "做题" })).toBeNull();
  });

  it("does not list the entry's quick setting a second time (page Quick skips automation entries)", () => {
    const s = openBubble(world({ pack: "local" }), { page: true });
    expect(s.q.getAllByRole("switch", { name: /跳过广告/ })).toHaveLength(1);
  });

  it("turning on a subscribed entry asks for consent first: 先不打开 keeps it off, 打开 enables it", async () => {
    const s = openBubble(world());
    await userEvent.click(s.q.getByRole("switch", { name: "跳过广告" }));
    const d = within(await s.q.findByRole("alertdialog"));
    await userEvent.click(d.getByRole("button", { name: "先不打开" }));
    await waitFor(() => expect(s.q.queryByRole("alertdialog")).toBeNull());
    expect(s.q.getByRole("switch", { name: "跳过广告" }).getAttribute("aria-checked")).toBe("false");
    expect(s.storage.get(consentKey("vid/skip-ads.auto"))).toBeUndefined();

    await userEvent.click(s.q.getByRole("switch", { name: "跳过广告" }));
    await userEvent.click(within(await s.q.findByRole("alertdialog")).getByRole("button", { name: "打开" }));
    await waitFor(() => expect(s.q.getByRole("switch", { name: "跳过广告" }).getAttribute("aria-checked")).toBe("true"));
    expect(s.storage.get(consentKey("vid/skip-ads.auto"))).toBe(FP);
  });

  it("the pause switch pauses this site at once, greys the command button and the entry switches; off restores", async () => {
    const s = openBubble(world({ pack: "local" }));
    const pause = s.q.getByRole("switch", { name: "在这个网站暂停自动化" });
    expect(pause.getAttribute("aria-checked")).toBe("false");
    expect(s.q.getByRole("button", { name: /帮我做这页的题/ }).getAttribute("aria-disabled")).not.toBe("true");
    await userEvent.click(pause);
    expect(createAutomationPrefs(s.storage).isPaused(HOST)).toBe(true);
    await waitFor(() => expect(s.q.getByRole("button", { name: /帮我做这页的题/ }).getAttribute("aria-disabled")).toBe("true"));
    expect(s.q.getByRole("switch", { name: "跳过广告" }).hasAttribute("disabled")).toBe(true);
    await userEvent.click(s.q.getByRole("switch", { name: "在这个网站暂停自动化" }));
    expect(createAutomationPrefs(s.storage).isPaused(HOST)).toBe(false);
    await waitFor(() => expect(s.q.getByRole("button", { name: /帮我做这页的题/ }).getAttribute("aria-disabled")).not.toBe("true"));
  });

  it("shows this site's recent actions with time, action and target, rule, mode and confidence", () => {
    const at = new Date(2026, 10, 17, 16, 42).getTime();
    const s = openBubble(world({ pack: "local" }), {
      prep: ({ storage }) => {
        const log = createActionLog(storage, () => at);
        log.append({ site: HOST, rule: "跳过广告", entry: "local/skip-ads.auto", action: "click", target: "「跳过广告 5」按钮", confidence: 0.93, mode: "auto" });
        log.append({ site: HOST, rule: "跳过广告", entry: "local/skip-ads.auto", action: "click", target: "「跳过广告」按钮", confidence: 0.72, mode: "asked-yes" });
        log.append({ site: HOST, rule: "跳过广告", entry: "local/skip-ads.auto", action: "click", target: "「跳过片头」按钮", confidence: 0.91, mode: "not-applicable" });
        log.append({ site: HOST, rule: "跳过广告", entry: "local/skip-ads.auto", action: "click", target: "「x」", mode: "skip" });
        log.append({ site: "other.example", rule: "别站规则", entry: "e", action: "click", target: "别站目标", mode: "auto" });
      },
    });
    expect(s.q.getByText("最近动作")).toBeTruthy();
    expect(s.q.getAllByText("16:42").length).toBeGreaterThan(0);
    expect(s.q.getByText(/点击\s*「跳过广告 5」按钮/)).toBeTruthy();
    expect(s.q.getByText("93%")).toBeTruthy();
    expect(s.q.getByText("跳过广告 · 自动")).toBeTruthy();
    expect(s.q.getByText("跳过广告 · 问过你")).toBeTruthy();
    expect(s.q.getByText("72%")).toBeTruthy();
    expect(s.q.getByText("跳过广告 · 不是广告")).toBeTruthy();
    // an element the engine judged not an ad was not clicked (mockup v6: 没点「跳过片头」按钮)
    expect(s.q.getByText(/^没点击\s*「跳过片头」按钮$/)).toBeTruthy();
    expect(s.q.getByText("跳过广告 · 没点")).toBeTruthy();
    expect(s.q.queryByText(/别站/)).toBeNull();
  });

  it("全部 opens the feature page through openSettings", async () => {
    const s = openBubble(world({ pack: "local" }), {
      page: true,
      prep: ({ storage }) => createActionLog(storage).append({ site: HOST, rule: "r", entry: "e", action: "click", target: "t", mode: "auto" }),
    });
    await userEvent.click(s.q.getByRole("button", { name: /全部/ }));
    const dialog = within(await s.q.findByRole("dialog", { name: "陪伴猫设置" }));
    expect(dialog.getAllByText("跳过广告功能").length).toBeGreaterThan(0);
  });
});
