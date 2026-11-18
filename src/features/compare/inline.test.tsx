// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallError } from "../../core/errors";
import type { BatchResult } from "./batch";
import type { Block } from "./blocks";
import { createInline, INLINE_TAG } from "./Inline";

const CSS = ":host { --ink: #2a2421; --font-read: serif; }";

function page() {
  document.body.innerHTML = `<article id="a"><p id="p1" style="color: red">One</p><p id="p2">Two</p><p id="p3">Three</p></article>`;
  const blocks: Block[] = ["p1", "p2", "p3"].map((id) => {
    const el = document.getElementById(id)!;
    return { el, text: el.textContent! };
  });
  return blocks;
}
const trOf = (b: Block) => b.el.nextElementSibling as HTMLElement;
const shadow = (b: Block) => trOf(b).shadowRoot!;
const ok = (blocks: Block[], texts: string[], index = 0): BatchResult => ({
  index,
  ok: true,
  cached: false,
  blocks,
  items: blocks.map((block, i) => ({ block, text: texts[i]! })),
});
const fail = (blocks: Block[], type: ConstructorParameters<typeof CallError>[0], index = 0): BatchResult => ({
  index,
  ok: false,
  blocks,
  error: new CallError(type),
});
const make = (extra = {}) =>
  createInline({ css: CSS, openSettings: vi.fn(), onRetry: vi.fn(), ...extra });

afterEach(() => {
  document.body.innerHTML = "";
});

describe("inline translation (R7.4)", () => {
  it("inserts a custom element with its own shadow root right after each block, in the reading font", () => {
    const blocks = page();
    const inl = make();
    inl.pending(blocks);
    expect(trOf(blocks[0]!).localName).toBe(INLINE_TAG);
    expect(trOf(blocks[2]!).localName).toBe(INLINE_TAG);
    inl.show(ok([blocks[0]!], ["一"]));
    const root = shadow(blocks[0]!);
    expect(root.textContent).toContain("一");
    const sheetText = root.adoptedStyleSheets.flatMap((x) => [...x.cssRules].map((r) => r.cssText)).join("\n") + (root.querySelector("style")?.textContent ?? "");
    expect(sheetText).toMatch(/\.tr \{[^}]*font-family: var\(--font-read\)/);
  });

  it("keeps the translation out of the light DOM (page CSS cannot reach it) and does not touch the host's style sheets", () => {
    const blocks = page();
    const inl = make();
    inl.show(ok([blocks[0]!], ["一"]));
    expect(trOf(blocks[0]!).textContent).toBe("");
    expect(document.head.querySelectorAll("style").length).toBe(0);
    expect(shadow(blocks[0]!).host.getAttribute("style")).toBeNull();
  });

  it("shows a placeholder while loading and replaces it when the batch arrives, per block", () => {
    const blocks = page();
    const inl = make();
    inl.pending(blocks);
    expect(shadow(blocks[1]!).querySelector('[aria-label="正在翻译"]')).not.toBeNull();
    inl.show(ok([blocks[0]!, blocks[1]!], ["一", "二"]));
    expect(shadow(blocks[1]!).querySelector('[aria-label="正在翻译"]')).toBeNull();
    expect(shadow(blocks[1]!).textContent).toContain("二");
    expect(shadow(blocks[2]!).querySelector('[aria-label="正在翻译"]')).not.toBeNull();
  });

  it("does not insert a second element when a block is shown twice", () => {
    const blocks = page();
    const inl = make();
    inl.pending(blocks);
    inl.show(ok([blocks[0]!], ["一"]));
    inl.show(ok([blocks[0]!], ["一一"]));
    expect(document.querySelectorAll(INLINE_TAG).length).toBe(3);
    expect(shadow(blocks[0]!).textContent).toContain("一一");
  });

  it("只看译文 hides the sources without removing them, and shows them again when switched off", () => {
    const blocks = page();
    const inl = make();
    inl.show(ok(blocks, ["一", "二", "三"]));
    inl.setOnly(true);
    for (const b of blocks) {
      expect(b.el.isConnected).toBe(true);
      expect((b.el as HTMLElement).style.getPropertyValue("display")).toBe("none");
      expect(trOf(b).hidden).toBe(false);
    }
    inl.setOnly(false);
    expect(blocks[0]!.el.getAttribute("style")).toBe("color: red");
    expect(blocks[1]!.el.hasAttribute("style")).toBe(false);
  });

  it("hides blocks that are translated after 只看译文 was switched on", () => {
    const blocks = page();
    const inl = make({ only: true });
    inl.pending(blocks);
    inl.show(ok([blocks[2]!], ["三"]));
    expect((blocks[2]!.el as HTMLElement).style.display).toBe("none");
  });
});

describe("failures (R7.5)", () => {
  it("shows a 重试 under every block of a failed batch only; clicking asks the caller to retry that batch and goes back to the placeholder", () => {
    const blocks = page();
    const onRetry = vi.fn();
    const inl = make({ onRetry });
    inl.show(ok([blocks[0]!], ["一"], 0));
    inl.show(fail([blocks[1]!, blocks[2]!], "rateLimit", 1));
    expect(shadow(blocks[0]!).querySelector("button")).toBeNull();
    const btn = shadow(blocks[1]!).querySelector("button")!;
    expect(btn.textContent).toContain("重试");
    expect(shadow(blocks[2]!).querySelector("button")).not.toBeNull();
    btn.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, [blocks[1], blocks[2]]);
    expect(shadow(blocks[1]!).querySelector('[aria-label="正在翻译"]')).not.toBeNull();
    expect(shadow(blocks[2]!).querySelector('[aria-label="正在翻译"]')).not.toBeNull();
  });

  it.each(["missingKey", "disabled"] as const)("%s: a hint and a link to the engines page, no 重试", (type) => {
    const blocks = page();
    const openSettings = vi.fn();
    const inl = make({ openSettings });
    inl.show(fail([blocks[0]!], type));
    const root = shadow(blocks[0]!);
    expect(root.querySelector("button")).toBeNull();
    const link = root.querySelector("a")!;
    expect(root.textContent).toContain(type === "missingKey" ? "Key" : "停用");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(openSettings).toHaveBeenCalledWith("engines");
  });
});

describe("restore (R7.2)", () => {
  it("removes every inserted element and leaves the host DOM exactly as before", () => {
    const blocks = page();
    const before = document.body.innerHTML;
    const inl = make();
    inl.pending(blocks);
    inl.show(ok([blocks[0]!], ["一"]));
    inl.show(fail([blocks[1]!], "missingKey", 1));
    inl.setOnly(true);
    expect(document.body.innerHTML).not.toBe(before);
    inl.restore();
    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelectorAll(INLINE_TAG).length).toBe(0);
  });

  it("ignores results that arrive after restore", () => {
    const blocks = page();
    const before = document.body.innerHTML;
    const inl = make({ only: true });
    inl.restore();
    inl.show(ok([blocks[0]!], ["一"]));
    inl.pending(blocks);
    expect(document.body.innerHTML).toBe(before);
  });
});

describe("long pages that drop their paragraphs (infinite feeds)", () => {
  it("lets go of a paragraph the page removed together with its translation, giving its style back first", () => {
    const blocks = page();
    const article = document.getElementById("a")!;
    const inl = make({ only: true });
    inl.pending([blocks[0]!]);
    expect(blocks[0]!.el.getAttribute("style")).toContain("display: none");
    article.remove(); // the feed recycled this part of the page
    document.body.innerHTML = `<p id="q">Later</p>`;
    const later = { el: document.getElementById("q")!, text: "Later" };
    inl.pending([later]);
    // put back by the page later: the source is shown as it was, not left hidden by a translation that is gone
    document.body.append(article);
    expect(blocks[0]!.el.getAttribute("style")).toBe("color: red");
    expect(article.querySelector(INLINE_TAG)).toBeNull();
    inl.restore();
    expect(blocks[0]!.el.getAttribute("style")).toBe("color: red");
    expect(document.querySelectorAll(INLINE_TAG)).toHaveLength(0);
  });
});
