import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pack from "../../../rules/packs/official-quiz.json";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { CallError } from "../../core/errors";
import type { Invoker } from "../../core/invoke";
import { resolveRules } from "../../core/rules";
import { createSettingsStore, createStorage } from "../../core/stores";
import { staticRules, type Command, type RuntimeContext } from "../../shell";
import { enableWithConsent, fingerprint } from "../page/enabled";
import { startAutomation } from "./runtime";

/** R5 / R8.2: the official 做题 pack, resolved as the app does, run on a fake quiz page with a fake invoker. */
const HOST = "quiz.test";
const resolved = () => resolveRules([{ pack, official: true }]);
const FEATURE = "official-quiz/quiz";
const ENTRY = `${FEATURE}.do-quiz`;

const PAGE = `<form id="exam">
  <fieldset id="q1"><legend>1. TCP 属于哪一层？</legend>
    <label><input type="radio" name="q1" value="a"> 网络层</label>
    <label><input type="radio" name="q1" value="b"> 传输层</label>
    <label><input type="radio" name="q1" value="c"> 应用层</label></fieldset>
  <fieldset id="q2"><legend>2. HTTP 的默认端口是？</legend>
    <label><input type="radio" name="q2" value="a"> 21</label>
    <label><input type="radio" name="q2" value="b"> 80</label>
    <label><input type="radio" name="q2" value="c"> 443</label></fieldset>
  <div id="q3"><p>3. 三次握手的第二步是 ____</p><input id="blank" type="text"></div>
  <button id="submit" type="submit">提交</button>
</form>`;

const cleanups: (() => void)[] = [];
let clicks: string[] = [];
let submits = 0;

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let i = 0; i < 30; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
};

interface Asked {
  contract: string;
  strategy?: string;
  engines?: string[];
  input: { question?: string; options?: Record<string, string>; messages?: { content: string }[] };
}

interface Opts {
  /** Per-stem answers of the fake choose engine. */
  choose?: Record<string, { choice: string; confidence: number }>;
  /** The fake chat engine's replies, one per call. */
  chat?: (n: number) => { ok: true; text: string } | { ok: false };
  set?: Record<string, unknown>;
  consent?: boolean;
  /** Stems whose choose call fails (once each, unless listed again by a later call). */
  failChoose?: string[];
}

const CHOOSE: Record<string, { choice: string; confidence: number }> = { "TCP 属于哪一层": { choice: "B", confidence: 0.96 }, "HTTP 的默认端口": { choice: "B", confidence: 0.61 } };
const CHAT = () => ({ ok: true as const, text: '{"answer":"SYN+ACK","confidence":0.9}' });

function start(opts: Opts = {}) {
  const storage = createStorage(createGmStorageFake().tab());
  const rules = resolved();
  const entry = rules.features[0]!.entries[0]!;
  enableWithConsent(storage, ENTRY, fingerprint(entry.def));
  const settings = createSettingsStore(storage);
  for (const [k, v] of Object.entries(opts.set ?? {})) settings.set(ENTRY, k, entry.def.settings![k]!, v);
  const asked: Asked[] = [];
  let chats = 0;
  const invoke = vi.fn(async (req: Asked) => {
    asked.push(req);
    if (req.contract === "choose") {
      const failing = opts.failChoose?.findIndex((s) => req.input.question!.includes(s)) ?? -1;
      if (failing >= 0) {
        opts.failChoose!.splice(failing, 1);
        return { ok: false, strategy: "first", contract: "choose", error: new CallError("network", "网络出错了"), results: [] };
      }
      const stem = Object.keys(opts.choose ?? CHOOSE).find((s) => req.input.question!.includes(s) || JSON.stringify(req.input).includes(s))!;
      const a = (opts.choose ?? CHOOSE)[stem]!;
      return { ok: true, strategy: req.strategy ?? "first", contract: "choose", engine: "x/judge", output: { choice: a.choice }, confidence: a.confidence, results: [] };
    }
    const r = (opts.chat ?? CHAT)(++chats);
    if (!r.ok) return { ok: false, strategy: "first", contract: "chat", error: new CallError("network", "网络出错了"), results: [] };
    return { ok: true, strategy: "first", contract: "chat", engine: "x/writer", output: { text: r.text }, results: [] };
  });
  const invoker = { invoke, preferredEngines: () => ({ engines: ["x/judge"] }) } as unknown as Invoker;
  const host = document.createElement("companion-cat");
  const root = host.attachShadow({ mode: "open" });
  const layer = document.createElement("div");
  root.append(layer);
  document.documentElement.append(host);
  const commands: Command[] = [];
  const toast = vi.fn(() => () => {});
  const ctx: RuntimeContext = {
    root,
    layer,
    hostname: HOST,
    services: { storage, rules: staticRules(rules), invoker },
    setAwake: vi.fn(),
    toast,
    openSettings: vi.fn(),
    commands: {
      register: (c: Command) => {
        commands.push(c);
        return () => {};
      },
    },
  };
  const stop = startAutomation(ctx);
  cleanups.push(() => {
    stop();
    host.remove();
  });
  const run = async () => {
    await settle(0);
    const cmd = commands.at(-1)!;
    cmd.run();
    await settle(50);
  };
  const card = () => layer.querySelector<HTMLElement>("[data-cc-result]");
  return { asked, invoke, toast, layer, commands: () => commands, run, card };
}

const $ = <T extends Element = HTMLInputElement>(sel: string) => document.querySelector<T>(sel)!;
const checked = (name: string) => Array.from(document.querySelectorAll<HTMLInputElement>(`input[name=${name}]`)).map((i) => i.checked);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    return (this.closest("[hidden]") ? [] : [new DOMRect(0, 0, 10, 10)]) as unknown as DOMRectList;
  });
  Element.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = PAGE;
  clicks = [];
  submits = 0;
  document.addEventListener("click", (e) => void clicks.push((e.target as Element).id || (e.target as Element).tagName), true);
  document.addEventListener("submit", () => void submits++, true);
});

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("official 做题 pack (R5.1, R8.2)", () => {
  it("resolves with no diagnostics: one feature on every site, one command entry 「帮我做这页的题」 with the five settings", () => {
    const r = resolved();
    expect(r.diagnostics).toEqual([]);
    expect(r.features.map((f) => [f.ref, f.def.match, f.entries.map((e) => e.ref)])).toEqual([[FEATURE, ["*://*/*"], [ENTRY]]]);
    const entry = r.features[0]!.entries[0]!.def;
    expect(entry.triggers).toMatchObject([{ on: "command", title: "帮我做这页的题", quick: true }]);
    expect(Object.keys(entry.settings!)).toEqual(["engine", "vote", "blankEngine", "threshold", "below"]);
    expect(entry.settings).toMatchObject({
      engine: { type: "engine", capability: "choose", title: "选择题用哪个引擎" },
      vote: { type: "boolean", default: false, title: "多个引擎投票" },
      blankEngine: { type: "engine", capability: "chat", title: "填空题用哪个引擎" },
      threshold: { type: "number", format: "percent", default: 0.8, title: "多有把握才直接填" },
      below: { type: "enum", title: "低于门槛时", options: { hint: "标出建议答案", skip: "空着不管" } },
    });
    expect(r.views.map((v) => v.ref)).toEqual(["official-quiz/quiz-result"]);
  });

  it("registers the command as a bubble button", async () => {
    const s = start();
    await settle(0);
    expect(s.commands().at(-1)).toMatchObject({ title: "帮我做这页的题", quick: true });
  });
});

describe("answering (R5.3, R5.4)", () => {
  it("fills what the engines are sure of with a 「小猫填的 N%」 badge and marks the unsure one with a hint", async () => {
    const s = start();
    await s.run();
    expect(checked("q1")).toEqual([false, true, false]);
    expect($("#blank").value).toBe("SYN+ACK");
    expect(checked("q2")).toEqual([false, false, false]); // 61% < 80%: not chosen for the user
    const badges = Array.from(s.layer.querySelectorAll("[data-cc-badge]")).map((b) => b.textContent);
    expect(badges).toEqual(["小猫填的 96%", "小猫填的 90%"]);
    const hint = s.layer.querySelector("[data-cc-hint]")!;
    expect(hint.textContent).toContain("小猫建议 B（61%），没到门槛 80%，没替你选");
    expect(hint.textContent).toContain("就选 B");
    expect(hint.textContent).toContain("我自己来");
  });

  it("asks choose with the question and the options, and chat for the blank", async () => {
    const s = start();
    await s.run();
    const choose = s.asked.filter((a) => a.contract === "choose");
    expect(choose).toHaveLength(2);
    expect(choose[0]!.input.options).toEqual({ A: "网络层", B: "传输层", C: "应用层" });
    expect(choose[0]!.input.question).toContain("TCP 属于哪一层");
    expect(choose[0]!.strategy).toBe("first");
    const chat = s.asked.filter((a) => a.contract === "chat");
    expect(chat).toHaveLength(1);
    expect(chat[0]!.input.messages!.map((m) => m.content).join("\n")).toContain("三次握手的第二步是");
  });

  it("「空着不管」: no marker for the unsure question, only the card lists it", async () => {
    const s = start({ set: { below: "skip" } });
    await s.run();
    expect(s.layer.querySelector("[data-cc-hint]")).toBeNull();
    expect(checked("q2")).toEqual([false, false, false]);
    expect(s.card()!.querySelector('[data-style="below"]')).not.toBeNull();
  });

  it("a higher threshold turns the 90% blank into a hint too", async () => {
    const s = start({ set: { threshold: 0.95 } });
    await s.run();
    expect($("#blank").value).toBe("");
    expect(s.layer.querySelectorAll("[data-cc-hint]")).toHaveLength(2);
    expect(Array.from(s.layer.querySelectorAll("[data-cc-badge]")).map((b) => b.textContent)).toEqual(["小猫填的 96%"]);
  });

  it("「就选 B」 on the hint picks that option", async () => {
    const s = start();
    await s.run();
    const pick = Array.from(s.layer.querySelectorAll<HTMLButtonElement>("[data-cc-hint] button")).find((b) => b.textContent === "就选 B")!;
    await act(async () => pick.click());
    await settle(0);
    expect(checked("q2")).toEqual([false, true, false]);
  });

  it("asks with strategy vote when 多个引擎投票 is on, first when off", async () => {
    const on = start({ set: { vote: true } });
    await on.run();
    expect(on.asked.filter((a) => a.contract === "choose").map((a) => a.strategy)).toEqual(["vote", "vote"]);
    expect(on.asked.filter((a) => a.contract === "chat").map((a) => a.strategy)).toEqual(["first"]);
    cleanups.splice(0).forEach((c) => c());
    document.body.innerHTML = PAGE;
    const off = start();
    await off.run();
    expect(off.asked.filter((a) => a.contract === "choose").map((a) => a.strategy)).toEqual(["first", "first"]);
  });

  it("never submits: no click on 提交 and no submit event, however confident", async () => {
    const s = start({ choose: { "TCP 属于哪一层": { choice: "B", confidence: 1 }, "HTTP 的默认端口": { choice: "B", confidence: 1 } } });
    await s.run();
    expect(checked("q2")).toEqual([false, true, false]);
    expect(clicks).not.toContain("submit");
    expect(clicks).not.toContain("BUTTON");
    expect(submits).toBe(0);
    // the rule itself has no such step: its acts are only check and fill
    const acts = JSON.stringify(pack.features[0]!.entries[0]!.run).match(/"act":"[a-z]+"/g);
    expect(new Set(acts)).toEqual(new Set(['"act":"check"', '"act":"fill"']));
    expect(JSON.stringify(pack.features[0]!.entries[0]!.run)).not.toMatch(/submit|提交/);
  });
});

describe("result card (R5.5, R5.6)", () => {
  it("lists every question with answer, confidence as a percent and engine; marks the one below the threshold; says nothing was submitted", async () => {
    const s = start();
    await s.run();
    const card = s.card()!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("做题结果");
    const rows = Array.from(card.querySelectorAll('[data-part="row"]'));
    expect(rows).toHaveLength(3);
    const text = rows.map((r) => r.textContent);
    expect(text[0]).toContain("第 1 题");
    expect(text[0]).toContain("96%");
    expect(text[0]).toContain("B");
    expect(text[1]).toContain("61%");
    expect(text[2]).toContain("90%");
    expect(text[2]).toContain("SYN+ACK");
    expect(card.textContent).toContain("x/judge");
    expect(card.textContent).toContain("x/writer");
    expect(card.querySelectorAll('[data-style="below"]')).toHaveLength(1);
    expect(rows[1]!.querySelector('[data-style="below"]') ?? rows[1]!.matches('[data-style="below"]')).toBeTruthy();
    expect(card.textContent).toContain("没有点提交，检查后自己交卷");
  });

  it("clicking a row scrolls to that question", async () => {
    const s = start();
    await s.run();
    const rows = Array.from(s.card()!.querySelectorAll<HTMLElement>('[data-part="row"]'));
    await act(async () => rows[1]!.click());
    expect(($("#q2") as unknown as { scrollIntoView: unknown }).scrollIntoView).toHaveBeenCalled();
  });

  it("a failed question shows its error and 重试 while the others keep their answers; 重试 asks only that question", async () => {
    const s = start({ chat: (n) => (n === 1 ? { ok: false } : { ok: true, text: '{"answer":"SYN+ACK","confidence":0.9}' }) });
    await s.run();
    expect(checked("q1")).toEqual([false, true, false]);
    expect($("#blank").value).toBe("");
    let card = s.card()!;
    expect(card.textContent).toContain("第 3 题");
    expect(card.textContent).toContain("重试");
    expect(card.textContent).toContain("第 1 题");
    expect(card.textContent).toContain("96%");
    const before = s.asked.length;
    const retry = Array.from(card.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "重试")!;
    await act(async () => retry.click());
    await settle(50);
    expect(s.asked.slice(before).map((a) => a.contract)).toEqual(["chat"]); // not the two answered choices again
    expect($("#blank").value).toBe("SYN+ACK");
    card = s.card()!;
    expect(card.textContent).not.toContain("重试");
    expect(Array.from(card.querySelectorAll('[data-part="row"]'))).toHaveLength(3);
    expect(card.textContent).toContain("96%");
    expect(card.textContent).toContain("90%");
    expect(s.layer.querySelectorAll("[data-cc-result]")).toHaveLength(1);
    expect(Array.from(s.layer.querySelectorAll("[data-cc-badge]")).map((b) => b.textContent)).toEqual(["小猫填的 96%", "小猫填的 90%"]);
  });
});

describe("a failed question leaves the others unaffected (R5.6 with R1.6)", () => {
  it("a choose failure on the first question still answers the questions after it; 重试 then asks only the failed one", async () => {
    const s = start({ failChoose: ["TCP 属于哪一层"] });
    await s.run();
    expect(checked("q1")).toEqual([false, false, false]);
    // the questions after the failed one are still answered (each run still stops at its failed ask)
    expect($("#blank").value).toBe("SYN+ACK");
    expect(s.layer.querySelector("[data-cc-hint]")!.textContent).toContain("小猫建议 B（61%）");
    const card = s.card()!;
    const rows = Array.from(card.querySelectorAll('[data-part="row"]')).map((r) => r.textContent);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("第 1 题");
    expect(rows[0]).toContain("重试");
    expect(rows[2]).toContain("SYN+ACK");
    const before = s.asked.length;
    const retry = Array.from(card.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "重试")!;
    await act(async () => retry.click());
    await settle(50);
    expect(s.asked.slice(before).map((a) => a.input.question ?? "chat")).toEqual([expect.stringContaining("TCP 属于哪一层")]);
    expect(checked("q1")).toEqual([false, true, false]);
  });
});

describe("multiple choice (R5.2, R5.3)", () => {
  const MULTI = `<fieldset id="m1"><legend>1. 哪些是应用层协议？（多选）</legend>
    <label><input type="checkbox" name="m1" value="a"> HTTP</label>
    <label><input type="checkbox" name="m1" value="b"> TCP</label>
    <label><input type="checkbox" name="m1" value="c"> DNS</label></fieldset>`;

  it("offers choose the combinations of options and checks every option of the chosen one", async () => {
    document.body.innerHTML = MULTI;
    const s = start({ choose: { 应用层协议: { choice: "A、C", confidence: 0.9 } } });
    await s.run();
    const options = s.asked.find((a) => a.contract === "choose")!.input.options!;
    expect(options["A、C"]).toBe("HTTP；DNS");
    expect(options.B).toBe("TCP");
    expect(Object.keys(options)).toHaveLength(7);
    expect(checked("m1")).toEqual([true, false, true]);
    expect(s.card()!.textContent).toContain("A、C");
  });
});

describe("no questions (R5.2)", () => {
  it("toasts 「这一页没找到题目」, asks nothing and shows no card", async () => {
    document.body.innerHTML = "<p>今天没有题</p>";
    const s = start();
    await s.run();
    expect(s.toast).toHaveBeenCalledWith(expect.objectContaining({ text: "这一页没找到题目" }));
    expect(s.invoke).not.toHaveBeenCalled();
    expect(s.card()).toBeNull();
  });
});
