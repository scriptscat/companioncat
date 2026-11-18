// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { elementHandle, elementOf, type ElementHandle } from "../../core/expr";
import type { ActStep, RunStepDef } from "../../core/rules/types";
import { performAct, undo, type ActRecord, type PerformCtx } from "./acts";
import { runAutomation } from "./run";

function el<T extends Element>(html: string): T {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  const node = wrap.firstElementChild as T;
  document.body.append(node);
  return node;
}

/** Counts every event of the given types on `node`, in order. */
function track(node: EventTarget, types: string[]) {
  const seen: string[] = [];
  for (const t of types) node.addEventListener(t, () => seen.push(t));
  return seen;
}

function ctx(over: Partial<PerformCtx> = {}): PerformCtx {
  return {
    path: [0],
    vars: {},
    site: "video.test",
    rule: "pack/skip-ads/auto",
    askUser: vi.fn(async () => true),
    hint: vi.fn(),
    prefs: { isAlwaysDo: vi.fn(() => false) },
    ...over,
  };
}

const h = (node: Element): ElementHandle => elementHandle(node);

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("acts change the page like a user would (R1.2)", () => {
  it("click dispatches pointer/mouse down, up, then click", async () => {
    const button = el<HTMLButtonElement>("<button>跳过广告</button>");
    const seen = track(button, ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    const rec = await performAct({ act: "click", target: "x" }, h(button), ctx({ describe: "「跳过广告」按钮" }));
    expect(seen).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    expect(rec).toMatchObject({ mode: "auto", act: "click", describe: "「跳过广告」按钮" });
    expect(rec.error).toBeUndefined();
  });

  it("click events bubble so delegated page listeners see them", async () => {
    const button = el<HTMLButtonElement>("<button>go</button>");
    const seen = track(document.body, ["click"]);
    await performAct({ act: "click", target: "x" }, h(button), ctx());
    expect(seen).toEqual(["click"]);
  });

  it("fill sets the value through the native setter, then fires input and change", async () => {
    const input = el<HTMLInputElement>('<input value="old">');
    // React-style value tracker on the instance: writes through `input.value = …` are recorded here
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
    let tracked = "old";
    Object.defineProperty(input, "value", {
      configurable: true,
      get() {
        return proto.get!.call(this);
      },
      set(v: string) {
        tracked = v;
        proto.set!.call(this, v);
      },
    });
    const seen: string[] = [];
    input.addEventListener("input", () => seen.push(`input:${input.value}`));
    input.addEventListener("change", () => seen.push(`change:${input.value}`));
    await performAct({ act: "fill", target: "x", value: "42" }, h(input), ctx({ value: "42" }));
    expect(seen).toEqual(["input:42", "change:42"]);
    expect(tracked).toBe("old");
  });

  it("fill works on a textarea", async () => {
    const area = el<HTMLTextAreaElement>("<textarea>a</textarea>");
    const seen = track(area, ["input", "change"]);
    const rec = await performAct({ act: "fill", target: "x", value: "答案" }, h(area), ctx({ value: "答案" }));
    expect(area.value).toBe("答案");
    expect(seen).toEqual(["input", "change"]);
    expect(rec.mode).toBe("auto");
  });

  it("fill on something that takes no text fails and stops nothing else", async () => {
    const div = el<HTMLDivElement>("<div>x</div>");
    const rec = await performAct({ act: "fill", target: "x", value: "v" }, h(div), ctx({ value: "v" }));
    expect(rec.mode).toBe("failed");
    expect(rec.error).toMatchObject({ type: "rule" });
  });

  it("check ticks a checkbox and fires change; already ticked fires nothing", async () => {
    const box = el<HTMLInputElement>('<input type="checkbox">');
    const seen = track(box, ["click", "input", "change"]);
    await performAct({ act: "check", target: "x" }, h(box), ctx());
    expect(box.checked).toBe(true);
    expect(seen).toEqual(["click", "input", "change"]);
    seen.length = 0;
    await performAct({ act: "check", target: "x", value: true }, h(box), ctx({ value: true }));
    expect(box.checked).toBe(true);
    expect(seen).toEqual([]);
  });

  it("check with value false unticks", async () => {
    const box = el<HTMLInputElement>('<input type="checkbox" checked>');
    const seen = track(box, ["change"]);
    await performAct({ act: "check", target: "x", value: false }, h(box), ctx({ value: false }));
    expect(box.checked).toBe(false);
    expect(seen).toEqual(["change"]);
  });

  it("check selects a radio in its group", async () => {
    const form = el<HTMLFormElement>('<form><input type="radio" name="q" value="a" checked><input type="radio" name="q" value="b"></form>');
    const a = form.querySelector<HTMLInputElement>('[value="a"]')!;
    const b = form.querySelector<HTMLInputElement>('[value="b"]')!;
    const seen = track(b, ["change"]);
    await performAct({ act: "check", target: "x" }, h(b), ctx());
    expect(b.checked).toBe(true);
    expect(a.checked).toBe(false);
    expect(seen).toEqual(["change"]);
  });

  it("check on a non-checkable element fails", async () => {
    const input = el<HTMLInputElement>('<input type="text">');
    const rec = await performAct({ act: "check", target: "x" }, h(input), ctx());
    expect(rec.mode).toBe("failed");
  });

  it("select picks an option by value, else by label, and fires input and change", async () => {
    const select = el<HTMLSelectElement>('<select><option value="">-</option><option value="b">北京</option><option value="s">上海</option></select>');
    const seen = track(select, ["input", "change"]);
    await performAct({ act: "select", target: "x", value: "s" }, h(select), ctx({ value: "s" }));
    expect(select.value).toBe("s");
    expect(seen).toEqual(["input", "change"]);
    await performAct({ act: "select", target: "x", value: "北京" }, h(select), ctx({ value: "北京" }));
    expect(select.value).toBe("b");
  });

  it("select with no matching option fails without changing anything", async () => {
    const select = el<HTMLSelectElement>('<select><option value="a">A</option><option value="b">B</option></select>');
    const seen = track(select, ["input", "change"]);
    const rec = await performAct({ act: "select", target: "x", value: "z" }, h(select), ctx({ value: "z" }));
    expect(rec.mode).toBe("failed");
    expect(select.value).toBe("a");
    expect(seen).toEqual([]);
  });

  it("scroll brings the element into view", async () => {
    const div = el<HTMLDivElement>("<div>far</div>");
    const spy = vi.fn();
    (div as unknown as { scrollIntoView: unknown }).scrollIntoView = spy;
    const rec = await performAct({ act: "scroll", target: "x" }, h(div), ctx());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(rec.mode).toBe("auto");
  });

  it("focus gives the element focus", async () => {
    const input = el<HTMLInputElement>("<input>");
    const seen = track(input, ["focus"]);
    await performAct({ act: "focus", target: "x" }, h(input), ctx());
    expect(document.activeElement).toBe(input);
    expect(seen).toEqual(["focus"]);
  });

  it("nothing guards what an act may target: a submit button is clicked", async () => {
    const form = el<HTMLFormElement>('<form><button type="submit">交卷</button></form>');
    const submitted = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener("submit", submitted);
    await performAct({ act: "click", target: "x" }, h(form.querySelector("button")!), ctx());
    expect(submitted).toHaveBeenCalledTimes(1);
  });
});

describe("wait (R1.2, R1.6)", () => {
  it("waits ms and continues", async () => {
    vi.useFakeTimers();
    let done = false;
    const p = performAct({ act: "wait", ms: 500 }, undefined, ctx({ ms: 500 })).then((r) => ((done = true), r));
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const rec = await p;
    expect(rec).toMatchObject({ mode: "auto", act: "wait" });
    expect(rec.stop).toBeFalsy();
  });

  it("waits until the selector appears", async () => {
    const p = performAct({ act: "wait", selector: ".skip", timeoutMs: 2000 }, undefined, ctx({ selector: ".skip", timeoutMs: 2000 }));
    setTimeout(() => el("<button class='skip'>跳过</button>"), 20);
    const rec = await p;
    expect(rec.mode).toBe("auto");
    expect(rec.stop).toBeFalsy();
    expect(rec.error).toBeUndefined();
  });

  it("returns at once when the selector is already there", async () => {
    el("<i class='here'></i>");
    const rec = await performAct({ act: "wait", selector: ".here", timeoutMs: 1 }, undefined, ctx({ selector: ".here", timeoutMs: 1 }));
    expect(rec.mode).toBe("auto");
  });

  it("a selector that never appears times out: stop with an error", async () => {
    vi.useFakeTimers();
    const p = performAct({ act: "wait", selector: ".never", timeoutMs: 300 }, undefined, ctx({ selector: ".never", timeoutMs: 300 }));
    await vi.advanceTimersByTimeAsync(300);
    const rec = await p;
    expect(rec).toMatchObject({ mode: "failed", act: "wait", stop: true, error: { type: "timeout" } });
  });

  it("an abort ends a wait early", async () => {
    const ac = new AbortController();
    const p = performAct({ act: "wait", ms: 60_000 }, undefined, ctx({ ms: 60_000, signal: ac.signal }));
    ac.abort();
    const rec = await p;
    expect(rec.stop).toBe(true);
  });
});

describe("threshold routing (R1.3, R2.3)", () => {
  const click: ActStep = { act: "click", target: "x" };

  it("at or above the threshold performs without asking", async () => {
    const button = el<HTMLButtonElement>("<button>跳过</button>");
    const seen = track(button, ["click"]);
    const c = ctx({ confidence: 0.85, minConfidence: 0.85, below: "ask" });
    const rec = await performAct(click, h(button), c);
    expect(seen).toEqual(["click"]);
    expect(c.askUser).not.toHaveBeenCalled();
    expect(rec).toMatchObject({ mode: "auto", confidence: 0.85 });
  });

  it("no minConfidence performs directly whatever the confidence", async () => {
    const button = el<HTMLButtonElement>("<button>跳过</button>");
    const seen = track(button, ["click"]);
    const c = ctx({ confidence: 0.1 });
    const rec = await performAct(click, h(button), c);
    expect(seen).toEqual(["click"]);
    expect(c.askUser).not.toHaveBeenCalled();
    expect(c.prefs.isAlwaysDo).not.toHaveBeenCalled();
    expect(rec.mode).toBe("auto");
  });

  it("below ask: asks, performs only on yes", async () => {
    const button = el<HTMLButtonElement>("<button>跳过</button>");
    const seen = track(button, ["click"]);
    const yes = ctx({ confidence: 0.72, minConfidence: 0.85, below: "ask", describe: "「跳过」按钮" });
    const rec = await performAct(click, h(button), yes);
    expect(yes.askUser).toHaveBeenCalledWith(
      expect.objectContaining({ target: h(button), act: "click", describe: "「跳过」按钮", confidence: 0.72, minConfidence: 0.85, site: "video.test", rule: "pack/skip-ads/auto" }),
    );
    expect(seen).toEqual(["click"]);
    expect(rec).toMatchObject({ mode: "asked-yes", confidence: 0.72, minConfidence: 0.85 });

    const no = ctx({ confidence: 0.72, minConfidence: 0.85, below: "ask", askUser: vi.fn(async () => false) });
    const rec2 = await performAct(click, h(button), no);
    expect(seen).toEqual(["click"]);
    expect(rec2.mode).toBe("asked-no");
    expect(rec2.error).toBeUndefined();
    expect(rec2.stop).toBeFalsy();
  });

  it("missing below defaults to asking", async () => {
    const button = el<HTMLButtonElement>("<button>跳过</button>");
    const c = ctx({ confidence: 0.5, minConfidence: 0.85, askUser: vi.fn(async () => false) });
    const rec = await performAct(click, h(button), c);
    expect(c.askUser).toHaveBeenCalledTimes(1);
    expect(rec.mode).toBe("asked-no");
  });

  it("a missing confidence counts as below the threshold", async () => {
    const button = el<HTMLButtonElement>("<button>跳过</button>");
    const seen = track(button, ["click"]);
    const rec = await performAct(click, h(button), ctx({ minConfidence: 0.5, below: "skip" }));
    expect(seen).toEqual([]);
    expect(rec.mode).toBe("skip");
  });

  it("below hint: calls the hint port with the suggestion and does not perform", async () => {
    const input = el<HTMLInputElement>('<input value="">');
    const seen = track(input, ["input", "change"]);
    const c = ctx({ confidence: 0.4, minConfidence: 0.8, below: "hint", value: "B", describe: "第 3 题" });
    const rec = await performAct({ act: "fill", target: "x", value: "B" }, h(input), c);
    expect(c.hint).toHaveBeenCalledWith(h(input), expect.objectContaining({ act: "fill", value: "B", confidence: 0.4, describe: "第 3 题" }));
    expect(seen).toEqual([]);
    expect(input.value).toBe("");
    expect(c.askUser).not.toHaveBeenCalled();
    expect(rec.mode).toBe("hint");
  });

  it("below skip: does nothing but still records", async () => {
    const button = el<HTMLButtonElement>("<button>跳过</button>");
    const seen = track(button, ["click"]);
    const c = ctx({ confidence: 0.4, minConfidence: 0.8, below: "skip" });
    const rec = await performAct(click, h(button), c);
    expect(seen).toEqual([]);
    expect(c.askUser).not.toHaveBeenCalled();
    expect(c.hint).not.toHaveBeenCalled();
    expect(rec).toMatchObject({ mode: "skip", confidence: 0.4 });
  });

  it("always-do for this site and rule performs below the threshold without asking", async () => {
    const button = el<HTMLButtonElement>("<button>跳过</button>");
    const seen = track(button, ["click"]);
    const isAlwaysDo = vi.fn((site: string, rule: string) => site === "video.test" && rule === "pack/skip-ads/auto");
    const c = ctx({ confidence: 0.5, minConfidence: 0.85, below: "ask", prefs: { isAlwaysDo } });
    const rec = await performAct(click, h(button), c);
    expect(isAlwaysDo).toHaveBeenCalledWith("video.test", "pack/skip-ads/auto");
    expect(c.askUser).not.toHaveBeenCalled();
    expect(seen).toEqual(["click"]);
    expect(rec.mode).toBe("auto");
  });

  it("does not act when the run was discarded while it waited for always-do or for your answer", async () => {
    const button = el<HTMLButtonElement>("<button>跳过</button>");
    const seen = track(button, ["click"]);
    const ac = new AbortController();
    const isAlwaysDo = vi.fn(async () => (ac.abort(), true));
    const rec = await performAct(click, h(button), ctx({ confidence: 0.5, minConfidence: 0.85, below: "ask", prefs: { isAlwaysDo }, signal: ac.signal }));
    const ac2 = new AbortController();
    const askUser = vi.fn(async () => (ac2.abort(), true));
    const asked = await performAct(click, h(button), ctx({ confidence: 0.5, minConfidence: 0.85, below: "ask", askUser, signal: ac2.signal }));
    expect(seen).toEqual([]);
    expect(rec).toMatchObject({ mode: "skip", stop: true });
    expect(asked).toMatchObject({ mode: "skip", stop: true });
  });

  it("always-do set for another site still asks", async () => {
    const button = el<HTMLButtonElement>("<button>跳过</button>");
    const isAlwaysDo = vi.fn((site: string) => site === "other.test");
    const c = ctx({ confidence: 0.5, minConfidence: 0.85, below: "ask", prefs: { isAlwaysDo } });
    await performAct(click, h(button), c);
    expect(c.askUser).toHaveBeenCalledTimes(1);
  });
});

describe("a target that is gone (R1.6)", () => {
  it("skips and records 目标已经不在了 without stopping the run", async () => {
    const button = el<HTMLButtonElement>("<button>跳过</button>");
    const seen = track(button, ["click"]);
    button.remove();
    const c = ctx({ confidence: 0.4, minConfidence: 0.8, below: "ask" });
    const rec = await performAct({ act: "click", target: "x" }, h(button), c);
    expect(seen).toEqual([]);
    expect(c.askUser).not.toHaveBeenCalled();
    expect(rec).toMatchObject({ mode: "skip", summary: "目标已经不在了" });
    expect(rec.stop).toBeFalsy();
    expect(rec.error).toBeUndefined();
  });

  it("a target removed while you were being asked is not acted on", async () => {
    const button = el<HTMLButtonElement>("<button>跳过</button>");
    const seen = track(button, ["click"]);
    const askUser = vi.fn(async () => {
      button.remove();
      return true;
    });
    const rec = await performAct({ act: "click", target: "x" }, h(button), ctx({ confidence: 0.4, minConfidence: 0.8, below: "ask", askUser }));
    expect(seen).toEqual([]);
    expect(rec).toMatchObject({ mode: "skip", summary: "目标已经不在了" });
  });
});

describe("records and undo (R2.4)", () => {
  it("a fill record never carries the filled or the previous value", async () => {
    const input = el<HTMLInputElement>('<input value="旧值-secret">');
    const rec = await performAct({ act: "fill", target: "x", value: "新值-secret" }, h(input), ctx({ value: "新值-secret", describe: "第 1 题", confidence: 0.9 }));
    expect(rec).toMatchObject({ mode: "auto", act: "fill", describe: "第 1 题", confidence: 0.9, site: "video.test", rule: "pack/skip-ads/auto" });
    const text = JSON.stringify(rec) + String(rec.summary);
    expect(text).not.toContain("新值");
    expect(text).not.toContain("旧值");
    expect(Object.values(rec)).not.toContain("新值-secret");
  });

  it("a hinted fill record does not carry the value either", async () => {
    const input = el<HTMLInputElement>("<input>");
    const rec = await performAct({ act: "fill", target: "x", value: "答案C-secret" }, h(input), ctx({ value: "答案C-secret", confidence: 0.1, minConfidence: 0.5, below: "hint" }));
    expect(JSON.stringify(rec) + rec.summary).not.toContain("答案C");
  });

  it("undo of a fill restores the previous value with input and change", async () => {
    const input = el<HTMLInputElement>('<input value="before">');
    const rec = await performAct({ act: "fill", target: "x", value: "after" }, h(input), ctx({ value: "after" }));
    expect(input.value).toBe("after");
    expect(rec.undo).toBeDefined();
    const seen = track(input, ["input", "change"]);
    const markWrong = vi.fn();
    expect(await undo(rec, { markWrong })).toBe("restored");
    expect(input.value).toBe("before");
    expect(seen).toEqual(["input", "change"]);
    expect(markWrong).not.toHaveBeenCalled();
  });

  it("undo of any other performed act marks it wrong", async () => {
    const button = el<HTMLButtonElement>("<button>跳过</button>");
    const rec = await performAct({ act: "click", target: "x" }, h(button), ctx());
    expect(rec.undo).toBeUndefined();
    const markWrong = vi.fn();
    expect(await undo(rec, { markWrong })).toBe("marked");
    expect(markWrong).toHaveBeenCalledWith(rec);
  });

  it("undo of an act asked and approved also marks it wrong", async () => {
    const box = el<HTMLInputElement>('<input type="checkbox">');
    const rec = await performAct({ act: "check", target: "x" }, h(box), ctx({ confidence: 0.1, minConfidence: 0.5, below: "ask" }));
    expect(rec.mode).toBe("asked-yes");
    const markWrong = vi.fn();
    expect(await undo(rec, { markWrong })).toBe("marked");
  });

  it("nothing to undo for an act that was not performed", async () => {
    const button = el<HTMLButtonElement>("<button>跳过</button>");
    const markWrong = vi.fn();
    for (const rec of [
      await performAct({ act: "click", target: "x" }, h(button), ctx({ confidence: 0.1, minConfidence: 0.5, below: "skip" })),
      await performAct({ act: "click", target: "x" }, h(button), ctx({ confidence: 0.1, minConfidence: 0.5, below: "hint" })),
      await performAct({ act: "click", target: "x" }, h(button), ctx({ confidence: 0.1, minConfidence: 0.5, askUser: async () => false })),
    ] as ActRecord[]) {
      expect(await undo(rec, { markWrong })).toBe("none");
    }
    expect(markWrong).not.toHaveBeenCalled();
  });

  it("every record carries a summary for the run report", async () => {
    const button = el<HTMLButtonElement>("<button>跳过</button>");
    const rec = await performAct({ act: "click", target: "x" }, h(button), ctx({ describe: "「跳过」按钮" }));
    expect(rec.summary).toContain("「跳过」按钮");
    expect(elementOf(h(button))).toBe(button);
  });
});

describe("as the runner's env.act (R1.6)", () => {
  const host = { text: (e: Element) => e.textContent ?? "", visible: () => true };
  const invoker = { invoke: vi.fn(), preferredEngines: () => ({ engines: [] }) };
  const steps = (s: unknown[]) => s as RunStepDef[];

  it("a gone target is skipped and later steps still run; a wait timeout stops the run", async () => {
    vi.useFakeTimers();
    el("<button class='a'>A</button>");
    const later = el<HTMLButtonElement>("<button class='b'>B</button>");
    const seen = track(later, ["click"]);
    const deps = { site: "video.test", rule: "r", askUser: vi.fn(async () => true), hint: vi.fn(), prefs: { isAlwaysDo: () => false } };
    const p = runAutomation(
      steps([
        { find: ".a", as: "a" },
        { find: ".b", as: "b" },
        { act: "click", target: "{{ vars.a }}", describe: "A" },
        { act: "click", target: "{{ vars.b }}", describe: "B" },
        { act: "wait", selector: ".never", timeoutMs: 100 },
        { act: "click", target: "{{ vars.b }}" },
      ]),
      { settings: {}, page: {}, site: {} },
      {
        invoker,
        host,
        act: async (step, target, c) => {
          if (step.act === "click" && c.describe === "A") document.querySelector(".a")!.remove();
          return performAct(step, target, { ...c, ...deps });
        },
      },
    );
    await vi.advanceTimersByTimeAsync(100);
    const report = await p;
    expect(report.steps.map((s) => s.summary)).toEqual(expect.arrayContaining(["目标已经不在了", "点击：B"]));
    expect(seen).toEqual(["click"]);
    expect(report.end).toBe("error");
    expect(report.steps.at(-1)?.error).toMatchObject({ type: "timeout" });
  });
});
