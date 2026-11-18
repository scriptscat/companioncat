// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { elementHandle } from "../../core/expr";
import type { ResolvedFeature } from "../../core/rules/types";
import type { RunReport } from "./run";
import { presentAutomation } from "./Result";
import type { AutoEntry } from "./triggers";

const VIEWS = {
  "official-quiz/quiz-result": {
    params: ["items"],
    type: "card",
    header: [
      { type: "text", value: "做题结果" },
      { type: "spacer" },
      { type: "icon-button", icon: "x", label: "关闭", action: { surface: "close" } },
    ],
    body: [
      {
        type: "result-list",
        primary: "none",
        from: "{{ params.items }}",
        item: {
          ok: {
            type: "row",
            style: "{{ item.output.below ? 'below' : '' }}",
            action: { scrollTo: "{{ item.output.handle }}" },
            children: [
              { type: "text", value: "{{ item.output.title }}" },
              { type: "text", value: "{{ item.output.answer }}" },
              { type: "text", tone: "muted", value: "{{ item.output.sure + ' · ' + item.output.engine }}" },
            ],
          },
          error: {
            type: "row",
            children: [
              { type: "text", tone: "danger", value: "{{ item.output.title + ' ' + item.error.message }}" },
              { type: "button", label: "重试", action: { retry: "{{ item.engine }}" } },
            ],
          },
        },
      },
      { type: "text", tone: "muted", value: "没有点提交，检查后自己交卷" },
    ],
  },
};

const entryOf = (ref = "official-quiz/quiz/start"): AutoEntry =>
  ({
    feature: { ref: "official-quiz/quiz" } as ResolvedFeature,
    entry: {
      ref,
      def: {
        id: "start",
        name: "做题",
        triggers: [],
        run: [],
        present: { surface: { type: "page-card" }, view: { use: "official-quiz/quiz-result", with: { items: "{{ vars.rows }}" } } },
      },
    },
  }) as unknown as AutoEntry;

let layer: HTMLElement;
let els: HTMLElement[];
const row = (i: number, over: Record<string, unknown> = {}) => ({
  engine: `q${i}`,
  engineName: "",
  state: "ok",
  output: { title: `第 ${i} 题`, answer: "ABC"[i - 1], sure: ["96%", "88%", "61%"][i - 1], engine: "DeepSeek", below: false, handle: elementHandle(els[i - 1]!) },
  ...over,
});
const report = (rows: unknown[]): RunReport => ({ mode: "live", end: "done", steps: [], vars: { rows } });
const present = (r: RunReport, entry = entryOf(), opts: Parameters<typeof presentAutomation>[3] = {}) =>
  presentAutomation({ layer, services: { rules: { get: () => ({ views: Object.entries(VIEWS).map(([ref, def]) => ({ ref, def })) }) } } } as never, entry, r, opts);

beforeEach(() => {
  document.body.innerHTML = "";
  els = [1, 2, 3].map(() => {
    const e = document.createElement("div");
    e.scrollIntoView = vi.fn();
    document.body.append(e);
    return e;
  });
  layer = document.createElement("div");
  document.body.append(layer);
});
afterEach(() => {
  document.body.innerHTML = "";
});

const card = () => layer.querySelector<HTMLElement>("[data-cc-result]");

describe("quiz result card (R5.5, R5.6)", () => {
  it("lists every question with answer, confidence and engine, and the footer note", async () => {
    present(report([row(1), row(2), row(3, { output: { ...row(3).output, below: true } })]));
    const c = within(await waitFor(() => { const x = card(); if (!x) throw new Error("no card"); return x; }));
    await c.findByText("第 1 题");
    for (const t of ["第 2 题", "第 3 题", "A", "B", "C", "96% · DeepSeek", "88% · DeepSeek", "61% · DeepSeek", "没有点提交，检查后自己交卷"]) expect(c.getByText(t)).toBeTruthy();
  });

  it("marks only the below-threshold row", async () => {
    present(report([row(1), row(3, { output: { ...row(3).output, below: true } })]));
    await screen.findByText("第 3 题");
    const rows = [...layer.querySelectorAll("[data-part=row]")];
    expect(rows.map((r) => r.getAttribute("data-style"))).toEqual([null, "below"]);
  });

  it("clicking a row scrolls to that question's element", async () => {
    present(report([row(1), row(2)]));
    await userEvent.click(await screen.findByRole("button", { name: /第 2 题/ }));
    await waitFor(() => expect(els[1]!.scrollIntoView).toHaveBeenCalled());
    expect(els[0]!.scrollIntoView).not.toHaveBeenCalled();
  });

  it("a failed question shows its error and 重试 without disturbing the others; retry reports the question id and shows the new report", async () => {
    const retry = vi.fn(async (_id: string) => report([row(1), row(2)]));
    present(report([row(1), row(2, { state: "error", error: { message: "引擎没回应" } })]), entryOf(), { retry });
    expect(await screen.findByText("第 2 题 引擎没回应")).toBeTruthy();
    expect(screen.getByText("第 1 题")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledWith("q2");
    await waitFor(() => expect(screen.queryByText("第 2 题 引擎没回应")).toBeNull());
    expect(screen.getByText("96% · DeepSeek")).toBeTruthy();
    expect(await screen.findByText("88% · DeepSeek")).toBeTruthy();
  });

  it("stays until closed: close button, Escape and the returned function all remove it", async () => {
    const close = present(report([row(1)]));
    await screen.findByText("第 1 题");
    await new Promise((r) => setTimeout(r, 50));
    expect(card()).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(card()).toBeNull());

    present(report([row(1)]));
    await screen.findByText("第 1 题");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(card()).toBeNull());

    const c3 = present(report([row(1)]));
    await screen.findByText("第 1 题");
    act(() => c3());
    expect(card()).toBeNull();
    close();
  });

  it("keeps one card per entry: a newer run replaces it; another entry has its own card", async () => {
    present(report([row(1)]));
    await screen.findByText("第 1 题");
    present(report([row(2)]));
    await screen.findByText("第 2 题");
    expect(layer.querySelectorAll("[data-cc-result]").length).toBe(1);
    expect(screen.queryByText("第 1 题")).toBeNull();
    present(report([row(3)]), entryOf("official-quiz/quiz/other"));
    await screen.findByText("第 3 题");
    expect(layer.querySelectorAll("[data-cc-result]").length).toBe(2);
  });

  it("takes the focus when it appears and gives it back where it was when closed (R9.3)", async () => {
    const before = document.createElement("button");
    document.body.append(before);
    before.focus();
    present(report([row(1)]));
    await screen.findByText("第 1 题");
    await waitFor(() => expect(card()!.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(card()).toBeNull());
    expect(document.activeElement).toBe(before);
  });

  it("does nothing for an entry without present", () => {
    const e = entryOf();
    (e.entry.def as { present?: unknown }).present = undefined;
    const close = present(report([row(1)]), e);
    expect(card()).toBeNull();
    expect(() => close()).not.toThrow();
  });
});
