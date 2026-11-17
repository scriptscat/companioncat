import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { createStorage, type Storage } from "../../platform/storage";
import { createSubscriptionManager, type FetchFn, type SubscriptionManager } from "../../core/subscriptions";
import { ShellCtx, type ShellApi } from "../../shell/context";
import { TipProvider } from "../../ui";
import { EMPTY_RESOLVED, staticRules } from "../../shell/services";
import { LOCAL_RULES_KEY, RulesPage } from "./RulesPage";

const TRANSLATE = {
  schema: 1,
  id: "official-translate",
  name: "官方翻译",
  version: "1.2.0",
  providers: [
    { id: "google", name: "Google 翻译", implements: {} },
    { id: "ms", name: "微软翻译", implements: {} },
  ],
  features: [
    {
      id: "translate",
      name: "翻译",
      match: ["*://*/*"],
      settings: { to: { type: "string", title: "译成", quick: true } },
      entries: [
        { id: "sel", name: "划词翻译", triggers: [{ on: "selection" }], run: [{ set: { to: "{{ settings.to }}" } }], present: { surface: { type: "near-selection" }, view: { type: "text", value: "x" } } },
      ],
    },
  ],
};
const OTHER = { schema: 1, id: "community", name: "社区规则", version: "0.3.0" };

type Route = { status: number; body?: unknown } | Error;
function setup(routes: Record<string, Route>, seedUrls: string[] = []) {
  const fake = createGmStorageFake();
  const storage: Storage = createStorage(fake.tab());
  const calls: string[] = [];
  let now = 1_700_000_000_000;
  const fetch: FetchFn = async (url) => {
    calls.push(url);
    const r = routes[url] ?? { status: 404 };
    if (r instanceof Error) throw r;
    return { status: r.status, headers: {}, text: r.body === undefined ? "" : JSON.stringify(r.body) };
  };
  const mgr: SubscriptionManager = createSubscriptionManager({ storage, fetch, now: () => now });
  return { storage, mgr, calls, seedUrls, tick: (ms: number) => (now += ms) };
}

async function subscribed(routes: Record<string, Route>, urls: string[]) {
  const s = setup(routes);
  for (const u of urls) await s.mgr.subscribe(u);
  return s;
}

function shellApi(storage: Storage): ShellApi {
  return {
    services: { storage, rules: staticRules(EMPTY_RESOLVED) },
    resolved: EMPTY_RESOLVED,
    bare: true,
    hostname: "x",
    prefs: {} as never,
    setPref: () => {},
    openSettings: () => {},
    closeSettings: () => {},
    closeBubble: () => {},
    subscribe: { run: vi.fn(), busy: false, error: null, available: true },
    narrow: false,
    root: document as never,
    layer: document.body,
  };
}

function renderPage(s: Awaited<ReturnType<typeof subscribed>>, clipboard = { writeText: vi.fn(async () => {}) }) {
  const user = userEvent.setup();
  const api = shellApi(s.storage);
  render(
    <ShellCtx.Provider value={api}>
      <TipProvider>
        <RulesPage subscriptions={s.mgr} clipboard={clipboard} />
      </TipProvider>
    </ShellCtx.Provider>,
  );
  return { user, clipboard, api };
}

const A = "https://a.test/translate.json";
const B = "https://b.test/community.json";
const ROUTES = { [A]: { status: 200, body: TRANSLATE }, [B]: { status: 200, body: OTHER } };

afterEach(() => vi.restoreAllMocks());

describe("rules page: subscriptions (R2.4, R2.7)", () => {
  it("shows the empty state with the subscribe button when nothing is subscribed", async () => {
    const s = await subscribed({}, []);
    const { user, api } = renderPage(s);
    expect(screen.getByText("还没有订阅任何规则")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "订阅官方规则" }));
    expect(api.subscribe.run).toHaveBeenCalled();
  });

  it("lists subscriptions in priority order with their contribution summary", async () => {
    const s = await subscribed(ROUTES, [A, B]);
    renderPage(s);
    const rows = screen.getAllByTestId("pack-row");
    expect(rows.map((r) => within(r).getByRole("button", { name: /详情/ }).getAttribute("aria-label"))).toEqual(["查看 社区规则 详情", "查看 官方翻译 详情"]);
    const row = rows[1]!;
    expect(within(row).getByText("1 个功能（1 个入口）")).toBeTruthy();
    expect(within(row).getByText("2 个引擎")).toBeTruthy();
    expect(within(row).getByText("1 个设置项")).toBeTruthy();
    expect(within(row).getByText("1 个气泡开关")).toBeTruthy();
  });

  it("subscribes to a pasted url and shows the failure reason when it is rejected", async () => {
    const s = await subscribed({ "https://bad.test/x.json": { status: 503 } }, []);
    const { user } = renderPage(s);
    await user.type(screen.getByLabelText("规则订阅地址"), "https://bad.test/x.json");
    await user.click(screen.getByRole("button", { name: "订阅" }));
    expect((await screen.findByRole("alert")).textContent).toContain("503");
  });

  it("checks one subscription for updates from its menu", async () => {
    const s = await subscribed(ROUTES, [A, B]);
    const { user } = renderPage(s);
    s.calls.length = 0;
    await user.click(screen.getByRole("button", { name: "官方翻译 的更多操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "检查更新" }));
    await waitFor(() => expect(s.calls).toEqual([A]));
  });

  it("moves a subscription up or down and disables the impossible moves", async () => {
    const s = await subscribed(ROUTES, [A, B]); // order: community, official-translate
    const { user } = renderPage(s);
    await user.click(screen.getByRole("button", { name: "社区规则 的更多操作" }));
    expect(screen.getByRole("menuitem", { name: "调高优先级" }).getAttribute("aria-disabled")).toBe("true");
    await user.click(screen.getByRole("menuitem", { name: "调低优先级" }));
    await waitFor(() => expect(s.mgr.list().map((x) => x.id)).toEqual(["official-translate", "community"]));
    expect(screen.getAllByTestId("pack-row")[0]?.textContent).toContain("官方翻译");
  });

  it("copies the subscription url through the injected clipboard", async () => {
    const s = await subscribed(ROUTES, [A]);
    const { user, clipboard } = renderPage(s);
    await user.click(screen.getByRole("button", { name: "官方翻译 的更多操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "复制订阅地址" }));
    expect(clipboard.writeText).toHaveBeenCalledWith(A);
  });

  it("unsubscribes and drops the row", async () => {
    const s = await subscribed(ROUTES, [A, B]);
    const { user } = renderPage(s);
    await user.click(screen.getByRole("button", { name: "社区规则 的更多操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "取消订阅" }));
    await waitFor(() => expect(screen.getAllByTestId("pack-row")).toHaveLength(1));
    expect(s.mgr.get("community")).toBeUndefined();
  });

  it("shows the update-failed state with the reason and the last good version (R2.3)", async () => {
    const routes: Record<string, Route> = { ...ROUTES };
    const s = await subscribed(routes, [A]);
    routes[A] = { status: 502 };
    const { user } = renderPage(s);
    await user.click(screen.getByRole("button", { name: "官方翻译 的更多操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "检查更新" }));
    const note = await screen.findByText(/最近一次更新失败/);
    expect(note.textContent).toContain("502");
    expect(note.textContent).toContain("1.2.0");
    await user.click(screen.getByRole("button", { name: "官方翻译 的更多操作" }));
    expect(await screen.findByRole("menuitem", { name: "重试更新" })).toBeTruthy();
  });

  it("opens a detail page listing each contribution with the raw rule text (R2.7), and goes back", async () => {
    const s = await subscribed(ROUTES, [A]);
    const { user } = renderPage(s);
    await user.click(screen.getByRole("button", { name: "查看 官方翻译 详情" }));
    expect(screen.getByText("划词翻译")).toBeTruthy();
    expect(screen.getByText("Google 翻译")).toBeTruthy();
    expect(screen.getByText("微软翻译")).toBeTruthy();
    expect(screen.getByText("译成")).toBeTruthy();
    const raw = screen.getByTestId("raw-rules");
    expect(JSON.parse(raw.textContent!)).toEqual(TRANSLATE);
    await user.click(screen.getByRole("button", { name: "全部规则" }));
    expect(screen.getByLabelText("规则订阅地址")).toBeTruthy();
  });
});

describe("rules page: local rules editor (R3.2, R3.3)", () => {
  const HEAD = `{\n  "schema": 1,\n  "id": "local",\n  "name": "本地规则",`;
  const EXPR_ERR = `${HEAD}
  "features": [{
    "id": "demo", "name": "示例", "match": ["*://*/*"],
    "entries": [{
      "id": "sel", "name": "划词",
      "triggers": [{ "on": "selection" }],
      "run": [{ "set": { "to": "{{ settings.to + }}" } }],
      "present": { "surface": { "type": "near-selection" }, "view": { "type": "text", "value": "{{ vars.to }}" } }
    }]
  }]
}`;

  async function openEditor(text?: string) {
    const s = await subscribed(ROUTES, [A]);
    if (text !== undefined) s.storage.set(LOCAL_RULES_KEY, text);
    const r = renderPage(s);
    await r.user.click(screen.getByRole("button", { name: /编辑本地规则/ }));
    const box = screen.getByLabelText("本地规则 JSON") as HTMLTextAreaElement;
    return { ...s, ...r, box };
  }
  const setText = (box: HTMLTextAreaElement, text: string) => {
    // fireEvent-free: userEvent.paste avoids parsing braces as key descriptors
    return userEvent.setup().clear(box).then(() => userEvent.setup().click(box)).then(() => userEvent.setup().paste(text));
  };

  it("loads the stored text and shows one line number per line", async () => {
    const { box } = await openEditor(EXPR_ERR);
    expect(box.value).toBe(EXPR_ERR);
    expect(screen.getByTestId("line-numbers").textContent).toBe(EXPR_ERR.split("\n").map((_, i) => i + 1).join("\n"));
  });

  it("saves rules with expression errors, listing line, path, expression and caret", async () => {
    const { box, user, storage } = await openEditor("");
    await setText(box, EXPR_ERR);
    await user.click(screen.getByRole("button", { name: "检查并保存" }));
    expect(storage.get(LOCAL_RULES_KEY)).toBe(EXPR_ERR);
    const item = screen.getByTestId("problem");
    expect(item.textContent).toContain("第 10 行");
    expect(item.textContent).toContain("/features/0/entries/0/run/0/set/to");
    expect(screen.getByTestId("problem-expr").textContent).toBe("{{ settings.to + }}");
    const caret = screen.getByTestId("problem-caret").textContent!;
    expect(caret).toMatch(/^ +\^+$/);
    expect(screen.getByRole("status").textContent).toContain("已保存");
  });

  it("does not save when the JSON is invalid and lists the syntax error", async () => {
    const { box, user, storage } = await openEditor();
    await setText(box, `{\n  "schema": 1,\n  "id": "local"\n  "name": "x"\n}`);
    await user.click(screen.getByRole("button", { name: "检查并保存" }));
    expect(storage.get(LOCAL_RULES_KEY)).toBeUndefined();
    expect(screen.getByTestId("problem").textContent).toContain("第 4 行");
    expect(screen.getByRole("status").textContent).toContain("没有保存");
  });

  it("warns about key-like literals but still saves (R3.3)", async () => {
    const text = `${HEAD}\n  "providers": [{ "id": "k", "name": "k", "implements": {}, "options": { "token": { "type": "string", "title": "t", "default": "sk-abcdefghijklmnopqrstuvwx" } } }]\n}`;
    const { box, user, storage } = await openEditor();
    await setText(box, text);
    await user.click(screen.getByRole("button", { name: "检查并保存" }));
    expect(screen.getByTestId("problem").textContent).toContain("API Key 请在引擎页面填写");
    expect(storage.get(LOCAL_RULES_KEY)).toBe(text);
  });

  it("formats valid JSON without changing its content, and leaves invalid text alone", async () => {
    const { box, user } = await openEditor();
    await setText(box, `{"schema":1,"id":"local","name":"x"}`);
    await user.click(screen.getByRole("button", { name: "整理格式" }));
    expect(box.value).toBe(JSON.stringify({ schema: 1, id: "local", name: "x" }, null, 2));
    await setText(box, `{"a":`);
    await user.click(screen.getByRole("button", { name: "整理格式" }));
    expect(box.value).toBe(`{"a":`);
    expect(screen.getByTestId("problem")).toBeTruthy();
  });

  it("clearing the text removes the local rules", async () => {
    const { box, user, storage } = await openEditor(EXPR_ERR);
    await user.clear(box);
    await user.click(screen.getByRole("button", { name: "检查并保存" }));
    expect(storage.get(LOCAL_RULES_KEY)).toBeUndefined();
    expect(screen.getByRole("status").textContent).toContain("已保存");
  });
});
