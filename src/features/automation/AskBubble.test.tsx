// @vitest-environment jsdom
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { elementHandle } from "../../core/expr";
import type { AskPrompt } from "./acts";
import { createAskUser } from "./AskBubble";

let layer: HTMLElement;
let btn: HTMLButtonElement;
let setAwake: Mock<(on: boolean, label?: string) => void>;
let setAlwaysDo: Mock<(site: string, rule: string, on: boolean) => void>;
let rect = { left: 200, top: 300, width: 100, height: 30 };

const prompt = (over: Partial<AskPrompt & { engine: string }> = {}) =>
  ({ target: elementHandle(btn), act: "click", site: "vidoo.example", rule: "跳过广告", describe: "这个按钮", confidence: 0.72, minConfidence: 0.85, engine: "DeepSeek", ...over }) as AskPrompt;

const make = () => createAskUser({ layer, prefs: { setAlwaysDo }, setAwake });
const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};
const q = (sel: string) => layer.querySelector(sel);

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<button id="skip">跳过广告</button><input id="other" />';
  btn = document.getElementById("skip") as HTMLButtonElement;
  layer = document.createElement("div");
  document.body.append(layer);
  rect = { left: 200, top: 300, width: 100, height: 30 };
  btn.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON() {} }) as DOMRect;
  setAwake = vi.fn<(on: boolean, label?: string) => void>();
  setAlwaysDo = vi.fn<(site: string, rule: string, on: boolean) => void>();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ask bubble (R2.1)", () => {
  it("words the question with the confidence and shows rule, engine and threshold", async () => {
    make()(prompt());
    await settle();
    expect(screen.getByText("小猫觉得是这个按钮（72%），要点吗？")).toBeTruthy();
    expect(screen.getByText("跳过广告 · DeepSeek 判断 · 门槛 85%")).toBeTruthy();
    expect(screen.getByRole("button", { name: "点吧" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "不用" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "这个网站以后都照做" })).toBeTruthy();
  });

  it("words the verb from the act and omits unknown parts", async () => {
    make()(prompt({ act: "fill", describe: "姓名输入框", engine: undefined, minConfidence: undefined }));
    await settle();
    expect(screen.getByText("小猫觉得是姓名输入框（72%），要填吗？")).toBeTruthy();
    expect(layer.textContent).toContain("跳过广告");
  });

  it("点吧 resolves true without touching always-do", async () => {
    const p = make()(prompt());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "点吧" }));
    await expect(p).resolves.toBe(true);
    expect(setAlwaysDo).not.toHaveBeenCalled();
    expect(layer.textContent).not.toContain("点吧");
  });

  it("不用 resolves false and never sets always-do, even when ticked", async () => {
    const p = make()(prompt());
    await settle();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "不用" }));
    await expect(p).resolves.toBe(false);
    expect(setAlwaysDo).not.toHaveBeenCalled();
  });

  it("ticked + 点吧 sets always-do for site and rule (R2.3)", async () => {
    const p = make()(prompt());
    await settle();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "点吧" }));
    await expect(p).resolves.toBe(true);
    expect(setAlwaysDo).toHaveBeenCalledWith("vidoo.example", "跳过广告", true);
  });

  it("draws a dashed outline in the layer around the target without styling the page element", async () => {
    make()(prompt());
    await settle();
    const o = q("[data-cc-outline]") as HTMLElement;
    expect(o).toBeTruthy();
    expect(o.style.borderStyle).toBe("dashed");
    expect([o.style.left, o.style.top, o.style.width, o.style.height]).toEqual(["200px", "300px", "100px", "30px"]);
    expect(btn.getAttribute("style")).toBeNull();
    expect(btn.className).toBe("");
  });

  it("shows 等你回答 on the cat while waiting and clears it after", async () => {
    const p = make()(prompt());
    await settle();
    expect(setAwake).toHaveBeenLastCalledWith(true, "等你回答");
    fireEvent.click(screen.getByRole("button", { name: "不用" }));
    await p;
    expect(setAwake).toHaveBeenLastCalledWith(false);
  });

  it("sits below the target, flips above near the bottom and clamps to the viewport", async () => {
    make()(prompt());
    await settle();
    const bubble = q("[data-cc-ask]") as HTMLElement;
    expect(parseInt(bubble.style.top)).toBeGreaterThanOrEqual(330);
    fireEvent.click(screen.getByRole("button", { name: "不用" }));
    await settle();

    rect = { left: 990, top: window.innerHeight - 40, width: 100, height: 30 };
    make()(prompt());
    await settle();
    const b2 = q("[data-cc-ask]") as HTMLElement;
    expect(parseInt(b2.style.top)).toBeLessThan(rect.top);
    expect(parseInt(b2.style.left) + 300).toBeLessThanOrEqual(window.innerWidth);
    expect(parseInt(b2.style.left)).toBeGreaterThanOrEqual(0);
  });

  it("follows the target on scroll", async () => {
    make()(prompt());
    await settle();
    const before = parseInt((q("[data-cc-ask]") as HTMLElement).style.top);
    rect = { ...rect, top: 340 };
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(parseInt((q("[data-cc-ask]") as HTMLElement).style.top)).toBe(before + 40);
    expect((q("[data-cc-outline]") as HTMLElement).style.top).toBe("340px");
  });

  it("30 s without an answer counts as 不用", async () => {
    const p = make()(prompt());
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(q("[data-cc-ask]")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await expect(p).resolves.toBe(false);
    expect(q("[data-cc-ask]")).toBeNull();
    expect(setAwake).toHaveBeenLastCalledWith(false);
  });

  it("the target leaving the page counts as 不用", async () => {
    const p = make()(prompt());
    await settle();
    btn.remove();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await expect(p).resolves.toBe(false);
    expect(q("[data-cc-ask]")).toBeNull();
  });

  it("an aborted signal (navigation) counts as 不用, also when already aborted", async () => {
    const ac = new AbortController();
    const p = make()(prompt({ signal: ac.signal }));
    await settle();
    ac.abort();
    await expect(p).resolves.toBe(false);
    expect(q("[data-cc-ask]")).toBeNull();
    expect(setAwake).toHaveBeenLastCalledWith(false);

    const done = new AbortController();
    done.abort();
    await expect(make()(prompt({ signal: done.signal }))).resolves.toBe(false);
    expect(q("[data-cc-ask]")).toBeNull();
  });

  it("Esc counts as 不用", async () => {
    const p = make()(prompt());
    await settle();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await expect(p).resolves.toBe(false);
    expect(setAlwaysDo).not.toHaveBeenCalled();
  });

  it("shows one ask at a time and queues the rest in order", async () => {
    const ask = make();
    const p1 = ask(prompt({ describe: "第一个" }));
    const p2 = ask(prompt({ describe: "第二个" }));
    await settle();
    expect(layer.querySelectorAll("[data-cc-ask]")).toHaveLength(1);
    expect(screen.getByText(/第一个/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "点吧" }));
    await expect(p1).resolves.toBe(true);
    await settle();
    expect(layer.querySelectorAll("[data-cc-ask]")).toHaveLength(1);
    expect(screen.getByText(/第二个/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "不用" }));
    await expect(p2).resolves.toBe(false);
  });

  it("a queued ask whose signal aborts never shows", async () => {
    const ask = make();
    const ac = new AbortController();
    const p1 = ask(prompt({ describe: "第一个" }));
    const p2 = ask(prompt({ describe: "第二个", signal: ac.signal }));
    await settle();
    ac.abort();
    await expect(p2).resolves.toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "不用" }));
    await p1;
    await settle();
    expect(q("[data-cc-ask]")).toBeNull();
  });

  it("moves focus to 点吧 and returns it afterwards (R9.3)", async () => {
    const other = document.getElementById("other") as HTMLInputElement;
    other.focus();
    const p = make()(prompt());
    await settle();
    expect(document.activeElement && layer.contains(document.activeElement) ? (document.activeElement as HTMLElement).textContent : "").toBe("点吧");
    fireEvent.click(screen.getByRole("button", { name: "不用" }));
    await p;
    await settle();
    expect(document.activeElement).toBe(other);
  });
});
