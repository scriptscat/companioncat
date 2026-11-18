import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import type { InvokeRequest, InvokeResult } from "../../core/invoke";
import { getFeature } from "../../core/rules/local-edit";
import type { Resolved, ResolvedProvider } from "../../core/rules/types";
import { LOCAL_RULES_KEY, RulesPage } from "../../pages/rules/RulesPage";
import { createStorage, type Storage } from "../../platform/storage";
import { staticRules, type RuntimeContext } from "../../shell";
import { ShellCtx, type ShellApi } from "../../shell/context";
import { EMPTY_RESOLVED } from "../../shell/services";
import { TipProvider } from "../../ui";
import { disable } from "../page/enabled";
import type { SavedConversation } from "./conversation";
import { draftPane, turnFooter } from "./Draft";
import { openTeachPanel, Panel } from "./Panel";
import { teachKey, UNSAVED_KEY } from "./store";

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});

const provider = {
  ref: "llm/deepseek",
  id: "deepseek",
  pack: "llm",
  source: 0,
  enabled: true,
  problems: [],
  def: { id: "deepseek", name: "DeepSeek", hosts: ["api.deepseek.com"], implements: {} },
} as unknown as ResolvedProvider;
const resolved: Resolved = { features: [], providers: [provider], views: [], bridges: [], contracts: [], sites: [], diagnostics: [] };

const reply = (r: Record<string, unknown>) => JSON.stringify(r);
const feature = (run: unknown[]) => ({
  id: "auto-expand",
  name: "自动展开全文",
  match: ["*://news.example.cn/*"],
  entries: [{ id: "expand", name: "展开全文", triggers: [{ on: "page-load" }], run }],
});
/** Finds both 展开全文 buttons, asks which one is the article's, clicks them. */
const V1 = feature([
  { find: ".fold-btn", all: true, as: "folds" },
  { ask: "choose", input: { question: "哪个展开的是正文？", options: { a: "第一个", b: "第二个" } }, as: "pick" },
  { act: "click", target: "{{ vars.folds }}" },
]);
/** Only the article's button, no engine; then the reply buttons. */
const V2 = feature([
  { find: "article > .fold-btn", as: "fold" },
  { act: "click", target: "{{ vars.fold }}" },
  { find: ".reply-more", all: true, as: "replies" },
]);
const BAD = feature([
  { find: "article > .fold-btn", where: "{{ nope }}", as: "fold" },
  { act: "click", target: "{{ alsoNope }}" },
]);

interface World {
  storage: Storage;
  script: string[];
  invoke: Mock<(req: InvokeRequest, opts?: { signal?: AbortSignal }) => Promise<InvokeResult>>;
  ctx: RuntimeContext;
  layer: HTMLElement;
  clicks: Mock<() => void>;
}

let page: HTMLElement;

function world(script: string[]): World {
  const storage = createStorage(createGmStorageFake().tab());
  const invoke = vi.fn(async (req: InvokeRequest): Promise<InvokeResult> => {
    const next = script.shift();
    if (next === undefined) throw new Error(`no scripted reply left (${req.contract})`);
    return { ok: true, strategy: "first", contract: req.contract, engine: "llm/deepseek", output: { text: next }, results: [] };
  });
  const invoker = { invoke, preferredEngines: () => ({ engines: ["llm/deepseek"], preferred: "llm/deepseek", using: "llm/deepseek" }) };
  const layer = document.createElement("div");
  layer.dataset.ccLayer = "";
  document.body.append(layer);
  const ctx = {
    layer,
    root: layer as unknown as ShadowRoot,
    hostname: "news.example.cn",
    services: { storage, rules: staticRules(resolved), invoker },
    setAwake: vi.fn(),
    commands: { register: () => () => {} },
    openSettings: vi.fn(),
  } as unknown as RuntimeContext;
  const clicks = vi.fn();
  for (const b of page.querySelectorAll("button")) b.addEventListener("click", clicks);
  return { storage, script, invoke, ctx, layer, clicks };
}

const view = (w: World, extra: Partial<React.ComponentProps<typeof Panel>> = {}, container?: HTMLElement) =>
  render(
    <Panel
      ctx={w.ctx}
      onClose={vi.fn()}
      page={() => ({ url: "https://news.example.cn/a/1", title: "夜间公交" })}
      draftPane={draftPane}
      turnFooter={turnFooter}
      {...extra}
    />,
    container ? { container } : {},
  );

const say = async (text: string) => {
  await userEvent.type(screen.getByRole("textbox", { name: "和小猫说" }), text);
  await userEvent.click(screen.getByRole("button", { name: "发送" }));
};

const pane = () => screen.getByRole("region", { name: "草稿" });
const marks = (w: World) => [...w.layer.querySelectorAll<HTMLElement>("[data-cc-mark]")].map((m) => m.dataset.ccMark);
const trialRow = (path: string) => within(pane()).getByText(path, { exact: false }).closest("li")!;
const sentence = (text: string) => within(pane()).getByText(text).closest("li")!;
const contracts = (w: World) => w.invoke.mock.calls.map(([req]) => req.contract);

beforeEach(() => {
  // jsdom has no layout: every element counts as visible for find
  Element.prototype.checkVisibility = () => true;
  page = document.createElement("div");
  page.innerHTML = `
    <article><p>正文</p><button class="fold-btn">展开全文</button></article>
    <aside><button class="fold-btn">展开全文</button></aside>
    <section id="comments">
      <button class="reply-more">展开 3 条回复</button>
      <button class="reply-more">展开 5 条回复</button>
      <button class="reply-more">展开 12 条回复</button>
    </section>`;
  document.body.append(page);
});

afterEach(() => {
  document.body.innerHTML = "";
  delete (Element.prototype as { checkVisibility?: unknown }).checkVisibility;
});

describe("draft pane: 草稿 vN and the dry run on this page (R6.5)", () => {
  it("shows 草稿 v1 with 通过校验 and marks what find found with letters drawn in the layer, never acting or asking", async () => {
    const w = world([reply({ message: "写好了", draft: V2 })]);
    const before = page.innerHTML;
    view(w);
    await say("帮我展开全文");
    await within(pane()).findByText("草稿 v1");
    expect(within(pane()).getByText("通过校验")).toBeTruthy();

    await waitFor(() => expect(marks(w)).toEqual(["A", "1", "2", "3"]));
    expect(within(trialRow("run[0] find")).getByText("A")).toBeTruthy();
    expect(within(trialRow("run[1] act: click")).getByText("A")).toBeTruthy();
    expect(within(trialRow("run[2] find")).getByText("1、2、3")).toBeTruthy();
    // the act target's marker says what would happen to it
    expect(w.layer.querySelector('[data-cc-mark="A"]')!.textContent).toContain("会点击这个");
    // nothing on the page was styled, clicked or changed; only the chat engine was called
    expect(page.innerHTML).toBe(before);
    expect(w.clicks).not.toHaveBeenCalled();
    expect(contracts(w)).toEqual(["chat"]);
    expect(within(pane()).getByText(/这一版不会把任何内容发给引擎/)).toBeTruthy();
  });

  it("lists what an ask step would send and to which host, without calling the engine", async () => {
    const w = world([reply({ message: "写好了", draft: V1 })]);
    view(w);
    await say("帮我展开全文");
    await within(pane()).findByText("草稿 v1");
    const ask = await waitFor(() => trialRow("run[1] ask: choose"));
    await waitFor(() => expect(ask.textContent).toContain("api.deepseek.com"));
    expect(ask.textContent).toMatch(/会发.*问题、候选项/);
    expect(ask.textContent).toContain("DeepSeek");
    // the list find is numbered, its act targets carry the same numbers
    await waitFor(() => expect(marks(w)).toEqual(["1", "2"]));
    expect(within(trialRow("run[2] act: click")).getByText("1、2")).toBeTruthy();
    expect(contracts(w)).toEqual(["chat"]);
    expect(w.clicks).not.toHaveBeenCalled();
  });

  it("finds the questions of a quiz page with auto:questions, the same finders the runtime uses, and marks them", async () => {
    const quiz = document.createElement("form");
    quiz.innerHTML = `
      <fieldset id="q1"><legend>1. TCP 属于哪一层？</legend>
        <label><input type="radio" name="q1"> 网络层</label>
        <label><input type="radio" name="q1"> 传输层</label></fieldset>
      <fieldset id="q2"><legend>2. UDP 可靠吗？</legend>
        <label><input type="radio" name="q2"> 可靠</label>
        <label><input type="radio" name="q2"> 不可靠</label></fieldset>`;
    page.replaceChildren(quiz);
    const w = world([reply({ message: "写好了", draft: feature([{ find: "auto:questions", all: true, as: "qs" }]) })]);
    // in the shell the panel sits in the layer, which the question finder leaves alone (its own textarea is no blank)
    view(w, {}, w.layer.appendChild(document.createElement("div")));
    await say("帮我做这页的题");
    await within(pane()).findByText("草稿 v1");
    await waitFor(() => expect(marks(w)).toEqual(["1", "2"]));
    const row = trialRow("run[0] find");
    expect(row.textContent).not.toContain("不认识的查找方式");
    expect(within(row).getByText("1、2")).toBeTruthy();
    expect(contracts(w)).toEqual(["chat"]);
  });

  it("marks sentences added, removed and changed since the previous version, with their field sources", async () => {
    const w = world([reply({ message: "v1", draft: V1 }), reply({ message: "v2", draft: V2 })]);
    view(w);
    await say("帮我展开全文");
    await within(pane()).findByText("草稿 v1");
    // v1 has nothing to compare with
    expect(within(pane()).queryByText(/^比 v/)).toBeNull();
    await say("只点正文那个");
    await within(pane()).findByText("草稿 v2");

    // the removed ask takes its 会把…发到… sentence with it (R1.5)
    expect(within(pane()).getByText(/比 v1：加 1 处、改 1 处、删 2 处/)).toBeTruthy();
    expect(within(within(pane()).getByText(/^会把问题、候选项/).closest("li")!).getByLabelText("删掉")).toBeTruthy();
    expect(within(sentence("在页面里找「article > .fold-btn」")).getByLabelText("改了")).toBeTruthy();
    expect(within(sentence("在页面里找所有「.reply-more」")).getByLabelText("新加")).toBeTruthy();
    // no engine in the draft: the sentence names the engine that goes first for choose
    const removed = within(pane()).getByText(/^问 .+：哪个展开的是正文？$/).closest("li")!;
    expect(within(removed).getByLabelText("删掉")).toBeTruthy();
    expect(removed.textContent).toContain("run[1].ask");
    const same = sentence("点击目标元素");
    expect(within(same).queryByLabelText(/新加|删掉|改了/)).toBeNull();
    expect(same.textContent).toContain("run[1].act");
  });
});

describe("draft pane: versions (R6.6)", () => {
  it("switches between v1 and v2, redrawing the markers for the version shown", async () => {
    const w = world([reply({ message: "v1", draft: V1 }), reply({ message: "v2", draft: V2 })]);
    view(w);
    await say("帮我展开全文");
    await within(pane()).findByText("草稿 v1");
    await say("只点正文那个");
    await within(pane()).findByText("草稿 v2");
    await waitFor(() => expect(marks(w)).toEqual(["A", "1", "2", "3"]));

    const versions = within(pane()).getByRole("radiogroup", { name: "草稿版本" });
    expect(within(versions).getByRole("radio", { name: "v2" }).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(within(versions).getByRole("radio", { name: "v1" }));
    await within(pane()).findByText("草稿 v1");
    expect(within(pane()).getByText(/你在看旧版 v1/)).toBeTruthy();
    await waitFor(() => expect(marks(w)).toEqual(["1", "2"]));
  });

  it("clears the markers when the panel closes", async () => {
    const w = world([reply({ message: "v1", draft: V2 })]);
    const r = view(w);
    await say("帮我展开全文");
    await waitFor(() => expect(marks(w)).toHaveLength(4));
    r.unmount();
    expect(marks(w)).toEqual([]);
  });
});

describe("draft pane: saving (R6.7)", () => {
  it("saves the current draft as a new local rule, then the panel counts it as saved", async () => {
    const w = world([reply({ message: "v1", draft: V2 })]);
    w.storage.set(LOCAL_RULES_KEY, JSON.stringify({ schema: 1, id: "local", features: [] }));
    view(w);
    await say("帮我展开全文");
    await within(pane()).findByText("草稿 v1");
    expect(within(pane()).getByText("存 v1，只新增这一条规则，不动别的")).toBeTruthy();
    expect(screen.getByText("新规则")).toBeTruthy();

    await userEvent.click(within(pane()).getByRole("button", { name: "存进本地规则" }));
    const saved = getFeature(w.storage.get<string>(LOCAL_RULES_KEY)!, "teach-auto-expand");
    expect(saved?.entries).toEqual(V2.entries);
    expect(w.storage.get(teachKey("teach-auto-expand"))).toBeTruthy();
    // markSaved: the panel header says 已存 and no unsaved record is left
    expect(await screen.findByText("已存")).toBeTruthy();
    expect(w.storage.get(UNSAVED_KEY)).toBeUndefined();
    expect(within(pane()).getByText("v1 已存进本地规则")).toBeTruthy();
  });

  it("saves the older version being viewed, and later saves only change that rule", async () => {
    const w = world([reply({ message: "v1", draft: V1 }), reply({ message: "v2", draft: V2 })]);
    view(w);
    await say("帮我展开全文");
    await within(pane()).findByText("草稿 v1");
    await say("只点正文那个");
    await within(pane()).findByText("草稿 v2");
    await userEvent.click(within(pane()).getByRole("radio", { name: "v1" }));
    await within(pane()).findByText("草稿 v1");
    await userEvent.click(within(pane()).getByRole("button", { name: "存进本地规则" }));
    expect(getFeature(w.storage.get<string>(LOCAL_RULES_KEY)!, "teach-auto-expand")?.entries).toEqual(V1.entries);

    await userEvent.click(within(pane()).getByRole("radio", { name: "v2" }));
    expect(await within(pane()).findByText("存 v2，只改这一条规则，不动别的")).toBeTruthy();
    await userEvent.click(within(pane()).getByRole("button", { name: "存进本地规则" }));
    const text = w.storage.get<string>(LOCAL_RULES_KEY)!;
    expect(JSON.parse(text).features).toHaveLength(1);
    expect(getFeature(text, "teach-auto-expand")?.entries).toEqual(V2.entries);
  });

  it("disables saving with the reason when the current draft fails validation, and does not dry-run it", async () => {
    const w = world([]);
    const saved: SavedConversation = {
      v: 1,
      turns: [{ id: "t1", at: 1, kind: "message", text: "帮我展开全文", attachments: [], base: 0, status: "done", reply: { message: "v1" }, version: 1 }],
      versions: [
        { n: 1, draft: V2, turn: "t1", at: 1 },
        { n: 2, draft: BAD, turn: "hand-edit", at: 2 },
      ],
      current: 2,
    };
    view(w, { saved });
    await within(pane()).findByText("草稿 v2");
    expect(within(pane()).getByText("没通过校验")).toBeTruthy();
    expect(within(pane()).getByText("你手改的")).toBeTruthy();
    expect(within(pane()).getByRole("button", { name: "存进本地规则" })).toHaveProperty("disabled", true);
    expect(within(pane()).getByText(/v2 没通过校验（entries\[0\]\.run\[0\]\.where/).textContent).toContain("不能存");
    expect(within(pane()).getByText(/没通过校验的草稿不能试运行/)).toBeTruthy();
    expect(marks(w)).toEqual([]);

    await userEvent.click(within(pane()).getByRole("radio", { name: "v1" }));
    await waitFor(() => expect(within(pane()).getByRole("button", { name: "存进本地规则" })).toHaveProperty("disabled", false));
  });
});

const rejectedScript = () => [reply({ message: "v1", draft: V2 }), ...Array.from({ length: 4 }, () => reply({ message: "加了一个触发", draft: BAD }))];

describe("turn footer: the repair rounds ran out (R6.5)", () => {
  it("shows the remaining errors with field paths, keeps the last good draft, and 让小猫再试 retries", async () => {
    const w = world(rejectedScript());
    view(w);
    await say("帮我展开全文");
    await within(pane()).findByText("草稿 v1");
    await say("评论里新加载的也要点开");
    const retry = await screen.findByRole("button", { name: "让小猫再试" });
    const bubble = retry.closest("div.rounded-2xl") as HTMLElement;
    expect(bubble.textContent).toContain("entries[0].run[0].where");
    expect(bubble.textContent).toContain("entries[0].run[1].target");
    expect(within(bubble).getByRole("button", { name: "自己改" })).toBeTruthy();
    // the draft side still shows the last draft that works
    expect(within(pane()).getByText("草稿 v1")).toBeTruthy();
    expect(within(pane()).getByText(/最新一版没通过校验/)).toBeTruthy();

    w.script.push(reply({ message: "修好了", draft: V1 }));
    const calls = w.invoke.mock.calls.length;
    await userEvent.click(retry);
    await within(pane()).findByText("草稿 v2");
    expect(w.invoke.mock.calls.length).toBe(calls + 1);
    expect(screen.queryByRole("button", { name: "让小猫再试" })).toBeNull();
  });

  it("自己改 puts the rejected draft into the local rules editor, unsaved, and closes the panel keeping the conversation", async () => {
    const w = world(rejectedScript());
    const before = JSON.stringify({ schema: 1, id: "local", features: [{ id: "mine", name: "我的", match: ["*://*/*"], entries: [] }] }, null, 2);
    w.storage.set(LOCAL_RULES_KEY, before);
    act(() => void openTeachPanel(w.ctx, { draftPane, turnFooter }));
    await say("帮我展开全文");
    await within(pane()).findByText("草稿 v1");
    await say("评论里新加载的也要点开");
    await userEvent.click(await screen.findByRole("button", { name: "自己改" }));

    expect(w.ctx.openSettings).toHaveBeenCalledWith("rules");
    expect(screen.queryByRole("dialog", { name: "教小猫做件事" })).toBeNull();
    expect(w.storage.get(UNSAVED_KEY)).toBeTruthy();
    expect(w.storage.get(LOCAL_RULES_KEY)).toBe(before);

    renderRules(w.storage);
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "本地规则 JSON" });
    const placed = JSON.parse(editor.value);
    expect(placed.features.map((f: { id: string }) => f.id)).toEqual(["mine", "teach-auto-expand"]);
    expect(placed.features[1].entries).toEqual(BAD.entries);
    expect(screen.getByText(/还没保存/)).toBeTruthy();
    // the editor points at what is wrong
    expect(screen.getAllByTestId("problem").some((p) => p.textContent!.includes("/features/1/entries/0/run/0/where"))).toBe(true);
    expect(w.storage.get(LOCAL_RULES_KEY)).toBe(before);
  });

  it("自己改 picks the id 存进本地规则 would: not one a deleted rule's off switch still holds", async () => {
    const w = world(rejectedScript());
    disable(w.storage, "local/teach-auto-expand"); // left by a deleted rule; the new one would start off
    act(() => void openTeachPanel(w.ctx, { draftPane, turnFooter }));
    await say("帮我展开全文");
    await within(pane()).findByText("草稿 v1");
    await say("评论里新加载的也要点开");
    await userEvent.click(await screen.findByRole("button", { name: "自己改" }));
    renderRules(w.storage);
    const placed = JSON.parse(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "本地规则 JSON" }).value);
    expect(placed.features.map((f: { id: string }) => f.id)).toEqual(["teach-auto-expand-2"]);
  });
});

function shellApi(storage: Storage): ShellApi {
  return {
    services: { storage, rules: staticRules(EMPTY_RESOLVED) },
    resolved: EMPTY_RESOLVED,
    subscribe: { run: vi.fn(), busy: false, error: null, available: true },
    narrow: false,
  } as unknown as ShellApi;
}

function renderRules(storage: Storage) {
  return render(
    <ShellCtx.Provider value={shellApi(storage)}>
      <TipProvider>
        <RulesPage />
      </TipProvider>
    </ShellCtx.Provider>,
  );
}

describe("local rules editor: opened with a draft (自己改)", () => {
  it("an open rules page switches to the editor with the text; saving there clears the not-saved hint", async () => {
    const storage = createStorage(createGmStorageFake().tab());
    renderRules(storage);
    expect(screen.queryByRole("textbox", { name: "本地规则 JSON" })).toBeNull();
    const { editLocalRules } = await import("../../pages/rules/RulesPage");
    const text = JSON.stringify({ schema: 1, id: "local", features: [V2] }, null, 2);
    act(() => editLocalRules(text));
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "本地规则 JSON" });
    expect(editor.value).toBe(text);
    expect(screen.getByText(/还没保存/)).toBeTruthy();
    expect(storage.get(LOCAL_RULES_KEY)).toBeUndefined();

    await userEvent.click(screen.getByRole("button", { name: "检查并保存" }));
    expect(storage.get(LOCAL_RULES_KEY)).toBe(text);
    expect(screen.queryByText(/还没保存/)).toBeNull();
  });
});
