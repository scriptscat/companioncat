import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { installGmHttp, type Recorded, type FakeGm } from "../../../test/fakes/gm-http";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { createStorage } from "../../platform/storage";
import { createSecretStore } from "../../core/stores";
import { createConfirmHost } from "./confirm";
import { resolveRules } from "../../core/rules";
import { OFFICIAL_PACKS, official, renderEngines } from "./harness";
import { createInvoker } from "../../core/invoke";
import { testAndSave } from "./keys";
import { LOCAL_RULES_KEY } from "../rules/RulesPage";

let fake: FakeGm | undefined;
afterEach(() => {
  cleanup();
  fake?.restore();
  fake = undefined;
  document.body.innerHTML = "";
});

// recording() resolves fixtures through import.meta.url, which jsdom breaks; read the file directly.
const recording = (name: string): Recorded[] => JSON.parse(readFileSync(`test/fixtures/recorded/${name}.json`, "utf8")).exchanges;

const KEY = "sk-4b1e9c07d2a64f3f2a";
const DEEPSEEK = "official-llm/deepseek";
const row = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const seed = (fn: () => void) => act(fn);
const secretsOf = (r: ReturnType<typeof renderEngines>) => createSecretStore(r.storage, () => r.resolved);

describe("engine list (R5.5)", () => {
  it("groups engines into 可以用 / 填上 API Key 就能用 / 有问题", () => {
    renderEngines();
    const group = (title: string) => within(screen.getByRole("group", { name: title }));
    expect(group("可以用").getByText("Google 翻译")).toBeTruthy();
    expect(group("可以用").getByText("微软翻译")).toBeTruthy();
    expect(group("可以用").queryByText("DeepSeek")).toBeNull();
    expect(group("填上 API Key 就能用").getByText("DeepSeek")).toBeTruthy();
    expect(group("填上 API Key 就能用").getByText("Jev")).toBeTruthy();
    expect(group("有问题").getByText("孤儿引擎")).toBeTruthy();
    expect(group("有问题").getByText("继承的 nowhere/none 找不到")).toBeTruthy();
  });

  it("shows an engine in 可以用 when its key was saved earlier", () => {
    const base = official();
    const storage = createStorage(createGmStorageFake().tab());
    createSecretStore(storage, () => base).set(DEEPSEEK, "apiKey", KEY, ["api.deepseek.com"]);
    renderEngines(base, { storage });
    expect(within(screen.getByRole("group", { name: "可以用" })).getByText("DeepSeek")).toBeTruthy();
  });

  it("R13.4 首次打开: before any key is filled, the page welcomes and offers the first keyed engine", async () => {
    const user = userEvent.setup();
    renderEngines(official(false));
    expect(screen.getByText("选中网页上的文字，就能翻译")).toBeTruthy();
    expect(screen.getByText(/Google 翻译和微软翻译现在就能用/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "给 DeepSeek 填 Key" }));
    expect(screen.getByRole("heading", { name: "DeepSeek" })).toBeTruthy();
  });

  it("once a key is filled the empty detail just asks to pick an engine", () => {
    const base = official(false);
    const storage = createStorage(createGmStorageFake().tab());
    createSecretStore(storage, () => base).set(DEEPSEEK, "apiKey", KEY, ["api.deepseek.com"]);
    renderEngines(base, { storage });
    expect(screen.getByText("选一个引擎查看设置")).toBeTruthy();
    expect(screen.queryByText("选中网页上的文字，就能翻译")).toBeNull();
  });

  it("narrow: shows the list first, the detail with a way back after picking", async () => {
    const user = userEvent.setup();
    renderEngines(official(), { narrow: true });
    expect(screen.queryByRole("heading", { name: "Google 翻译" })).toBeNull();
    await user.click(row("Google 翻译"));
    expect(screen.getByRole("heading", { name: "Google 翻译" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /全部引擎/ }));
    expect(screen.getByRole("group", { name: "可以用" })).toBeTruthy();
  });
});

describe("engine detail (R5.5)", () => {
  it("R2.6: a problem engine without implements opens its detail with the reason", async () => {
    const user = userEvent.setup();
    renderEngines();
    await user.click(row("孤儿引擎"));
    expect(screen.getByRole("heading", { name: "孤儿引擎" })).toBeTruthy();
    expect(screen.getAllByText(/继承的 nowhere\/none 找不到/).length).toBeGreaterThan(0);
  });

  it("R5.4: an engine whose only implementation is an unsupported builtin is listed under 有问题 with the reason", async () => {
    const user = userEvent.setup();
    const local = { schema: 1, id: "mine", name: "我的规则", version: "1.0.0", providers: [{ id: "b", name: "内置引擎", hosts: ["b.test"], implements: { translate: { builtin: "deepl" } } }] };
    renderEngines(resolveRules([...OFFICIAL_PACKS, { pack: local, local: true }] as never));
    const problems = within(screen.getByRole("group", { name: "有问题" }));
    expect(problems.getByText("内置引擎")).toBeTruthy();
    expect(problems.getByText("这个版本的陪伴猫不支持这个内置适配器")).toBeTruthy();
    await user.click(row("内置引擎"));
    expect(screen.getByText(/这个版本的陪伴猫不支持这个内置适配器。/)).toBeTruthy();
    expect(screen.queryByTestId("engine-trace-slot")).toBeNull();
  });

  it("R9.12/R10.5: an engine:<ref> target opens that engine's detail", () => {
    renderEngines(official(), { target: `engine:${DEEPSEEK}` });
    expect(screen.getByRole("heading", { name: "DeepSeek" })).toBeTruthy();
  });

  it("the registered page passes an engine:<ref> target through (R9.12)", () => {
    renderEngines(official(), { target: `engine:${DEEPSEEK}`, registered: true });
    expect(screen.getByRole("heading", { name: "DeepSeek" })).toBeTruthy();
  });

  it("R2.6: an engine whose rule has no name is listed (by its id) and opens instead of crashing the page", async () => {
    const user = userEvent.setup();
    const local = { schema: 1, id: "local", providers: [{ id: "nameless", implements: {} }] };
    renderEngines(resolveRules([...OFFICIAL_PACKS, { pack: local, local: true }] as never));
    const problems = within(screen.getByRole("group", { name: "有问题" }));
    expect(problems.getByText("nameless")).toBeTruthy();
    await user.click(row("nameless"));
    expect(screen.getByRole("heading", { name: "nameless" })).toBeTruthy();
  });

  it("lists capabilities and marks the ones a large model does", async () => {
    const user = userEvent.setup();
    renderEngines();
    await user.click(row("DeepSeek"));
    const caps = within(screen.getByRole("region", { name: "能做什么" }));
    expect(caps.getByText("翻译").closest("li")!.textContent).toContain("由大模型完成");
    expect(caps.getByText("对话").closest("li")!.textContent).not.toContain("由大模型完成");
  });

  it("shows rule details: id, parent, request host", async () => {
    const user = userEvent.setup();
    renderEngines();
    await user.click(row("DeepSeek"));
    const d = within(screen.getByRole("region", { name: "规则详情" }));
    expect(d.getByText(DEEPSEEK)).toBeTruthy();
    expect(d.getByText("official-llm/openai-compatible")).toBeTruthy();
    expect(await d.findByText("api.deepseek.com")).toBeTruthy();
  });

  it("leaves a named slot for the trial run panel (task 15)", async () => {
    const user = userEvent.setup();
    renderEngines();
    await user.click(row("Google 翻译"));
    expect(screen.getByTestId("engine-trace-slot")).toBeTruthy();
  });

  it("the 启用 switch stops and resumes the engine", async () => {
    const user = userEvent.setup();
    const r = renderEngines();
    await user.click(row("Google 翻译"));
    const toggle = screen.getByRole("switch", { name: "启用" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    expect(secretsOf(r).isDisabled("official-translate/google")).toBe(true);
    await user.click(screen.getByRole("switch", { name: "启用" }));
    expect(secretsOf(r).isDisabled("official-translate/google")).toBe(false);
  });
});

describe("options form (R5.5 local overrides)", () => {
  const localText = (r: { storage: { get<T>(k: string): T | undefined } }) => r.storage.get<string>(LOCAL_RULES_KEY);
  const resolvedModel = (text: string) =>
    resolveRules([...OFFICIAL_PACKS, { pack: JSON.parse(text), local: true }] as never).providers.find((p) => p.ref === DEEPSEEK)!.def.options!.model!.default;

  it("writes changes as local overrides that resolve to the new value, and restores the official ones", async () => {
    const user = userEvent.setup();
    const r = renderEngines();
    await user.click(row("DeepSeek"));
    expect(screen.queryByRole("button", { name: "恢复官方设置" })).toBeNull();
    const model = screen.getByRole("textbox", { name: "使用的模型" }) as HTMLInputElement;
    expect(model.value).toBe("deepseek-chat");
    await user.clear(model);
    await user.type(model, "deepseek-reasoner");
    expect(JSON.parse(localText(r)!)).toEqual({ schema: 1, id: "local", overrides: { [DEEPSEEK]: { options: { model: { default: "deepseek-reasoner" } } } } });
    expect(resolvedModel(localText(r)!)).toBe("deepseek-reasoner");
    await user.click(screen.getByRole("radio", { name: "Responses" }));
    expect(JSON.parse(localText(r)!).overrides[DEEPSEEK].options).toEqual({ model: { default: "deepseek-reasoner" }, api: { default: "responses" } });
    await user.click(screen.getByRole("button", { name: "恢复官方设置" }));
    expect(localText(r)).toBeUndefined();
    expect((screen.getByRole("textbox", { name: "使用的模型" }) as HTMLInputElement).value).toBe("deepseek-chat");
  });

  it("falls back to the official value when a field is emptied", async () => {
    const user = userEvent.setup();
    const r = renderEngines();
    await user.click(row("DeepSeek"));
    const model = screen.getByRole("textbox", { name: "使用的模型" });
    await user.type(model, "x");
    await user.clear(model);
    expect(localText(r)).toBeUndefined();
  });

  it("leaves other local content alone, also when restoring", async () => {
    const user = userEvent.setup();
    const storage = createStorage(createGmStorageFake().tab());
    const other = { schema: 1, id: "local", name: "我的规则", providers: [{ id: "deep2", name: "x", extends: "official-llm/deepseek" }], overrides: { "official-llm/glm": { name: "智谱" }, [DEEPSEEK]: { name: "DS" } } };
    storage.set(LOCAL_RULES_KEY, JSON.stringify(other));
    renderEngines(official(), { storage });
    await user.click(row("DeepSeek"));
    await user.type(screen.getByRole("textbox", { name: "使用的模型" }), "2");
    expect(JSON.parse(storage.get<string>(LOCAL_RULES_KEY)!)).toEqual({ ...other, overrides: { ...other.overrides, [DEEPSEEK]: { name: "DS", options: { model: { default: "deepseek-chat2" } } } } });
    await user.click(screen.getByRole("button", { name: "恢复官方设置" }));
    expect(JSON.parse(storage.get<string>(LOCAL_RULES_KEY)!)).toEqual(other);
  });

  it("does not overwrite local rules that are not valid JSON, and says so", async () => {
    const user = userEvent.setup();
    const storage = createStorage(createGmStorageFake().tab());
    storage.set(LOCAL_RULES_KEY, "{ not json");
    renderEngines(official(), { storage });
    await user.click(row("DeepSeek"));
    await user.type(screen.getByRole("textbox", { name: "使用的模型" }), "2");
    expect(storage.get(LOCAL_RULES_KEY)).toBe("{ not json");
    expect(screen.getByText(/本地规则不是合法的 JSON/)).toBeTruthy();
  });
});

describe("shared key (R5.6)", () => {
  it("says it uses the parent's key and links to the parent", async () => {
    const user = userEvent.setup();
    renderEngines();
    await user.click(row("我的 DeepSeek"));
    expect(screen.getByText(/直接用「DeepSeek」的 Key/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "测试并保存" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "改 DeepSeek 的 Key" }));
    expect(screen.getByRole("heading", { name: "DeepSeek" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "测试并保存" })).toBeTruthy();
  });
});

describe("key declared by an abstract parent (R5.6)", () => {
  it("lets the user fill the shared key from a child, and saves it where every child reads it", async () => {
    const user = userEvent.setup();
    fake = installGmHttp([{ method: "GET", url: "https://a.test/t", status: 401, json: { error: "bad" }, repeat: true }]);
    const impl = { translate: { http: { request: { method: "GET", url: "https://a.test/t" }, output: { texts: "{{ [response.t] }}" } } } };
    const resolved = resolveRules([
      ...OFFICIAL_PACKS,
      {
        pack: {
          schema: 1,
          id: "p",
          name: "p",
          version: "1.0.0",
          providers: [
            { id: "base", name: "Base", abstract: true, hosts: ["a.test"], secrets: [{ name: "apiKey", title: "API Key" }], implements: impl },
            { id: "kid", extends: "base", name: "Kid", abstract: false },
            { id: "twin", extends: "base", name: "Twin", abstract: false },
          ],
        },
        local: true,
      },
    ] as never);
    const r = renderEngines(resolved);
    await user.click(row("Kid"));
    await user.type(screen.getByLabelText("API Key"), KEY);
    await user.click(screen.getByRole("button", { name: "测试并保存" }));
    await screen.findByText(/认证（401\/403）/);
    await user.click(screen.getByRole("button", { name: "不测试，直接保存" }));
    const s = secretsOf(r);
    expect(s.get("p/twin", "apiKey")).toBe(KEY);
    expect(s.isHostConfirmed("p/twin", "a.test")).toBe(true);
    await user.click(screen.getByRole("button", { name: "删除 Key" }));
    expect(s.get("p/twin", "apiKey")).toBeUndefined();
  });
});

describe("filling a key (R7.1, R7.2)", () => {
  it("shows the two-step guidance with the help link and the privacy note", async () => {
    const user = userEvent.setup();
    renderEngines();
    await user.click(row("DeepSeek"));
    const link = screen.getByRole("link", { name: /DeepSeek 开放平台/ });
    expect(link.getAttribute("href")).toBe("https://platform.deepseek.com/api_keys");
    expect(screen.getByText(/复制后粘贴到下面，点「测试并保存」/)).toBeTruthy();
    expect(screen.getByText(/Key 只存在这台电脑上，只会发给/).textContent).toContain("api.deepseek.com");
    const input = screen.getByLabelText("API Key") as HTMLInputElement;
    expect(input.type).toBe("password");
    await user.click(screen.getByRole("button", { name: "显示 Key" }));
    expect(input.type).toBe("text");
  });

  it("test passes: saves the key, records the host, enables the engine and shows the sample", async () => {
    const user = userEvent.setup();
    fake = installGmHttp(recording("openai-chat-sse"));
    const r = renderEngines();
    seed(() => secretsOf(r).setDisabled(DEEPSEEK, true));
    await user.click(row("DeepSeek"));
    await user.type(screen.getByLabelText("API Key"), KEY);
    await user.click(screen.getByRole("button", { name: "测试并保存" }));
    expect(await screen.findByText(/测试通过，用时/)).toBeTruthy();
    expect(screen.getByText(/你好！我是一个助手。/)).toBeTruthy();
    const s = secretsOf(r);
    expect(s.get(DEEPSEEK, "apiKey")).toBe(KEY);
    expect(s.hostsConfirmed(DEEPSEEK)).toEqual(["api.deepseek.com"]);
    expect(s.isDisabled(DEEPSEEK)).toBe(false);
    expect(fake.calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(screen.queryByText(KEY)).toBeNull();
  });

  it("test fails: nothing is saved, the error type and provider hint show, save-anyway offered", async () => {
    const user = userEvent.setup();
    fake = installGmHttp([{ method: "POST", url: "https://api.deepseek.com/v1/chat/completions", status: 401, json: { error: "bad" }, repeat: true }]);
    const r = renderEngines();
    await user.click(row("DeepSeek"));
    await user.type(screen.getByLabelText("API Key"), KEY);
    await user.click(screen.getByRole("button", { name: "测试并保存" }));
    const err = await screen.findByText(/认证（401\/403）/);
    expect(err.textContent).toContain("这个 Key 无效或已过期");
    expect(err.textContent).toContain("401");
    const s = secretsOf(r);
    expect(s.get(DEEPSEEK, "apiKey")).toBeUndefined();
    expect(s.hostsConfirmed(DEEPSEEK)).toEqual([]);
    expect(s.isDisabled(DEEPSEEK)).toBe(false);
    await user.click(screen.getByRole("button", { name: "不测试，直接保存" }));
    expect(s.get(DEEPSEEK, "apiKey")).toBe(KEY);
    expect(s.hostsConfirmed(DEEPSEEK)).toEqual(["api.deepseek.com"]);
    expect(screen.queryByRole("button", { name: "不测试，直接保存" })).toBeNull();
  });

  it("a re-test reaches the service: a translate engine's test is never answered from the result cache", async () => {
    let calls = 0;
    fake = installGmHttp([
      {
        url: "https://k.test/t",
        repeat: true,
        respond: () => (++calls === 1 ? { json: { texts: ["好"] } } : { status: 401, json: { error: "bad" } }),
      },
    ]);
    const keyed = {
      schema: 1,
      id: "mine",
      name: "我的规则",
      version: "1.0.0",
      providers: [
        {
          id: "k",
          name: "带 Key 的翻译",
          secrets: [{ name: "apiKey", title: "API Key" }],
          hosts: ["k.test"],
          implements: {
            translate: {
              http: {
                request: { method: "POST", url: "https://k.test/t", json: { texts: "{{ input.texts }}" } },
                response: "json",
                output: { texts: "{{ response.texts }}" },
              },
            },
          },
        },
      ],
    };
    const resolved = resolveRules([...OFFICIAL_PACKS, { pack: keyed, local: true }] as never);
    const storage = createStorage(createGmStorageFake().tab());
    const secrets = createSecretStore(storage, () => resolved);
    const invoker = createInvoker({ rules: () => resolved, secrets });
    const p = resolved.providers.find((x) => x.def.name === "带 Key 的翻译")!;
    expect(p.enabled).toBe(true);
    const deps = { secrets, invoker, contracts: resolved.contracts };
    expect((await testAndSave(p, { apiKey: "sk-good-000000000000" }, deps)).ok).toBe(true);
    const again = await testAndSave(p, { apiKey: "sk-wrong-00000000000" }, deps);
    expect(again.ok).toBe(false);
    expect(fake.calls).toHaveLength(2);
    expect(secrets.get(p.ref, "apiKey")).toBe("sk-good-000000000000");
  });

  it("the typed key is never written into a DOM attribute", async () => {
    const user = userEvent.setup();
    renderEngines();
    await user.click(row("DeepSeek"));
    const input = screen.getByLabelText("API Key");
    await user.type(input, KEY);
    expect(input.outerHTML).not.toContain(KEY);
    expect(screen.getByRole("button", { name: "测试并保存" }).hasAttribute("disabled")).toBe(false);
  });

  it("a test that throws (not a CallError) stores nothing and says so", async () => {
    const r = renderEngines();
    const secrets = secretsOf(r);
    act(() => secrets.setDisabled(DEEPSEEK, true));
    const p = r.resolved.providers.find((x) => x.ref === DEEPSEEK)!;
    const invoker = { invoke: async () => { throw new Error("boom"); } } as never;
    const out = await testAndSave(p, { apiKey: KEY }, { secrets, invoker, contracts: r.resolved.contracts });
    expect(out.ok).toBe(false);
    expect(secrets.get(DEEPSEEK, "apiKey")).toBeUndefined();
    expect(secrets.isDisabled(DEEPSEEK)).toBe(true);
  });

  it("a passing test whose output is empty shows the result instead of crashing", async () => {
    const user = userEvent.setup();
    const invoker = { invoke: async () => ({ ok: true, output: undefined, results: [] }), preferredEngines: () => ({ engines: [] }) } as never;
    renderEngines(official(), { services: { invoker } });
    await user.click(row("DeepSeek"));
    await user.type(screen.getByLabelText("API Key"), KEY);
    await user.click(screen.getByRole("button", { name: "测试并保存" }));
    expect(await screen.findByText(/测试通过，用时/)).toBeTruthy();
    expect(screen.getByText(/输出：/)).toBeTruthy();
  });

  it("a failed re-test keeps the previously saved key", async () => {
    const user = userEvent.setup();
    fake = installGmHttp([{ method: "POST", url: "https://api.deepseek.com/v1/chat/completions", status: 401, repeat: true }]);
    const r = renderEngines();
    seed(() => secretsOf(r).set(DEEPSEEK, "apiKey", "old-key-0000000000", ["api.deepseek.com"]));
    await user.click(row("DeepSeek"));
    await user.type(screen.getByLabelText("API Key"), KEY);
    await user.click(screen.getByRole("button", { name: "测试并保存" }));
    await screen.findByText(/认证（401\/403）/);
    expect(secretsOf(r).get(DEEPSEEK, "apiKey")).toBe("old-key-0000000000");
  });
});

describe("test-and-save of a streaming engine through ScriptCat's GM_xmlhttpRequest (R7.2, R5.2)", () => {
  const CHAT = "https://api.deepseek.com/v1/chat/completions";
  const gate = () => {
    let open!: () => void;
    const wait = new Promise<void>((r) => (open = r));
    return { wait, open };
  };
  const group = (title: string) => within(screen.getByRole("group", { name: title }));

  /** While the test request is in flight: nothing is stored, the engine is not usable yet. */
  async function inFlight(r: ReturnType<typeof renderEngines>) {
    await waitFor(() => expect(fake!.calls).toHaveLength(1));
    expect(fake!.calls[0]!).toMatchObject({ url: CHAT, responseType: "stream" });
    expect(screen.getByRole("button", { name: "正在测试" })).toBeTruthy();
    const s = secretsOf(r);
    expect(s.get(DEEPSEEK, "apiKey")).toBeUndefined();
    expect(s.hostsConfirmed(DEEPSEEK)).toEqual([]);
    expect(s.isDisabled(DEEPSEEK)).toBe(true);
    expect(screen.queryByText(/已保存/)).toBeNull();
    expect(group("可以用").queryByText("DeepSeek")).toBeNull();
  }

  it("a 401 on the stream fails promptly as auth and stores nothing", async () => {
    const user = userEvent.setup();
    const g = gate();
    fake = installGmHttp([
      { method: "POST", url: CHAT, status: 401, headers: { "content-type": "application/json" }, json: { error: { message: "Incorrect API key provided" } }, wait: g.wait },
    ]);
    const r = renderEngines();
    seed(() => secretsOf(r).setDisabled(DEEPSEEK, true));
    await user.click(row("DeepSeek"));
    await user.type(screen.getByLabelText("API Key"), KEY);
    await user.click(screen.getByRole("button", { name: "测试并保存" }));
    await inFlight(r);
    g.open();
    const err = await screen.findByText(/认证（401\/403）/, {}, { timeout: 1000 });
    expect(err.textContent).toContain("这个 Key 无效或已过期");
    expect(screen.getByRole("button", { name: "测试并保存" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "不测试，直接保存" })).toBeTruthy();
    const s = secretsOf(r);
    expect(s.get(DEEPSEEK, "apiKey")).toBeUndefined();
    expect(s.hostsConfirmed(DEEPSEEK)).toEqual([]);
    expect(s.isDisabled(DEEPSEEK)).toBe(true);
    expect(group("填上 API Key 就能用").getByText("DeepSeek")).toBeTruthy();
  });

  it("a streamed answer passes the test, and only then is the key stored, its host confirmed and the engine enabled", async () => {
    const user = userEvent.setup();
    const g = gate();
    fake = installGmHttp(recording("openai-chat-sse").map((x) => ({ ...x, wait: g.wait })), { chunkSize: 24 });
    const r = renderEngines();
    seed(() => secretsOf(r).setDisabled(DEEPSEEK, true));
    await user.click(row("DeepSeek"));
    await user.type(screen.getByLabelText("API Key"), KEY);
    await user.click(screen.getByRole("button", { name: "测试并保存" }));
    await inFlight(r);
    g.open();
    expect(await screen.findByText(/测试通过，用时/, {}, { timeout: 1000 })).toBeTruthy();
    expect(screen.getByText(/你好！我是一个助手。/)).toBeTruthy();
    const s = secretsOf(r);
    expect(s.get(DEEPSEEK, "apiKey")).toBe(KEY);
    expect(s.hostsConfirmed(DEEPSEEK)).toEqual(["api.deepseek.com"]);
    expect(s.isDisabled(DEEPSEEK)).toBe(false);
    expect(group("可以用").getByText("DeepSeek")).toBeTruthy();
    expect(fake.calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("a failed re-test keeps the old key, also while it runs", async () => {
    const user = userEvent.setup();
    const g = gate();
    fake = installGmHttp([{ method: "POST", url: CHAT, status: 401, json: { error: "bad" }, wait: g.wait }]);
    const r = renderEngines();
    seed(() => secretsOf(r).set(DEEPSEEK, "apiKey", "old-key-0000000000", ["api.deepseek.com"]));
    await user.click(row("DeepSeek"));
    await user.type(screen.getByLabelText("API Key"), KEY);
    await user.click(screen.getByRole("button", { name: "测试并保存" }));
    await waitFor(() => expect(fake!.calls).toHaveLength(1));
    expect(secretsOf(r).get(DEEPSEEK, "apiKey")).toBe("old-key-0000000000");
    expect(screen.getByText("已保存：old••••••••0000")).toBeTruthy();
    g.open();
    await screen.findByText(/认证（401\/403）/, {}, { timeout: 1000 });
    expect(secretsOf(r).get(DEEPSEEK, "apiKey")).toBe("old-key-0000000000");
    expect(secretsOf(r).hostsConfirmed(DEEPSEEK)).toEqual(["api.deepseek.com"]);
  });

  it("leaving the engine mid-test stops that test: it neither saves its key nor overwrites a key tested after it", async () => {
    const user = userEvent.setup();
    const g = gate();
    const [chat] = recording("openai-chat-sse");
    fake = installGmHttp([{ ...chat!, wait: g.wait }, chat!]);
    const r = renderEngines();
    seed(() => secretsOf(r).setDisabled(DEEPSEEK, true));
    await user.click(row("DeepSeek"));
    await user.type(screen.getByLabelText("API Key"), "sk-first-0000000000");
    await user.click(screen.getByRole("button", { name: "测试并保存" }));
    await waitFor(() => expect(fake!.calls).toHaveLength(1));
    // away and back: a fresh panel, and the first test is still out there
    await user.click(row("Google 翻译"));
    expect(fake.aborted).toBe(1);
    await user.click(row("DeepSeek"));
    await user.type(screen.getByLabelText("API Key"), KEY);
    await user.click(screen.getByRole("button", { name: "测试并保存" }));
    expect(await screen.findByText(/测试通过，用时/, {}, { timeout: 1000 })).toBeTruthy();
    g.open();
    await new Promise((res) => setTimeout(res, 50));
    expect(secretsOf(r).get(DEEPSEEK, "apiKey")).toBe(KEY);
  });
});

describe("deleting a key (R7.3)", () => {
  it("shows the key masked, deletes it and stops the engine", async () => {
    const user = userEvent.setup();
    const r = renderEngines();
    seed(() => secretsOf(r).set(DEEPSEEK, "apiKey", KEY, ["api.deepseek.com"]));
    await user.click(row("DeepSeek"));
    expect(screen.getByText(/sk-••••••••3f2a/)).toBeTruthy();
    expect(screen.queryByText(KEY)).toBeNull();
    await user.click(screen.getByRole("button", { name: "删除 Key" }));
    expect(secretsOf(r).get(DEEPSEEK, "apiKey")).toBeUndefined();
    expect(secretsOf(r).isDisabled(DEEPSEEK)).toBe(true);
    expect(screen.getByLabelText("API Key")).toBeTruthy();
  });
});

describe("domain confirmation dialog (R7.4)", () => {
  const provider = () => official().providers.find((p) => p.ref === DEEPSEEK)!;
  const ask = (layer: HTMLElement, versions?: Parameters<typeof createConfirmHost>[1]) =>
    createConfirmHost(layer, versions)({ provider: provider(), hosts: ["api.glm-proxy.example.net"], confirmed: ["open.bigmodel.cn"] });

  it("names the engine, the old and the new host; stopping the engine is the primary action and returns false", async () => {
    const user = userEvent.setup();
    const layer = document.body.appendChild(document.createElement("div"));
    const answer = ask(layer);
    const dialog = await within(layer).findByRole("alertdialog");
    expect(dialog.textContent).toContain("DeepSeek");
    expect(dialog.textContent).toContain("official-llm");
    expect(within(dialog).getByText("open.bigmodel.cn")).toBeTruthy();
    expect(within(dialog).getByText("api.glm-proxy.example.net")).toBeTruthy();
    const stop = within(dialog).getByRole("button", { name: "先停用这个引擎" });
    expect(document.activeElement).toBe(stop);
    await user.click(stop);
    await expect(answer).resolves.toBe(false);
    expect(within(layer).queryByRole("alertdialog")).toBeNull();
  });

  it("covers the viewport (fixed), keeps Tab inside and returns focus when it closes (R7.4, R13.3)", async () => {
    const user = userEvent.setup();
    const before = document.body.appendChild(document.createElement("button"));
    before.focus();
    const layer = document.body.appendChild(document.createElement("div"));
    const answer = ask(layer);
    const dialog = await within(layer).findByRole("alertdialog");
    expect(dialog.parentElement!.className).toMatch(/\bfixed\b/);
    expect(dialog.parentElement!.className).not.toMatch(/\babsolute\b/);
    const stop = within(dialog).getByRole("button", { name: "先停用这个引擎" });
    const allow = within(dialog).getByRole("button", { name: "我认识这个地址，允许" });
    // the dialog renders through its own React root; its focus effect may land a tick after it shows
    await waitFor(() => expect(document.activeElement).toBe(stop));
    await user.tab();
    expect(document.activeElement).toBe(allow);
    await user.tab();
    expect(document.activeElement).toBe(stop);
    await user.click(stop);
    await answer;
    expect(document.activeElement).toBe(before);
  });

  it("allow returns true", async () => {
    const user = userEvent.setup();
    const layer = document.body.appendChild(document.createElement("div"));
    const answer = ask(layer);
    await user.click(await within(layer).findByRole("button", { name: "我认识这个地址，允许" }));
    await expect(answer).resolves.toBe(true);
  });

  it("Esc counts as refusing", async () => {
    const user = userEvent.setup();
    const layer = document.body.appendChild(document.createElement("div"));
    const answer = ask(layer);
    await within(layer).findByRole("alertdialog");
    await user.keyboard("{Escape}");
    await expect(answer).resolves.toBe(false);
  });

  it("mentions the pack update when versions are known", async () => {
    const layer = document.body.appendChild(document.createElement("div"));
    void ask(layer, (pack) => (pack === "official-llm" ? { from: "2026.11.01", to: "2026.11.16" } : undefined));
    const dialog = await within(layer).findByRole("alertdialog");
    expect(dialog.textContent).toContain("2026.11.01");
    expect(dialog.textContent).toContain("2026.11.16");
  });

  it("never touches the engine's disabled flag itself (invoke does)", async () => {
    const user = userEvent.setup();
    const r = renderEngines();
    const layer = document.body.appendChild(document.createElement("div"));
    const answer = createConfirmHost(layer)({ provider: provider(), hosts: ["x.test"], confirmed: [] });
    await user.click(await within(layer).findByRole("button", { name: "先停用这个引擎" }));
    await answer;
    expect(secretsOf(r).isDisabled(DEEPSEEK)).toBe(false);
  });
});
