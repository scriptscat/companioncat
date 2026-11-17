import { act, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { definePage } from "./registry";
import { useShell } from "./context";
import { EMPTY, feature, focused, rulesSource, setup, unmountAll, withFeatures } from "./testing";

const setWidth = (w: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: w });
  window.dispatchEvent(new Event("resize"));
};

beforeEach(() => setWidth(1024));
afterEach(() => {
  unmountAll();
  setWidth(1024);
});

const open = (h: { handle: { openSettings(to?: string): void } }, to?: string) => act(() => h.handle.openSettings(to));
const dialog = (q: ReturnType<typeof setup>["q"]) => q.getByRole("dialog", { name: "陪伴猫设置" });
const labels = (el: HTMLElement) => within(el).getAllByRole("button").map((b) => b.textContent?.trim());

describe("settings window layout (R1.5)", () => {
  it("desktop: centred window, nav groups 「功能」 (rule features, priority order) and 「陪伴猫」 (引擎 规则 通用)", () => {
    const s = setup({
      resolved: withFeatures(feature("local", "notes", "笔记", 2), feature("official-translate", "translate", "翻译", 0)),
    });
    open(s);
    const d = dialog(s.q);
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.className).toContain("rounded-[28px]");
    const nav = within(d).getByRole("navigation", { name: "设置分区" });
    expect(labels(within(nav).getByRole("group", { name: "功能" }))).toEqual(["笔记", "翻译"]);
    expect(labels(within(nav).getByRole("group", { name: "陪伴猫" }))).toEqual(["引擎", "规则", "通用"]);
    expect(within(d).queryByRole("radiogroup")).toBeNull();
  });

  it("the window surface is an opaque token fill, not an alpha colour (R13.4)", () => {
    const s = setup({ resolved: EMPTY });
    open(s);
    const cls = dialog(s.q).className;
    expect(cls).toContain("bg-paper");
    expect(cls).not.toMatch(/bg-[a-z-]+\/\d+/);
  });

  it("renders the registered page for a slot and marks the nav item current", async () => {
    const user = userEvent.setup();
    const General = () => <p>外观设置在这里</p>;
    const s = setup({ registrations: [definePage({ id: "general", group: "companion", component: General })] });
    open(s);
    const d = dialog(s.q);
    await user.click(within(d).getByRole("button", { name: "通用" }));
    expect(d.textContent).toContain("外观设置在这里");
    expect(within(d).getByRole("heading", { level: 2 }).textContent).toBe("通用");
    expect(within(d).getByRole("button", { name: "通用" }).getAttribute("aria-current")).toBe("page");
  });

  it("feature pages use the registered feature renderer with that feature", async () => {
    const user = userEvent.setup();
    const FeaturePage = ({ feature }: { feature?: { def: { name: string } } }) => <p>功能页：{feature?.def.name}</p>;
    const s = setup({ registrations: [definePage({ id: "feature", group: "features", component: FeaturePage })] });
    open(s);
    await user.click(within(dialog(s.q)).getByRole("button", { name: "翻译" }));
    expect(dialog(s.q).textContent).toContain("功能页：翻译");
  });

  it("switching between features gives each its own page state", async () => {
    const user = userEvent.setup();
    const FeaturePage = () => {
      const [n, setN] = useState(0);
      return (
        <button type="button" onClick={() => setN(n + 1)}>
          点了 {n} 次
        </button>
      );
    };
    const s = setup({
      resolved: withFeatures(feature("p", "a", "甲"), feature("p", "b", "乙")),
      registrations: [definePage({ id: "feature", group: "features", component: FeaturePage })],
    });
    open(s, "feature:p/a");
    await user.click(within(dialog(s.q)).getByRole("button", { name: "点了 0 次" }));
    expect(within(dialog(s.q)).getByRole("button", { name: "点了 1 次" })).toBeTruthy();
    await user.click(within(dialog(s.q)).getByRole("button", { name: "乙" }));
    expect(within(dialog(s.q)).getByRole("button", { name: "点了 0 次" })).toBeTruthy();
  });

  it("a page that throws while rendering shows an error in its place; the window and the cat stay", async () => {
    const user = userEvent.setup();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const Broken = (): never => {
        throw new Error("坏掉了");
      };
      const General = () => <p>通用页</p>;
      const s = setup({
        registrations: [
          definePage({ id: "engines", group: "companion", component: Broken }),
          definePage({ id: "general", group: "companion", component: General }),
        ],
      });
      open(s, "engines");
      const d = dialog(s.q);
      expect(within(d).getByRole("alert").textContent).toContain("坏掉了");
      expect(s.cat()).toBeTruthy();
      await user.click(within(d).getByRole("button", { name: "通用" }));
      expect(dialog(s.q).textContent).toContain("通用页");
    } finally {
      quiet.mockRestore();
    }
  });

  it("R9.12/R10.5: an `engine:<ref>` target opens the engines page and hands it the target", () => {
    const Engines = ({ target }: { target?: string }) => <p>引擎页：{target}</p>;
    const s = setup({ registrations: [definePage({ id: "engines", group: "companion", component: Engines })] });
    open(s, "engine:official-translate/google");
    const d = dialog(s.q);
    expect(within(d).getByRole("heading", { level: 2 }).textContent).toBe("引擎");
    expect(d.textContent).toContain("引擎页：engine:official-translate/google");
    expect(within(d).getByRole("button", { name: "引擎" }).getAttribute("aria-current")).toBe("page");
  });

  it("R9.1: a feature's nav icon is the one its rule names (the same icon names views use)", () => {
    const f = feature("local", "notes", "笔记");
    const s = setup({ resolved: withFeatures({ ...f, def: { ...f.def, icon: "globe" } }) });
    open(s);
    const button = within(dialog(s.q)).getByRole("button", { name: "笔记" });
    expect(button.querySelector("svg")!.getAttribute("class")).toContain("lucide-globe");
  });

  it("extra companion pages append after the three built-ins", () => {
    const s = setup({ registrations: [definePage({ id: "about", group: "companion", label: "关于", component: () => null })] });
    open(s);
    const nav = within(dialog(s.q)).getByRole("group", { name: "陪伴猫" });
    expect(labels(nav)).toEqual(["引擎", "规则", "通用", "关于"]);
  });

  it("narrow (< 640px): fills the screen with segmented sections on top, and follows resizes", () => {
    setWidth(390);
    const s = setup();
    open(s);
    let d = dialog(s.q);
    expect(d.className).toContain("h-full w-full");
    expect(within(d).queryByRole("navigation")).toBeNull();
    const seg = within(d).getByRole("radiogroup", { name: "设置分区" });
    expect(within(seg).getAllByRole("radio").map((r) => r.textContent)).toEqual(["翻译", "引擎", "规则", "通用"]);
    expect(within(seg).getByRole("radio", { name: "引擎" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(seg).getByRole("radio", { name: "规则" }));
    expect(within(seg).getByRole("radio", { name: "规则" }).getAttribute("aria-checked")).toBe("true");
    act(() => setWidth(1024));
    d = dialog(s.q);
    expect(within(d).getByRole("navigation", { name: "设置分区" })).toBeTruthy();
    expect(within(d).getByRole("button", { name: "规则" }).getAttribute("aria-current")).toBe("page");
  });

  it("the close button closes it", async () => {
    const user = userEvent.setup();
    const s = setup();
    open(s);
    await user.click(within(dialog(s.q)).getByRole("button", { name: "关闭 (Esc)" }));
    expect(s.q.queryByRole("dialog", { name: "陪伴猫设置" })).toBeNull();
  });

  it("follows rule changes without reopening (R1.8)", () => {
    const rules = rulesSource(EMPTY);
    const s = setup({ rules });
    open(s);
    act(() => rules.set(withFeatures(feature("official-translate", "translate", "翻译"))));
    expect(labels(within(dialog(s.q)).getByRole("group", { name: "功能" }))).toEqual(["翻译"]);
  });
});

describe("no rules (R1.6)", () => {
  it("「功能」 is empty and says features come from rules; the engine page says the cat knows nothing yet", async () => {
    const user = userEvent.setup();
    let subscribed = 0;
    const s = setup({ resolved: EMPTY, subscribeOfficial: () => void subscribed++ });
    open(s);
    const d = dialog(s.q);
    const group = within(d).getByRole("group", { name: "功能" });
    expect(within(group).queryAllByRole("button")).toEqual([]);
    expect(group.textContent).toContain("功能由规则提供");
    expect(within(d).getByRole("button", { name: "引擎" }).getAttribute("aria-current")).toBe("page");
    expect(d.textContent).toContain("陪伴猫还什么都不会");
    await user.click(within(d).getByRole("button", { name: "订阅官方规则" }));
    expect(subscribed).toBe(1);
  });

  it("the engine empty state replaces the registered engine page only while there are no rules", () => {
    const Engines = () => <p>引擎列表</p>;
    const rules = rulesSource(EMPTY);
    const s = setup({ rules, registrations: [definePage({ id: "engines", group: "companion", component: Engines })] });
    open(s, "engines");
    expect(dialog(s.q).textContent).not.toContain("引擎列表");
    act(() => rules.set(withFeatures(feature("official-translate", "translate", "翻译"))));
    expect(dialog(s.q).textContent).toContain("引擎列表");
    expect(dialog(s.q).textContent).not.toContain("陪伴猫还什么都不会");
  });

  it("narrow: the segmented control has only the built-in sections", () => {
    setWidth(390);
    const s = setup({ resolved: EMPTY });
    open(s);
    const seg = within(dialog(s.q)).getByRole("radiogroup", { name: "设置分区" });
    expect(within(seg).getAllByRole("radio").map((r) => r.textContent)).toEqual(["引擎", "规则", "通用"]);
  });
});

describe("Esc, focus trap and focus return (R13.3)", () => {
  it("moves focus into the window, keeps Tab inside it, closes on Esc and returns focus to the page element", () => {
    const outside = document.createElement("button");
    outside.textContent = "page button";
    document.body.append(outside);
    outside.focus();
    const s = setup();
    open(s);
    const d = dialog(s.q);
    expect(d.contains(focused(s.root))).toBe(true);

    const tabbables = [...d.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, select, textarea, [tabindex='0']")];
    const last = tabbables[tabbables.length - 1]!;
    act(() => last.focus());
    fireEvent.keyDown(last, { key: "Tab" });
    expect(focused(s.root)).toBe(tabbables[0]);
    fireEvent.keyDown(tabbables[0]!, { key: "Tab", shiftKey: true });
    expect(focused(s.root)).toBe(last);

    // (an IconBtn's tooltip is its own Radix layer and takes the first Esc, like any Radix popup)
    act(() => tabbables[0]!.focus());
    fireEvent.keyDown(tabbables[0]!, { key: "Escape" });
    expect(s.q.queryByRole("dialog", { name: "陪伴猫设置" })).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("opened from the bubble: Esc returns focus to the cat", async () => {
    const user = userEvent.setup();
    const s = setup();
    await user.click(s.cat());
    await user.click(s.q.getByRole("button", { name: "打开设置" }));
    expect(s.q.queryByRole("dialog", { name: "陪伴猫" })).toBeNull();
    fireEvent.keyDown(focused(s.root)!, { key: "Escape" });
    expect(s.q.queryByRole("dialog", { name: "陪伴猫设置" })).toBeNull();
    expect(focused(s.root)).toBe(s.cat());
  });

  it("Esc inside an open popup closes only the popup", () => {
    let close!: () => void;
    const Page = () => {
      const shell = useShell();
      close = shell.closeSettings;
      return (
        <input
          aria-label="inner"
          onKeyDown={(e) => {
            if (e.key === "Escape") e.preventDefault();
          }}
        />
      );
    };
    const s = setup({ registrations: [definePage({ id: "general", group: "companion", component: Page })] });
    open(s, "general");
    fireEvent.keyDown(s.q.getByRole("textbox", { name: "inner" }), { key: "Escape" });
    expect(s.q.queryByRole("dialog", { name: "陪伴猫设置" })).not.toBeNull();
    act(() => close());
    expect(s.q.queryByRole("dialog", { name: "陪伴猫设置" })).toBeNull();
  });
});
