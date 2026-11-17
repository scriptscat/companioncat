import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { installGmHttp, type FakeGm } from "../../../../test/fakes/gm-http";
import { createGmStorageFake } from "../../../../test/fakes/gm-storage";
import { CallError } from "../../../core/errors";
import * as impl from "../../../core/impl";
import type { TraceEvent } from "../../../core/impl";
import { createInvoker } from "../../../core/invoke";
import type { Resolved } from "../../../core/rules/types";
import { ShellCtx, type ShellApi } from "../../../shell/context";
import { staticRules } from "../../../shell/services";
import { createSecretStore } from "../../../core/stores";
import { createStorage } from "../../../platform/storage";
import { TipProvider } from "../../../ui";
import { official, renderEngines } from "../harness";
import { TracePanel } from "./index";

vi.mock("../../../core/impl", async (orig) => {
  const actual = await orig<typeof import("../../../core/impl")>();
  return { ...actual, executeImpl: vi.fn(actual.executeImpl) };
});
const realExecute = (await vi.importActual<typeof import("../../../core/impl")>("../../../core/impl")).executeImpl;
const executeImpl = vi.mocked(impl.executeImpl);

let fake: FakeGm | undefined;
afterEach(() => {
  cleanup();
  fake?.restore();
  fake = undefined;
  executeImpl.mockReset();
  executeImpl.mockImplementation(realExecute);
  document.body.innerHTML = "";
});

const KEY = "sk-4b1e9c07d2a64f3f2a";
const ENGINE = "official-llm/deepseek";
const resolved = official();
const provider = resolved.providers.find((p) => p.ref === ENGINE)!;
const translate = resolved.contracts.find((c) => c.id.startsWith("translate"))!;
const chat = resolved.contracts.find((c) => c.id.startsWith("chat"))!;

function shellOf(r: Resolved, storage: ReturnType<typeof createStorage>, extra: Partial<ShellApi["services"]> = {}): ShellApi {
  return {
    services: { storage, rules: staticRules(r), ...extra },
    resolved: r,
    layer: document.body,
  } as unknown as ShellApi;
}

function mount(
  r: Resolved,
  contracts = [translate, chat],
  invoker = createInvoker({ rules: () => r, secrets: undefined as never }),
  services: Partial<ShellApi["services"]> = {},
) {
  const storage = createStorage(createGmStorageFake().tab());
  const secrets = createSecretStore(storage, () => r);
  secrets.set(ENGINE, "apiKey", KEY, ["api.deepseek.com"]);
  const view = render(
    <ShellCtx.Provider value={shellOf(r, storage, services)}>
      <TipProvider>
        <TracePanel provider={provider} contracts={contracts} invoker={invoker} secrets={secrets} />
      </TipProvider>
    </ShellCtx.Provider>,
  );
  return { secrets, ...view };
}

/** executeImpl replaced by a script of trace events and either an output or an error. */
function setup(events: TraceEvent[], result: Record<string, unknown>, contracts = [translate, chat]) {
  executeImpl.mockImplementation(async (_p, _c, _i, ctx) => {
    for (const ev of events) ctx.onTrace?.(ev);
    if (result.error) throw result.error;
    return result.output;
  });
  return { invoke: executeImpl, ...mount(resolved, contracts) };
}

const run = () => userEvent.click(screen.getByRole("button", { name: "用样例试运行" }));

const OK: TraceEvent[] = [
  { type: "bridge", bridge: "llm-translate", from: "translate@1", to: "chat@1", attempt: 1, input: {} },
  { type: "expr", position: "桥接 input", template: "{{ langName(input.to) }}", value: "简体中文" },
  { type: "request", step: "request", method: "POST", url: "https://api.deepseek.com/v1/chat/completions", headers: { Authorization: "Bearer sk-••••••••3f2a" }, body: '{"stream":true}' },
  { type: "response", step: "request", status: 200, ms: 410, chunks: 12, body: '{"ok":1}' },
  { type: "expr", position: "引擎 output", template: "{{ extractJson(result.text) }}", value: ["你好"] },
  { type: "output", contract: "translate@1", output: { texts: ["你好，世界"] } },
];

describe("trial run (R12.1)", () => {
  it("prefills the input from the contract sample and runs only this engine with that input", async () => {
    const { invoke } = setup(OK, { engine: ENGINE, output: { texts: ["你好，世界"] } });
    const box = screen.getByRole("textbox", { name: "输入" }) as HTMLTextAreaElement;
    expect(JSON.parse(box.value)).toEqual(translate.def.sample);
    await run();
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(invoke.mock.calls[0]!.slice(0, 3)).toEqual([provider, translate.id, translate.def.sample]);
  });

  it("lets the user pick another contract and switches the sample", async () => {
    const { invoke } = setup(OK, { output: {} });
    await userEvent.click(screen.getByRole("radio", { name: new RegExp(chat.id) }));
    expect(JSON.parse((screen.getByRole("textbox", { name: "输入" }) as HTMLTextAreaElement).value)).toEqual(chat.def.sample);
    await run();
    await waitFor(() => expect(invoke.mock.calls[0]![1]).toBe(chat.id));
  });

  it("shows bridge, request, response, expression values and output in order", async () => {
    setup(OK, { engine: ENGINE, output: { texts: ["你好，世界"] } });
    await run();
    const steps = await screen.findAllByRole("listitem", { name: /^第 \d+ 步/ });
    expect(steps).toHaveLength(2);
    expect(within(steps[0]!).getByText(/llm-translate/)).toBeTruthy();
    expect(within(steps[0]!).getByText("{{ langName(input.to) }}")).toBeTruthy();
    expect(within(steps[0]!).getByText('"简体中文"')).toBeTruthy();
    expect(within(steps[1]!).getByText(/POST https:\/\/api\.deepseek\.com\/v1\/chat\/completions/)).toBeTruthy();
    expect(within(steps[1]!).getByText(/Authorization: Bearer sk-••••••••3f2a/)).toBeTruthy();
    expect(within(steps[1]!).getByText(/200/)).toBeTruthy();
    expect(within(steps[1]!).getByText(/410 ms/)).toBeTruthy();
    expect(within(steps[1]!).getByText(/12 段/)).toBeTruthy();
    expect(within(steps[1]!).getByText("{{ extractJson(result.text) }}")).toBeTruthy();
    expect(screen.getByText("成功")).toBeTruthy();
    expect(screen.getByRole("region", { name: "输出" }).textContent).toContain("你好，世界");
  });

  it("renders a declared contract's output by its view, else the auto view", async () => {
    const withView = { ...translate, def: { ...translate.def, view: { type: "text", value: "{{ result.texts[0] }}" } } };
    setup(OK, { engine: ENGINE, output: { texts: ["视图里的字"] } }, [withView as never]);
    await run();
    await waitFor(() => expect(within(screen.getByRole("region", { name: "输出" })).getByText("视图里的字")).toBeTruthy());
  });
});

describe("keys never shown (R7.3)", () => {
  it("masks a key even if an event carries it unmasked", async () => {
    const leaky: TraceEvent[] = [
      { type: "request", step: "request", method: "POST", url: `https://x.test/?k=${KEY}`, headers: { Authorization: `Bearer ${KEY}` }, body: `{"k":"${KEY}"}` },
      { type: "response", step: "request", status: 200, ms: 5, chunks: 1, body: `echo ${KEY}` },
      { type: "output", contract: "translate@1", output: { echo: KEY } },
    ];
    const { container } = setup(leaky, { engine: ENGINE, output: { echo: KEY } });
    await run();
    await screen.findByText("成功");
    expect(container.textContent).not.toContain(KEY);
    expect(container.textContent).toContain("sk-••••••••3f2a");
  });
});

describe("errors (R12.2)", () => {
  const failing = (): [TraceEvent[], Record<string, unknown>] => [
    [
      { type: "request", step: "request", method: "POST", url: "https://a.test/x", headers: {}, body: "{}" },
      { type: "response", step: "request", status: 200, ms: 20, chunks: 1, body: '{"bad":true}' },
      { type: "expr", position: "引擎 output", template: "{{ response.texts[0] }}", error: "no such key: texts" },
    ],
    {
      ok: false,
      error: new CallError("badOutput", "映射输出失败", {
        step: "request",
        expr: { position: "引擎 output", path: ["texts", 0], source: "response.texts[0]", start: 3, end: 20, message: "no such key: texts" },
      }),
    },
  ];

  it("shows the error type, marks the failing step and the failing expression with its source and range", async () => {
    const [ev, res] = failing();
    setup([{ type: "bridge", bridge: "b", from: "a", to: "c", attempt: 1, input: {} }, ...ev], res);
    await run();
    const steps = await screen.findAllByRole("listitem", { name: /^第 \d+ 步/ });
    expect(steps[0]!.getAttribute("data-failed")).toBeNull();
    expect(steps[1]!.getAttribute("data-failed")).toBe("true");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("返回格式不对");
    expect(alert.textContent).toContain("映射输出失败");
    expect(alert.textContent).toContain("第 2 步");
    const mark = within(alert).getByText("response.texts[0]");
    expect(mark.tagName).toBe("MARK");
    expect(alert.textContent).toContain("3");
    expect(alert.textContent).toContain("20");
    expect(within(steps[1]!).getByText("no such key: texts").closest("[data-failed-expr]")).toBeTruthy();
  });

  it("shows an error that happened before any step (e.g. missing key)", async () => {
    setup([], { ok: false, error: new CallError("missingKey") });
    await run();
    expect((await screen.findByRole("alert")).textContent).toContain("缺 Key");
  });

  it("shows an unreadable input without calling the engine", async () => {
    const { invoke } = setup(OK, {});
    const box = screen.getByRole("textbox", { name: "输入" });
    await userEvent.clear(box);
    await userEvent.type(box, "{{ nope");
    await run();
    expect((await screen.findByRole("alert")).textContent).toContain("JSON");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("truncates raw responses over 2000 characters behind an expand control", async () => {
    const long = "a".repeat(2500) + "END";
    setup([{ type: "request", step: "request", method: "GET", url: "https://a.test", headers: {}, body: undefined }, { type: "response", step: "request", status: 200, ms: 1, chunks: 1, body: long }, { type: "output", contract: "c", output: 1 }], { engine: ENGINE, output: 1 });
    await run();
    await screen.findByText("成功");
    const raw = () => screen.getByTestId("raw-response");
    expect(raw().textContent).toBe("a".repeat(2000));
    await userEvent.click(screen.getByRole("button", { name: /展开全部.*2503/ }));
    expect(raw().textContent).toBe(long);
    expect(screen.getByRole("button", { name: "收起" })).toBeTruthy();
  });

  it("does not truncate a response of exactly 2000 characters", async () => {
    setup([{ type: "request", step: "request", method: "GET", url: "https://a.test", headers: {}, body: undefined }, { type: "response", step: "request", status: 200, ms: 1, chunks: 1, body: "b".repeat(2000) }], { engine: ENGINE, output: 1 });
    await run();
    await screen.findByText("成功");
    expect(screen.queryByRole("button", { name: /展开全部/ })).toBeNull();
  });
});

describe("no cache (R12.1)", () => {
  const GOOGLE = "official-translate/google";
  const google = resolved.providers.find((p) => p.ref === GOOGLE)!;
  const recordedGoogle = [{ method: "GET", url: /translate_a\/single/, status: 200, repeat: true, body: JSON.parse(readFileSync("test/fixtures/recorded/google-translate.json", "utf8")).exchanges[0].body }];

  function withInvoker() {
    const storage = createStorage(createGmStorageFake().tab());
    const secrets = createSecretStore(storage, () => resolved);
    const invoker = createInvoker({ rules: () => resolved, secrets });
    const view = render(
      <ShellCtx.Provider value={shellOf(resolved, storage)}>
        <TipProvider>
          <TracePanel provider={google} contracts={[translate]} invoker={invoker} secrets={secrets} />
        </TipProvider>
      </ShellCtx.Provider>,
    );
    return { invoker, ...view };
  }

  it("a trial run after an identical invoke still shows the request step and leaves the cache alone", async () => {
    fake = installGmHttp(recordedGoogle as never);
    const { invoker } = withInvoker();
    const first = await invoker.invoke({ contract: translate.id, input: translate.def.sample, engines: [GOOGLE] });
    expect(first.ok).toBe(true);
    const before = invoker.cacheStats().entries;
    expect(before).toBeGreaterThan(0);
    const sent = fake.calls.length;
    await run();
    const steps = await screen.findAllByRole("listitem", { name: /^第 \d+ 步/ });
    expect(steps.some((s) => /GET https:\/\/translate\.googleapis\.com/.test(s.textContent ?? ""))).toBe(true);
    expect(fake.calls.length).toBe(sent + 1);
    expect(screen.queryByText(/来自缓存/)).toBeNull();
    expect(invoker.cacheStats().entries).toBe(before);
  });

  it("renders the output through a view template (`use`) of the rule pack", async () => {
    const withTpl: Resolved = {
      ...resolved,
      views: [...resolved.views, { ref: "t/v", id: "v", pack: "t", source: 0, enabled: true, problems: [], def: { type: "text", value: "模板：{{ params.x }}" } } as never],
    };
    const c = { ...translate, def: { ...translate.def, view: { use: "t/v", with: { x: "{{ result.texts[0] }}" } } } };
    executeImpl.mockImplementation(async () => ({ texts: ["你好"] }));
    mount(withTpl, [c as never]);
    await run();
    await waitFor(() => expect(within(screen.getByRole("region", { name: "输出" })).getByText("模板：你好")).toBeTruthy());
  });

  it("confirms a host the store lists without asking, and asks the dialog for any other", async () => {
    const seen: boolean[] = [];
    executeImpl.mockImplementation(async (p, _c, _i, ctx) => {
      seen.push(await ctx.confirmHost!("api.deepseek.com", p));
      seen.push(await ctx.confirmHost!("evil.test", p));
      return {};
    });
    mount(resolved);
    await run();
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(seen).toEqual([true]);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(seen).toEqual([true, false]));
  });
});

describe("host dialog wiring (R7.4)", () => {
  it("uses the app's dialog (which knows the pack versions) when the shell has one", async () => {
    const confirmHost = vi.fn(async () => true);
    executeImpl.mockImplementation(async (p, _c, _i, ctx) => ({ ok: await ctx.confirmHost!("new.test", p) }));
    mount(resolved, [translate, chat], undefined, { confirmHost });
    await run();
    await waitFor(() => expect(confirmHost).toHaveBeenCalledWith(expect.objectContaining({ hosts: ["new.test"], confirmed: ["api.deepseek.com"] })));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("mounting", () => {
  it("is mounted in the engine detail slot", async () => {
    renderEngines(resolved);
    await userEvent.click(screen.getByRole("button", { name: /^Google 翻译/ }));
    const slot = await screen.findByTestId("engine-trace-slot");
    expect(within(slot).getByRole("button", { name: "用样例试运行" })).toBeTruthy();
  });
});
