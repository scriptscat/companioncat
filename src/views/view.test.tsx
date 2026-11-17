import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import pack from "../../rules/packs/official-translate.json";
import { renderView, type ResultItem, type ViewAction, type ViewOptions } from "./index";

beforeAll(() => {
  // Radix Select in jsdom
  Object.assign(Element.prototype, { hasPointerCapture: () => false, setPointerCapture() {}, releasePointerCapture() {}, scrollIntoView() {} });
});

const translationCard = (pack as { views: Record<string, unknown> }).views["translation-card"] as never;
const views = { "official-translate/translation-card": translationCard };

const show = (node: unknown, scope: Record<string, unknown> = {}, onAction: (a: ViewAction) => void = () => {}, opts: ViewOptions = {}) =>
  render(<>{renderView(node as never, scope, onAction, opts)}</>);

describe("components (R9.10)", () => {
  it("renders card header/body, row, text with tone and reading styles, icon, spacer, dots", async () => {
    const { container } = show({
      type: "card",
      header: [
        { type: "text", value: "{{ 'a' + 'b' }}", tone: "muted" },
        { type: "icon", name: "arrow-right" },
        { type: "spacer" },
      ],
      body: [
        { type: "row", children: [{ type: "text", value: "x", style: "reading-lg" }, { type: "text", value: "y", style: "reading", tone: "danger" }] },
        { type: "dots" },
      ],
    });
    const ab = await screen.findByText("ab");
    expect(ab.dataset.tone).toBe("muted");
    expect(screen.getByText("x").dataset.style).toBe("reading-lg");
    expect(screen.getByText("x").className).toContain("font-read");
    expect(screen.getByText("y").dataset.tone).toBe("danger");
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".cc-dots")).not.toBeNull();
    expect(container.querySelector("[data-part=header]")).not.toBeNull();
    expect(container.querySelector("[data-part=body]")).not.toBeNull();
    expect(container.querySelector("[data-part=spacer]")).not.toBeNull();
  });

  it("renders icon-button and button and dispatches their actions with templates resolved", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    show(
      {
        type: "row",
        children: [
          { type: "icon-button", icon: "pin", label: "固定", action: { surface: "pin" } },
          { type: "button", label: "去{{ vars.w }}", action: { open: "engine:{{ vars.eng }}" } },
        ],
      },
      { vars: { w: "设置", eng: "llm/glm" } },
      onAction,
    );
    await user.click(screen.getByRole("button", { name: "固定" }));
    expect(onAction).toHaveBeenLastCalledWith({ surface: "pin" });
    await user.click(await screen.findByRole("button", { name: "去设置" }));
    expect(onAction).toHaveBeenLastCalledWith({ open: "engine:llm/glm" });
  });

  it("select shows the current value and runs onChange with `value`", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    show(
      {
        type: "select",
        value: "{{ vars.to }}",
        label: "翻译成",
        options: { "zh-CN": "中文", en: "English" },
        onChange: { rerun: { vars: { to: "{{ value }}" } } },
      },
      { vars: { to: "zh-CN" } },
      onAction,
    );
    const trigger = await screen.findByRole("combobox", { name: "翻译成" });
    await waitFor(() => expect(trigger.textContent).toContain("中文"));
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "English" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ rerun: { vars: { to: "en" } } }));
  });

  it("select accepts options returned by an expression", async () => {
    show({ type: "select", value: "en", label: "语言", options: "{{ languages() }}" });
    const trigger = await screen.findByRole("combobox", { name: "语言" });
    await waitFor(() => expect(trigger.textContent).toBe("English"));
  });
});

describe("rule data cannot crash the view", () => {
  it("an icon named after an Object.prototype key renders the fallback dot", async () => {
    const { container } = show({ type: "row", children: [{ type: "icon", name: "constructor" }, { type: "text", value: "旁边" }] });
    expect(await screen.findByText("旁边")).toBeTruthy();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("expressions stay correct without flicker", () => {
  it("keeps the previous text while a new scope is being evaluated and ignores stale results", async () => {
    const node = { type: "text", value: "{{ vars.who }}" };
    const { rerender } = show(node, { vars: { who: "a" } });
    await screen.findByText("a");
    rerender(<>{renderView(node as never, { vars: { who: "b" } }, () => {})}</>);
    expect(screen.queryByText("a")).not.toBeNull(); // still the old value, never blank
    await screen.findByText("b");
    expect(screen.queryByText("a")).toBeNull();
  });

  it("renders static content synchronously", () => {
    show({ type: "text", value: "静态" });
    expect(screen.getByText("静态")).toBeTruthy();
  });

  it("an erroring expression does not blank previously rendered text", async () => {
    const node = { type: "text", value: "{{ vars.xs[0] }}" };
    const { rerender } = show(node, { vars: { xs: ["ok"] } });
    await screen.findByText("ok");
    rerender(<>{renderView(node as never, { vars: { xs: [] } }, () => {})}</>);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.queryByText("ok")).not.toBeNull();
  });
});

describe("views use / with / params", () => {
  const tpl = { params: ["name", "n"], type: "text", value: "你好 {{ params.name }} {{ params.n + 1 }}" };

  it("renders a template with `with` evaluated in the page scope", async () => {
    show({ use: "t", with: { name: "{{ selection.text }}", n: 2 } }, { selection: { text: "猫" } }, () => {}, { views: { t: tpl } as never });
    await screen.findByText("你好 猫 3");
  });

  it("re-renders when the scope behind `with` changes", async () => {
    const node = { use: "t", with: { name: "{{ vars.x }}", n: 0 } };
    const opts = { views: { t: tpl } as never };
    const { rerender } = show(node, { vars: { x: "一" } }, () => {}, opts);
    await screen.findByText("你好 一 1");
    rerender(<>{renderView(node as never, { vars: { x: "二" } }, () => {}, opts)}</>);
    await screen.findByText("你好 二 1");
  });

  it("shows a visible error for an unknown view", () => {
    show({ use: "nope" }, {}, () => {}, { views: {} });
    expect(screen.getByRole("alert").textContent).toContain("nope");
  });

  it("does not loop on a template that uses itself", () => {
    show({ use: "a" }, {}, () => {}, { views: { a: { type: "card", body: { use: "a" } } } as never });
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  });
});

describe("auto view from the output schema (R9.10)", () => {
  it("shows a string as text", async () => {
    show(null, { result: "你好" }, () => {}, { outputSchema: { type: "string" } });
    await screen.findByText("你好");
  });

  it("shows an object as a key/value table, using schema titles", async () => {
    show(null, { result: { choice: "B", confidence: 0.9 } }, () => {}, {
      outputSchema: { type: "object", properties: { choice: { type: "string", title: "选项" }, confidence: { type: "number" } } },
    });
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("选项")).toBeTruthy();
    expect(within(rows[0]!).getByText("B")).toBeTruthy();
    expect(within(rows[1]!).getByText("confidence")).toBeTruthy();
    expect(within(rows[1]!).getByText("0.9")).toBeTruthy();
  });

  it("shows an array as a list", async () => {
    show(null, { result: ["甲", "乙"] }, () => {}, { outputSchema: { type: "array", items: { type: "string" } } });
    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["甲", "乙"]);
  });

  it("nests: array of objects", async () => {
    show(null, { result: [{ a: "1" }] }, () => {}, { outputSchema: { type: "array" } });
    const list = await screen.findByRole("list");
    expect(within(list).getByRole("table")).toBeTruthy();
  });

  it("explicit views win over the auto view", async () => {
    show({ type: "text", value: "自定义" }, { result: "x" }, () => {}, { outputSchema: { type: "string" } });
    await screen.findByText("自定义");
    expect(screen.queryByText("x")).toBeNull();
  });
});

const items = (...i: Partial<ResultItem>[]): ResultItem[] =>
  i.map((x, n) => ({ engine: `e${n}`, engineName: `引擎${n}`, state: "loading", ...x }) as ResultItem);

const card = (results: ResultItem[], onAction: (a: ViewAction) => void = () => {}, opts: ViewOptions = {}) => {
  const node = { use: "official-translate/translation-card", with: { results: "{{ vars.results }}", from: "{{ selection.lang }}", to: "{{ vars.to }}" } };
  const scope = (r: ResultItem[]) => ({ vars: { results: r, to: "zh-CN" }, selection: { lang: "en" } });
  const utils = show(node, scope(results), onAction, { views: views as never, ...opts });
  return {
    ...utils,
    update: (r: ResultItem[]) => utils.rerender(<>{renderView(node as never, scope(r), onAction, { views: views as never, ...opts })}</>),
  };
};

describe("result-list with the official translation-card (R9.11)", () => {
  it("renders the header from the view: source language (langName), picker, pin and close", async () => {
    card(items({ state: "loading" }));
    // R10.1: the header reads 英语 → 简体中文 (source language by its Chinese name)
    await screen.findByText("英语");
    expect(screen.getByRole("combobox").textContent).toContain("中文");
    expect(screen.getByRole("button", { name: "固定" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("lists the other engines without a height cap of their own, opaque, with room under the last row (R13.4)", async () => {
    const { container } = card(items({ state: "ok", output: { texts: ["主"] } }, { state: "ok", output: { texts: ["二"] } }, { state: "needKey" }));
    await screen.findByText("二");
    const list = container.querySelector('[data-part="result-list"] > div:last-child') as HTMLElement;
    expect(list.className).toContain("bg-paper");
    expect(list.className).not.toMatch(/\bmax-h-/);
    expect(list.className).toMatch(/\bpb-(2|3|4)\b/);
  });

  it("shows the four states per item in engine order, first item primary", async () => {
    const { container } = card(
      items(
        { state: "ok", output: { texts: ["主译文"] }, cached: true },
        { state: "ok", output: { texts: ["次译文"] } },
        { state: "loading" },
        { state: "error", error: { type: "timeout", message: "10 秒没有响应，已放弃" } },
        { state: "needKey" },
      ),
    );
    const primary = await screen.findByText("主译文");
    expect(primary.dataset.style).toBe("reading-lg");
    const second = await screen.findByText("次译文");
    expect(second.dataset.style).toBe("reading");
    const rows = [...container.querySelectorAll("[data-part=result-item]")] as HTMLElement[];
    expect(rows.map((r) => r.dataset.state)).toEqual(["ok", "ok", "loading", "error", "needKey"]);
    expect(rows.map((r) => r.dataset.primary)).toEqual(["true", "false", "false", "false", "false"]);
    expect(rows[0]!.textContent).toContain("引擎0");
    expect(rows[0]!.textContent).toContain("刚才翻译过，直接用了缓存");
    expect(rows[1]!.textContent).not.toContain("刚才翻译过");
    expect(rows[2]!.querySelector(".cc-dots")).not.toBeNull();
    expect(rows[3]!.textContent).toContain("10 秒没有响应，已放弃");
    expect(within(rows[3]!).getByRole("button", { name: "重试" })).toBeTruthy();
    expect(rows[4]!.textContent).toContain("还没填 API Key");
    expect(within(rows[4]!).getByRole("button", { name: "填 Key" })).toBeTruthy();
    // the items keep engine order
    expect(rows.map((r) => r.dataset.engine)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
  });

  it("updates in place while a result streams in, and moves loading -> streaming -> done", async () => {
    const c = card(items({ state: "loading" }, { state: "ok", output: { texts: ["其他"] } }));
    await screen.findByText("其他");
    const row = () => document.querySelector("[data-part=result-item][data-engine=e0]") as HTMLElement;
    expect(row().dataset.state).toBe("loading");
    c.update(items({ state: "streaming", output: { texts: ["诀"] } }, { state: "ok", output: { texts: ["其他"] } }));
    await screen.findByText("诀");
    expect(row().dataset.state).toBe("streaming");
    expect(row().getAttribute("aria-busy")).toBe("true");
    c.update(items({ state: "streaming", output: { texts: ["诀窍在于"] } }, { state: "ok", output: { texts: ["其他"] } }));
    await screen.findByText("诀窍在于");
    expect(screen.queryByText("诀")).toBeNull();
    // no blank frame: the old text stays until the new one is ready
    c.update(items({ state: "ok", output: { texts: ["诀窍在于事件循环"] } }, { state: "ok", output: { texts: ["其他"] } }));
    expect(screen.queryByText("诀窍在于")).not.toBeNull();
    await screen.findByText("诀窍在于事件循环");
    expect(row().dataset.state).toBe("ok");
    expect(row().getAttribute("aria-busy")).toBeNull();
  });

  it("streaming with no output yet shows the loading view", async () => {
    const { container } = card(items({ state: "streaming" }));
    await screen.findByText("英语");
    expect(container.querySelector("[data-part=result-item] .cc-dots")).not.toBeNull();
  });

  it("primary: none gives no item the large style", async () => {
    show(
      { type: "result-list", from: "{{ vars.rs }}", primary: "none", item: { ok: { type: "text", value: "{{ item.output }}", style: "{{ item.primary ? 'reading-lg' : 'reading' }}" } } },
      { vars: { rs: items({ state: "ok", output: "甲" }) } },
    );
    expect((await screen.findByText("甲")).dataset.style).toBe("reading");
  });

  it("falls back to an auto view of the output when the rule has no `ok` view", async () => {
    show({ type: "result-list", from: "{{ vars.rs }}" }, { vars: { rs: items({ state: "ok", output: "自动" }) } });
    await screen.findByText("自动");
  });

  it("without item views the built-in states still give the primary item larger text, 重试 and 填 Key (R9.11)", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    show(
      { type: "result-list", from: "{{ vars.rs }}" },
      { vars: { rs: items({ state: "ok", output: "主" }, { state: "error", error: { type: "timeout", message: "超时了" } }, { state: "needKey" }) } },
      onAction,
    );
    const primary = (await screen.findByText("主")).closest("[data-part=result-item] > div")!;
    expect(primary.className).toContain("text-[17px]");
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(onAction).toHaveBeenCalledWith({ retry: "e1" });
    await user.click(screen.getByRole("button", { name: "填 Key" }));
    expect(onAction).toHaveBeenCalledWith({ open: "engine:e2" });
  });

  it("an item whose view expression fails does not hide its siblings", async () => {
    const { container } = show({ type: "result-list", from: "{{ vars.rs }}", item: { ok: { type: "text", value: "{{ item.output.t }}" } } }, { vars: {
      rs: items({ state: "ok", output: {} }, { state: "ok", output: { t: "好的" } }),
    } });
    await screen.findByText("好的");
    const [bad] = container.querySelectorAll("[data-part=result-item]");
    await waitFor(() => expect(bad!.querySelector("[data-part=text]")!.getAttribute("data-expr-error")).toBeTruthy());
  });
});

describe("actions (R9.12)", () => {
  it("copy writes to the injected clipboard, confirms, and is dispatched", async () => {
    const copy = vi.fn(async () => {});
    const onAction = vi.fn();
    const user = userEvent.setup();
    card(items({ state: "ok", output: { texts: ["要复制的"] } }), onAction, { clipboard: copy });
    await user.click(await screen.findByRole("button", { name: "复制译文" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("要复制的"));
    expect(onAction).toHaveBeenCalledWith({ copy: "要复制的" });
    expect((await screen.findByRole("status")).textContent).toContain("已复制");
  });

  it("copy failure is reported instead of claiming success", async () => {
    const user = userEvent.setup();
    card(items({ state: "ok", output: { texts: ["x"] } }), () => {}, { clipboard: async () => { throw new Error("denied"); } });
    await user.click(await screen.findByRole("button", { name: "复制译文" }));
    expect((await screen.findByRole("status")).textContent).toContain("复制失败");
  });

  it("copy falls back to navigator.clipboard when none is injected", async () => {
    const writeText = vi.fn(async () => {});
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    card(items({ state: "ok", output: { texts: ["系统"] } }));
    await user.click(await screen.findByRole("button", { name: "复制译文" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("系统"));
  });

  it("retry targets only that engine; open targets engine settings; surface pin/close", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    card(
      items({ state: "ok", output: { texts: ["a"] } }, { engine: "builtin/edge", state: "error", error: { type: "timeout", message: "超时" } }, { engine: "llm/glm", state: "needKey" }),
      onAction,
    );
    await user.click(await screen.findByRole("button", { name: "重试" }));
    expect(onAction).toHaveBeenLastCalledWith({ retry: "builtin/edge" });
    await user.click(screen.getByRole("button", { name: "填 Key" }));
    expect(onAction).toHaveBeenLastCalledWith({ open: "engine:llm/glm" });
    await user.click(screen.getByRole("button", { name: "固定" }));
    expect(onAction).toHaveBeenLastCalledWith({ surface: "pin" });
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(onAction).toHaveBeenLastCalledWith({ surface: "close" });
  });

  it("changing the target language dispatches rerun with new vars", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    card(items({ state: "loading" }), onAction);
    await user.click(await screen.findByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "English" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ rerun: { vars: { to: "en" } } }));
  });

  it("an action whose template fails to evaluate is not dispatched", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    show({ type: "button", label: "go", action: { copy: "{{ nope.x }}" } }, {}, onAction);
    await user.click(screen.getByRole("button", { name: "go" }));
    expect(onAction).not.toHaveBeenCalled();
  });
});
