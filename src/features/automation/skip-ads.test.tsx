import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pack from "../../../rules/packs/official-skip-ads.json";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import type { Invoker } from "../../core/invoke";
import { resolveRules } from "../../core/rules";
import { createActionLog, createSettingsStore, createStorage } from "../../core/stores";
import { staticRules, type Command, type RuntimeContext } from "../../shell";
import { enableWithConsent, fingerprint } from "../page/enabled";
import { startAutomation, type AutomationDeps } from "./runtime";

/** R4 / R8.2: the official 跳过广告 pack, resolved as the app does, run on a fake video page with a fake choose engine. */
const HOST = "video.test";
const resolved = () => resolveRules([{ pack, official: true }]);
const FEATURE = "official-skip-ads/skip-ads";
const ENTRY = `${FEATURE}.auto-skip`;

let clicks: string[] = [];
const cleanups: (() => void)[] = [];

const record = (e: Event) => {
  const t = e.target as Element;
  if (t.tagName !== "COMPANION-CAT") clicks.push(t.id);
};

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let i = 0; i < 20; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
};

const add = (html: string, parent: Element = document.querySelector(".player")!) => {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  parent.append(wrap.firstElementChild!);
};

interface Judge {
  /** The option key to answer with; a function sees the asked options. */
  choice: string | ((options: Record<string, string>) => string);
  confidence: number;
}

function start(opts: { siteEnabled?: boolean; judge?: Judge; deps?: AutomationDeps; set?: Record<string, unknown> } = {}) {
  const storage = createStorage(createGmStorageFake().tab());
  const rules = resolved();
  const def = rules.features[0]!.entries[0]!.def.settings!;
  const settings = createSettingsStore(storage);
  // R3.2: an official automation entry still runs only after the user has switched it on
  enableWithConsent(storage, ENTRY, fingerprint(rules.features[0]!.entries[0]!.def));
  if (opts.siteEnabled !== false) settings.set(ENTRY, "siteEnabled", def.siteEnabled!, true, HOST);
  for (const [k, v] of Object.entries(opts.set ?? {})) settings.set(ENTRY, k, def[k]!, v);
  const asked: { contract: string; input: { state: string; question: string; options: Record<string, string> } }[] = [];
  const invoke = vi.fn(async (req: { contract: string; input: never }) => {
    asked.push(req as never);
    const j = opts.judge ?? { choice: "none", confidence: 0.99 };
    const options = (req.input as { options: Record<string, string> }).options;
    const choice = typeof j.choice === "function" ? j.choice(options) : j.choice;
    return { ok: true, strategy: "first", contract: "choose", engine: "x/judge", output: { choice }, confidence: j.confidence, results: [] };
  });
  const invoker = { invoke, preferredEngines: () => ({ engines: ["x/judge"] }) } as unknown as Invoker;
  const host = document.createElement("companion-cat");
  const root = host.attachShadow({ mode: "open" });
  const layer = document.createElement("div");
  root.append(layer);
  document.documentElement.append(host);
  const ctx: RuntimeContext = {
    root,
    layer,
    hostname: HOST,
    services: { storage, rules: staticRules(rules), invoker },
    setAwake: vi.fn(),
    toast: vi.fn(() => () => {}),
    openSettings: vi.fn(),
    commands: { register: (_: Command) => () => {} },
  };
  const stop = startAutomation(ctx, opts.deps);
  cleanups.push(() => {
    if (typeof stop === "function") stop();
    host.remove();
  });
  return { asked, invoke, log: () => createActionLog(storage).list(HOST) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    return (this.closest("[hidden]") ? [] : [new DOMRect(0, 0, 10, 10)]) as unknown as DOMRectList;
  });
  clicks = [];
  // a fake video page whose player already carries a skip-looking button at load
  document.body.innerHTML = `<div class="player"><video></video><button id="old">跳过片头</button></div>`;
  document.addEventListener("click", record, true);
});

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  document.removeEventListener("click", record, true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const pick = (text: string) => (options: Record<string, string>) => Object.keys(options).find((k) => options[k]!.includes(text))!;

describe("official 跳过广告 pack (R4.1–R4.3, R8.2)", () => {
  it("resolves with no diagnostics, as one feature with one automation entry matching every site", () => {
    const r = resolved();
    expect(r.diagnostics).toEqual([]);
    expect(r.features.map((f) => [f.ref, f.def.match, f.entries.map((e) => e.ref)])).toEqual([[FEATURE, ["*://*/*"], [ENTRY]]]);
    const entry = r.features[0]!.entries[0]!.def;
    expect(entry.triggers![0]).toMatchObject({ on: "appear" });
    expect(Object.keys(entry.settings!)).toEqual(["siteEnabled", "engine", "threshold", "below"]);
    expect(entry.settings).toMatchObject({
      siteEnabled: { type: "boolean", scope: "site", default: false, quick: true },
      engine: { type: "engine", capability: "choose" },
      threshold: { type: "number", format: "percent", default: 0.85 },
      below: { type: "enum", default: "ask" },
    });
  });

  it("ignores buttons present at load (R4.3) and elements that do not look like a skip button", async () => {
    const { invoke } = start();
    await settle(400);
    add('<button id="vol">音量</button>');
    await settle(400);
    expect(invoke).not.toHaveBeenCalled();
    expect(clicks).toEqual([]);
  });

  it("asks choose with the candidates, 都不是 and the player outline, then clicks the pick at high confidence", async () => {
    const { asked, log } = start({ judge: { choice: pick("跳过广告"), confidence: 0.95 } });
    await settle(400);
    add('<button id="ad">跳过广告 5s</button>');
    await settle(300);
    expect(clicks).toEqual(["ad"]);
    expect(asked).toHaveLength(1);
    const { input } = asked[0]!;
    expect(Object.values(input.options)).toHaveLength(3);
    expect(Object.values(input.options).filter((t) => t.includes("跳过广告 5s"))).toHaveLength(1);
    expect(Object.values(input.options)).toContain("都不是");
    expect(input.state.length).toBeLessThanOrEqual(400);
    expect(input.state).toContain("跳过广告 5s");
    expect(input.question.length).toBeGreaterThan(0);
    expect(log()[0]).toMatchObject({ action: "click", mode: "auto", confidence: 0.95, rule: "跳过广告", entry: ENTRY });
    // describe() names the button once: no doubled quotes
    expect(log()[0]!.target).toMatch(/^「[^「」]+」按钮$/);
  });

  it("below the threshold goes through the ask path and clicks only when the user agrees", async () => {
    const askUser = vi.fn(async () => true);
    const { log } = start({ judge: { choice: pick("Skip Ad"), confidence: 0.5 }, deps: { askUser } });
    await settle(400);
    add('<button id="ad">Skip Ad</button>');
    await settle(300);
    expect(askUser).toHaveBeenCalledWith(expect.objectContaining({ act: "click", confidence: 0.5, minConfidence: 0.85, rule: ENTRY }));
    expect(clicks).toEqual(["ad"]);
    expect(log()[0]).toMatchObject({ mode: "asked-yes" });
  });

  it("below the threshold and the user says no: no click; below=skip never asks", async () => {
    const no = vi.fn(async () => false);
    start({ judge: { choice: pick("Skip Ad"), confidence: 0.5 }, deps: { askUser: no } });
    await settle(400);
    add('<button id="ad">Skip Ad</button>');
    await settle(300);
    expect(no).toHaveBeenCalledOnce();
    expect(clicks).toEqual([]);
    cleanups.splice(0).forEach((c) => c());
    const never = vi.fn(async () => true);
    const s = start({ judge: { choice: pick("Skip Ad"), confidence: 0.5 }, deps: { askUser: never }, set: { below: "skip" } });
    await settle(400);
    add('<button id="ad2">Skip Ad</button>');
    await settle(300);
    expect(s.invoke).toHaveBeenCalled();
    expect(never).not.toHaveBeenCalled();
    expect(clicks).toEqual([]);
  });

  it("clicks nothing when the answer is 都不是, even with full confidence, and logs it as 不是广告 (R4.2)", async () => {
    const askUser = vi.fn(async () => true);
    const { invoke, log } = start({ judge: { choice: pick("都不是"), confidence: 1 }, deps: { askUser } });
    await settle(400);
    add('<button id="ad">关闭广告</button>');
    await settle(300);
    expect(invoke).toHaveBeenCalledOnce();
    expect(clicks).toEqual([]);
    expect(askUser).not.toHaveBeenCalled();
    expect(log()).toHaveLength(1);
    expect(log()[0]).toMatchObject({ action: "click", mode: "not-applicable", target: "「关闭广告」按钮", confidence: 1, rule: "跳过广告", entry: ENTRY });
  });

  it("does nothing while 在这个网站跳过广告 is off (the default)", async () => {
    const { invoke } = start({ siteEnabled: false });
    await settle(400);
    add('<button id="ad">跳过广告</button>');
    await settle(300);
    expect(invoke).not.toHaveBeenCalled();
    expect(clicks).toEqual([]);
  });

  it("looks only near the new element: a skip button elsewhere on the page is not a candidate", async () => {
    document.body.insertAdjacentHTML("beforeend", `<div class="other"></div>`);
    const { asked } = start({ judge: { choice: pick("跳过广告"), confidence: 0.99 } });
    await settle(400);
    add('<button id="far">Skip tour</button>', document.querySelector(".other")!);
    await settle(300);
    expect(asked).toEqual([]); // no player around it: nothing to judge
    add('<button id="ad">跳过广告</button>');
    await settle(300);
    expect(asked).toHaveLength(1);
    expect(Object.values(asked[0]!.input.options).join("|")).not.toContain("Skip tour");
  });
});
