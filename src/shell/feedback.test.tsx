import { act, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineFeature, type RuntimeContext } from "./registry";
import { setup, unmountAll } from "./testing";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  unmountAll();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function mountCtx() {
  const ctxs: Record<string, RuntimeContext> = {};
  const regs = ["a", "b"].map((id) => defineFeature({ id, start: (c) => void (ctxs[id] = c) }));
  const s = setup({ registrations: regs });
  return { ...s, a: ctxs.a!, b: ctxs.b! };
}
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("awake label (R2.1)", () => {
  it("shows the label next to the cat while on, with the cat awake", () => {
    const s = mountCtx();
    expect(s.q.queryByText("等你回答")).toBeNull();
    act(() => s.a.setAwake(true, "等你回答"));
    expect(s.q.getByText("等你回答")).toBeTruthy();
    expect(s.cat().dataset.awake).toBe("true");
    act(() => s.a.setAwake(false));
    expect(s.q.queryByText("等你回答")).toBeNull();
    expect(s.cat().dataset.awake).toBe("false");
  });

  it("latest label wins and each feature clears only its own", () => {
    const s = mountCtx();
    act(() => s.a.setAwake(true, "等你回答"));
    act(() => s.b.setAwake(true, "在翻译"));
    expect(s.q.queryByText("等你回答")).toBeNull();
    expect(s.q.getByText("在翻译")).toBeTruthy();
    act(() => s.b.setAwake(false));
    expect(s.q.getByText("等你回答")).toBeTruthy();
    expect(s.cat().dataset.awake).toBe("true");
    act(() => s.a.setAwake(true));
    expect(s.q.queryByText("等你回答")).toBeNull();
    expect(s.cat().dataset.awake).toBe("true");
  });
});

describe("label while asleep (R9.4: 网页对照进行中 shows 对照中 next to the sleeping cat)", () => {
  it("setAwake(false, label) shows the label with the cat still asleep; setAwake(false) clears it", () => {
    const s = mountCtx();
    act(() => s.a.setAwake(false, "对照中"));
    expect(s.q.getByText("对照中")).toBeTruthy();
    expect(s.cat().dataset.awake).toBe("false");
    act(() => s.a.setAwake(false));
    expect(s.q.queryByText("对照中")).toBeNull();
  });
});

describe("toast (R2.2)", () => {
  it("shows text and links near the cat, a link runs its handler and closes the toast", () => {
    const s = mountCtx();
    const undo = vi.fn();
    const log = vi.fn();
    act(() =>
      s.a.toast!({
        text: "小猫帮你点了「跳过广告」（93%）",
        links: [
          { label: "撤销", onClick: undo },
          { label: "记录", onClick: log },
        ],
      }),
    );
    const t = s.q.getByRole("status");
    expect(t.textContent).toContain("小猫帮你点了「跳过广告」（93%）");
    expect(t.getAttribute("aria-live")).toBe("polite");
    act(() => void fireEvent.click(s.q.getByRole("button", { name: "撤销" })));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(s.q.queryByRole("status")).toBeNull();
  });

  it("stacks several toasts, each with a close button", () => {
    const s = mountCtx();
    act(() => s.a.toast!({ text: "一" }));
    act(() => s.b.toast!({ text: "二" }));
    expect(s.q.getAllByRole("status")).toHaveLength(2);
    act(() => void fireEvent.click(s.q.getAllByRole("button", { name: "关闭" })[0]!));
    expect(s.q.getAllByRole("status")).toHaveLength(1);
    expect(s.q.getByText("二")).toBeTruthy();
  });

  it("dismisses itself after about 5 s, or after ms", () => {
    const s = mountCtx();
    act(() => s.a.toast!({ text: "默认" }));
    act(() => s.a.toast!({ text: "短", ms: 1000 }));
    tick(1100);
    expect(s.q.queryByText("短")).toBeNull();
    expect(s.q.getByText("默认")).toBeTruthy();
    tick(4000);
    expect(s.q.queryByText("默认")).toBeNull();
  });

  it("does not dismiss while hovered or focused, and counts again afterwards", () => {
    const s = mountCtx();
    act(() => s.a.toast!({ text: "悬停", ms: 1000, links: [{ label: "记录", onClick() {} }] }));
    const t = () => s.q.getByRole("status");
    act(() => void fireEvent.pointerEnter(t()));
    tick(3000);
    expect(s.q.getByText("悬停")).toBeTruthy();
    act(() => void fireEvent.pointerLeave(t()));
    tick(1100);
    expect(s.q.queryByText("悬停")).toBeNull();

    act(() => s.a.toast!({ text: "聚焦", ms: 1000, links: [{ label: "记录", onClick() {} }] }));
    act(() => s.q.getByRole("button", { name: "记录" }).focus());
    tick(3000);
    expect(s.q.getByText("聚焦")).toBeTruthy();
    act(() => s.q.getByRole("button", { name: "记录" }).blur());
    tick(1100);
    expect(s.q.queryByText("聚焦")).toBeNull();
  });

  it("Esc dismisses the newest toast", () => {
    const s = mountCtx();
    act(() => s.a.toast!({ text: "旧" }));
    act(() => s.a.toast!({ text: "新" }));
    act(() => void fireEvent.keyDown(document, { key: "Escape" }));
    expect(s.q.queryByText("新")).toBeNull();
    expect(s.q.getByText("旧")).toBeTruthy();
    act(() => void fireEvent.keyDown(document, { key: "Escape" }));
    expect(s.q.queryByText("旧")).toBeNull();
  });

  it("toast() returns a function that dismisses it", () => {
    const s = mountCtx();
    let off!: () => void;
    act(() => void (off = s.a.toast!({ text: "会收回" })));
    act(() => off());
    expect(s.q.queryByText("会收回")).toBeNull();
  });
});

describe("toast above the settings window (R2.2, R9.4)", () => {
  const zOf = (el: HTMLElement) => {
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      const m = /(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/.exec(n.className);
      if (m) return Number(m[1] ?? m[2]);
    }
    return 0;
  };

  it("the toast layer stacks above the open settings dialog and stays reachable", () => {
    const s = mountCtx();
    act(() => s.handle.openSettings());
    act(() => void s.a.toast?.({ text: "小猫帮你点了「跳过广告」", links: [{ label: "撤销", onClick: vi.fn() }] }));
    const toast = s.q.getByText("小猫帮你点了「跳过广告」");
    const dialog = s.q.getByRole("dialog", { name: "陪伴猫设置" });
    expect(zOf(toast)).toBeGreaterThan(zOf(dialog));
    expect(s.q.getByRole("button", { name: "撤销" })).toBeTruthy();
  });
});
