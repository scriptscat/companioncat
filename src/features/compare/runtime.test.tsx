import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { CallError } from "../../core/errors";
import { installGmHttp } from "../../../test/fakes/gm-http";
import { testProvider } from "../../core/impl/testkit";
import { createInvoker, type InvokeRequest, type InvokeResult, type Invoker } from "../../core/invoke";
import { resolveRules, type Resolved, type SettingDef } from "../../core/rules";
import { createSecretStore, createSettingsStore, createStorage, type Storage } from "../../core/stores";
import { staticRules, type Command, type FeatureRegistration, type RulesSource, type RuntimeContext } from "../../shell";
import { enabledKey } from "../page/enabled";
import registration from "./register";
import { COMPARING, RESTORE_TITLE, startCompare, type CompareDeps } from "./runtime";
import { INLINE_TAG } from "./Inline";

const HOST = "example-blog.dev";
const FEATURE = "official-translate/translate";
const ENTRY = `${FEATURE}.page`;
const TITLE = "对照翻译这个网页";
const CSS = ":host { --font-read: serif; }";

const readPack = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "rules/packs", `${name}.json`), "utf8"));
const translatePack = () => readPack("official-translate");
const official = (...local: object[]): Resolved =>
  resolveRules([{ pack: translatePack(), official: true }, ...local.map((pack) => ({ pack, local: true }))]);
const siteRule = (blocks: string[], match = ["*://localhost/docs/*"]) => ({
  schema: 1,
  id: "local",
  sites: [{ match, for: ENTRY, blocks }],
});

/** A long article: a nav, a title, 40 paragraphs, a code block and a do-not-translate line. `data-y` is the paragraph's row on the page. */
const ARTICLE = `
<nav><p data-y="0">Home · Posts · About this blog</p></nav>
<article class="content">
  <h1 data-y="0">Understanding the Event Loop in Modern Browsers</h1>
  ${Array.from({ length: 40 }, (_, i) => `<p data-y="${i + 1}">Paragraph ${i + 1}: the event loop picks one task, runs it, then drains every microtask.</p>`).join("\n  ")}
  <pre data-y="3"><code>console.log("sync");</code></pre>
  <p data-y="2" translate="no">This sentence must stay in English.</p>
</article>
<aside><p data-y="1">Related posts you might like to read next.</p></aside>`;

/** Rows 0..fold-1 are in the viewport. */
let fold = 10;
const isVisible = (el: Element) => Number((el as HTMLElement).dataset.y ?? 0) < fold;
const scrollTo = (rows: number) => {
  fold = rows;
  fireEvent.scroll(window);
};

type Call = { req: InvokeRequest; signal?: AbortSignal };
type Answer = (req: InvokeRequest, n: number) => InvokeResult | undefined | Promise<InvokeResult | undefined>;

/** Answers 「译:<text>」 per text unless `answer` returns something else. */
function fakeInvoker(answer: Answer = () => undefined) {
  const calls: Call[] = [];
  const invoke = vi.fn(async (req: InvokeRequest, opts?: { signal?: AbortSignal }): Promise<InvokeResult> => {
    calls.push({ req, signal: opts?.signal });
    const custom = await answer(req, calls.length - 1);
    if (custom) return custom;
    const { texts } = req.input as { texts: string[] };
    return { ok: true, strategy: "first", contract: "translate", output: { texts: texts.map((t) => `译:${t}`) }, cached: false, results: [] };
  });
  const invoker = { invoke, preferredEngines: () => ({ engines: [], preferred: undefined, using: undefined }) } as unknown as Invoker;
  return { invoker, calls, invoke };
}
const failed = (type: ConstructorParameters<typeof CallError>[0]): InvokeResult => ({
  ok: false,
  strategy: "first",
  contract: "translate",
  error: new CallError(type),
  results: [],
});

interface Opts {
  resolved?: Resolved;
  rules?: RulesSource;
  storage?: Storage;
  invoker?: Invoker;
  deps?: CompareDeps;
  viaRegister?: boolean;
}

const cleanups: (() => void)[] = [];

function start(o: Opts = {}) {
  const storage = o.storage ?? createStorage(createGmStorageFake().tab());
  const fake = o.invoker ? undefined : fakeInvoker();
  const invoker = o.invoker ?? fake!.invoker;
  const host = document.createElement("companion-cat");
  const root = host.attachShadow({ mode: "open" });
  const layer = document.createElement("div");
  root.append(layer);
  document.documentElement.append(host);
  const commands = new Map<string, Command>();
  const setAwake = vi.fn();
  const openSettings = vi.fn();
  const ctx: RuntimeContext = {
    root,
    layer,
    hostname: HOST,
    services: { storage, rules: o.rules ?? staticRules(o.resolved ?? official()), invoker },
    setAwake,
    openSettings,
    commands: {
      register(cmd) {
        commands.set(cmd.id, cmd);
        return () => {
          if (commands.get(cmd.id) === cmd) commands.delete(cmd.id);
        };
      },
    },
  };
  const stop = o.viaRegister
    ? (registration as FeatureRegistration).start!(ctx)
    : startCompare(ctx, { isVisible, css: CSS, ...o.deps });
  cleanups.push(() => {
    if (typeof stop === "function") stop();
    host.remove();
  });
  const command = () => [...commands.values()].find((c) => c.title === TITLE || c.title === RESTORE_TITLE);
  const settings = createSettingsStore(storage);
  const def = (name: string) => (o.resolved ?? official()).features[0]!.entries.find((e) => e.id === "page")!.def.settings![name] as SettingDef;
  const set = (name: string, value: unknown, site?: string) => act(() => void settings.set(ENTRY, name, def(name), value, site));
  return { ctx, storage, commands, command, setAwake, openSettings, set, calls: fake?.calls, invoke: fake?.invoke };
}

/** The translation element after `el`, or undefined. */
const trAfter = (el: Element) => (el.nextElementSibling?.localName === INLINE_TAG ? (el.nextElementSibling as HTMLElement) : undefined);
const trText = (el: Element) => trAfter(el)?.shadowRoot?.textContent ?? "";
/** The article paragraph on row `n`. */
const para = (n: number) => document.querySelector(`article > p[data-y="${n}"]:not([translate])`)!;
const translated = () => document.querySelectorAll(INLINE_TAG).length;
const flush = async () => {
  for (let i = 0; i < 10; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};

let original = "";
beforeEach(() => {
  fold = 10;
  history.replaceState(null, "", "/posts/event-loop");
  document.body.innerHTML = ARTICLE;
  original = document.body.innerHTML;
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the 网页对照 command (R7.1, R7.2)", () => {
  it("registers 对照翻译这个网页 as a quick command with the 快捷键 setting (default Alt+A)", async () => {
    const s = start();
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    expect(s.command()).toMatchObject({ title: TITLE, hotkey: "Alt+A", quick: true });
  });

  it("takes a changed hotkey, and no hotkey when the setting is cleared", async () => {
    const s = start();
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    s.set("hotkey", "Ctrl+Shift+K");
    await vi.waitFor(() => expect(s.command()!.hotkey).toBe("Ctrl+Shift+K"));
    s.set("hotkey", "");
    await vi.waitFor(() => expect(s.command()!.hotkey).toBeUndefined());
    expect(s.command()!.title).toBe(TITLE);
  });

  it("registers nothing when the entry is switched off, and goes away when it is switched off later", async () => {
    const storage = createStorage(createGmStorageFake().tab());
    storage.set(enabledKey(ENTRY), false);
    const s = start({ storage });
    await flush();
    expect(s.command()).toBeUndefined();
    act(() => storage.delete(enabledKey(ENTRY)));
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    act(() => storage.set(enabledKey(ENTRY), false));
    await vi.waitFor(() => expect(s.command()).toBeUndefined());
  });

  it("is registered by register.tsx through defineFeature", async () => {
    const s = start({ viaRegister: true });
    await vi.waitFor(() => expect(s.command()).toMatchObject({ title: TITLE, hotkey: "Alt+A" }));
  });
});

describe("turning it on: paragraphs, batches and inline translations (R7.3, R7.4)", () => {
  it("translates only paragraphs in the viewport, skipping nav, code and translate=no, through the shared invoker with the engine and to settings", async () => {
    const s = start();
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    act(() => s.command()!.run());
    await vi.waitFor(() => expect(trText(para(1))).toBe(`译:${para(1).textContent}`));
    // h1 + paragraphs 1..9 + the aside line: 11 blocks in one batch (20 per batch by default)
    expect(s.calls!.length).toBe(1);
    const req = s.calls![0]!.req;
    expect(req).toMatchObject({ contract: "translate", engines: ["official-translate/microsoft"], strategy: "first" });
    expect((req.input as { to: string }).to).toBe("zh-CN");
    expect((req.input as { texts: string[] }).texts).toHaveLength(11);
    expect(trText(document.querySelector("h1")!)).toContain("译:Understanding");
    expect(trAfter(para(10))).toBeUndefined(); // below the fold
    expect(trAfter(document.querySelector("nav p")!)).toBeUndefined();
    expect(trAfter(document.querySelector("[translate=no]")!)).toBeUndefined();
    expect(document.querySelector("pre")!.innerHTML).toBe('<code>console.log("sync");</code>');
    // the cat keeps sleeping while comparing, with 对照中 next to it (mockup v6 网页对照·进行中)
    expect(s.setAwake).toHaveBeenLastCalledWith(false, COMPARING);
  });

  it("splits by count: 30 visible paragraphs go out as two batches, each shown as soon as it settles", async () => {
    fold = 30;
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const f = fakeInvoker(async (_req, n) => {
      if (n === 1) await slow;
      return undefined;
    });
    const s = start({ invoker: f.invoker });
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    act(() => s.command()!.run());
    await vi.waitFor(() => expect(trText(para(1))).toContain("译:"));
    expect(f.calls.length).toBe(2);
    expect(f.calls.map((c) => (c.req.input as { texts: string[] }).texts.length)).toEqual([20, 11]);
    // the second batch is still out: its paragraphs show the placeholder
    const last = para(29);
    expect(trAfter(last)!.shadowRoot!.querySelector('[aria-label="正在翻译"]')).toBeTruthy();
    release();
    await vi.waitFor(() => expect(trText(last)).toContain("译:"));
  });

  it("uses the site rule's blocks when one matches the page, auto paragraphs otherwise", async () => {
    history.replaceState(null, "", "/docs/event-loop");
    const s = start({ resolved: official(siteRule(["aside p"])) });
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    act(() => s.command()!.run());
    await vi.waitFor(() => expect(translated()).toBe(1));
    expect(trText(document.querySelector("aside p")!)).toContain("译:Related posts");
    expect(trAfter(para(1))).toBeUndefined();
  });

  it("does not use a site rule for other pages", async () => {
    const s = start({ resolved: official(siteRule(["aside p"])) }); // at /posts/..., the rule is for /docs/*
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    act(() => s.command()!.run());
    await vi.waitFor(() => expect(trText(para(1))).toContain("译:"));
    expect(translated()).toBe(11);
  });

  it("translates paragraphs that scroll into view, and new paragraphs the page adds, once each", async () => {
    const s = start();
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    act(() => s.command()!.run());
    await vi.waitFor(() => expect(s.calls!.length).toBe(1));
    act(() => scrollTo(15));
    await vi.waitFor(() => expect(trText(para(14))).toContain("译:"));
    expect(s.calls!.length).toBe(2);
    expect((s.calls![1]!.req.input as { texts: string[] }).texts).toHaveLength(5);
    act(() => scrollTo(15));
    await flush();
    expect(s.calls!.length).toBe(2);
    const added = document.createElement("p");
    added.dataset.y = "3";
    added.textContent = "A comment loaded after the article.";
    act(() => document.querySelector("article")!.append(added));
    await vi.waitFor(() => expect(trText(added)).toBe("译:A comment loaded after the article."));
    expect(s.calls!.length).toBe(3);
  });

  it("goes through the shared invoker's cache: turning it off and on again sends nothing new", async () => {
    // a real invoker (result cache included) over a fake GM_xmlhttpRequest, with a keyless test engine
    const a = testProvider({
      id: "a",
      hosts: ["a.test"],
      implements: {
        translate: {
          http: {
            request: { method: "POST", url: "https://a.test/t", json: { texts: "{{ input.texts }}", to: "{{ input.to }}" } },
            response: "json",
            output: { texts: "{{ response.texts }}" },
          },
        },
      },
    });
    const base = resolveRules([{ pack: readPack("official-llm"), official: true }]);
    const rules: Resolved = { ...base, providers: [...base.providers, a] };
    const fake = installGmHttp([
      {
        url: "https://a.test/t",
        repeat: true,
        respond: (req) => ({ json: { texts: (JSON.parse(req.data!) as { texts: string[] }).texts.map((t) => `a:${t}`) } }),
      },
    ]);
    const real = { fake, invoker: createInvoker({ rules: () => rules, secrets: createSecretStore(createStorage(createGmStorageFake().tab()), () => rules) }) };
    try {
      const s = start({ invoker: real.invoker });
      s.set("engine", "test/a");
      await vi.waitFor(() => expect(s.command()).toBeTruthy());
      act(() => s.command()!.run());
      await vi.waitFor(() => expect(trText(para(1))).toBe(`a:${para(1).textContent}`));
      const sent = real.fake.calls.length;
      expect(sent).toBeGreaterThan(0);
      act(() => s.command()!.run()); // off
      await vi.waitFor(() => expect(translated()).toBe(0));
      act(() => s.command()!.run()); // on again
      await vi.waitFor(() => expect(trText(para(1))).toBe(`a:${para(1).textContent}`));
      expect(real.fake.calls.length).toBe(sent);
    } finally {
      real.fake.restore();
    }
  });
});

describe("turning it off (R7.2)", () => {
  it("running the command again restores the page exactly, aborts batches still out and stops watching", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const f = fakeInvoker(async () => {
      await hold;
      return undefined;
    });
    const s = start({ invoker: f.invoker });
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    act(() => s.command()!.run());
    await vi.waitFor(() => expect(translated()).toBe(11));
    await vi.waitFor(() => expect(s.command()!.title).toBe(RESTORE_TITLE));
    expect(s.command()!.hotkey).toBe("Alt+A");
    act(() => s.command()!.run());
    expect(document.body.innerHTML).toBe(original);
    expect(f.calls[0]!.signal!.aborted).toBe(true);
    release();
    await flush();
    expect(document.body.innerHTML).toBe(original);
    // no more watching: scrolling and new content do nothing
    act(() => scrollTo(40));
    const added = document.createElement("p");
    added.textContent = "Late paragraph appended after turning off.";
    act(() => document.querySelector("article")!.append(added));
    await flush();
    expect(f.calls.length).toBe(1);
    expect(translated()).toBe(0);
    await vi.waitFor(() => expect(s.command()!.title).toBe(TITLE));
    expect(s.setAwake).toHaveBeenLastCalledWith(false);
  });

  it("brings hidden sources back when it was in 只看译文", async () => {
    const s = start();
    s.set("show", "only");
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    act(() => s.command()!.run());
    await vi.waitFor(() => expect(trText(para(1))).toContain("译:"));
    expect((para(1) as HTMLElement).style.display).toBe("none");
    act(() => s.command()!.run());
    expect(document.body.innerHTML).toBe(original);
  });

  it("switching the entry off while on restores the page", async () => {
    const s = start();
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    act(() => s.command()!.run());
    await vi.waitFor(() => expect(trText(para(1))).toContain("译:"));
    act(() => s.storage.set(enabledKey(ENTRY), false));
    await vi.waitFor(() => expect(document.body.innerHTML).toBe(original));
  });

  it("stopping the feature (unmount) restores the page", async () => {
    const s = start();
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    act(() => s.command()!.run());
    await vi.waitFor(() => expect(trText(para(1))).toContain("译:"));
    act(() => cleanups.pop()!());
    expect(document.body.innerHTML).toBe(original);
  });
});

describe("page load (R7.2, R3.5)", () => {
  it("does not start by itself while 打开这个网站时自动对照 is off (the default)", async () => {
    const s = start();
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    await flush();
    expect(translated()).toBe(0);
    expect(s.calls!.length).toBe(0);
  });

  it("starts after load on a site where it is on, and only there", async () => {
    const storage = createStorage(createGmStorageFake().tab());
    const def = official().features[0]!.entries.find((e) => e.id === "page")!.def.settings!.auto!;
    createSettingsStore(storage).set(ENTRY, "auto", def, true, "other-site.dev");
    const other = start({ storage });
    await vi.waitFor(() => expect(other.command()).toBeTruthy());
    await flush();
    expect(translated()).toBe(0);
    act(() => cleanups.pop()!());

    createSettingsStore(storage).set(ENTRY, "auto", def, true, HOST);
    const s = start({ storage });
    await vi.waitFor(() => expect(trText(para(1))).toContain("译:"));
    await vi.waitFor(() => expect(s.command()!.title).toBe(RESTORE_TITLE));
    // the command turns it off like any other start
    act(() => s.command()!.run());
    expect(document.body.innerHTML).toBe(original);
  });
});

describe("page load after the runtime is gone", () => {
  /** A storage whose reads are counted, with auto on for this site. */
  function counted() {
    const tab = createGmStorageFake().tab();
    const storage = createStorage(tab);
    const def = official().features[0]!.entries.find((e) => e.id === "page")!.def.settings!.auto!;
    createSettingsStore(storage).set(ENTRY, "auto", def, true, HOST);
    const reads = vi.spyOn(tab, "GM_getValue");
    return { storage, reads };
  }

  it("stopping before the deferred page-load fires leaves no timer, reads nothing and translates nothing", async () => {
    vi.useFakeTimers();
    try {
      const { storage, reads } = counted();
      const s = start({ storage });
      act(() => cleanups.pop()!()); // stop at once, while the command title is still being rendered
      // let the rendering settle without running any timer
      await act(async () => {
        for (let i = 0; i < 50; i++) await Promise.resolve();
      });
      expect(vi.getTimerCount()).toBe(0);
      reads.mockClear();
      await act(async () => void (await vi.runAllTimersAsync()));
      expect(reads).not.toHaveBeenCalled();
      expect(s.calls!.length).toBe(0);
      expect(translated()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a shell taken off the page (never stopped) does not start on load", async () => {
    vi.useFakeTimers();
    try {
      const { storage, reads } = counted();
      const s = start({ storage });
      act(() => s.ctx.root.host.remove());
      reads.mockClear();
      await act(async () => void (await vi.runAllTimersAsync()));
      expect(reads).not.toHaveBeenCalled();
      expect(s.calls!.length).toBe(0);
      expect(translated()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("显示方式 (R7.4)", () => {
  it("applies 只看译文 and back live, without translating again", async () => {
    const s = start();
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    act(() => s.command()!.run());
    await vi.waitFor(() => expect(trText(para(1))).toContain("译:"));
    expect((para(1) as HTMLElement).style.display).toBe("");
    s.set("show", "only");
    await vi.waitFor(() => expect((para(1) as HTMLElement).style.display).toBe("none"));
    expect((document.querySelector("h1") as HTMLElement).style.display).toBe("none");
    s.set("show", "both");
    await vi.waitFor(() => expect((para(1) as HTMLElement).style.display).toBe(""));
    expect(s.calls!.length).toBe(1);
  });
});

describe("failures (R7.5)", () => {
  it("a failed batch shows 重试 after its paragraphs only; 重试 translates that batch again", async () => {
    fold = 30;
    const f = fakeInvoker((_req, n) => (n === 1 ? failed("server") : undefined));
    const s = start({ invoker: f.invoker });
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    act(() => s.command()!.run());
    const late = para(25);
    await vi.waitFor(() => expect(trText(late)).toContain("重试"));
    expect(trText(para(1))).toContain("译:");
    const retry = trAfter(late)!.shadowRoot!.querySelector("button")!;
    expect(retry.textContent).toBe("重试");
    act(() => retry.click());
    await vi.waitFor(() => expect(trText(late)).toBe(`译:${late.textContent}`));
    expect(f.calls.length).toBe(3);
    expect((f.calls[2]!.req.input as { texts: string[] }).texts).toEqual((f.calls[1]!.req.input as { texts: string[] }).texts);
  });

  it("a missing key says so with a link to the engines page", async () => {
    const f = fakeInvoker(() => failed("missingKey"));
    const s = start({ invoker: f.invoker });
    await vi.waitFor(() => expect(s.command()).toBeTruthy());
    act(() => s.command()!.run());
    await vi.waitFor(() => expect(trText(para(1))).toContain("去引擎页"));
    expect(trAfter(para(1))!.shadowRoot!.querySelector("button")).toBeNull();
    act(() => (trAfter(para(1))!.shadowRoot!.querySelector("a") as HTMLElement).click());
    expect(s.openSettings).toHaveBeenCalledWith("engines");
  });
});
