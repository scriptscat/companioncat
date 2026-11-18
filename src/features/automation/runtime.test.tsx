import { act, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import type { Invoker } from "../../core/invoke";
import { resolveRules, type Resolved } from "../../core/rules";
import { createActionLog, createAutomationPrefs, createSettingsStore, createStorage, type Storage } from "../../core/stores";
import { staticRules, type Command, type FeatureRegistration, type RulesSource, type RuntimeContext } from "../../shell";
import { disable, enableWithConsent, fingerprint } from "../page/enabled";
import registration from "./register";
import { startAutomation, type ActEvent, type AutomationDeps } from "./runtime";

const HOST = "video.test";
const FEATURE = "tp/auto";
const ref = (entry: string) => `${FEATURE}.${entry}`;

/** One automation feature: appear click, page-load, a command (quiz via auto:questions), a slow command and an ask-first one. */
const pack = (id: string, extra: object[] = []) => ({
  schema: 1,
  id,
  features: [
    {
      id: "auto",
      name: "测试自动化",
      match: ["*://*/*"],
      settings: { siteEnabled: { type: "boolean", title: "在这个网站打开", default: true, scope: "site" } },
      entries: [
        {
          id: "skip",
          name: "跳过广告",
          triggers: [{ on: "appear", selector: ".ad-skip", enabled: "{{ settings.siteEnabled }}" }],
          run: [{ act: "click", target: "{{ trigger.element }}", describe: "{{ text(trigger.element) }}" }],
        },
        {
          id: "load",
          name: "加载时",
          triggers: [{ on: "page-load" }],
          run: [
            { find: ".mark", all: true, as: "m" },
            { act: "click", target: "{{ vars.m }}", describe: "标记" },
          ],
        },
        {
          id: "quiz",
          name: "做题",
          triggers: [{ on: "command", title: "帮我做这页的题", hotkey: "Alt+Q", quick: true }],
          run: [
            { find: "auto:questions", all: true, as: "qs" },
            { act: "check", target: "{{ vars.qs[0].options[1].handle }}", describe: "{{ vars.qs[0].stem }}" },
          ],
        },
        {
          id: "slow",
          name: "慢",
          triggers: [{ on: "command", title: "慢慢来" }],
          run: [
            { act: "wait", ms: 1000 },
            { find: ".mark", as: "m" },
            { act: "click", target: "{{ vars.m }}", describe: "慢标记" },
          ],
        },
        {
          id: "asky",
          name: "先问",
          triggers: [{ on: "command", title: "问一下" }],
          run: [
            { find: ".mark", as: "m" },
            { act: "click", target: "{{ vars.m }}", confidence: 0.5, minConfidence: 0.8, below: "ask", describe: "低把握" },
          ],
        },
        {
          id: "elsewhere",
          name: "别处",
          match: ["*://elsewhere.test/*"],
          triggers: [{ on: "page-load" }],
          run: [
            { find: ".mark", as: "m" },
            { act: "click", target: "{{ vars.m }}", describe: "别处" },
          ],
        },
        ...extra,
      ],
    },
  ],
});

const local = (extra?: object[]) => resolveRules([{ pack: pack("local", extra), local: true }]);
const subscribed = () => resolveRules([{ pack: pack("tp") }]);
const localRef = (entry: string) => `local/auto.${entry}`;

let clicks: string[] = [];
const cleanups: (() => void)[] = [];

function mutable(resolved: Resolved): RulesSource & { set(r: Resolved): void } {
  let current = resolved;
  const subs = new Set<() => void>();
  return {
    get: () => current,
    subscribe(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    set(r) {
      current = r;
      subs.forEach((cb) => cb());
    },
  };
}

interface Opts {
  resolved?: Resolved;
  rules?: RulesSource;
  storage?: Storage;
  deps?: AutomationDeps;
  services?: Partial<RuntimeContext["services"]>;
  /** Use the registered feature (register.tsx) instead of startAutomation with deps. */
  viaRegister?: boolean;
}

function start(o: Opts = {}) {
  const storage = o.storage ?? createStorage(createGmStorageFake().tab());
  const host = document.createElement("companion-cat");
  const root = host.attachShadow({ mode: "open" });
  const layer = document.createElement("div");
  root.append(layer);
  document.documentElement.append(host);
  const commands = new Map<string, Command>();
  const setAwake = vi.fn();
  const toast = vi.fn(() => () => {});
  let registered = 0;
  const ctx: RuntimeContext = {
    root,
    layer,
    hostname: HOST,
    services: { storage, rules: o.rules ?? staticRules(o.resolved ?? local()), ...o.services },
    setAwake,
    toast,
    openSettings: vi.fn(),
    commands: {
      register(cmd) {
        registered++;
        commands.set(cmd.id, cmd);
        return () => {
          if (commands.get(cmd.id) === cmd) commands.delete(cmd.id);
        };
      },
    },
  };
  const stop = o.viaRegister ? (registration as FeatureRegistration).start!(ctx) : startAutomation(ctx, o.deps);
  let stopped = false;
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    if (typeof stop === "function") stop();
  };
  cleanups.push(() => {
    dispose();
    host.remove();
  });
  const command = (title: string) => [...commands.values()].find((c) => c.title === title);
  const log = () => createActionLog(storage).list(HOST);
  return { ctx, storage, commands, command, setAwake, toast, log, dispose, registered: () => registered };
}

/** Lets the async gating, CEL rendering and the run settle (fake timers). */
const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let i = 0; i < 20; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
};

const add = (html: string, parent: Element = document.body) => {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  const node = wrap.firstElementChild!;
  parent.append(node);
  return node;
};

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no layout: everything not under [hidden] counts as visible
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    return (this.closest("[hidden]") ? [] : [new DOMRect(0, 0, 10, 10)]) as unknown as DOMRectList;
  });
  clicks = [];
  document.body.innerHTML = `
    <button class="ad-skip" id="old">旧的跳过</button>
    <button class="mark" id="m1">标记一</button>
    <fieldset id="q1"><legend>1. 天空是什么颜色</legend>
      <label><input type="radio" name="q1" value="a"> 红色</label>
      <label><input type="radio" name="q1" value="b"> 蓝色</label>
    </fieldset>`;
  document.addEventListener("click", record, true);
});

const record = (e: Event) => {
  const t = e.target as Element;
  if (t.tagName === "COMPANION-CAT") return; // our own UI (clicks in the shadow root are retargeted)
  clicks.push(t.id || t.className || t.tagName);
};

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  document.removeEventListener("click", record, true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("page-load (R1.1)", () => {
  it("runs once after load, only for entries matching the page", async () => {
    const rules = mutable(local());
    const { log } = start({ rules });
    await settle();
    expect(clicks).toEqual(["m1"]);
    // a rule change rebuilds the triggers but does not run page-load again
    rules.set(local());
    await settle();
    expect(clicks).toEqual(["m1"]);
    expect(log().map((r) => r.target)).toEqual(["标记"]);
  });

  it("waits for the load event while the document is still loading", async () => {
    const state = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    start();
    await settle();
    expect(clicks).toEqual([]);
    state.mockReturnValue("complete");
    window.dispatchEvent(new Event("load"));
    await settle();
    expect(clicks).toEqual(["m1"]);
  });
});

describe("appear (R1.1)", () => {
  it("ignores elements present at start, debounces new ones and passes the added element as trigger.element", async () => {
    start();
    await settle();
    clicks = [];
    add('<div class="other">x</div>');
    await settle(400);
    expect(clicks).toEqual([]); // the .ad-skip present at load does not count
    add('<button class="ad-skip" id="new1">跳过 1</button>');
    add('<div><button class="ad-skip" id="new2">跳过 2</button></div>');
    await settle(299);
    expect(clicks).toEqual([]);
    await settle(1);
    expect(clicks).toEqual(["new1"]); // one run for the batch, on the first new element
    add('<button class="ad-skip" id="new3">跳过 3</button>');
    await settle(300);
    expect(clicks).toEqual(["new1", "new3"]);
  });

  it("honours debounceMs", async () => {
    start({ resolved: local([{ id: "fast", name: "快", triggers: [{ on: "appear", selector: ".fast", debounceMs: 50 }], run: [{ act: "click", target: "{{ trigger.element }}" }] }]) });
    await settle();
    clicks = [];
    add('<button class="fast" id="f1">f</button>');
    await settle(50);
    expect(clicks).toEqual(["f1"]);
  });

  it("does not fire when the trigger's enabled expression (a site setting) is false", async () => {
    const storage = createStorage(createGmStorageFake().tab());
    const resolved = local();
    const def = resolved.features[0]!.def.settings!.siteEnabled!;
    createSettingsStore(storage).set("local/auto", "siteEnabled", def, false, HOST);
    start({ resolved, storage });
    await settle();
    clicks = [];
    add('<button class="ad-skip" id="new1">跳过</button>');
    await settle(400);
    expect(clicks).toEqual([]);
  });
});

describe("command (R1.1, R3.6)", () => {
  it("registers a command with title, hotkey and quick; running it fills the quiz via auto:questions", async () => {
    const { command, log } = start();
    await settle();
    const cmd = command("帮我做这页的题")!;
    expect(cmd).toMatchObject({ title: "帮我做这页的题", hotkey: "Alt+Q", quick: true });
    expect(cmd.disabled?.()).toBe(false);
    cmd.run();
    await settle();
    const blue = document.querySelector<HTMLInputElement>('input[value="b"]')!;
    expect(blue.checked).toBe(true);
    expect(log()[0]).toMatchObject({ action: "check", mode: "auto", target: "天空是什么颜色", rule: "测试自动化", entry: localRef("quiz") });
  });

  it("is disabled while automation is paused on this site", async () => {
    const storage = createStorage(createGmStorageFake().tab());
    const { command } = start({ storage });
    await settle();
    createAutomationPrefs(storage).setPaused(HOST, true);
    expect(command("帮我做这页的题")!.disabled!()).toBe(true);
  });

  it("re-registers its commands when the pause changes, so the shell re-reads disabled()", async () => {
    const storage = createStorage(createGmStorageFake().tab());
    const { registered } = start({ storage });
    await settle();
    const before = registered();
    createAutomationPrefs(storage).setPaused(HOST, true);
    expect(registered()).toBeGreaterThan(before);
    const paused = registered();
    createAutomationPrefs(storage).setAlwaysDo(HOST, "x", true); // other prefs: nothing to re-read
    expect(registered()).toBe(paused);
    createAutomationPrefs(storage).setPaused(HOST, false);
    expect(registered()).toBeGreaterThan(paused);
  });

  it("is not registered for an entry switched off", async () => {
    const storage = createStorage(createGmStorageFake().tab());
    disable(storage, localRef("quiz"));
    const { command } = start({ storage });
    await settle();
    expect(command("帮我做这页的题")).toBeUndefined();
    expect(command("慢慢来")).toBeDefined();
  });

  it("re-registers when the rules change (a newly saved local rule takes effect)", async () => {
    const rules = mutable(local());
    const { command } = start({ rules });
    await settle();
    expect(command("新命令")).toBeUndefined();
    rules.set(local([{ id: "fresh", name: "新", triggers: [{ on: "command", title: "新命令" }], run: [{ find: ".mark", as: "m" }, { act: "click", target: "{{ vars.m }}" }] }]));
    await settle();
    command("新命令")!.run();
    await settle();
    expect(clicks).toContain("m1");
  });
});

describe("gating (R3.1–R3.4, R3.6)", () => {
  it("a subscribed entry without consent does not run on page-load or appear", async () => {
    const { log } = start({ resolved: subscribed() });
    await settle();
    add('<button class="ad-skip" id="new1">跳过</button>');
    await settle(400);
    expect(clicks).toEqual([]);
    expect(log()).toEqual([]);
  });

  it("a consented subscribed entry runs; one whose acts changed since consent (paused-by-update) does not", async () => {
    const storage = createStorage(createGmStorageFake().tab());
    const resolved = subscribed();
    const entry = (id: string) => resolved.features[0]!.entries.find((e) => e.id === id)!;
    enableWithConsent(storage, ref("load"), fingerprint(entry("load").def));
    enableWithConsent(storage, ref("skip"), "acts:fill|hosts:");
    start({ resolved, storage });
    await settle();
    expect(clicks).toEqual(["m1"]);
    add('<button class="ad-skip" id="new1">跳过</button>');
    await settle(400);
    expect(clicks).toEqual(["m1"]);
  });

  it("a command without consent asks for it first and runs only when given", async () => {
    const requestConsent = vi.fn(async () => false);
    const { command } = start({ resolved: subscribed(), deps: { requestConsent } });
    await settle();
    command("慢慢来")!.run();
    await settle(2000);
    expect(requestConsent).toHaveBeenCalledWith(ref("slow"));
    expect(clicks).toEqual([]);
    requestConsent.mockResolvedValue(true);
    command("慢慢来")!.run();
    await settle(2000);
    expect(clicks).toEqual(["m1"]);
  });

  it("nothing runs while the site is paused, and pausing discards a running run", async () => {
    const storage = createStorage(createGmStorageFake().tab());
    const prefs = createAutomationPrefs(storage);
    prefs.setPaused(HOST, true);
    const { command } = start({ storage });
    await settle();
    add('<button class="ad-skip" id="new1">跳过</button>');
    await settle(400);
    expect(clicks).toEqual([]);
    prefs.setPaused(HOST, false);
    command("慢慢来")!.run();
    await settle(500);
    prefs.setPaused(HOST, true);
    await settle(1000);
    expect(clicks).toEqual([]);
  });
});

describe("running (R1.6)", () => {
  it("drops a re-trigger while the entry is still running", async () => {
    const { command, log } = start();
    await settle();
    clicks = [];
    const cmd = command("慢慢来")!;
    cmd.run();
    await settle(100);
    cmd.run();
    await settle(2500);
    expect(clicks).toEqual(["m1"]);
    expect(log().filter((r) => r.target === "慢标记")).toHaveLength(1);
    // after it finished, it can run again
    cmd.run();
    await settle(1500);
    expect(clicks).toEqual(["m1", "m1"]);
  });

  it("discards an unfinished run on navigation (pagehide)", async () => {
    const { command, log } = start();
    await settle();
    clicks = [];
    command("慢慢来")!.run();
    await settle(100);
    window.dispatchEvent(new Event("pagehide"));
    await settle(2000);
    expect(clicks).toEqual([]);
    expect(log().filter((r) => r.target === "慢标记")).toEqual([]);
  });

  it("discards an unfinished run when the page moved to another address in place (pushState), not on a hash change", async () => {
    const { command, log } = start();
    await settle();
    const home = location.href;
    try {
      clicks = [];
      command("慢慢来")!.run();
      await settle(100);
      history.pushState(null, "", "/another-video");
      await settle(2000);
      expect(clicks).toEqual([]);
      expect(log().filter((r) => r.target === "慢标记")).toEqual([]);
      command("慢慢来")!.run();
      await settle(100);
      history.pushState(null, "", "#t=10");
      await settle(2000);
      expect(clicks).toEqual(["m1"]);
      // a run started after the page moved belongs to the new page
      history.pushState(null, "", "/third-video");
      command("慢慢来")!.run();
      await settle(2000);
      expect(clicks).toEqual(["m1", "m1"]);
    } finally {
      history.replaceState(null, "", home);
    }
  });

  it("discards an unfinished run when the runtime stops", async () => {
    const { command, dispose } = start();
    await settle();
    clicks = [];
    command("慢慢来")!.run();
    await settle(100);
    dispose();
    await settle(2000);
    expect(clicks).toEqual([]);
  });

  it("keeps the cat awake while running and clears it when done", async () => {
    const { command, setAwake } = start();
    await settle();
    setAwake.mockClear();
    command("慢慢来")!.run();
    await settle(100);
    expect(setAwake).toHaveBeenLastCalledWith(true);
    await settle(1500);
    expect(setAwake).toHaveBeenLastCalledWith(false);
  });
});

describe("ports and the action log (R2.1, R3.6, R3.7)", () => {
  it("logs every act; the default ask port is the bubble, and 不用 leaves the target alone", async () => {
    const { command, log, ctx } = start({ viaRegister: true });
    await settle();
    clicks = [];
    command("问一下")!.run();
    await settle();
    const bubble = ctx.root.querySelector('[role="dialog"]')!;
    expect(bubble.textContent).toContain("低把握");
    fireEvent.click([...bubble.querySelectorAll("button")].find((b) => b.textContent === "不用")!);
    await settle();
    expect(clicks).toEqual([]);
    expect(log()[0]).toMatchObject({ action: "click", mode: "asked-no", target: "低把握", confidence: 0.5, entry: localRef("asky"), rule: "测试自动化" });
    expect(log()[1]).toMatchObject({ action: "click", mode: "auto", target: "标记", entry: localRef("load") });
  });

  it("tells the ask port which engine judged (its name, else its ref)", async () => {
    const invoke = vi.fn(async () => ({ ok: true, contract: "choose", engine: "x/judge", output: { choice: "a" }, confidence: 0.5, results: [] }));
    const invoker = { invoke, preferredEngines: () => ({ engines: ["x/judge"] }) } as unknown as Invoker;
    const askUser = vi.fn(async () => false);
    const resolved = local([
      {
        id: "judged",
        name: "判断",
        triggers: [{ on: "command", title: "判断一下" }],
        run: [
          { ask: "choose", engine: "x/judge", input: { state: "s", question: "q", options: { a: "A", b: "B" } }, as: "pick" },
          { find: ".mark", as: "m" },
          { act: "click", target: "{{ vars.m }}", confidence: "{{ vars.pick.confidence }}", minConfidence: 0.8, describe: "判断" },
        ],
      },
    ]);
    const { command } = start({ resolved, services: { invoker }, deps: { askUser } });
    await settle();
    command("判断一下")!.run();
    await settle();
    expect(invoke).toHaveBeenCalled();
    expect(askUser).toHaveBeenCalledWith(expect.objectContaining({ engine: "x/judge", confidence: 0.5, rule: localRef("judged") }));
  });

  it("uses an injected ask port, shows 等你回答 while asking and reports each act with its undo prefs", async () => {
    const storage = createStorage(createGmStorageFake().tab());
    let answer!: (yes: boolean) => void;
    const askUser = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    const onAct = vi.fn<(e: ActEvent) => void>();
    const { command, setAwake, log } = start({ storage, deps: { askUser, onAct } });
    await settle();
    clicks = [];
    command("问一下")!.run();
    await settle();
    expect(askUser).toHaveBeenCalledWith(expect.objectContaining({ site: HOST, rule: localRef("asky"), act: "click", confidence: 0.5, minConfidence: 0.8 }));
    expect(setAwake).toHaveBeenLastCalledWith(true, "等你回答");
    answer(true);
    await settle();
    expect(clicks).toEqual(["m1"]);
    expect(setAwake).toHaveBeenLastCalledWith(false);
    const logged = log()[0]!;
    expect(logged).toMatchObject({ mode: "asked-yes", action: "click" });
    const events = onAct.mock.calls.map((c) => c[0]).filter((e) => e.record.rule === localRef("asky"));
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.record).toMatchObject({ mode: "asked-yes", act: "click" });
    expect(ev.logged.id).toBe(logged.id);
    expect(ev.target).toBeDefined();
    // R2.4: marking it wrong flags the logged record and turns always-do off
    const prefs = createAutomationPrefs(storage);
    prefs.setAlwaysDo(HOST, localRef("asky"), true);
    await ev.prefs.markWrong(ev.record);
    expect(log()[0]!.wrong).toBe(true);
    expect(prefs.isAlwaysDo(HOST, localRef("asky"))).toBe(false);
  });

  it("acts without asking when 以后都照做 is on for the rule on this site", async () => {
    const storage = createStorage(createGmStorageFake().tab());
    createAutomationPrefs(storage).setAlwaysDo(HOST, localRef("asky"), true);
    const askUser = vi.fn(async () => false);
    const { command, log } = start({ storage, deps: { askUser } });
    await settle();
    clicks = [];
    command("问一下")!.run();
    await settle();
    expect(askUser).not.toHaveBeenCalled();
    expect(clicks).toEqual(["m1"]);
    expect(log()[0]).toMatchObject({ mode: "auto" });
  });

  it("after an auto act shows the toast (default feedback port)", async () => {
    const { toast } = start();
    await settle();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("小猫帮你点了「标记」") }));
  });

  it("below: hint marks the target; 就选 performs it and logs it; navigation removes the markers", async () => {
    const resolved = local([
      {
        id: "hinty",
        name: "建议",
        triggers: [{ on: "command", title: "建议一下" }],
        run: [
          { find: ".mark", as: "m" },
          { act: "click", target: "{{ vars.m }}", confidence: 0.4, minConfidence: 0.8, below: "hint", describe: "建议标记" },
        ],
      },
    ]);
    const { command, ctx, log } = start({ resolved });
    await settle();
    clicks = [];
    command("建议一下")!.run();
    await settle();
    expect(clicks).toEqual([]);
    expect(log()[0]).toMatchObject({ mode: "hint", target: "建议标记" });
    const marker = () => ctx.root.querySelector("[data-cc-hint]");
    fireEvent.click([...marker()!.querySelectorAll("button")].find((b) => b.textContent!.startsWith("就选"))!);
    await settle();
    expect(clicks).toEqual(["m1"]);
    expect(log()[0]).toMatchObject({ mode: "auto", target: "建议标记", confidence: 0.4 });
    command("建议一下")!.run();
    await settle();
    expect(marker()).not.toBeNull();
    window.dispatchEvent(new Event("pagehide"));
    expect(marker()).toBeNull();
  });
});

describe("what the log and the ask bubble name (R2.1, R3.6, R3.7, R4.2)", () => {
  it("logs the rule by its name (the entry stays the entry ref) and tells the ask port the rule name", async () => {
    const askUser = vi.fn(async () => false);
    const { command, log } = start({ deps: { askUser } });
    await settle();
    command("问一下")!.run();
    await settle();
    expect(askUser).toHaveBeenCalledWith(expect.objectContaining({ rule: localRef("asky"), ruleName: "测试自动化" }));
    expect(log()[0]).toMatchObject({ rule: "测试自动化", entry: localRef("asky"), mode: "asked-no" });
  });

  it("an act without describe is logged with describe() of its target", async () => {
    const resolved = local([{ id: "plain", name: "没写描述", triggers: [{ on: "command", title: "点一下" }], run: [{ find: ".mark", as: "m" }, { act: "click", target: "{{ vars.m }}" }] }]);
    const { command, log, toast } = start({ resolved });
    await settle();
    command("点一下")!.run();
    await settle();
    expect(log()[0]).toMatchObject({ entry: localRef("plain"), target: "「标记一」按钮" });
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ text: "小猫帮你点了「标记一」按钮" }));
  });

  it("an appear run whose engine judged that nothing applies is logged as 不是广告 (not-applicable)", async () => {
    const invoke = vi.fn(async () => ({ ok: true, contract: "choose", engine: "x/judge", output: { choice: "都不是" }, confidence: 0.91, results: [] }));
    const invoker = { invoke, preferredEngines: () => ({ engines: ["x/judge"] }) } as unknown as Invoker;
    const resolved = local([
      {
        id: "judge-new",
        name: "判断新按钮",
        triggers: [{ on: "appear", selector: ".maybe" }],
        run: [
          { ask: "choose", input: { state: "s", question: "q", options: { a: "A", 都不是: "都不是" } }, as: "pick" },
          { if: "{{ vars.pick.choice != '都不是' }}", then: [{ act: "click", target: "{{ trigger.element }}" }] },
        ],
      },
    ]);
    const { log } = start({ resolved, services: { invoker } });
    await settle();
    clicks = [];
    add('<button class="maybe" id="mb">跳过片头</button>');
    await settle(400);
    expect(clicks).toEqual([]);
    expect(log()[0]).toMatchObject({ entry: localRef("judge-new"), mode: "not-applicable", action: "click", target: "「跳过片头」按钮", confidence: 0.91 });
  });
});

describe("re-confirm after an update on the next trigger (R3.3)", () => {
  it("an appear entry paused by an update asks again when it next fires and runs once confirmed", async () => {
    const storage = createStorage(createGmStorageFake().tab());
    enableWithConsent(storage, ref("skip"), "acts:fill|hosts:");
    const requestConsent = vi.fn(async () => true);
    start({ resolved: subscribed(), storage, deps: { requestConsent } });
    await settle();
    add('<button class="ad-skip" id="new1">跳过</button>');
    await settle(400);
    expect(requestConsent).toHaveBeenCalledWith(ref("skip"));
    expect(clicks).toContain("new1");
  });

  it("declining switches the entry off, so later triggers do not ask again", async () => {
    const storage = createStorage(createGmStorageFake().tab());
    enableWithConsent(storage, ref("skip"), "acts:fill|hosts:");
    const requestConsent = vi.fn(async () => false);
    start({ resolved: subscribed(), storage, deps: { requestConsent } });
    await settle();
    add('<button class="ad-skip" id="new1">跳过</button>');
    await settle(400);
    add('<button class="ad-skip" id="new2">跳过</button>');
    await settle(400);
    expect(requestConsent).toHaveBeenCalledTimes(1);
    expect(clicks).toEqual([]);
    expect(storage.get(`cc:on:${ref("skip")}`)).toBe(false);
  });

  it("an entry never consented to does not ask on appear (it stays off, R3.1)", async () => {
    const requestConsent = vi.fn(async () => true);
    start({ resolved: subscribed(), deps: { requestConsent } });
    await settle();
    add('<button class="ad-skip" id="new1">跳过</button>');
    await settle(400);
    expect(requestConsent).not.toHaveBeenCalled();
  });
});
