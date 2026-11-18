import { act, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmStorageFake } from "../../test/fakes/gm-storage";
import { boot, type GmApi } from "./boot";
import { defineFeature, type Command, type RuntimeContext } from "./registry";
import type { ShellHandle } from "./mount";
import { feature, setup, unmountAll, withFeatures } from "./testing";

afterEach(() => {
  unmountAll();
  document.body.innerHTML = "";
});

const PAUSED = "这个网站的自动化已暂停";

/** Mounts with one feature that registers `cmd` and exposes ctx. */
function withCommand(cmd: Command, menu?: (title: string, run: () => void) => void) {
  let ctx!: RuntimeContext;
  let unregister!: () => void;
  const reg = defineFeature({
    id: "auto",
    start(c) {
      ctx = c;
      unregister = c.commands.register(cmd);
    },
  });
  const s = setup({
    registrations: [reg],
    registerMenu: menu,
    resolved: withFeatures(feature("p", "auto", "自动化")),
  });
  return { ...s, ctx: () => ctx, unregister: () => unregister() };
}

const openBubble = (s: ReturnType<typeof setup>) => act(() => void fireEvent.click(s.cat()));
const key = (init: KeyboardEventInit & { target?: Element }) => {
  const { target, ...rest } = init;
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, ...rest });
  act(() => void (target ?? document.body).dispatchEvent(ev));
  return ev;
};
const altA = { code: "KeyA", key: "å", altKey: true };

describe("commands (R1.1 command, R3.6, R7.2)", () => {
  it("a quick command is a bubble button running its handler; non-quick ones are not shown", () => {
    const run = vi.fn();
    const s = withCommand({ id: "compare", title: "对照翻译这个网页", hotkey: "Alt+A", quick: true, run });
    s.ctx().commands.register({ id: "hidden", title: "不在气泡里", run: vi.fn() });
    openBubble(s);
    const btn = s.q.getByRole("button", { name: /对照翻译这个网页/ });
    expect(btn.textContent).toContain("Alt+A");
    expect(s.q.queryByRole("button", { name: /不在气泡里/ })).toBeNull();
    act(() => void fireEvent.click(btn));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("unregister removes the button and the hotkey", () => {
    const run = vi.fn();
    const s = withCommand({ id: "c", title: "做点事", hotkey: "Alt+A", quick: true, run });
    s.unregister();
    openBubble(s);
    expect(s.q.queryByRole("button", { name: /做点事/ })).toBeNull();
    key(altA);
    expect(run).not.toHaveBeenCalled();
  });

  it("the hotkey runs the command on keydown and swallows the key", () => {
    const run = vi.fn();
    withCommand({ id: "c", title: "做点事", hotkey: "Alt+A", run });
    const ev = key(altA);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("does not steal keys that do not match", () => {
    const run = vi.fn();
    withCommand({ id: "c", title: "做点事", hotkey: "Alt+A", run });
    const evs = [key({ code: "KeyA", key: "a" }), key({ code: "KeyA", altKey: true, shiftKey: true }), key({ code: "KeyB", altKey: true })];
    expect(run).not.toHaveBeenCalled();
    expect(evs.map((e) => e.defaultPrevented)).toEqual([false, false, false]);
  });

  it("ignores the hotkey while typing in inputs, textareas and contenteditable", () => {
    const run = vi.fn();
    withCommand({ id: "c", title: "做点事", hotkey: "Alt+A", run });
    const input = document.body.appendChild(document.createElement("input"));
    const area = document.body.appendChild(document.createElement("textarea"));
    const editable = document.body.appendChild(document.createElement("div"));
    editable.setAttribute("contenteditable", "true");
    const inner = editable.appendChild(document.createElement("span"));
    for (const target of [input, area, editable, inner]) {
      const ev = key({ ...altA, target });
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("registers one ScriptCat menu item per command, running the same handler", () => {
    const run = vi.fn();
    const menu = vi.fn();
    const s = withCommand({ id: "c", title: "对照翻译这个网页", hotkey: "Alt+A", quick: true, run }, menu);
    expect(menu).toHaveBeenCalledTimes(1);
    expect(menu.mock.calls[0]![0]).toBe("对照翻译这个网页");
    act(() => menu.mock.calls[0]![1]());
    key(altA);
    openBubble(s);
    act(() => void fireEvent.click(s.q.getByRole("button", { name: /对照翻译这个网页/ })));
    expect(run).toHaveBeenCalledTimes(3);
    // re-registering after an unregister must not add a second menu item
    s.unregister();
    s.ctx().commands.register({ id: "c", title: "对照翻译这个网页", run });
    expect(menu).toHaveBeenCalledTimes(1);
  });

  it("boot() puts each command into GM_registerMenuCommand next to the settings item", () => {
    const menus = new Map<string, () => void>();
    const gm: GmApi = {
      ...createGmStorageFake().tab(),
      GM_registerMenuCommand: (name, fn) => void menus.set(name, fn),
    };
    const run = vi.fn();
    let h!: ShellHandle;
    act(() => {
      h = boot({
        gm,
        hostname: "example-blog.dev",
        registrations: [defineFeature({ id: "a", start: (c) => void c.commands.register({ id: "c", title: "做点事", run }) })],
      })!;
    });
    expect([...menus.keys()]).toEqual(["做点事", "打开陪伴猫设置"]);
    act(() => menus.get("做点事")!());
    expect(run).toHaveBeenCalledTimes(1);
    act(() => h.unmount());
  });

  it("a disabled command is greyed out in the bubble and shows the paused notice instead of running", () => {
    let off = false;
    const run = vi.fn();
    const s = withCommand({ id: "c", title: "做点事", hotkey: "Alt+A", quick: true, run, disabled: () => off }, vi.fn());
    openBubble(s);
    const btn = () => s.q.getByRole("button", { name: /做点事/ });
    expect(btn().getAttribute("aria-disabled")).toBeNull();
    // re-evaluated when the bubble renders
    off = true;
    act(() => void fireEvent.click(s.cat()));
    openBubble(s);
    expect(btn().getAttribute("aria-disabled")).toBe("true");
    act(() => void fireEvent.click(btn()));
    expect(run).not.toHaveBeenCalled();
    expect(within(s.root as unknown as HTMLElement).getByText(PAUSED)).toBeTruthy();
  });

  it("disabled is re-evaluated when the command runs (hotkey and menu)", () => {
    let off = false;
    const run = vi.fn();
    const menu = vi.fn();
    const s = withCommand({ id: "c", title: "做点事", hotkey: "Alt+A", run, disabled: () => off }, menu);
    off = true;
    key(altA);
    act(() => menu.mock.calls[0]![1]());
    expect(run).not.toHaveBeenCalled();
    expect(s.q.getAllByText(PAUSED).length).toBeGreaterThan(0);
    off = false;
    key(altA);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops listening for keys after the shell unmounts", () => {
    const run = vi.fn();
    const s = withCommand({ id: "c", title: "做点事", hotkey: "Alt+A", run });
    act(() => s.handle.unmount());
    key(altA);
    expect(run).not.toHaveBeenCalled();
  });
});
