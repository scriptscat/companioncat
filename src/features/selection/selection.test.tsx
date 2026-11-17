import { act, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installGmHttp, type FakeGm, type Recorded } from "../../../test/fakes/gm-http";
import { createInvoker, type Invoker } from "../../core/invoke";
import { official } from "./testing";
import type { Resolved } from "../../core/rules";
import { createSecretStore, createSettingsStore, createStorage, type Storage } from "../../core/stores";
import { staticRules, type FeatureRegistration, type RuntimeContext } from "../../shell";
import { setup, unmountAll } from "../../shell/testing";
import { enabledKey } from "../page/enabled";
import { selectionContext } from "./context";
import registration from "./register";

const FEATURE = "official-translate/translate";
const ENTRY = "official-translate/translate.selection";
const GOOGLE = "official-translate/google";
const MS = "official-translate/microsoft";
const DEEPSEEK = "official-llm/deepseek";
const HOST = "example-blog.dev";
const recording = (n: string): Recorded[] =>
  (JSON.parse(readFileSync(join(process.cwd(), "test/fixtures/recorded", `${n}.json`), "utf8")) as { exchanges: Recorded[] }).exchanges;


let rect = { left: 100, top: 200, right: 300, bottom: 220 };
const domRect = (r: typeof rect) => ({ ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON() {} }) as DOMRect;

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // jsdom has real Selection/Range but no layout
  Range.prototype.getBoundingClientRect = () => domRect(rect);
  Range.prototype.getClientRects = (() => [domRect(rect)]) as unknown as () => DOMRectList;
});

/** Google answers `G(<tl>):<q>`, Microsoft `M(<to>):<text>`. */
const google = (over: Partial<Recorded> = {}): Recorded => ({
  url: /^https:\/\/translate\.googleapis\.com\/translate_a\/single\?/,
  repeat: true,
  respond: (req) => {
    const u = new URL(req.url);
    const q = u.searchParams.get("q");
    return { json: [[[`G(${u.searchParams.get("tl")}):${q}`, q, null, null, 3]], null, "en"] };
  },
  ...over,
});
const msToken: Recorded = {
  url: "https://www.bing.com/translator",
  repeat: true,
  body: '<script>window._G={IG:"0123ABCD"};</script><script>var params_AbusePreventionHelper = [1700000000000,"tok",3600000];</script>',
};
const ms = (): Recorded => ({
  method: "POST",
  url: /^https:\/\/www\.bing\.com\/ttranslatev3\?/,
  repeat: true,
  respond: (req) => {
    const f = new URLSearchParams(req.data);
    return { json: [{ translations: [{ text: `M(${f.get("to")}):${f.get("text")}` }] }] };
  },
});

let http: FakeGm;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  rect = { left: 100, top: 200, right: 300, bottom: 220 };
  document.title = "Test page";
  document.body.innerHTML = `
    <article>
      <p id="hello"></p>
      <p id="long">First sentence here. The event loop schedules tasks and microtasks. Last one!</p>
      <p id="zh">第一句。事件循环负责调度任务。</p>
      <p id="pad">   </p>
      <label id="lbl">Name <input id="inp" value="hello there"></label>
      <textarea id="ta">some text in a textarea</textarea>
      <div id="ce" contenteditable="true"><span id="ce-inner">editable words here</span></div>
    </article>`;
  document.getElementById("hello")!.textContent = "Hello, world\nGood morning";
  http = installGmHttp([google(), msToken, ms()]);
});

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  unmountAll();
  http.restore();
  getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

interface Opts {
  resolved?: Resolved;
  storage?: Storage;
  hostname?: string;
  services?: Partial<RuntimeContext["services"]>;
}

/** Starts the runtime against a hand-built shell context (real shadow root, spied setAwake/openSettings). */
function start(o: Opts = {}) {
  const resolved = o.resolved ?? official();
  const storage = o.storage ?? createStorage(createGmStorageFake().tab());
  const host = document.createElement("companion-cat");
  const root = host.attachShadow({ mode: "open" });
  const layer = document.createElement("div");
  root.append(layer);
  document.documentElement.append(host);
  const setAwake = vi.fn();
  const openSettings = vi.fn();
  const ctx: RuntimeContext = {
    root,
    layer,
    hostname: o.hostname ?? HOST,
    services: { storage, rules: staticRules(resolved), ...o.services },
    setAwake,
    openSettings,
  };
  let stop: void | (() => void);
  act(() => {
    stop = (registration as FeatureRegistration).start!(ctx);
  });
  const dispose = () => {
    const f = stop;
    stop = undefined;
    act(() => f?.());
  };
  cleanups.push(() => {
    dispose();
    host.remove();
  });
  const ui = within(root as unknown as HTMLElement);
  const settings = createSettingsStore(storage);
  const resolvedEntry = resolved.features[0]!.entries.find((e) => e.id === "selection")!;
  const setEntry = (name: string, value: unknown, h?: string) =>
    settings.set(ENTRY, name, resolvedEntry.def.settings![name]!, value, h);
  const setFeature = (name: string, value: unknown) => settings.set(FEATURE, name, resolved.features[0]!.def.settings![name]!, value);
  return { ctx, ui, root, host, layer, setAwake, openSettings, storage, setEntry, setFeature, resolved, dispose };
}

function textOf(el: Element): Text {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text;
}

/** Selects `part` (default: all) of the element's first text node, then releases the mouse there. */
function select(id: string | Element, part?: string, ev: { altKey?: boolean; target?: Element } = {}) {
  const el = typeof id === "string" ? document.getElementById(id)! : id;
  const node = textOf(el);
  const data = node.data;
  const from = part === undefined ? 0 : data.indexOf(part);
  const to = part === undefined ? data.length : from + part.length;
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const sel = getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent.mouseUp(ev.target ?? el, { altKey: ev.altKey ?? false });
  return range;
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 40)));
const paw = (ui: ReturnType<typeof start>["ui"]) => ui.queryByRole("button", { name: "翻译选中的文字" });
const card = (ui: ReturnType<typeof start>["ui"]) => ui.queryByRole("dialog", { name: "翻译结果" });
const HELLO = "Hello, world\nGood morning";
/** The translation text of each result item. */
const text = (root: ShadowRoot) =>
  [...root.querySelectorAll("[data-part=result-item] [data-part=text][data-style^=reading]")].map((el) => el.textContent);
const items = (root: ShadowRoot) =>
  [...root.querySelectorAll<HTMLElement>("[data-part=result-item]")].map((el) => [el.dataset.engine, el.dataset.state]);

async function openCard(s: ReturnType<typeof start>, id = "hello", part?: string) {
  select(id, part);
  await userEvent.click(await s.ui.findByRole("button", { name: "翻译选中的文字" }));
  return s.ui.findByRole("dialog", { name: "翻译结果" });
}

describe("R9.6 selection trigger", () => {
  it("paw: shows the paw at the selection end, wakes the cat, and goes away when the selection does", async () => {
    const s = start();
    select("hello");
    const p = await s.ui.findByRole("button", { name: "翻译选中的文字" });
    expect(s.setAwake).toHaveBeenLastCalledWith(true);
    expect(card(s.ui)).toBeNull();
    // paw sits right of the selection end
    expect((p.closest("[data-cc-paw]") as HTMLElement).style.left).toBe(`${rect.right + 4}px`);
    act(() => getSelection()!.removeAllRanges());
    await waitFor(() => expect(paw(s.ui)).toBeNull());
    expect(s.setAwake).toHaveBeenLastCalledWith(false);
  });

  it("paw: a new mouse-down on the page hides it", async () => {
    const s = start();
    select("hello");
    await s.ui.findByRole("button", { name: "翻译选中的文字" });
    fireEvent.mouseDown(document.getElementById("long")!);
    await waitFor(() => expect(paw(s.ui)).toBeNull());
  });

  it("none: goes straight to the card", async () => {
    const s = start();
    s.setEntry("confirm", "none");
    select("hello");
    expect(await s.ui.findByRole("dialog", { name: "翻译结果" })).toBeTruthy();
    expect(paw(s.ui)).toBeNull();
  });

  it("alt: only continues when Alt is held", async () => {
    const s = start();
    s.setEntry("confirm", "alt");
    select("hello");
    await settle();
    expect(paw(s.ui)).toBeNull();
    expect(card(s.ui)).toBeNull();
    select("hello", undefined, { altKey: true });
    expect(await s.ui.findByRole("dialog", { name: "翻译结果" })).toBeTruthy();
  });

  it("length bounds: blank and over-long selections do nothing, 5000 characters still do", async () => {
    const s = start();
    select("pad");
    await settle();
    expect(paw(s.ui)).toBeNull();
    const big = document.getElementById("long")!;
    big.textContent = "a".repeat(5001);
    select(big);
    await settle();
    expect(paw(s.ui)).toBeNull();
    big.textContent = ` ${"a".repeat(5000)} `;
    select(big);
    expect(await s.ui.findByRole("button", { name: "翻译选中的文字" })).toBeTruthy();
  });

  it("ignoreIn / R10.7: no paw in input, textarea or editable areas", async () => {
    const s = start();
    select("ta");
    await settle();
    expect(paw(s.ui)).toBeNull();
    select("ce-inner", "words");
    await settle();
    expect(paw(s.ui)).toBeNull();
    // a selection made inside an <input> reports the surrounding text node; the input has focus
    const input = document.getElementById("inp") as HTMLInputElement;
    input.focus();
    select("lbl", "Name", { target: input });
    await settle();
    expect(paw(s.ui)).toBeNull();
    input.blur();
    select("long", "event loop");
    expect(await s.ui.findByRole("button", { name: "翻译选中的文字" })).toBeTruthy();
  });

  it("the default ignoreIn leaves contenteditable=\"false\" regions alone", async () => {
    const resolved = official();
    const entry = resolved.features[0]!.entries.find((e) => e.id === "selection")!;
    for (const t of entry.def.triggers) delete (t as { ignoreIn?: string[] }).ignoreIn;
    const s = start({ resolved });
    const ro = document.createElement("div");
    ro.setAttribute("contenteditable", "false");
    ro.innerHTML = "<span>read only words</span>";
    document.body.append(ro);
    select(ro.firstElementChild!, "only");
    expect(await s.ui.findByRole("button", { name: "翻译选中的文字" })).toBeTruthy();
    select("ce-inner", "words");
    await settle();
    expect(paw(s.ui)).toBeNull();
  });

  it("an entry with an empty match uses the feature's match", async () => {
    const resolved = official();
    resolved.features[0]!.entries.find((e) => e.id === "selection")!.def.match = [];
    const s = start({ resolved });
    select("hello");
    expect(await s.ui.findByRole("button", { name: "翻译选中的文字" })).toBeTruthy();
  });

  it("does not trigger inside the companion's own UI", async () => {
    const s = start();
    const own = document.createElement("p");
    own.textContent = "Text inside the companion card";
    s.layer.append(own);
    select(own);
    await settle();
    expect(paw(s.ui)).toBeNull();
    // and a page selection released over the companion UI does not trigger either
    select("hello", undefined, { target: own });
    await settle();
    expect(paw(s.ui)).toBeNull();
  });
});

describe("R9.6 keyboard and scrolling", () => {
  it("R1.5: while a modal window (settings, host dialog) is open, Esc is left to it and the card stays", async () => {
    const s = start();
    await openCard(s);
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    s.root.append(modal);
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(false);
    expect(card(s.ui)).not.toBeNull();
    modal.remove();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(card(s.ui)).toBeNull());
  });

  it("a keyboard selection shows the paw; Esc hides it and does not bring it back", async () => {
    const s = start();
    select("hello");
    await s.ui.findByRole("button", { name: "翻译选中的文字" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(paw(s.ui)).toBeNull());
    fireEvent.keyUp(document.getElementById("hello")!, { key: "Escape" });
    await settle();
    expect(paw(s.ui)).toBeNull();
    fireEvent.keyUp(document.getElementById("hello")!, { key: "ArrowRight", shiftKey: true });
    expect(await s.ui.findByRole("button", { name: "翻译选中的文字" })).toBeTruthy();
  });

  it("a key that does not change the selection leaves the open card alone", async () => {
    const s = start();
    await openCard(s);
    expect(getSelection()!.isCollapsed).toBe(false);
    fireEvent.keyUp(document.getElementById("hello")!, { key: "ArrowDown" });
    fireEvent.keyUp(document.getElementById("hello")!, { key: "Shift" });
    await settle();
    expect(card(s.ui)).not.toBeNull();
    expect(paw(s.ui)).toBeNull();
  });

  it("select-all: the Meta / Control key-up after Cmd+A or Ctrl+A shows the paw", async () => {
    const s = start();
    const node = textOf(document.getElementById("long")!);
    const range = document.createRange();
    range.selectNodeContents(node);
    act(() => {
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    fireEvent.keyUp(document.getElementById("long")!, { key: "Meta" });
    expect(await s.ui.findByRole("button", { name: "翻译选中的文字" })).toBeTruthy();
  });

  it("the card is opaque and its content scrolls inside the room it has instead of clipping the last row (R13.4)", async () => {
    const s = start();
    const dlg = await openCard(s);
    const box = dlg.closest("[data-cc-card]") as HTMLElement;
    expect(box.className).toContain("bg-fur");
    expect(box.className).not.toMatch(/bg-[a-z-]+\/\d+/);
    const scroller = box.querySelector(":scope > div.relative") as HTMLElement;
    expect(scroller.className).toContain("overflow-y-auto");
    // the only scroller of a long result list: the thin, themed scrollbar of every other scroll area
    expect(scroller.className).toContain("cc-scroll");
    expect(scroller.style.maxHeight).toMatch(/^\d+px$/);
  });

  it("the paw and an unpinned card follow the selection when the page scrolls", async () => {
    const s = start();
    const dlg = await openCard(s);
    const box = dlg.closest("[data-cc-card]") as HTMLElement;
    expect(box.style.top).toBe("230px");
    rect = { left: 100, top: 100, right: 300, bottom: 120 };
    fireEvent.scroll(window);
    await waitFor(() => expect(box.style.top).toBe("130px"));
  });
});

describe("R10.6 switches", () => {
  it("site switch off stops it on this site only", async () => {
    const fake = createGmStorageFake();
    const a = start({ storage: createStorage(fake.tab()) });
    a.setEntry("siteEnabled", false, HOST);
    select("hello");
    await settle();
    expect(paw(a.ui)).toBeNull();
    for (const c of cleanups.splice(0)) c();
    const b = start({ storage: createStorage(fake.tab()), hostname: "other.dev" });
    select("hello");
    expect(await b.ui.findByRole("button", { name: "翻译选中的文字" })).toBeTruthy();
  });

  it("entry switch off stops it everywhere", async () => {
    const s = start();
    s.storage.set(enabledKey(ENTRY), false);
    select("hello");
    await settle();
    expect(paw(s.ui)).toBeNull();
    s.storage.delete(enabledKey(ENTRY));
    select("hello");
    expect(await s.ui.findByRole("button", { name: "翻译选中的文字" })).toBeTruthy();
  });

  it("feature switch off stops it everywhere", async () => {
    const s = start();
    s.storage.set(enabledKey(FEATURE), false);
    select("hello");
    await settle();
    expect(paw(s.ui)).toBeNull();
  });
});

describe("R9.7 selection context", () => {
  it("text is trimmed; lang, sentence (≤500), rect and page come along", async () => {
    const p = document.getElementById("long")!;
    p.textContent = "First sentence here.  The event loop schedules tasks.  Last one!";
    const node = textOf(p);
    const range = document.createRange();
    range.setStart(node, node.data.indexOf("event") - 1);
    range.setEnd(node, node.data.indexOf("loop") + 5);
    const c = selectionContext(range);
    expect(c.text).toBe("event loop");
    expect(c.lang).toBe("en");
    expect(c.sentence).toBe("The event loop schedules tasks.");
    expect(c.rect).toMatchObject({ left: 100, top: 200, width: 200, height: 20 });
    const zh = textOf(document.getElementById("zh")!);
    const r2 = document.createRange();
    r2.setStart(zh, zh.data.indexOf("调度"));
    r2.setEnd(zh, zh.data.indexOf("调度") + 2);
    expect(selectionContext(r2)).toMatchObject({ text: "调度", lang: "zh-CN", sentence: "事件循环负责调度任务。" });
  });

  it("sentence: source line breaks are not sentence ends, block boundaries are", () => {
    const p = document.getElementById("long")!;
    p.textContent = "The quick brown\n    fox jumps.  Next one.";
    const node = textOf(p);
    const r = document.createRange();
    r.setStart(node, node.data.indexOf("fox"));
    r.setEnd(node, node.data.indexOf("fox") + 3);
    expect(selectionContext(r).sentence).toBe("The quick brown fox jumps.");
    const div = document.createElement("div");
    div.innerHTML = "<h2>Title</h2><p>Body starts here. Next.</p>";
    document.body.append(div);
    const r2 = document.createRange();
    r2.setStart(div.querySelector("h2")!.firstChild!, 0);
    r2.setEnd(div.querySelector("p")!.firstChild!, 4);
    expect(selectionContext(r2).sentence).toBe("Title\nBody starts here.");
    // a selection across blocks ends where it ends, not one character per block boundary short
    const three = document.createElement("div");
    three.innerHTML = "<p>A.</p><p>B c</p><p>D.</p>";
    document.body.append(three);
    const ps = three.querySelectorAll("p");
    const r3 = document.createRange();
    r3.setStart(ps[1]!.firstChild!, 0);
    r3.setEnd(ps[2]!.firstChild!, 1);
    expect(selectionContext(r3).sentence).toBe("B c\nD.");
  });

  it("reaches the call: trimmed text, sentence as context", async () => {
    const invoke = vi.fn(async () => ({ ok: true, strategy: "all" as const, contract: "translate", results: [] }));
    const invoker = { invoke, preferredEngines: () => ({ engines: [] }) } as unknown as Invoker;
    const s = start({ services: { invoker } });
    s.setEntry("confirm", "none");
    select("long", "event loop");
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect((invoke.mock.calls[0] as unknown[])[0]).toMatchObject({
      contract: "translate",
      strategy: "all",
      stream: true,
      engines: [GOOGLE, MS],
      input: { texts: ["event loop"], to: "zh-CN", context: "The event loop schedules tasks and microtasks." },
    });
  });
});

describe("R9.7 page and lang in expressions", () => {
  it("run steps see page.url, page.title and selection.lang", async () => {
    const invoke = vi.fn(async () => ({ ok: true, strategy: "all" as const, contract: "translate", results: [] }));
    const invoker = { invoke, preferredEngines: () => ({ engines: [] }) } as unknown as Invoker;
    const resolved = official({
      overrides: {
        [ENTRY]: {
          run: [
            {
              call: "translate",
              strategy: "all",
              engines: [GOOGLE],
              input: { texts: ["{{ selection.text }}"], to: "zh-CN", context: "{{ page.title + ' ' + page.url + ' ' + selection.lang }}" },
              as: "results",
            },
          ],
        },
      },
    });
    const s = start({ resolved, services: { invoker } });
    s.setEntry("confirm", "none");
    select("long", "event loop");
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(((invoke.mock.calls[0] as unknown[])[0] as { input: { context: string } }).input.context).toBe(`Test page ${location.href} en`);
  });
});

describe("R10.1 first selection", () => {
  it("default keyless engines, Google first as the primary result", async () => {
    http.restore();
    http = installGmHttp([...recording("google-translate"), msToken, ms()]);
    const s = start();
    const dlg = within(await openCard(s));
    expect(dlg.getByRole("button", { name: "固定" })).toBeTruthy();
    expect(dlg.getByRole("button", { name: "关闭" })).toBeTruthy();
    expect(dlg.getByRole("combobox").textContent).toContain("简体中文");
    await waitFor(() => expect(items(s.root)).toEqual([[GOOGLE, "ok"], [MS, "ok"]]));
    const [first] = s.root.querySelectorAll("[data-part=result-item]");
    expect((first as HTMLElement).dataset.primary).toBe("true");
    expect(first!.textContent).toContain("你好，世界");
    expect(first!.querySelector("[data-style=reading-lg]")).toBeTruthy();
    expect(text(s.root)[1]).toBe(`M(zh-Hans):${HELLO}`);
    expect(http.calls.some((c) => c.url.includes("deepseek"))).toBe(false);
    expect(s.setAwake).toHaveBeenLastCalledWith(true);
  });

  it("works with the shell's own mount: the corner cat wakes on the paw", async () => {
    const r = setup({ resolved: official(), registrations: [registration as FeatureRegistration] });
    expect(r.cat().dataset.awake).toBe("false");
    select("hello");
    await r.q.findByRole("button", { name: "翻译选中的文字" });
    expect(r.cat().dataset.awake).toBe("true");
  });
});

describe("R10.3 swap if same", () => {
  it("Chinese text translates to English while swap is on, to Chinese when off", async () => {
    const s = start();
    s.setEntry("confirm", "none");
    select("zh", "调度任务");
    await waitFor(() => expect(within(card(s.ui)!).getByText("G(en):调度任务")).toBeTruthy());
    act(() => s.setFeature("swapIfSame", false));
    act(() => getSelection()!.removeAllRanges());
    select("zh", "事件循环");
    await waitFor(() => expect(within(card(s.ui)!).getByText("G(zh-CN):事件循环")).toBeTruthy());
  });
});

describe("R10.4 temporary language", () => {
  it("rerunning in the card re-translates every engine and changes no setting", async () => {
    const s = start();
    const dlg = within(await openCard(s));
    await waitFor(() => expect(items(s.root)).toEqual([[GOOGLE, "ok"], [MS, "ok"]]));
    const before = s.storage.keys("cc:set:");
    await userEvent.click(dlg.getByRole("combobox"));
    await userEvent.click(await s.ui.findByRole("option", { name: "日本語" }));
    await waitFor(() => expect(text(s.root)).toEqual([`G(ja):${HELLO}`, `M(ja):${HELLO}`]));
    expect(dlg.getByRole("combobox").textContent).toContain("日本語");
    expect(s.storage.keys("cc:set:")).toEqual(before);
  });
});

describe("R10.5 per-engine states", () => {
  it("one failing engine shows its error and 重试; retrying runs only that engine", async () => {
    http.restore();
    http = installGmHttp([google({ repeat: false, respond: undefined, status: 429, body: "busy" }), google(), msToken, ms()]);
    const s = start();
    const dlg = within(await openCard(s));
    await waitFor(() => expect(items(s.root)).toEqual([[GOOGLE, "error"], [MS, "ok"]]));
    expect(dlg.getByText("Google 翻译暂时限制了访问，过一会儿再试")).toBeTruthy();
    const msCalls = () => http.calls.filter((c) => c.url.includes("ttranslatev3")).length;
    const before = msCalls();
    await userEvent.click(dlg.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(items(s.root)).toEqual([[GOOGLE, "ok"], [MS, "ok"]]));
    expect(text(s.root)[0]).toBe(`G(zh-CN):${HELLO}`);
    expect(msCalls()).toBe(before);
  });

  it("a chosen engine without a key shows 填 Key, which opens its details", async () => {
    const s = start();
    s.setEntry("engines", [GOOGLE, DEEPSEEK]);
    const dlg = within(await openCard(s));
    await waitFor(() => expect(items(s.root)).toEqual([[GOOGLE, "ok"], [DEEPSEEK, "needKey"]]));
    expect(dlg.getByText("还没填 API Key")).toBeTruthy();
    await userEvent.click(dlg.getByRole("button", { name: "填 Key" }));
    expect(s.openSettings).toHaveBeenCalledWith(`engine:${DEEPSEEK}`);
    expect(http.calls.some((c) => c.url.includes("deepseek"))).toBe(false);
  });

  it("R9.12: open feature-settings opens this card's feature page", async () => {
    const s = start({
      resolved: official({
        overrides: {
          "official-translate/translation-card": {
            header: [{ type: "button", label: "功能设置", action: { open: "feature-settings" } }],
          },
        },
      }),
    });
    const dlg = within(await openCard(s));
    await userEvent.click(dlg.getByRole("button", { name: "功能设置" }));
    expect(s.openSettings).toHaveBeenCalledWith(`feature:${FEATURE}`);
  });

  it("the same text again comes from the cache and says so", async () => {
    const s = start();
    s.setEntry("confirm", "none");
    select("hello");
    await waitFor(() => expect(items(s.root)).toEqual([[GOOGLE, "ok"], [MS, "ok"]]));
    expect(within(card(s.ui)!).queryByText("刚才翻译过，直接用了缓存")).toBeNull();
    const sent = http.calls.length;
    act(() => getSelection()!.removeAllRanges());
    select("hello");
    await waitFor(() => expect(within(card(s.ui)!).getAllByText("刚才翻译过，直接用了缓存").length).toBeGreaterThan(0));
    expect(http.calls.length).toBe(sent);
  });

  it("uses the shell's invoker when one is wired", async () => {
    const storage = createStorage(createGmStorageFake().tab());
    const resolved = official();
    const real = createInvoker({ rules: () => resolved, secrets: createSecretStore(storage, () => resolved) });
    const spy = vi.spyOn(real, "invoke");
    const s = start({ storage, resolved, services: { invoker: real } });
    await openCard(s);
    await waitFor(() => expect(items(s.root)).toEqual([[GOOGLE, "ok"], [MS, "ok"]]));
    expect(spy).toHaveBeenCalled();
  });
});

describe("R9.9 near-selection surface", () => {
  it("appears at once below the selection, before any result", async () => {
    http.restore();
    http = installGmHttp([google({ respond: undefined, error: "hang" }), msToken, { ...ms(), respond: undefined, error: "hang" }]);
    const s = start();
    const dlg = await openCard(s);
    expect(items(s.root)).toEqual([[GOOGLE, "loading"], [MS, "loading"]]);
    const box = dlg.closest("[data-cc-card]") as HTMLElement;
    expect(box.style.top).toBe(`${rect.bottom + 10}px`);
    expect(box.style.left).toBe(`${rect.left}px`);
    expect(box.dataset.side).toBe("below");
  });

  it("flips above when there is no room below, and clamps to the viewport", async () => {
    rect = { left: window.innerWidth - 50, top: window.innerHeight - 40, right: window.innerWidth - 10, bottom: window.innerHeight - 20 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return domRect(this.hasAttribute("data-cc-card") ? { left: 0, top: 0, right: 388, bottom: 300 } : { left: 0, top: 0, right: 0, bottom: 0 });
    });
    const s = start();
    const dlg = await openCard(s);
    const box = dlg.closest("[data-cc-card]") as HTMLElement;
    await waitFor(() => expect(box.dataset.side).toBe("above"));
    expect(box.style.top).toBe(`${rect.top - 10 - 300}px`);
    expect(box.style.left).toBe(`${window.innerWidth - 388 - 8}px`);
  });

  it("closes on Esc, outside click and a new selection", async () => {
    const s = start();
    await openCard(s);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(card(s.ui)).toBeNull());
    expect(s.setAwake).toHaveBeenLastCalledWith(false);

    await openCard(s);
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(card(s.ui)).toBeNull());

    await openCard(s);
    fireEvent.mouseDown(s.ui.getByRole("dialog", { name: "翻译结果" }));
    await settle();
    expect(card(s.ui)).not.toBeNull(); // clicks inside the card keep it
    select("long", "event loop");
    await waitFor(() => expect(card(s.ui)).toBeNull());
  });

  it("a pinned card survives Esc, outside clicks and new selections; only 关闭 closes it", async () => {
    const s = start();
    const dlg = await openCard(s);
    await userEvent.click(within(dlg).getByRole("button", { name: "固定" }));
    expect((dlg.closest("[data-cc-card]") as HTMLElement).dataset.pinned).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(document.body);
    select("long", "event loop");
    await s.ui.findByRole("button", { name: "翻译选中的文字" });
    await settle();
    expect(card(s.ui)).toBe(dlg);
    await userEvent.click(within(dlg).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(card(s.ui)).toBeNull());
  });

  it("shows a step error in the card", async () => {
    const resolved = official({
      overrides: { [ENTRY]: { run: [{ set: { to: "{{ 1 / 0 }}" } }] } },
    });
    const s = start({ resolved });
    s.setEntry("confirm", "none");
    select("hello");
    const dlg = await s.ui.findByRole("dialog", { name: "翻译结果" });
    expect(await within(dlg).findByRole("alert")).toBeTruthy();
  });
});

describe("teardown", () => {
  it("a selection released just before teardown starts no call afterwards", async () => {
    const invoke = vi.fn(async () => ({ ok: true, strategy: "all" as const, contract: "translate", results: [] }));
    const invoker = { invoke, preferredEngines: () => ({ engines: [] }) } as unknown as Invoker;
    const s = start({ services: { invoker } });
    s.setEntry("confirm", "none");
    select("hello");
    s.dispose();
    await settle();
    await settle();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("host page invariant", () => {
  it("never touches the page DOM outside the shadow host", async () => {
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((r) => records.push(...r));
    const s = start();
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const dlg = within(await openCard(s));
    await waitFor(() => expect(items(s.root)).toEqual([[GOOGLE, "ok"], [MS, "ok"]]));
    await userEvent.click(dlg.getByRole("button", { name: "关闭" }));
    await settle();
    mo.disconnect();
    expect(records.filter((r) => r.target !== s.host && !s.host.contains(r.target))).toEqual([]);
  });
});
