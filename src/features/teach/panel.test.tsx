import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { CallError } from "../../core/errors";
import type { InvokeRequest, InvokeResult } from "../../core/invoke";
import type { Resolved, ResolvedProvider } from "../../core/rules/types";
import { createStorage, type Storage } from "../../platform/storage";
import { staticRules, type RuntimeContext } from "../../shell";
import { createConversation, validateDraft } from "./conversation";
import {
  EXAMPLE_FEATURE,
  openTeachPanel,
  Panel,
  type DraftPaneApi,
} from "./Panel";
import { saveDraft, loadUnsaved, saveUnsaved, UNSAVED_KEY } from "./store";
import registration from "./register";

vi.mock("./Picker", async (orig) => {
  const real = await orig<typeof import("./Picker")>();
  return {
    ...real,
    openPicker: vi.fn(async () => [document.createElement("a")]),
    describePicked: vi.fn(async (handles: unknown[]) =>
      handles.map((handle) => ({
        handle,
        label: "「下一页」链接",
        outline: '<a href="/p/2">下一页</a>',
      })),
    ),
  };
});
import { openPicker } from "./Picker";

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});

type Script = string | CallError | "hang";

const provider = {
  ref: "llm/deepseek",
  id: "deepseek",
  pack: "llm",
  source: 0,
  enabled: true,
  problems: [],
  def: {
    id: "deepseek",
    name: "DeepSeek",
    hosts: ["api.deepseek.com"],
    implements: {},
  },
} as unknown as ResolvedProvider;
const resolved = (providers: ResolvedProvider[]): Resolved => ({
  features: [],
  providers,
  views: [],
  bridges: [],
  contracts: [],
  sites: [],
  diagnostics: [],
});

const reply = (r: Record<string, unknown>) => JSON.stringify(r);
const feature = (run: unknown[]) => ({
  id: "auto-expand",
  name: "自动展开全文",
  match: ["*://news.example.cn/*"],
  entries: [
    { id: "expand", name: "展开全文", triggers: [{ on: "page-load" }], run },
  ],
});
const GOOD = feature([
  { find: "article > .fold-btn", as: "fold" },
  { act: "click", target: "{{ vars.fold }}" },
]);
const TWO_BAD = feature([
  { find: "article > .fold-btn", where: "{{ nope }}", as: "fold" },
  { act: "click", target: "{{ alsoNope }}" },
]);

interface World {
  storage: Storage;
  prompts: string[];
  script: Script[];
  invoke: ReturnType<typeof vi.fn>;
  ctx: RuntimeContext;
  onClose: Mock<() => void>;
  layer: HTMLElement;
}

function world(script: Script[], o: { engine?: boolean } = {}): World {
  const storage = createStorage(createGmStorageFake().tab());
  const prompts: string[] = [];
  const invoke = vi.fn(
    async (
      req: InvokeRequest,
      opts: { signal?: AbortSignal } = {},
    ): Promise<InvokeResult> => {
      const messages = (
        req.input as { messages: { role: string; content: string }[] }
      ).messages;
      prompts.push(messages[messages.length - 1]!.content);
      const next = script.shift();
      if (next === undefined) throw new Error("no scripted reply left");
      if (next === "hang")
        return new Promise((_, reject) =>
          opts.signal?.addEventListener("abort", () =>
            reject(opts.signal!.reason),
          ),
        );
      if (next instanceof CallError)
        return {
          ok: false,
          strategy: "first",
          contract: "chat",
          error: next,
          results: [],
        };
      return {
        ok: true,
        strategy: "first",
        contract: "chat",
        engine: "llm/deepseek",
        output: { text: next },
        results: [],
      };
    },
  );
  const engine = o.engine ?? true;
  const invoker = {
    invoke,
    preferredEngines: () =>
      engine
        ? {
            engines: ["llm/deepseek"],
            preferred: "llm/deepseek",
            using: "llm/deepseek",
          }
        : { engines: [], notice: "还没填 Key" },
  };
  const layer = document.createElement("div");
  document.body.append(layer);
  const ctx = {
    layer,
    root: layer as unknown as ShadowRoot,
    hostname: "news.example.cn",
    services: {
      storage,
      rules: staticRules(resolved(engine ? [provider] : [])),
      invoker,
    },
    setAwake: vi.fn(),
    commands: { register: () => () => {} },
    openSettings: vi.fn(),
  } as unknown as RuntimeContext;
  return { storage, prompts, script, invoke, ctx, onClose: vi.fn(), layer };
}

const view = (
  w: World,
  extra: Partial<React.ComponentProps<typeof Panel>> = {},
) =>
  render(
    <Panel
      ctx={w.ctx}
      onClose={w.onClose}
      page={() => ({ url: "https://news.example.cn/a/1", title: "一篇新闻" })}
      {...extra}
    />,
  );

const say = async (text: string) => {
  await userEvent.type(screen.getByRole("textbox", { name: "和小猫说" }), text);
  await userEvent.click(screen.getByRole("button", { name: "发送" }));
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.mocked(openPicker).mockClear();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
});

describe("teach panel: first use and engine (R6.1, R6.2)", () => {
  it("is a dialog named 教小猫做件事 and the example is a valid feature", () => {
    view(world([]));
    expect(screen.getByRole("dialog", { name: "教小猫做件事" })).toBeTruthy();
    expect(validateDraft(EXAMPLE_FEATURE)).toEqual([]);
  });

  it("the first-use notice names the chat engine and its host once", async () => {
    const w = world([reply({ message: "好" })]);
    const first = view(w);
    const notice = await screen.findByText(/第一次用/);
    const box = notice.closest("div")!;
    expect(box.textContent).toContain("DeepSeek");
    expect(box.textContent).toContain("api.deepseek.com");
    expect(box.textContent).toContain("不含输入框");
    await say("帮我展开全文");
    await screen.findByText("好");
    first.unmount();
    view(w);
    await screen.findByRole("textbox", { name: "和小猫说" });
    expect(screen.queryByText(/第一次用/)).toBeNull();
  });

  it("with no usable chat engine it shows guidance, a link to the engines page, and no way to send", async () => {
    const w = world([], { engine: false });
    view(w);
    expect(screen.getByText(/还没有可用的对话引擎/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /去引擎页/ }));
    expect(w.ctx.openSettings).toHaveBeenCalledWith("engines");
    expect(
      (screen.getByRole("textbox", { name: "和小猫说" }) as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "发送" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByText(/第一次用/)).toBeNull();
  });
});

describe("teach panel: messages (R6.3, R6.4)", () => {
  it("shows the user's text and the cat's reply, and clears the composer", async () => {
    const w = world([reply({ message: "好的，我来看看。" })]);
    view(w);
    await say("打开文章时帮我点展开全文");
    expect(await screen.findByText("好的，我来看看。")).toBeTruthy();
    expect(screen.getByText("打开文章时帮我点展开全文")).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "和小猫说" }) as HTMLTextAreaElement)
        .value,
    ).toBe("");
    expect(w.prompts[0]).toContain("打开文章时帮我点展开全文");
  });

  it("点选元素 attaches a chip to the message being written, removable, and sends the outline", async () => {
    const w = world([reply({ message: "收到" })]);
    view(w);
    await userEvent.click(screen.getByRole("button", { name: "点选元素" }));
    expect(openPicker).toHaveBeenCalledWith(
      expect.objectContaining({ layer: w.layer }),
    );
    const chip = await screen.findByText(/下一页/);
    expect(chip).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /去掉/ }));
    expect(screen.queryByText(/下一页/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "点选元素" }));
    await screen.findByText(/下一页/);
    await say("点这个");
    await screen.findByText("收到");
    expect(w.prompts[0]).toContain('<a href="/p/2">下一页</a>');
    // the sent message keeps its chip and the composer's chips are gone
    expect(screen.getAllByText(/下一页/)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /去掉/ })).toBeNull();
  });

  it("closing the panel while picking ends the picker", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(openPicker).mockImplementationOnce((o) => ((signal = o.signal), new Promise(() => {})));
    const w = world([]);
    const { unmount } = view(w);
    await userEvent.click(screen.getByRole("button", { name: "点选元素" }));
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("closing the panel mid-turn stops the request to the chat engine", async () => {
    const w = world(["hang"]);
    const { unmount } = view(w);
    await say("帮我点展开全文");
    await vi.waitFor(() => expect(w.invoke).toHaveBeenCalledTimes(1));
    const { signal } = w.invoke.mock.calls[0]![1] as { signal: AbortSignal };
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("an attachment alone is enough to send", async () => {
    const w = world([reply({ message: "收到" })]);
    view(w);
    await userEvent.click(screen.getByRole("button", { name: "点选元素" }));
    await screen.findByText(/下一页/);
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("收到");
  });

  it("questions come with quick replies; one click sends the answer", async () => {
    const w = world([
      reply({
        message: "写之前先问一件事",
        questions: [
          {
            text: "只在 news.example.cn，还是所有新闻网站？",
            quickReplies: ["只在 news.example.cn", "所有新闻网站"],
          },
        ],
      }),
      reply({ message: "明白了" }),
    ]);
    view(w);
    await say("展开全文");
    expect(await screen.findByText(/还是所有新闻网站/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "所有新闻网站" }));
    await screen.findByText("明白了");
    expect(w.prompts[1]).toContain("所有新闻网站");
    expect(screen.getAllByText("所有新闻网站").length).toBeGreaterThan(0);
  });

  it("去点选 opens the picker and attaches the result to the next message", async () => {
    const w = world([
      reply({
        message: "我需要看一眼",
        askPick: { text: "「展开全文」长什么样？点给我看一下。" },
      }),
      reply({ message: "看到了" }),
    ]);
    view(w);
    await say("展开全文");
    expect(await screen.findByText(/点给我看一下/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "去点选" }));
    expect(openPicker).toHaveBeenCalledTimes(1);
    await screen.findByText(/下一页/);
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("看到了");
    expect(w.prompts[1]).toContain("下一页");
  });

  it("shows a compact repair line when validation found problems and the repair fixed them", async () => {
    const w = world([
      reply({ message: "写好了", draft: TWO_BAD }),
      reply({ message: "修好了", draft: GOOD }),
    ]);
    view(w);
    await say("展开全文");
    expect(await screen.findByText("校验发现 2 处问题，已修好")).toBeTruthy();
  });

  it("lists what is left when the repair rounds ran out", async () => {
    const bad = reply({ message: "草稿", draft: TWO_BAD });
    const w = world([bad, bad, bad, bad]);
    view(w);
    await say("展开全文");
    expect(await screen.findByText(/还剩 2 处/)).toBeTruthy();
    expect(screen.getByText("entries[0].run[0].where")).toBeTruthy();
  });

  it("shows 停下 while a turn is pending and the turn is dropped when it is pressed", async () => {
    const w = world(["hang"]);
    view(w);
    await say("展开全文");
    const stop = await screen.findByRole("button", { name: "停下" });
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    await userEvent.click(stop);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "停下" })).toBeNull(),
    );
    expect(screen.getByText("已停下")).toBeTruthy();
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
  });
});

describe("teach panel: failure (R6.11)", () => {
  it("shows the error type and 重试 re-runs the turn; earlier messages stay", async () => {
    const w = world([
      reply({ message: "第一句回复" }),
      new CallError("network", "连不上"),
      reply({ message: "这次好了" }),
    ]);
    view(w);
    await say("一");
    await screen.findByText("第一句回复");
    await say("二");
    expect(await screen.findByText(/网络/)).toBeTruthy();
    expect(screen.getByText("第一句回复")).toBeTruthy();
    expect(screen.getByText("二")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("这次好了");
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });
});

describe("teach panel: unsaved draft and closing (R6.9)", () => {
  const withDraft = async (w: World) => {
    view(w);
    await say("展开全文");
    await screen.findByText("草稿来了");
  };

  it("keeps the unsaved record updated after each turn", async () => {
    const w = world([reply({ message: "草稿来了", draft: GOOD })]);
    await withDraft(w);
    await waitFor(() =>
      expect(loadUnsaved(w.storage)?.conversation.versions).toHaveLength(1),
    );
  });

  it("writes no record while there is no draft", async () => {
    const w = world([
      reply({ message: "先问你", questions: [{ text: "哪里？" }] }),
    ]);
    view(w);
    await say("展开全文");
    await screen.findByText("先问你");
    expect(w.storage.get(UNSAVED_KEY)).toBeUndefined();
  });

  it("closing with no draft closes at once", async () => {
    const w = world([]);
    view(w);
    await userEvent.click(screen.getByRole("button", { name: /关闭/ }));
    expect(w.onClose).toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("closing with an unsaved draft asks 要丢掉这次的草稿吗; 继续写 stays", async () => {
    const w = world([reply({ message: "草稿来了", draft: GOOD })]);
    await withDraft(w);
    await userEvent.click(screen.getByRole("button", { name: /关闭/ }));
    const dlg = screen.getByRole("alertdialog");
    expect(dlg.textContent).toContain("要丢掉这次的草稿吗");
    await userEvent.click(within(dlg).getByRole("button", { name: "继续写" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(w.onClose).not.toHaveBeenCalled();
    expect(loadUnsaved(w.storage)).toBeTruthy();
  });

  it("丢掉 closes and forgets the unsaved record", async () => {
    const w = world([reply({ message: "草稿来了", draft: GOOD })]);
    await withDraft(w);
    await waitFor(() => expect(loadUnsaved(w.storage)).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /关闭/ }));
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "丢掉",
      }),
    );
    expect(w.onClose).toHaveBeenCalled();
    expect(loadUnsaved(w.storage)).toBeUndefined();
  });

  it("先留着 closes and keeps the record for 接着上次没写完的", async () => {
    const w = world([reply({ message: "草稿来了", draft: GOOD })]);
    await withDraft(w);
    await userEvent.click(screen.getByRole("button", { name: /关闭/ }));
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "先留着",
      }),
    );
    expect(w.onClose).toHaveBeenCalled();
    expect(loadUnsaved(w.storage)).toBeTruthy();
  });

  it("a draft that was saved does not ask on close", async () => {
    const w = world([reply({ message: "草稿来了", draft: GOOD })]);
    let api!: DraftPaneApi;
    view(w, { draftPane: (a) => ((api = a), null) });
    await say("展开全文");
    await screen.findByText("草稿来了");
    act(() => api.markSaved("auto-expand", api.state.current));
    expect(loadUnsaved(w.storage)).toBeUndefined();
    await userEvent.click(screen.getByRole("button", { name: /关闭/ }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(w.onClose).toHaveBeenCalled();
  });
});

describe("teach panel: narrow (R6.10)", () => {
  const narrow = () =>
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 500,
    });

  it("wide: chat and draft side by side, no tabs", () => {
    view(world([]), { draftPane: () => <p>草稿区内容</p> });
    expect(screen.queryByRole("tab", { name: "对话" })).toBeNull();
    expect(screen.getByText("草稿区内容")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "和小猫说" })).toBeTruthy();
  });

  it("narrow: 对话 and 草稿 vN tabs switch the two halves", async () => {
    narrow();
    const w = world([reply({ message: "草稿来了", draft: GOOD })]);
    view(w, { draftPane: (a) => <p>草稿区内容 v{a.state.current}</p> });
    expect(
      screen.getByRole("dialog", { name: "教小猫做件事" }).className,
    ).toContain("fixed");
    expect(
      screen.getByRole("tab", { name: "对话" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByText(/草稿区内容/)).toBeNull();
    await say("展开全文");
    await screen.findByText("草稿来了");
    await userEvent.click(screen.getByRole("tab", { name: "草稿 v1" }));
    expect(screen.getByText("草稿区内容 v1")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "和小猫说" })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "对话" }));
    expect(screen.getByRole("textbox", { name: "和小猫说" })).toBeTruthy();
  });
});

describe("teach panel: keyboard (R9.3)", () => {
  it("focus moves into the panel on open", () => {
    view(world([]));
    const dlg = screen.getByRole("dialog", { name: "教小猫做件事" });
    expect(dlg.contains(document.activeElement)).toBe(true);
  });

  it("Esc closes when nothing is unsaved", () => {
    const w = world([]);
    view(w);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "和小猫说" }), {
      key: "Escape",
    });
    expect(w.onClose).toHaveBeenCalled();
  });

  it("Esc with an unsaved draft asks first; Esc again in the question keeps writing", async () => {
    const w = world([reply({ message: "草稿来了", draft: GOOD })]);
    view(w);
    await say("展开全文");
    await screen.findByText("草稿来了");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "和小猫说" }), {
      key: "Escape",
    });
    const dlg = screen.getByRole("alertdialog");
    expect(dlg.contains(document.activeElement)).toBe(true);
    expect(w.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(dlg, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(w.onClose).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("dialog", { name: "教小猫做件事" })
        .contains(document.activeElement),
    ).toBe(true);
  });
});

describe("openTeachPanel and the draft slot", () => {
  let opener: HTMLButtonElement;
  beforeEach(() => {
    opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
  });

  it("mounts in the layer, hands the draft slot the conversation, and returns focus on close", async () => {
    const w = world([reply({ message: "草稿来了", draft: GOOD })]);
    document.body.append(opener);
    opener.focus();
    const seen: number[] = [];
    const handle = openTeachPanel(w.ctx, {
      draftPane: (a) => (
        seen.push(a.state.versions.length),
        (<p>草稿槽 v{a.state.current}</p>)
      ),
    });
    const dlg = await within(w.layer).findByRole("dialog", {
      name: "教小猫做件事",
    });
    expect(dlg).toBeTruthy();
    expect(within(w.layer).getByText("草稿槽 v0")).toBeTruthy();
    expect(dlg.contains(document.activeElement)).toBe(true);
    await userEvent.type(
      within(w.layer).getByRole("textbox", { name: "和小猫说" }),
      "展开",
    );
    await userEvent.click(
      within(w.layer).getByRole("button", { name: "发送" }),
    );
    await within(w.layer).findByText("草稿槽 v1");
    handle.close();
    await waitFor(() =>
      expect(w.layer.querySelector('[role="dialog"]')).toBeNull(),
    );
    expect(document.activeElement).toBe(opener);
  });

  it("a second open replaces the first instead of stacking", async () => {
    const w = world([]);
    openTeachPanel(w.ctx);
    openTeachPanel(w.ctx);
    await within(w.layer).findByRole("dialog");
    expect(w.layer.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("with a featureId it continues the saved conversation", async () => {
    const w = world([reply({ message: "再改一版", draft: GOOD })]);
    const seed = createConversation({
      invoker: {
        invoke: async () =>
          ({
            ok: true,
            strategy: "first",
            contract: "chat",
            output: { text: reply({ message: "原来的回复", draft: GOOD }) },
            results: [],
          }) as InvokeResult,
      },
      schema: {},
      example: {},
      validate: () => [],
    });
    await seed.send("原来的话");
    const saved = saveDraft(w.storage, seed, seed.versions[0]!.draft);
    expect(saved.ok).toBe(true);
    const id = (saved as { featureId: string }).featureId;
    openTeachPanel(w.ctx, { featureId: id });
    expect(await within(w.layer).findByText("原来的回复")).toBeTruthy();
    expect(within(w.layer).getByText("原来的话")).toBeTruthy();
    // a saved, untouched rule is not an unsaved draft
    fireEvent.keyDown(
      within(w.layer).getByRole("textbox", { name: "和小猫说" }),
      { key: "Escape" },
    );
    await waitFor(() =>
      expect(w.layer.querySelector('[role="dialog"]')).toBeNull(),
    );
  });

  it("resume reopens the unsaved conversation", async () => {
    const w = world([]);
    const seed = createConversation({
      invoker: {
        invoke: async () =>
          ({
            ok: true,
            strategy: "first",
            contract: "chat",
            output: { text: reply({ message: "没写完的回复", draft: GOOD }) },
            results: [],
          }) as InvokeResult,
      },
      schema: {},
      example: {},
      validate: () => [],
    });
    await seed.send("没写完");
    saveUnsaved(w.storage, seed);
    openTeachPanel(w.ctx, { resume: true });
    expect(await within(w.layer).findByText("没写完的回复")).toBeTruthy();
  });
});

describe("registration", () => {
  it("registers a feature without bubble or overlay", () => {
    const regs = Array.isArray(registration) ? registration : [registration];
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({ kind: "feature", id: "teach" });
    expect((regs[0] as { quick?: unknown }).quick).toBeUndefined();
  });
});
