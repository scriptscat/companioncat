// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describePicked, openPicker, removeAttachment } from "./Picker";
import { elementOf } from "../../core/expr";

let layer: HTMLElement;
let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = `
    <div id="news">
      <a id="link" href="https://example.com/next">下一页</a>
      <button id="btn">展开评论</button>
      <form id="form"><input id="name" type="text" value="hunter2-secret" /><button id="send" type="submit">发送</button></form>
    </div>`;
  host = document.createElement("companion-cat");
  const root = host.attachShadow({ mode: "open" });
  layer = document.createElement("div");
  root.append(layer);
  const own = document.createElement("button");
  own.id = "own";
  own.textContent = "陪伴猫的按钮";
  root.append(own);
  document.documentElement.append(host);
});

afterEach(() => {
  fireEvent.keyDown(document, { key: "Escape" }); // closes a picker a test left open
  host.remove();
});

const $ = (id: string) => document.getElementById(id)!;
const bar = () => layer.querySelector<HTMLElement>("[data-cc-picker-bar]");
const box = () => layer.querySelector<HTMLElement>("[data-cc-picker-highlight]");
const done = () => [...layer.querySelectorAll("button")].find((b) => b.textContent === "完成")!;
const rect = (el: Element, r: { left: number; top: number; width: number; height: number }) =>
  (el.getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON() {} }) as DOMRect);

describe("element picker (R6.4)", () => {
  it("closes on its signal (the panel went away): nothing on the page stays blocked", async () => {
    const ac = new AbortController();
    const result = openPicker({ layer, signal: ac.signal });
    fireEvent.click($("btn"));
    ac.abort();
    await expect(result).resolves.toHaveLength(1);
    expect(bar()).toBeNull();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    $("link").dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    const aborted = new AbortController();
    aborted.abort();
    await expect(openPicker({ layer, signal: aborted.signal })).resolves.toEqual([]);
    expect(bar()).toBeNull();
  });

  it("shows the top hint with a count and a 完成 button inside the layer", () => {
    void openPicker({ layer });
    expect(bar()?.textContent).toContain("点选相关元素，按 Esc 完成");
    expect(bar()?.textContent).toContain("已选 0 个");
    expect(done()).toBeTruthy();
    fireEvent.click($("btn"));
    expect(bar()?.textContent).toContain("已选 1 个");
  });

  it("draws the hover highlight in the layer, never on the page element", () => {
    const before = document.body.innerHTML;
    rect($("btn"), { left: 10, top: 20, width: 80, height: 30 });
    void openPicker({ layer });
    expect(box()?.hidden).toBe(true);
    fireEvent.mouseOver($("btn"));
    expect(box()!.hidden).toBe(false);
    expect(box()!.style.left).toBe("10px");
    expect(box()!.style.top).toBe("20px");
    expect(box()!.style.width).toBe("80px");
    expect(box()!.style.height).toBe("30px");
    expect(document.body.innerHTML).toBe(before);
  });

  it("click selects and click again unselects, without the page's own behaviour", async () => {
    const pageClick = vi.fn();
    const pageDown = vi.fn();
    const pageSubmit = vi.fn();
    const clickEvents: MouseEvent[] = [];
    document.addEventListener("click", pageClick);
    $("btn").addEventListener("click", pageClick);
    $("link").addEventListener("mousedown", pageDown);
    $("form").addEventListener("submit", pageSubmit);
    const result = openPicker({ layer });
    const link = new MouseEvent("click", { bubbles: true, cancelable: true });
    clickEvents.push(link);
    $("link").dispatchEvent(link);
    expect(link.defaultPrevented).toBe(true); // a link would not navigate
    fireEvent.mouseDown($("link"));
    fireEvent.pointerDown($("link"));
    const send = new MouseEvent("click", { bubbles: true, cancelable: true });
    $("send").dispatchEvent(send);
    expect(send.defaultPrevented).toBe(true); // a submit button would not submit
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    $("form").dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    fireEvent.click($("btn"));
    fireEvent.click($("btn")); // unselect
    expect(pageClick).not.toHaveBeenCalled();
    expect(pageDown).not.toHaveBeenCalled();
    expect(pageSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    // link and send were selected; btn was toggled off
    expect((await result).map((h) => elementOf(h).id)).toEqual(["link", "send"]);
    document.removeEventListener("click", pageClick);
  });

  it("Esc and the 完成 button both resolve with the selection", async () => {
    const a = openPicker({ layer });
    fireEvent.click($("link"));
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect((await a).map((h) => elementOf(h).id)).toEqual(["link"]);

    const b = openPicker({ layer });
    fireEvent.click($("btn"));
    fireEvent.click(done());
    expect((await b).map((h) => elementOf(h).id)).toEqual(["btn"]);
  });

  it("never selects 陪伴猫's own UI and leaves its clicks alone", async () => {
    const result = openPicker({ layer });
    const ownClick = vi.fn();
    host.shadowRoot!.getElementById("own")!.addEventListener("click", ownClick);
    fireEvent.click(host.shadowRoot!.getElementById("own")!);
    fireEvent.click(host);
    fireEvent.mouseOver(host.shadowRoot!.getElementById("own")!);
    expect(ownClick).toHaveBeenCalledTimes(1);
    expect(box()!.hidden).toBe(true);
    expect(bar()?.textContent).toContain("已选 0 个");
    fireEvent.click(done());
    expect(await result).toEqual([]);
  });

  it("leaves the page as it was: no listeners left, no style or markup changes", async () => {
    const before = document.documentElement.outerHTML.replace(host.outerHTML, "");
    const addSpy = vi.spyOn(document, "addEventListener");
    const rmSpy = vi.spyOn(document, "removeEventListener");
    const result = openPicker({ layer });
    fireEvent.mouseOver($("btn"));
    fireEvent.click($("btn"));
    fireEvent.keyDown(document, { key: "Escape" });
    await result;
    expect(addSpy.mock.calls.length).toBeGreaterThan(0);
    const key = (c: unknown[]) => JSON.stringify([c[0], typeof c[2] === "object" ? (c[2] as { capture?: boolean }).capture : c[2]]);
    const live = new Map<string, unknown[]>();
    for (const c of addSpy.mock.calls) live.set(key(c) + String(c[1]), c);
    for (const c of rmSpy.mock.calls) live.delete(key(c) + String(c[1]));
    expect([...live.keys()]).toEqual([]);
    expect(layer.innerHTML).toBe("");
    expect(document.documentElement.outerHTML.replace(host.outerHTML, "")).toBe(before);
    // later clicks behave normally again
    const pageClick = vi.fn();
    $("btn").addEventListener("click", pageClick);
    fireEvent.click($("btn"));
    expect(pageClick).toHaveBeenCalledTimes(1);
    addSpy.mockRestore();
    rmSpy.mockRestore();
  });
});

describe("picked element attachments (R6.4, R9.2)", () => {
  it("each pick becomes {handle, label, outline} and the outline never holds input values", async () => {
    const result = openPicker({ layer });
    fireEvent.click($("name"));
    fireEvent.click($("link"));
    fireEvent.keyDown(document, { key: "Escape" });
    const picked = await result;
    const list = await describePicked(picked);
    expect(list).toHaveLength(2);
    expect(list[0]!.handle).toBe(picked[0]);
    expect(list[1]!.label).toBe("「下一页」链接");
    expect(list[1]!.outline).toContain("下一页");
    expect(list[0]!.outline).toContain('<input');
    expect(JSON.stringify(list.map((a) => [a.label, a.outline]))).not.toContain("hunter2-secret");
  });

  it("removeAttachment drops one pick and keeps the others", async () => {
    const result = openPicker({ layer });
    fireEvent.click($("link"));
    fireEvent.click($("btn"));
    fireEvent.keyDown(document, { key: "Escape" });
    const list = await describePicked(await result);
    const left = removeAttachment(list, list[0]!.handle);
    expect(left.map((a) => a.label)).toEqual(["「展开评论」按钮"]);
    expect(list).toHaveLength(2);
  });
});
