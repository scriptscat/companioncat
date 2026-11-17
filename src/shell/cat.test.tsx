import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmStorageFake } from "../../test/fakes/gm-storage";
import { createStorage } from "../platform/storage";
import { defineFeature } from "./registry";
import { EMPTY, focused, setup, unmountAll } from "./testing";

afterEach(unmountAll);

const drag = (el: Element, from: [number, number], to: [number, number]) => {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2 });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: to[0], clientY: to[1] });
  fireEvent.click(el);
};

describe("corner cat (R1.3)", () => {
  it("sleeps in the bottom-right corner: breathing, zzz, not visible to the page's own DOM queries", () => {
    const { cat } = setup();
    const btn = cat();
    expect(btn.style.right).toBe("12px");
    expect(btn.style.bottom).toBe("4px");
    expect(btn.dataset.awake).toBe("false");
    expect(btn.querySelector(".cc-breathe")).not.toBeNull();
    expect(btn.querySelector("text")?.textContent).toContain("z");
    expect(screen.queryByRole("button", { name: "陪伴猫" })).toBeNull();
  });

  it("opens and closes the bubble on click", async () => {
    const user = userEvent.setup();
    const { cat, q } = setup();
    await user.click(cat());
    const bubble = q.getByRole("dialog", { name: "陪伴猫" });
    expect(bubble.textContent).toContain("example-blog.dev");
    expect(cat().getAttribute("aria-expanded")).toBe("true");
    await user.click(cat());
    expect(q.queryByRole("dialog", { name: "陪伴猫" })).toBeNull();
    expect(cat().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes the bubble on Esc and returns focus to the cat (R13.3)", async () => {
    const user = userEvent.setup();
    const { cat, q, root } = setup();
    await user.click(cat());
    const bubble = q.getByRole("dialog", { name: "陪伴猫" });
    expect(bubble.contains(focused(root))).toBe(true);
    fireEvent.keyDown(focused(root)!, { key: "Escape" });
    expect(q.queryByRole("dialog", { name: "陪伴猫" })).toBeNull();
    expect(focused(root)).toBe(cat());
  });

  it("can be dragged; the spot is remembered across page loads, and a drag is not a click", () => {
    const fake = createGmStorageFake();
    const storage = createStorage(fake.tab());
    const first = setup({ storage });
    drag(first.cat(), [980, 720], [880, 620]);
    expect(first.cat().style.right).toBe("112px");
    expect(first.cat().style.bottom).toBe("104px");
    expect(first.q.queryByRole("dialog", { name: "陪伴猫" })).toBeNull();
    unmountAll();

    const again = setup({ storage: createStorage(fake.tab()) });
    expect(again.cat().style.right).toBe("112px");
    expect(again.cat().style.bottom).toBe("104px");
  });

  it("stays inside the viewport when dragged past an edge", () => {
    const { cat } = setup();
    drag(cat(), [980, 720], [5000, 5000]);
    expect(cat().style.right).toBe("0px");
    expect(cat().style.bottom).toBe("0px");
  });

  it("is pulled back inside when the window shrinks", () => {
    const { cat } = setup();
    drag(cat(), [980, 720], [80, 720]);
    expect(cat().style.right).toBe("912px");
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 500 });
      window.dispatchEvent(new Event("resize"));
    });
    expect(cat().style.right).toBe("414px");
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
  });

  it("wakes up while a feature shows its paw or card, and sleeps again after", () => {
    let wake!: (on: boolean) => void;
    const paw = defineFeature({
      id: "selection",
      start(ctx) {
        wake = ctx.setAwake;
      },
    });
    const { cat } = setup({ registrations: [paw] });
    act(() => wake(true));
    expect(cat().dataset.awake).toBe("true");
    expect(cat().querySelector("text")).toBeNull();
    expect(cat().querySelector(".cc-breathe")).toBeNull();
    act(() => wake(false));
    expect(cat().dataset.awake).toBe("false");
  });

  it("is not shown when hidden globally or on this site", () => {
    const fake = createGmStorageFake();
    const storage = createStorage(fake.tab());
    storage.set("cc:shell:show-cat", false);
    expect(setup({ storage }).q.queryByRole("button", { name: "陪伴猫" })).toBeNull();
    unmountAll();
    storage.delete("cc:shell:show-cat");
    storage.set("cc:shell:cat-off@example-blog.dev", true);
    expect(setup({ storage }).q.queryByRole("button", { name: "陪伴猫" })).toBeNull();
    unmountAll();
    expect(setup({ storage, hostname: "other.dev" }).q.queryByRole("button", { name: "陪伴猫" })).not.toBeNull();
  });

  it("「让小猫先躲起来」 hides the cat for this page", async () => {
    const user = userEvent.setup();
    const { cat, q } = setup();
    await user.click(cat());
    await user.click(q.getByRole("button", { name: "让小猫先躲起来" }));
    expect(q.queryByRole("button", { name: "陪伴猫" })).toBeNull();
    expect(q.queryByRole("dialog", { name: "陪伴猫" })).toBeNull();
  });
});

describe("quick bubble", () => {
  it("with no rules says the cat knows nothing yet and offers to subscribe (R1.6)", async () => {
    const user = userEvent.setup();
    let subscribed = 0;
    const { cat, q } = setup({ resolved: EMPTY, subscribeOfficial: () => void subscribed++ });
    await user.click(cat());
    const bubble = q.getByRole("dialog", { name: "陪伴猫" });
    expect(bubble.textContent).toContain("陪伴猫还什么都不会");
    await user.click(q.getByRole("button", { name: "订阅官方规则" }));
    expect(subscribed).toBe(1);
  });

  it("shows why subscribing failed, and disables the button when subscriptions are not wired", async () => {
    const user = userEvent.setup();
    const failing = setup({ resolved: EMPTY, subscribeOfficial: () => Promise.reject(new Error("网络不通")) });
    await user.click(failing.cat());
    await user.click(failing.q.getByRole("button", { name: "订阅官方规则" }));
    expect((await failing.q.findByRole("alert")).textContent).toBe("订阅失败：网络不通");
    unmountAll();
    const unwired = setup({ resolved: EMPTY });
    await user.click(unwired.cat());
    expect((unwired.q.getByRole("button", { name: "订阅官方规则" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows each feature's quick items when rules exist", async () => {
    const user = userEvent.setup();
    const f = defineFeature({ id: "selection", quick: () => <p>划词主要用</p> });
    const { cat, q } = setup({ registrations: [f] });
    await user.click(cat());
    const bubble = q.getByRole("dialog", { name: "陪伴猫" });
    expect(bubble.textContent).toContain("划词主要用");
    expect(bubble.textContent).not.toContain("陪伴猫还什么都不会");
  });
});

describe("teardown", () => {
  it("a feature whose stop throws still lets the others stop and the shell leave the page", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stopped = vi.fn();
      const bad = defineFeature({ id: "bad", start: () => () => { throw new Error("stop failed"); } });
      const good = defineFeature({ id: "good", start: () => stopped });
      const { handle } = setup({ registrations: [bad, good] });
      expect(() => act(() => handle.unmount())).not.toThrow();
      expect(stopped).toHaveBeenCalled();
      expect(handle.host.isConnected).toBe(false);
    } finally {
      quiet.mockRestore();
    }
  });
});
