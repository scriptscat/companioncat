import { act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EntryDef, Resolved, ResolvedEntry, ResolvedFeature, ResolvedProvider } from "../../core/rules/types";
import { featureTarget } from "../../shell";
import { setup, unmountAll } from "../../shell/testing";
import registrations from "./register";
import { requestConsent } from "./ConfirmEnable";
import { consentKey, enabledKey, fingerprint } from "./enabled";

const FP = "acts:click|hosts:api.deepseek.com";
const REF = "vid/skip-ads.auto";

const provider: ResolvedProvider = {
  ref: "vid/deepseek",
  id: "deepseek",
  pack: "vid",
  source: 0,
  enabled: true,
  problems: [],
  def: { id: "deepseek", name: "DeepSeek", hosts: ["api.deepseek.com"], implements: {} },
} as unknown as ResolvedProvider;

const entryDef = (act = "click"): EntryDef =>
  ({
    id: "auto",
    name: "自动跳过广告",
    settings: {
      engine: { type: "engine", title: "引擎", capability: "choose", default: "vid/deepseek" },
      siteEnabled: { type: "boolean", title: "在这个网站打开", scope: "site", default: false },
    },
    triggers: [{ on: "appear", selector: "button" }],
    run: [
      { find: "button", as: "b" },
      { ask: "choose", engine: "{{ settings.engine }}", input: { question: "哪个是跳过？", options: "{{ vars.b }}" }, as: "r" },
      { act, target: "{{ vars.b }}", describe: "「跳过广告」按钮" },
    ],
  }) as unknown as EntryDef;

function world(pack = "vid", def = entryDef()): Resolved {
  const entry: ResolvedEntry = { ref: `${pack}/skip-ads.auto`, id: "auto", pack, source: 0, enabled: true, problems: [], def };
  const feature: ResolvedFeature = {
    ref: `${pack}/skip-ads`,
    id: "skip-ads",
    pack,
    source: 0,
    enabled: true,
    problems: [],
    def: { id: "skip-ads", name: "跳过广告", icon: "languages", match: ["*://*/*"] },
    entries: [entry],
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

function openPage(resolved: Resolved, prep?: (s: ReturnType<typeof setup>["storage"]) => void) {
  const s = setup({ resolved, registrations: [...(registrations as never[])] });
  prep?.(s.storage);
  s.storage.set("cc:app:pack-versions", { vid: { from: "2026.11.01", to: "2026.11.17" } });
  act(() => s.handle.openSettings(featureTarget(resolved.features[0]!)));
  const dialog = within(s.q.getByRole("dialog", { name: "陪伴猫设置" }));
  const sw = () => dialog.getByRole("switch", { name: "启用自动跳过广告" });
  const confirm = () => s.q.findByRole("alertdialog");
  return { ...s, dialog, sw, confirm };
}

describe("enable confirmation (R3.2, R9.3)", () => {
  it("opening the switch of a subscribed automation entry asks first and lists acts, sends, place and pack", async () => {
    const t = openPage(world());
    expect(t.sw().getAttribute("aria-checked")).toBe("false");
    await userEvent.click(t.sw());
    const d = within(await t.confirm());
    expect(d.getByRole("heading").textContent).toContain("自动跳过广告");
    expect(d.getByText("点击")).toBeTruthy(); // acts, human label
    expect(d.getByText("api.deepseek.com")).toBeTruthy(); // sends: host
    expect(d.getByText(/DeepSeek/)).toBeTruthy(); // sends: engine
    expect(d.getByText(/所有网站/)).toBeTruthy(); // match
    expect(d.getByText(/单独打开/)).toBeTruthy(); // per site
    expect(d.getByText(/vid/)).toBeTruthy(); // pack
    expect(d.getByText(/v2026\.11\.17/)).toBeTruthy(); // version
    expect(t.sw().getAttribute("aria-checked")).toBe("false");
  });

  it("先不打开 leaves it off, stores nothing and returns focus to the switch", async () => {
    const t = openPage(world());
    t.sw().focus();
    await userEvent.click(t.sw());
    await userEvent.click(within(await t.confirm()).getByRole("button", { name: "先不打开" }));
    await waitFor(() => expect(t.q.queryByRole("alertdialog")).toBeNull());
    expect(t.sw().getAttribute("aria-checked")).toBe("false");
    expect(t.storage.get(consentKey(REF))).toBeUndefined();
    expect(t.root.activeElement).toBe(t.sw());
  });

  it("打开 consents with the fingerprint and turns the entry on", async () => {
    const t = openPage(world());
    await userEvent.click(t.sw());
    await userEvent.click(within(await t.confirm()).getByRole("button", { name: "打开" }));
    await waitFor(() => expect(t.sw().getAttribute("aria-checked")).toBe("true"));
    expect(t.storage.get(consentKey(REF))).toBe(FP);
    expect(fingerprint(world().features[0]!.entries[0]!.def, { providers: [provider], hosts: { "vid/deepseek": ["api.deepseek.com"] } })).toBe(FP);
  });

  it("after an update that changed the hosts, the switch is off and the title says the address changed", async () => {
    const t = openPage(world(), (s) => s.set(consentKey(REF), "acts:click|hosts:old.example"));
    expect(t.sw().getAttribute("aria-checked")).toBe("false");
    await userEvent.click(t.sw());
    const d = within(await t.confirm());
    expect(d.getByRole("heading").textContent).toContain("发送地址");
    expect(d.getByRole("heading").textContent).not.toContain("动作");
    await userEvent.click(d.getByRole("button", { name: "打开" }));
    await waitFor(() => expect(t.storage.get(consentKey(REF))).toBe(FP));
  });

  it("after an update that changed the acts, the title says the actions changed", async () => {
    const t = openPage(world(), (s) => s.set(consentKey(REF), "acts:fill|hosts:api.deepseek.com"));
    await userEvent.click(t.sw());
    const h = within(await t.confirm()).getByRole("heading").textContent;
    expect(h).toContain("动作");
    expect(h).not.toContain("发送地址");
  });

  it("R3.4: a local entry turns on without a dialog or consent", async () => {
    const t = openPage(world("local"));
    expect(t.sw().getAttribute("aria-checked")).toBe("true");
    await userEvent.click(t.sw());
    expect(t.sw().getAttribute("aria-checked")).toBe("false");
    await userEvent.click(t.sw());
    expect(t.q.queryByRole("alertdialog")).toBeNull();
    expect(t.sw().getAttribute("aria-checked")).toBe("true");
    expect(t.storage.keys("cc:auto:")).toEqual([]);
  });

  it("a switched-off entry with unchanged consent turns back on without a dialog", async () => {
    const t = openPage(world(), (s) => {
      s.set(consentKey(REF), FP);
      s.set(enabledKey(REF), false);
    });
    await userEvent.click(t.sw());
    expect(t.q.queryByRole("alertdialog")).toBeNull();
    expect(t.sw().getAttribute("aria-checked")).toBe("true");
  });

  it("keyboard: focus enters on 先不打开, Tab stays inside, Esc means 先不打开", async () => {
    const t = openPage(world());
    t.sw().focus();
    await userEvent.click(t.sw());
    const d = within(await t.confirm());
    const no = d.getByRole("button", { name: "先不打开" });
    const yes = d.getByRole("button", { name: "打开" });
    await waitFor(() => expect(t.root.activeElement).toBe(no));
    await userEvent.tab();
    expect(t.root.activeElement).toBe(yes);
    await userEvent.tab();
    expect(t.root.activeElement).toBe(no);
    await userEvent.tab({ shift: true });
    expect(t.root.activeElement).toBe(yes);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(t.q.queryByRole("alertdialog")).toBeNull());
    expect(t.storage.get(consentKey(REF))).toBeUndefined();
    expect(t.root.activeElement).toBe(t.sw());
    // Esc did not also close the settings window
    expect(t.q.queryByRole("dialog", { name: "陪伴猫设置" })).toBeTruthy();
  });
});

describe("requestConsent (for the bubble and the automation runtime)", () => {
  const ctxOf = (t: ReturnType<typeof setup>, hostname = "example-blog.dev") => ({
    layer: t.root.querySelector<HTMLElement>("[data-cc-layer]")!,
    services: { storage: t.storage, rules: { get: () => world(), subscribe: () => () => {} } },
    hostname,
  });

  it("resolves true after 打开 and false after 先不打开", async () => {
    const t = setup({ resolved: world() });
    const c = ctxOf(t);
    const no = requestConsent(c, REF);
    await userEvent.click(await t.q.findByRole("button", { name: "先不打开" }));
    await expect(no).resolves.toBe(false);
    expect(t.storage.get(consentKey(REF))).toBeUndefined();
    const yes = requestConsent(c, REF);
    await userEvent.click(await t.q.findByRole("button", { name: "打开" }));
    await expect(yes).resolves.toBe(true);
    expect(t.storage.get(consentKey(REF))).toBe(FP);
    // consent is current now: no dialog
    await expect(requestConsent(c, REF)).resolves.toBe(true);
    expect(t.q.queryByRole("alertdialog")).toBeNull();
  });

  it("resolves false for an entry it does not know", async () => {
    const t = setup({ resolved: world() });
    const c = ctxOf(t, "x");
    await expect(requestConsent(c, "vid/nope.entry")).resolves.toBe(false);
  });
});
