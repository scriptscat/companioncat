// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectBlocks, watchBlocks, type Block } from "./blocks";

const EXCLUDE = ["pre", "code", "nav", "[translate=no]"];

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}
const texts = (bs: Block[]) => bs.map((b) => b.text);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("selectBlocks: site selectors and auto detection", () => {
  it("auto-detects paragraphs, list items, headings, blockquotes and table cells", () => {
    const root = mount(`
      <h1>Heading one</h1><p>Paragraph text</p><ul><li>List item text</li></ul>
      <blockquote>Quoted words here</blockquote>
      <table><tr><td>Cell text here</td></tr></table><div>Loose div text</div>`);
    expect(texts(selectBlocks(root, { blocks: "auto", exclude: EXCLUDE }))).toEqual([
      "Heading one",
      "Paragraph text",
      "List item text",
      "Quoted words here",
      "Cell text here",
    ]);
  });

  it("uses the site selector list instead of auto detection", () => {
    const root = mount(`<p>Auto paragraph</p><div class="x">Selected one</div><span class="y">Selected two</span>`);
    expect(texts(selectBlocks(root, { blocks: [".x", ".y"] }))).toEqual(["Selected one", "Selected two"]);
  });

  it("ignores an invalid selector without throwing", () => {
    const root = mount(`<div class="x">Selected one</div>`);
    expect(texts(selectBlocks(root, { blocks: ["!!bad", ".x"] }))).toEqual(["Selected one"]);
  });

  it("ignores too short blocks and blocks that are only numbers or punctuation", () => {
    const root = mount(`<p>ok</p><p>12345</p><p>... --- !!!</p><p>3.14 / 2024</p><p>Real text</p><p>你好吗</p>`);
    expect(texts(selectBlocks(root, { blocks: "auto" }))).toEqual(["Real text", "你好吗"]);
  });

  it("collapses whitespace in the text", () => {
    const root = mount(`<p>  Hello\n   brave   world </p>`);
    expect(texts(selectBlocks(root, { blocks: "auto" }))).toEqual(["Hello brave world"]);
  });
});

describe("selectBlocks: exclude", () => {
  it("skips excluded selectors and anything inside them", () => {
    const root = mount(`
      <nav><p>Navigation paragraph</p></nav>
      <pre><p>Preformatted para</p></pre>
      <p translate="no">No translate</p>
      <div translate="no"><p>Inside no translate</p></div>
      <p>Kept paragraph</p>`);
    expect(texts(selectBlocks(root, { blocks: "auto", exclude: EXCLUDE }))).toEqual(["Kept paragraph"]);
  });

  it("applies exclude to explicit site selectors too", () => {
    const root = mount(`<nav><div class="x">skip me</div></nav><div class="x">keep me</div>`);
    const r = selectBlocks(root, { blocks: [".x"], exclude: ["nav"] });
    expect(texts(r)).toEqual(["keep me"]);
  });
});

describe("selectBlocks: inputs and the companion host", () => {
  it("skips form controls, contenteditable and companion-cat", () => {
    const root = mount(`
      <textarea>Typed text area</textarea>
      <p contenteditable="true">Editable paragraph</p>
      <div contenteditable=""><p>Inside editable</p></div>
      <p contenteditable="false">Not editable para</p>
      <companion-cat><p>Our own UI text</p></companion-cat>`);
    expect(texts(selectBlocks(root, { blocks: "auto" }))).toEqual(["Not editable para"]);
  });
});

describe("selectBlocks: nesting", () => {
  it("auto: returns the innermost block, never a block containing another block", () => {
    const root = mount(`<blockquote><p>Inner paragraph</p></blockquote><table><tr><td><p>Cell para</p></td></tr></table>`);
    expect(texts(selectBlocks(root, { blocks: "auto" }))).toEqual(["Inner paragraph", "Cell para"]);
  });

  it("explicit: never returns a block nested inside another returned block", () => {
    const root = mount(`<div class="a">Outer text <p class="a">Nested text</p></div>`);
    const r = selectBlocks(root, { blocks: [".a"] });
    expect(r).toHaveLength(1);
    expect(r[0]!.el.tagName).toBe("DIV");
  });
});

describe("watchBlocks", () => {
  function setup(html: string, visible: Set<Element> | ((el: Element) => boolean)) {
    const root = mount(html);
    const isVisible = typeof visible === "function" ? visible : (el: Element) => visible.has(el);
    let mutate: () => void = () => {};
    const disconnect = vi.fn();
    const onBlocks = vi.fn<(b: Block[]) => void>();
    const handle = watchBlocks(root, { blocks: "auto" }, onBlocks, {
      isVisible,
      observeMutations: (_r, cb) => {
        mutate = cb;
        return disconnect;
      },
    });
    return { root, onBlocks, mutate: () => mutate(), disconnect, handle };
  }

  it("yields only blocks in the viewport initially", () => {
    const root = mount(`<p id="a">First para</p><p id="b">Second para</p>`);
    const a = root.querySelector("#a")!;
    const onBlocks = vi.fn();
    watchBlocks(root, { blocks: "auto" }, onBlocks, {
      isVisible: (el) => el === a,
      observeMutations: () => () => {},
    });
    expect(onBlocks).toHaveBeenCalledTimes(1);
    expect(texts(onBlocks.mock.calls[0]![0])).toEqual(["First para"]);
  });

  it("yields newly visible blocks on scroll, each exactly once", () => {
    const visible = new Set<Element>();
    const { root, onBlocks } = setup(`<p id="a">First para</p><p id="b">Second para</p>`, visible);
    expect(onBlocks).not.toHaveBeenCalled();
    visible.add(root.querySelector("#a")!);
    window.dispatchEvent(new Event("scroll"));
    expect(onBlocks).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("scroll"));
    expect(onBlocks).toHaveBeenCalledTimes(1);
    visible.add(root.querySelector("#b")!);
    window.dispatchEvent(new Event("scroll"));
    expect(onBlocks).toHaveBeenCalledTimes(2);
    expect(texts(onBlocks.mock.calls[1]![0])).toEqual(["Second para"]);
  });

  it("yields blocks added by the page on mutation, once", () => {
    const { root, onBlocks, mutate } = setup(`<p>First para</p>`, () => true);
    expect(onBlocks).toHaveBeenCalledTimes(1);
    const p = document.createElement("p");
    p.textContent = "Added later";
    root.append(p);
    mutate();
    expect(onBlocks).toHaveBeenCalledTimes(2);
    expect(texts(onBlocks.mock.calls[1]![0])).toEqual(["Added later"]);
    mutate();
    expect(onBlocks).toHaveBeenCalledTimes(2);
  });

  it("stop disconnects the observer and ignores later scroll and mutation", () => {
    const { root, onBlocks, mutate, disconnect, handle } = setup(`<p>First para</p>`, () => true);
    handle.stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
    const p = document.createElement("p");
    p.textContent = "Added later";
    root.append(p);
    mutate();
    window.dispatchEvent(new Event("scroll"));
    expect(onBlocks).toHaveBeenCalledTimes(1);
    handle.stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("the default visibility check leaves out what is not shown at all (an empty box at 0,0)", () => {
    const root = mount(`<p id="shown">Shown text</p><div style="display:none"><p id="none">Collapsed menu text</p></div>`);
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    root.querySelector("#shown")!.getBoundingClientRect = () => ({ top: 100, bottom: 120, left: 0, right: 100, width: 100, height: 20 }) as DOMRect;
    const onBlocks = vi.fn();
    watchBlocks(root, { blocks: "auto" }, onBlocks, { observeMutations: () => () => {} }).stop();
    expect(texts(onBlocks.mock.calls[0]![0])).toEqual(["Shown text"]);
  });

  it("the default visibility check uses the viewport plus a margin", () => {
    const root = mount(`<p id="in">In view</p><p id="near">Near below</p><p id="far">Far below</p>`);
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const tops: Record<string, number> = { in: 100, near: 1000, far: 5000 };
    for (const [id, top] of Object.entries(tops)) {
      root.querySelector("#" + id)!.getBoundingClientRect = () =>
        ({ top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20 }) as DOMRect;
    }
    const onBlocks = vi.fn();
    watchBlocks(root, { blocks: "auto" }, onBlocks, { observeMutations: () => () => {} }).stop();
    expect(texts(onBlocks.mock.calls[0]![0])).toEqual(["In view", "Near below"]);
  });
});
