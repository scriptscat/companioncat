import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { compileStyles } from "../ui/compile-css";
import { Menu, Picker, Btn } from "../ui";
import { definePage } from "./registry";
import { setup, unmountAll } from "./testing";

let css = "";
beforeAll(async () => {
  css = await compileStyles();
  // jsdom lacks these; Radix popups call them.
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

let hostile: HTMLStyleElement | undefined;
afterEach(() => {
  unmountAll();
  hostile?.remove();
});

const pageCss = (text: string) => {
  hostile = document.createElement("style");
  hostile.textContent = text;
  document.head.append(hostile);
};

describe("style isolation (R1.2)", () => {
  it("lives in one shadow host on <html>, adds nothing to the page's <head>", () => {
    const headBefore = document.head.children.length;
    const { handle } = setup({ css });
    expect(handle.host.parentNode).toBe(document.documentElement);
    expect(handle.host.shadowRoot).toBe(handle.root);
    expect(document.querySelectorAll(handle.host.localName)).toHaveLength(1);
    expect(document.head.children.length).toBe(headBefore);
    const sheets = handle.root.adoptedStyleSheets;
    const text = sheets.flatMap((s) => [...s.cssRules].map((r) => r.cssText)).join("\n");
    expect(text).toContain("--paper");
  });

  it("the page's CSS (including html { font-size: 10px } and !important rules) does not change the UI", () => {
    pageCss(`html { font-size: 10px !important; }
      * { color: rgb(0, 0, 255) !important; font-size: 30px !important; font-family: Papyrus !important; }
      button { display: none !important; }
      companion-cat { display: none !important; }`);
    const { handle, cat } = setup({ css });
    const style = getComputedStyle(cat());
    expect(style.fontSize).toBe("14px");
    expect(style.color).toBe("rgb(42, 36, 33)");
    expect(style.display).not.toBe("none");
    expect(getComputedStyle(handle.host).display).not.toBe("none");
  });

  it("the UI's CSS does not change the page: no sheet reaches the document", () => {
    const sheets = document.styleSheets.length;
    const adopted = document.adoptedStyleSheets.length;
    const { handle } = setup({ css });
    expect(handle.root.adoptedStyleSheets.length).toBeGreaterThan(0);
    expect(document.styleSheets.length).toBe(sheets);
    expect(document.adoptedStyleSheets.length).toBe(adopted);
  });

  it("opening a Radix menu or select leaves the page's <body> untouched (no aria-hidden, no scroll lock)", async () => {
    const user = userEvent.setup();
    const article = document.createElement("article");
    document.body.append(article);
    const Page = () => (
      <div>
        <Menu trigger={<Btn>更多</Btn>} items={[{ label: "删除" }]} />
        <Picker label="翻译成" defaultValue="zh-CN" options={[{ value: "zh-CN", label: "中文" }, { value: "en", label: "English" }]} />
      </div>
    );
    const { handle, q } = setup({ css, registrations: [definePage({ id: "general", group: "companion", component: Page })] });
    act(() => handle.openSettings("general"));
    const untouched = () => {
      for (const el of [document.body, ...document.body.children]) {
        expect(el.getAttribute("aria-hidden")).toBeNull();
        expect(el.getAttribute("data-aria-hidden")).toBeNull();
        expect(el.getAttribute("data-scroll-locked")).toBeNull();
      }
    };
    try {
      await user.click(q.getByRole("button", { name: "更多" }));
      await q.findByRole("menuitem", { name: "删除" });
      untouched();
      await user.keyboard("{Escape}");
      await user.click(q.getByRole("combobox", { name: "翻译成" }));
      await q.findByRole("listbox");
      untouched();
    } finally {
      article.remove();
    }
  });

  it("Radix popups (menu, select) mount inside the shadow root, not in document.body", async () => {
    const user = userEvent.setup();
    const Page = () => (
      <div>
        <Menu trigger={<Btn>更多</Btn>} items={[{ label: "删除" }]} />
        <Picker label="翻译成" defaultValue="zh-CN" options={[{ value: "zh-CN", label: "中文" }, { value: "en", label: "English" }]} />
      </div>
    );
    const { handle, q } = setup({ css, registrations: [definePage({ id: "general", group: "companion", component: Page })] });
    act(() => handle.openSettings("general"));

    await user.click(q.getByRole("button", { name: "更多" }));
    const item = await q.findByRole("menuitem", { name: "删除" });
    expect(handle.root.contains(item)).toBe(true);
    expect(screen.queryByRole("menuitem")).toBeNull();
    await user.keyboard("{Escape}");

    await user.click(q.getByRole("combobox", { name: "翻译成" }));
    const listbox = await q.findByRole("listbox");
    expect(handle.root.contains(listbox)).toBe(true);
    expect(within(listbox).getByRole("option", { name: "English" })).toBeTruthy();
    expect(document.body.querySelector("[role=listbox]")).toBeNull();
  });
});
