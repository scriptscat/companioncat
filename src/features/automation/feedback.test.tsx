// @vitest-environment jsdom
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { elementHandle } from "../../core/expr";
import type { ToastSpec } from "../../shell/registry";
import { FillUndo, type ActRecord } from "./acts";
import { badge, showActFeedback } from "./Feedback";
import { createHint } from "./Hint";

let layer: HTMLElement;
let toasts: ToastSpec[];
const toast = vi.fn((t: ToastSpec) => {
  toasts.push(t);
  return () => {};
});

function target(html = '<button id="skip">跳过</button>'): HTMLElement {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  const node = wrap.firstElementChild as HTMLElement;
  document.body.append(node);
  node.getBoundingClientRect = () => ({ top: 200, left: 50, width: 80, height: 30, right: 130, bottom: 230, x: 50, y: 200, toJSON() {} });
  return node;
}

const record = (over: Partial<ActRecord> = {}): ActRecord => ({
  mode: "auto",
  act: "click",
  site: "video.test",
  rule: "pack/skip-ads",
  summary: "点击",
  describe: "跳过广告",
  confidence: 0.93,
  ...over,
});

/**
 * Badge sizes follow the shown text — full 「小猫填的 N%」 96 px, compact 「N%」 34, 22 tall — from the moment
 * a badge is made (it measures itself once then), not only after the test gets hold of it.
 */
function badgeSizes(): () => void {
  const w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
  const h = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
  const isBadge = (el: HTMLElement) => el.dataset.ccBadge !== undefined;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return isBadge(this) ? (this.textContent!.startsWith("小猫") ? 96 : 34) : w.get!.call(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isBadge(this) ? 22 : h.get!.call(this);
    },
  });
  return () => {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", w);
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", h);
  };
}

const first = () => toasts[0]!;
const second = () => toasts[1]!;
const link = (t: ToastSpec, label: string) => t.links!.find((l) => l.label === label)!;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  layer = document.createElement("div");
  document.body.append(layer);
  toasts = [];
  toast.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("showActFeedback", () => {
  const deps = (over = {}) => ({ target: elementHandle(target()), prefs: { markWrong: vi.fn() }, onOpenLog: vi.fn(), ...over });

  it.each([
    ["click", "小猫帮你点了「跳过广告」（93%）"],
    ["fill", "小猫帮你填了「跳过广告」（93%）"],
    ["check", "小猫帮你勾选了「跳过广告」（93%）"],
    ["select", "小猫帮你选了「跳过广告」（93%）"],
    ["scroll", "小猫帮你滚动到了「跳过广告」（93%）"],
    ["focus", "小猫帮你聚焦了「跳过广告」（93%）"],
  ] as const)("words a %s act", (act, text) => {
    showActFeedback({ layer, toast }, record({ act }), deps());
    expect(first().text).toBe(text);
  });

  it("omits the confidence and the name when unknown", () => {
    showActFeedback({ layer, toast }, record({ confidence: undefined, describe: undefined }), deps());
    expect(first().text).toBe("小猫帮你点了");
  });

  it("offers 撤销 and 记录 only", () => {
    showActFeedback({ layer, toast }, record(), deps());
    expect(first().links!.map((l) => l.label)).toEqual(["撤销", "记录"]);
  });

  it("撤销 on a fill restores the field and confirms", async () => {
    const input = target('<input value="old">') as HTMLInputElement;
    const rec = record({ act: "fill", undo: new FillUndo(input, "old") });
    input.value = "new";
    const d = deps();
    showActFeedback({ layer, toast }, rec, d);
    await link(first(), "撤销").onClick();
    expect(input.value).toBe("old");
    expect(d.prefs.markWrong).not.toHaveBeenCalled();
    expect(second().text).toBe("已经恢复原来的内容");
  });

  it("撤销 on a click marks it wrong and confirms", async () => {
    const d = deps();
    const rec = record();
    showActFeedback({ layer, toast }, rec, d);
    await link(first(), "撤销").onClick();
    expect(d.prefs.markWrong).toHaveBeenCalledWith(rec);
    expect(second().text).toBe("记下了，这个网站下次先问你");
  });

  it("记录 calls onOpenLog", () => {
    const d = deps();
    showActFeedback({ layer, toast }, record(), d);
    link(first(), "记录").onClick();
    expect(d.onOpenLog).toHaveBeenCalledTimes(1);
  });

  it("draws a highlight over the target in the layer that fades away", () => {
    showActFeedback({ layer, toast }, record(), deps());
    const box = layer.querySelector<HTMLElement>("[data-cc-highlight]")!;
    expect(box).toBeTruthy();
    expect(box.style.top).toBe("200px");
    expect(box.style.left).toBe("50px");
    expect(box.style.width).toBe("80px");
    expect(box.style.height).toBe("30px");
    vi.advanceTimersByTime(3000);
    expect(layer.querySelector("[data-cc-highlight]")).toBeNull();
  });

  it("does not touch the page element's style", () => {
    const t = target();
    showActFeedback({ layer, toast }, record(), { target: elementHandle(t), prefs: { markWrong: vi.fn() }, onOpenLog: vi.fn() });
    expect(t.getAttribute("style")).toBeNull();
  });
});

describe("createHint", () => {
  const suggestion = { act: "check" as const, value: "B", confidence: 0.61, minConfidence: 0.8 };

  it("anchors a marker with the suggestion, confidence and threshold", () => {
    const hint = createHint({ layer, perform: vi.fn() });
    hint(elementHandle(target()), suggestion);
    const marker = layer.querySelector<HTMLElement>("[data-cc-hint]")!;
    expect(marker.textContent).toContain("小猫建议 B（61%），没到门槛 80%，没替你选");
    expect(within(marker).getByRole("button", { name: "就选 B" })).toBeTruthy();
    expect(within(marker).getByRole("button", { name: "我自己来" })).toBeTruthy();
    expect(marker.style.top).toBe("160px"); // above the target (34 px bar + 6 px)
  });

  it("就选 performs the suggestion and removes the marker", () => {
    const perform = vi.fn();
    const hint = createHint({ layer, perform });
    const t = elementHandle(target());
    hint(t, suggestion);
    fireEvent.click(within(layer).getByRole("button", { name: "就选 B" }));
    expect(perform).toHaveBeenCalledWith(t, suggestion);
    expect(layer.querySelector("[data-cc-hint]")).toBeNull();
  });

  it("我自己来 removes without acting", () => {
    const perform = vi.fn();
    const hint = createHint({ layer, perform });
    hint(elementHandle(target()), suggestion);
    fireEvent.click(within(layer).getByRole("button", { name: "我自己来" }));
    expect(perform).not.toHaveBeenCalled();
    expect(layer.querySelector("[data-cc-hint]")).toBeNull();
  });

  it("follows scroll and goes away on stop", () => {
    const hint = createHint({ layer, perform: vi.fn() });
    const node = target();
    hint(elementHandle(node), suggestion);
    node.getBoundingClientRect = () => ({ top: 120, left: 50, width: 80, height: 30, right: 130, bottom: 150, x: 50, y: 120, toJSON() {} });
    fireEvent.scroll(window);
    expect(layer.querySelector<HTMLElement>("[data-cc-hint]")!.style.top).toBe("80px");
    const off = vi.spyOn(window, "removeEventListener");
    hint.stop();
    expect(layer.querySelector("[data-cc-hint]")).toBeNull();
    expect(off).toHaveBeenCalledWith("scroll", expect.any(Function), true);
  });

  it("removes the marker when its target leaves the page", () => {
    const hint = createHint({ layer, perform: vi.fn() });
    const node = target();
    hint(elementHandle(node), suggestion);
    node.remove();
    fireEvent.scroll(window);
    expect(layer.querySelector("[data-cc-hint]")).toBeNull();
  });
});

describe("badge", () => {
  it("shows 小猫填的 N% next to the target and follows scroll; remove cleans up", () => {
    const node = target();
    const remove = badge(elementHandle(node), 0.96, layer);
    const b = layer.querySelector<HTMLElement>("[data-cc-badge]")!;
    expect(b.textContent).toBe("小猫填的 96%");
    // right of the target, vertically centred on it (22 px tall when jsdom has no layout)
    expect(b.style.left).toBe("138px");
    expect(b.style.top).toBe("204px");
    node.getBoundingClientRect = () => ({ top: 90, left: 50, width: 80, height: 30, right: 130, bottom: 120, x: 50, y: 90, toJSON() {} });
    fireEvent.scroll(window);
    expect(b.style.top).toBe("94px");
    remove();
    expect(layer.querySelector("[data-cc-badge]")).toBeNull();
  });
});

describe("placement in the viewport (R5.3 R9.4)", () => {
  const rect = (top: number, left: number, right: number, bottom: number) => ({ top, left, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} });
  const view = (w: number, h = 800) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: w });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: h });
  };
  const size = (el: HTMLElement, w: number, h: number) => {
    Object.defineProperty(el, "offsetWidth", { configurable: true, value: w });
    Object.defineProperty(el, "offsetHeight", { configurable: true, value: h });
  };
  afterEach(() => view(1024, 768));

  /** A question whose stem sits right above its options (no gap), options as wide as the page. */
  function question(vw: number) {
    document.body.innerHTML = `<div id="q"><p id="stem">第2题 多选</p><label id="l"><input type="checkbox" name="q2" id="i"></label></div>`;
    const stem = document.getElementById("stem")!;
    const input = document.getElementById("i") as HTMLInputElement;
    const label = document.getElementById("l")!;
    stem.getBoundingClientRect = () => rect(300, 8, vw - 8, 322);
    input.getBoundingClientRect = () => rect(324, 8, 22, 338);
    label.getBoundingClientRect = () => rect(324, 8, vw - 8, 346);
    return { stem, input };
  }

  it.each([
    ["wide", 1024],
    ["narrow", 400],
  ])("the hint never covers the stem or the options and stays in the viewport (%s)", (_n, vw) => {
    view(vw);
    const { stem, input } = question(vw);
    const hint = createHint({ layer, perform: vi.fn() });
    hint(elementHandle(input), { act: "check", value: "B", confidence: 0.61, minConfidence: 0.8 });
    const marker = layer.querySelector<HTMLElement>("[data-cc-hint]")!;
    size(marker, Math.min(420, vw - 16), 36);
    fireEvent.scroll(window);
    const top = parseFloat(marker.style.top);
    const left = parseFloat(marker.style.left);
    const box = { top, left, right: left + marker.offsetWidth, bottom: top + 36 };
    const hits = (b: ReturnType<typeof rect>) => box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top;
    expect(hits(stem.getBoundingClientRect())).toBe(false);
    expect(hits(document.getElementById("l")!.getBoundingClientRect())).toBe(false);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(vw);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(800);
  });

  it("the badge stays inside a 400 px viewport", () => {
    view(400);
    const node = target();
    node.getBoundingClientRect = () => rect(200, 8, 392, 222);
    const restore = badgeSizes();
    try {
      badge(elementHandle(node), 0.95, layer);
    } finally {
      restore();
    }
    const b = layer.querySelector<HTMLElement>("[data-cc-badge]")!;
    Object.defineProperty(b, "offsetWidth", { configurable: true, get: () => (b.textContent!.startsWith("小猫") ? 96 : 34) });
    fireEvent.scroll(window);
    const left = parseFloat(b.style.left);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + b.offsetWidth).toBeLessThanOrEqual(400);
    expect(parseFloat(b.style.top)).toBeGreaterThanOrEqual(0);
  });
});

describe("badge never covers another option (R9.4 R5.3)", () => {
  const rect = (top: number, left: number, right: number, bottom: number) => ({ top, left, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} });
  const view = (w: number) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: w });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });
  };
  let restoreSizes: () => void;
  beforeEach(() => (restoreSizes = badgeSizes()));
  afterEach(() => {
    restoreSizes();
    view(1024);
  });

  /** Three stacked options under a stem; each label spans `labelRight`. Option B (index 1) is the answer. */
  function stack(labelRight: number) {
    document.body.innerHTML = `<p id="stem">第1题</p>${["a", "b", "c"].map((k) => `<label id="l${k}"><input type="radio" name="q" id="i${k}">${k}</label>`).join("")}`;
    const stem = document.getElementById("stem")!;
    stem.getBoundingClientRect = () => rect(70, 8, 392, 92);
    const tops = [100, 124, 148];
    ["a", "b", "c"].forEach((k, n) => {
      document.getElementById(`i${k}`)!.getBoundingClientRect = () => rect(tops[n]!, 8, 22, tops[n]! + 22);
      document.getElementById(`l${k}`)!.getBoundingClientRect = () => rect(tops[n]!, 8, labelRight, tops[n]! + 22);
    });
    return stem;
  }
  /** Sizes follow the shown text (badgeSizes). */
  function placed(answer: string) {
    const input = document.getElementById(answer) as HTMLInputElement;
    badge(elementHandle(input), 0.95, layer);
    const b = layer.querySelector<HTMLElement>("[data-cc-badge]")!;
    fireEvent.scroll(window);
    const top = parseFloat(b.style.top);
    const left = parseFloat(b.style.left);
    return { b, box: { top, left, right: left + b.offsetWidth, bottom: top + 22 } };
  }
  const hits = (a: { top: number; left: number; right: number; bottom: number }, id: string) => {
    const r = document.getElementById(id)!.getBoundingClientRect();
    return a.left < r.right && a.right > r.left && a.top < r.bottom && a.bottom > r.top;
  };

  it("at 400 px with full-width options it stays on its own line, off the other options and the stem, inside the viewport", () => {
    view(400);
    const stem = stack(392);
    const { b, box } = placed("ib");
    expect(hits(box, "la")).toBe(false);
    expect(hits(box, "lc")).toBe(false);
    expect(box.top < stem.getBoundingClientRect().bottom && box.bottom > stem.getBoundingClientRect().top).toBe(false);
    expect(box.top).toBeGreaterThanOrEqual(124);
    expect(box.bottom).toBeLessThanOrEqual(146);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(400);
    // compact, with the full wording kept for everyone who reads the title
    expect(b.textContent).toBe("95%");
    expect(b.title).toBe("小猫填的 95%");
    expect(b.getAttribute("aria-label")).toBe("小猫填的 95%");
  });

  it("at 400 px a short option still gets the full badge at the end of its own line", () => {
    view(400);
    stack(150);
    const { b, box } = placed("ib");
    expect(b.textContent).toBe("小猫填的 95%");
    expect(box.left).toBe(158);
    expect(box.top).toBe(124);
  });

  it("at 400 px a medium option gets the compact badge beside the text instead of dropping below", () => {
    view(400);
    stack(340);
    const { b, box } = placed("ib");
    expect(b.textContent).toBe("95%");
    expect(box.left).toBe(348);
    expect(hits(box, "lc")).toBe(false);
  });

  /** Three options side by side on one line (A 8–80, B 100–172, C 192–264), as many quiz pages lay short options out. */
  function row(lefts = [8, 100, 192], width = 72) {
    document.body.innerHTML = `<p id="stem">第1题</p>${["a", "b", "c"].map((k) => `<label id="l${k}"><input type="radio" name="q" id="i${k}">${k}</label>`).join("")}`;
    document.getElementById("stem")!.getBoundingClientRect = () => rect(70, 8, 392, 92);
    ["a", "b", "c"].forEach((k, n) => {
      const l = lefts[n]!;
      document.getElementById(`i${k}`)!.getBoundingClientRect = () => rect(100, l, l + 14, 122);
      document.getElementById(`l${k}`)!.getBoundingClientRect = () => rect(100, l, l + width, 122);
    });
  }

  it("options side by side: the badge never lands on the next option in the same line (wide and narrow)", () => {
    for (const w of [1024, 400]) {
      view(w);
      row();
      const { box } = placed("ib");
      expect(hits(box, "la")).toBe(false);
      expect(hits(box, "lc")).toBe(false);
      expect(box.top).toBe(100);
      layer.innerHTML = "";
    }
  });

  it("options side by side with room after the option: the compact mark fits in the gap", () => {
    view(1024);
    // B ends at 172, C starts at 222: room for the 34 px compact mark with 8 px either side, not for more
    row([8, 100, 222]);
    const { b, box } = placed("ib");
    expect(b.textContent).toBe("95%");
    expect(box.left).toBe(180);
    expect(hits(box, "lc")).toBe(false);
  });

  it("the last option in a line still gets the full badge after it", () => {
    view(1024);
    row();
    const { b, box } = placed("ic");
    expect(b.textContent).toBe("小猫填的 95%");
    expect(box.left).toBe(272);
  });

  it("following a scroll measures the options found at the start, it does not look their labels up again", () => {
    view(1024);
    row();
    const labels = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "labels")!;
    let lookups = 0;
    Object.defineProperty(HTMLInputElement.prototype, "labels", {
      configurable: true,
      get(this: HTMLInputElement) {
        lookups++;
        return labels.get!.call(this);
      },
    });
    try {
      placed("ib");
      lookups = 0;
      fireEvent.scroll(window);
      expect(lookups).toBe(0);
    } finally {
      Object.defineProperty(HTMLInputElement.prototype, "labels", labels);
    }
  });

  it("on a resize every badge is measured before any of them changes its wording (one layout, not one per badge)", () => {
    view(1024);
    document.body.innerHTML = ["x", "y"].map((q) => `<label id="l${q}"><input type="radio" name="${q}" id="i${q}">${q}</label>`).join("");
    const log: string[] = [];
    ["x", "y"].forEach((q, n) => {
      const top = 100 + n * 40;
      document.getElementById(`i${q}`)!.getBoundingClientRect = () => (log.push("read"), rect(top, 8, 22, top + 22));
      document.getElementById(`l${q}`)!.getBoundingClientRect = () => (log.push("read"), rect(top, 8, 340, top + 22));
    });
    const text = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!;
    const badges = ["x", "y"].map((q) => {
      badge(elementHandle(document.getElementById(`i${q}`)!), 0.95, layer);
      const b = layer.lastElementChild as HTMLElement;
      Object.defineProperty(b, "textContent", {
        configurable: true,
        get: () => text.get!.call(b),
        set: (v: string) => (log.push("write"), text.set!.call(b, v)),
      });
      return b;
    });
    expect(badges.map((b) => b.textContent)).toEqual(["小猫填的 95%", "小猫填的 95%"]);
    log.length = 0;
    view(400);
    fireEvent(window, new Event("resize"));
    expect(badges.map((b) => b.textContent)).toEqual(["95%", "95%"]);
    expect(log.indexOf("write")).toBeGreaterThan(log.lastIndexOf("read"));
  });

  it("at 1024 px the badge stays full size beside the option", () => {
    view(1024);
    stack(392);
    const { b, box } = placed("ib");
    expect(b.textContent).toBe("小猫填的 95%");
    expect(b.title).toBe("");
    expect(box.left).toBe(400);
    expect(box.top).toBe(124);
  });
});

describe("hint above the question (R5.3)", () => {
  const rect = (top: number, left: number, right: number, bottom: number) => ({ top, left, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} });
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
  });

  it.each([1024, 400])("question 2's bar touches no stem of 1-3 nor its own options (%i px)", (vw) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: vw });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    document.body.innerHTML = [1, 2, 3]
      .map((n) => `<div class="q" id="q${n}"><p id="s${n}">第${n}题 题干</p><label id="a${n}"><input type="checkbox" name="n${n}" id="i${n}"> 甲</label><label id="b${n}"><input type="checkbox" name="n${n}" id="j${n}"> 乙</label></div>`)
      .join("");
    // 140 px per question, 18 px gap, stem right under the container top
    const stubs: Record<string, [number, number]> = {};
    [1, 2, 3].forEach((n) => {
      const top = 100 + (n - 1) * 140;
      stubs[`q${n}`] = [top, top + 110];
      stubs[`s${n}`] = [top, top + 24];
      stubs[`a${n}`] = [top + 40, top + 62];
      stubs[`i${n}`] = [top + 40, top + 62];
      stubs[`b${n}`] = [top + 70, top + 92];
      stubs[`j${n}`] = [top + 70, top + 92];
    });
    for (const [id, [t, b]] of Object.entries(stubs)) document.getElementById(id)!.getBoundingClientRect = () => rect(t, 8, vw - 8, b);
    const hint = createHint({ layer, perform: vi.fn() });
    hint(elementHandle(document.getElementById("i2")!), { act: "check", value: "甲", confidence: 0.6, minConfidence: 0.8 });
    const m = layer.querySelector<HTMLElement>("[data-cc-hint]")!;
    Object.defineProperty(m, "offsetWidth", { configurable: true, value: Math.min(420, vw - 16) });
    Object.defineProperty(m, "offsetHeight", { configurable: true, value: 36 });
    fireEvent.scroll(window);
    const top = parseFloat(m.style.top);
    const left = parseFloat(m.style.left);
    const box = { top, left, right: left + Math.min(420, vw - 16), bottom: top + 36 };
    const hits = (id: string) => {
      const b = document.getElementById(id)!.getBoundingClientRect();
      return box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top;
    };
    for (const id of ["s1", "s2", "s3", "a2", "b2"]) expect(hits(id), id).toBe(false);
    expect(box.top).toBeLessThan(stubs.s2![0]); // above the question
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(vw);
  });
});

describe("marks stay with their question when it is scrolled away (R5.3)", () => {
  const rect = (top: number, left: number, right: number, bottom: number) => ({ top, left, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} });
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 768 });
  });

  function question(top: number) {
    document.body.innerHTML = `<div id="q"><p id="s">第2题 多选</p><label id="l"><input type="checkbox" name="q2" id="i"> 乙</label><label id="m"><input type="checkbox" name="q2" id="k"> 丙</label></div>`;
    for (const id of ["m", "k"]) document.getElementById(id)!.getBoundingClientRect = () => rect(top + 70, 8, id === "k" ? 22 : 700, top + 92);
    document.getElementById("q")!.getBoundingClientRect = () => rect(top, 8, 700, top + 110);
    document.getElementById("s")!.getBoundingClientRect = () => rect(top, 8, 700, top + 24);
    document.getElementById("i")!.getBoundingClientRect = () => rect(top + 40, 8, 22, top + 62);
    document.getElementById("l")!.getBoundingClientRect = () => rect(top + 40, 8, 700, top + 62);
    return document.getElementById("i")!;
  }

  it.each([
    ["above the viewport", -2000],
    ["below the viewport", 3000],
  ])("the hint and the badge go along with a question %s instead of sticking to the viewport edge", (_n, top) => {
    const input = question(top);
    createHint({ layer, perform: vi.fn() })(elementHandle(input), { act: "check", value: "乙", confidence: 0.6, minConfidence: 0.8 });
    badge(elementHandle(input), 0.95, layer);
    for (const sel of ["[data-cc-hint]", "[data-cc-badge]"]) {
      const at = parseFloat(layer.querySelector<HTMLElement>(sel)!.style.top);
      expect(Math.abs(at - top), sel).toBeLessThan(200);
    }
  });
});

describe("hint for questions without a container of their own (R5.3)", () => {
  const rect = (top: number, left: number, right: number, bottom: number) => ({ top, left, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} });
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
  });

  it("a flat page (stems and options side by side in one form): question 2's hint sits right above its own stem", () => {
    document.body.innerHTML =
      `<form id="f"><p id="s1">1. 题干一</p><label id="a1"><input type="radio" name="q1"> 甲</label><label id="b1"><input type="radio" name="q1"> 乙</label>` +
      `<p id="s2">2. 题干二</p><label id="a2"><input type="radio" name="q2" id="i2"> 甲</label><label id="b2"><input type="radio" name="q2" id="j2"> 乙</label></form>`;
    const at: Record<string, [number, number]> = { f: [100, 400], s1: [100, 124], a1: [130, 152], b1: [156, 178], s2: [240, 264], a2: [270, 292], b2: [296, 318] };
    for (const [id, [t, b]] of Object.entries(at)) document.getElementById(id)!.getBoundingClientRect = () => rect(t, 8, 700, b);
    document.getElementById("i2")!.getBoundingClientRect = () => rect(270, 8, 22, 292);
    document.getElementById("j2")!.getBoundingClientRect = () => rect(296, 8, 22, 318);
    createHint({ layer, perform: vi.fn() })(elementHandle(document.getElementById("j2")!), { act: "check", value: "B", confidence: 0.6, minConfidence: 0.8 });
    const m = layer.querySelector<HTMLElement>("[data-cc-hint]")!;
    Object.defineProperty(m, "offsetWidth", { configurable: true, value: 420 });
    Object.defineProperty(m, "offsetHeight", { configurable: true, value: 36 });
    fireEvent.scroll(window);
    const top = parseFloat(m.style.top);
    expect(top + 36).toBeLessThanOrEqual(at.s2![0]); // above question 2's stem
    expect(top).toBeGreaterThanOrEqual(at.b1![1]); // below question 1
  });

  it("options in their own wrapper: the hint for option B goes above the stem, not just above the options", () => {
    document.body.innerHTML = `<div id="q"><p id="s">3. 题干</p><div id="opts"><label id="a"><input type="radio" name="q3" id="ia"> 甲</label><label id="b"><input type="radio" name="q3" id="ib"> 乙</label></div></div>`;
    const at: Record<string, [number, number]> = { q: [300, 400], s: [300, 324], opts: [326, 380], a: [326, 350], ia: [326, 350], b: [354, 378], ib: [354, 378] };
    for (const [id, [t, b]] of Object.entries(at)) document.getElementById(id)!.getBoundingClientRect = () => rect(t, 8, 700, b);
    createHint({ layer, perform: vi.fn() })(elementHandle(document.getElementById("ib")!), { act: "check", value: "B", confidence: 0.6, minConfidence: 0.8 });
    const m = layer.querySelector<HTMLElement>("[data-cc-hint]")!;
    Object.defineProperty(m, "offsetWidth", { configurable: true, value: 420 });
    Object.defineProperty(m, "offsetHeight", { configurable: true, value: 36 });
    fireEvent.scroll(window);
    expect(parseFloat(m.style.top) + 36).toBeLessThanOrEqual(at.s![0]);
  });
});

describe("question box on awkward pages (R5.3)", () => {
  const rect = (top: number, left: number, right: number, bottom: number) => ({ top, left, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} });
  const stub = (at: Record<string, [number, number, number?, number?]>) => {
    for (const [id, [t, b, l = 8, r = 700]] of Object.entries(at)) document.getElementById(id)!.getBoundingClientRect = () => rect(t, l, r, b);
  };
  const open = (id: string) => {
    createHint({ layer, perform: vi.fn() })(elementHandle(document.getElementById(id)!), { act: "check", value: "甲", confidence: 0.6, minConfidence: 0.8 });
    const m = layer.querySelector<HTMLElement>("[data-cc-hint]")!;
    Object.defineProperty(m, "offsetWidth", { configurable: true, value: 420 });
    Object.defineProperty(m, "offsetHeight", { configurable: true, value: 36 });
    fireEvent.scroll(window);
    return m;
  };
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
  });

  it("a lone poll inside the page's wrapper: the hint stays by the poll, not at the far end of the page", () => {
    document.body.innerHTML = `<div id="app"><h1 id="t">调查</h1><div id="poll"><label id="a"><input type="radio" name="p" id="i"> 甲</label></div><article id="art">很长的正文</article></div>`;
    stub({ app: [0, 6000, 0, 1024], t: [10, 40, 0, 1024], poll: [60, 90, 0, 1024], a: [60, 90, 0, 1024], i: [60, 90, 8, 22], art: [100, 6000, 0, 1024] });
    const top = parseFloat(open("i").style.top);
    expect(top).toBeGreaterThanOrEqual(90); // below the poll (no room above, none beside)
    expect(top).toBeLessThan(200);
  });

  it("an option whose input is display:none (styled options): marks are not stretched to the window's corner", () => {
    document.body.innerHTML = `<div id="q"><p id="s">1. 题干</p><label id="a"><input type="radio" name="q1" id="i" style="display:none"><span>甲</span></label></div>`;
    stub({ q: [400, 480], s: [400, 424], a: [430, 452] });
    document.getElementById("i")!.getBoundingClientRect = () => rect(0, 0, 0, 0);
    const m = open("i");
    expect(parseFloat(m.style.top) + 36).toBeLessThanOrEqual(400); // above the stem
    expect(parseFloat(m.style.top)).toBeGreaterThan(300);
    expect(layer.querySelector<HTMLElement>("[data-cc-hint-target]")!.style.top).toBe("427px");
  });

  it("a script between the stem and the options of a flat page is not taken for the stem", () => {
    document.body.innerHTML =
      `<form id="f"><p id="s1">1. 题干一</p><label id="a1"><input type="radio" name="q1"> 甲</label>` +
      `<p id="s2">2. 题干二</p><script>window.__x = 1</script><label id="a2"><input type="radio" name="q2" id="i2"> 甲</label></form>`;
    stub({ f: [100, 400], s1: [100, 124], a1: [130, 152], s2: [240, 264], a2: [270, 292], i2: [270, 292, 8, 22] });
    const top = parseFloat(open("i2").style.top);
    expect(top + 36).toBeLessThanOrEqual(240);
    expect(top).toBeGreaterThanOrEqual(152);
  });

  it("scrolling with a hint open does not search the page again", () => {
    document.body.innerHTML = `<div id="q"><p id="s">1. 题干</p><label id="a"><input type="radio" name="q1" id="i"> 甲</label><label id="b"><input type="radio" name="q1"> 乙</label></div>`;
    stub({ q: [400, 480], s: [400, 424], a: [430, 452], b: [456, 478], i: [430, 452, 8, 22] });
    open("i");
    const spies = [vi.spyOn(Document.prototype, "querySelectorAll"), vi.spyOn(Element.prototype, "querySelectorAll"), vi.spyOn(Document.prototype, "createTreeWalker")];
    fireEvent.scroll(window);
    fireEvent.scroll(window);
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });

  it("a deeply nested page with no stem is looked through once, not once per level", () => {
    const depth = 300;
    const filler = Array.from({ length: 10 }, () => "<span>正文</span>").join("");
    let html = `<label><input type="radio" name="deep" id="deep"> 甲</label>`;
    for (let i = 0; i < depth; i++) html = `<div>${html}${filler}</div>`;
    document.body.innerHTML = html;
    let reads = 0;
    const real = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!;
    const step = vi.spyOn(TreeWalker.prototype, "nextNode");
    Object.defineProperty(Node.prototype, "textContent", { configurable: true, get() { reads++; return real.get!.call(this); }, set: real.set });
    const t0 = Date.now();
    try {
      open("deep");
    } finally {
      Object.defineProperty(Node.prototype, "textContent", real);
    }
    const visited = step.mock.calls.length;
    step.mockRestore();
    // 300 levels x 10 fillers: one look at each filler, not every subtree again at every level
    expect(reads + visited).toBeLessThan(depth * 10 * 4);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
