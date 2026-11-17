import { render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { testProvider } from "../../core/impl/testkit";
import { createInvoker, type Invoker } from "../../core/invoke";
import { createSecretStore } from "../../core/stores";
import type { Resolved } from "../../core/rules/types";
import { createStorage, type Storage } from "../../platform/storage";
import { ShellCtx, type ShellApi } from "../../shell/context";
import { readPrefs, writePref, type ShellPrefs } from "../../shell/prefs";
import { EMPTY_RESOLVED, staticRules } from "../../shell/services";
import { TipProvider } from "../../ui";
import { GeneralPage } from "./GeneralPage";
import { autoUpdateEnabled, preferredEngine, setPreferredEngine } from "./prefs";

const HOST = "example.org";
const AUTO = "自动（按规则顺序）";

afterEach(() => vi.restoreAllMocks());

// jsdom lacks these; Radix Select calls them when opened.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

function resolvedWith(...providers: Resolved["providers"]): Resolved {
  return { ...EMPTY_RESOLVED, providers };
}

const http = (url: string) => ({ http: { request: { method: "POST" as const, url }, response: "json" as const, output: {} } });
const deepseek = testProvider({ id: "deepseek", name: "DEEPSEEK", secrets: [{ name: "apiKey", title: "API Key" }], implements: { translate: http("https://d.test/t") } });
const free = testProvider({ id: "free", name: "FREE", implements: { translate: http("https://f.test/t") } });
const bot = testProvider({ id: "bot", name: "BOT", implements: { chat: http("https://b.test/c") } });

interface CacheStub {
  entries: number;
  bytes: number;
}

function setup(
  o: {
    storage?: Storage;
    resolved?: Resolved;
    invoker?: Invoker | null;
    cache?: CacheStub;
  } = {},
) {
  const storage = o.storage ?? createStorage(createGmStorageFake().tab());
  const resolved = o.resolved ?? resolvedWith(deepseek, free, bot);
  const invoker: Invoker | undefined =
    o.invoker === null
      ? undefined
      : (o.invoker ??
        (o.cache
          ? (stubInvoker(o.cache) as unknown as Invoker)
          : createInvoker({
              rules: () => resolved,
              secrets: createSecretStore(storage, () => resolved),
              preferred: preferredEngine(storage),
            })));

  function Harness() {
    const [prefs, setPrefs] = useState<ShellPrefs>(() => readPrefs(storage, HOST));
    const api: ShellApi = {
      services: { storage, rules: staticRules(resolved), invoker },
      resolved,
      bare: resolved.providers.length === 0,
      hostname: HOST,
      prefs,
      setPref(key, value) {
        writePref(storage, HOST, key, value);
        setPrefs(readPrefs(storage, HOST));
      },
      openSettings: () => {},
      closeSettings: () => {},
      closeBubble: () => {},
      subscribe: { run: vi.fn(), busy: false, error: null, available: false },
      narrow: false,
      root: document as never,
      layer: document.body,
    };
    return (
      <ShellCtx.Provider value={api}>
        <TipProvider>
          <GeneralPage />
        </TipProvider>
      </ShellCtx.Provider>
    );
  }

  const r = render(<Harness />);
  return { ...r, storage, invoker, q: within(document.body) };
}

function stubInvoker(cache: CacheStub) {
  return {
    preferredEngines: () => ({ engines: [] }),
    cacheStats: () => ({ ...cache }),
    clearCache: () => {
      cache.entries = 0;
      cache.bytes = 0;
    },
  };
}

async function pick(user: ReturnType<typeof userEvent.setup>, q: ReturnType<typeof within>, label: string, option: string) {
  await user.click(q.getByRole("combobox", { name: label }));
  await user.click(await q.findByRole("option", { name: option }));
}

describe("R5.7 每种能力先用谁", () => {
  it("each capability picker lists only the engines that implement it, plus the automatic choice", async () => {
    const user = userEvent.setup();
    const { q } = setup();
    await user.click(q.getByRole("combobox", { name: "翻译先用" }));
    expect((await q.findAllByRole("option")).map((o) => o.textContent)).toEqual([AUTO, "DEEPSEEK", "FREE"]);
    await user.keyboard("{Escape}");
    await user.click(q.getByRole("combobox", { name: "对话先用" }));
    expect((await q.findAllByRole("option")).map((o) => o.textContent)).toEqual([AUTO, "BOT"]);
  });

  it("choosing an engine stores it for that capability only, and the invoker honours it", async () => {
    const user = userEvent.setup();
    const { q, storage, invoker } = setup();
    await pick(user, q, "翻译先用", "FREE");
    expect(storage.get("cc:general:preferred:translate")).toBe("test/free");
    expect(preferredEngine(storage)("translate")).toBe("test/free");
    expect(preferredEngine(storage)("chat")).toBeUndefined();
    expect(invoker?.preferredEngines("translate").preferred).toBe("test/free");
  });

  it("shows 还没填 Key, 现在先用 when the chosen engine has no key, and drops it once it is switched", async () => {
    const user = userEvent.setup();
    const storage = createStorage(createGmStorageFake().tab());
    setPreferredEngine(storage, "translate", "test/deepseek");
    const { q } = setup({ storage });
    expect(q.getByText("还没填 Key，现在先用「FREE」")).toBeTruthy();
    await pick(user, q, "翻译先用", "FREE");
    expect(q.queryByText(/还没填 Key/)).toBeNull();
  });

  it("a stored choice whose engine is gone shows automatic, the way the invoker treats it", () => {
    const storage = createStorage(createGmStorageFake().tab());
    setPreferredEngine(storage, "translate", "test/removed");
    const { q } = setup({ storage });
    expect(q.getByRole("combobox", { name: "翻译先用" }).textContent).toContain(AUTO);
    expect(q.queryByText(/还没填 Key/)).toBeNull();
  });

  it("shows no note while the choice is automatic", () => {
    const { q } = setup();
    expect(q.queryByText(/还没填 Key/)).toBeNull();
  });

  it("with no engines at all, says so and offers no pickers", () => {
    const { q } = setup({ resolved: EMPTY_RESOLVED });
    expect(q.getByText("还没有引擎。订阅规则后，可以在这里为每种能力选一个先用的引擎。")).toBeTruthy();
    expect(q.queryByRole("combobox")).toBeNull();
  });
});

describe("R1.3 角落的小猫（全局开关）", () => {
  it("the global switch writes cc:shell:show-cat and reflects it", async () => {
    const user = userEvent.setup();
    const { q, storage } = setup();
    const sw = q.getByRole("switch", { name: "在所有网站显示小猫" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await user.click(sw);
    expect(storage.get("cc:shell:show-cat")).toBe(false);
    expect(q.getByRole("switch", { name: "在所有网站显示小猫" }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("R1.7 外观", () => {
  it("defaults to 跟随系统 and writes the chosen theme", async () => {
    const user = userEvent.setup();
    const { q, storage } = setup();
    const group = q.getByRole("radiogroup", { name: "外观" });
    expect(within(group).getByRole("radio", { name: "跟随系统" }).getAttribute("aria-checked")).toBe("true");
    await user.click(within(group).getByRole("radio", { name: "深色" }));
    expect(storage.get("cc:shell:theme")).toBe("dark");
    expect(within(q.getByRole("radiogroup", { name: "外观" })).getByRole("radio", { name: "深色" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("R2.3 自动更新（只有开关）", () => {
  it("is on by default and toggling it is what the subscription manager reads", async () => {
    const user = userEvent.setup();
    const { q, storage } = setup();
    const sw = q.getByRole("switch", { name: "自动更新规则包" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(autoUpdateEnabled(storage)()).toBe(true);
    await user.click(sw);
    expect(storage.get("cc:general:auto-update")).toBe(false);
    expect(autoUpdateEnabled(storage)()).toBe(false);
    await user.click(q.getByRole("switch", { name: "自动更新规则包" }));
    expect(autoUpdateEnabled(storage)()).toBe(true);
  });
});

describe("R6.4 缓存", () => {
  it("shows the entry count and a human-readable size, and clearing updates the count", async () => {
    const user = userEvent.setup();
    const { q } = setup({ cache: { entries: 2, bytes: 2048 } });
    expect(q.getByText("已缓存 2 条结果，约 2.0 KB")).toBeTruthy();
    await user.click(q.getByRole("button", { name: "清空" }));
    expect(q.getByText("已缓存 0 条结果，约 0 B")).toBeTruthy();
    expect((q.getByRole("button", { name: "清空" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("formats sizes in KB and MB", () => {
    const { q, unmount } = setup({ cache: { entries: 1284, bytes: Math.round(2.1 * 1024 * 1024) } });
    expect(q.getByText("已缓存 1284 条结果，约 2.1 MB")).toBeTruthy();
    unmount();
  });

  it("without an invoker wired, shows an empty cache and a disabled clear button", () => {
    const { q } = setup({ invoker: null });
    expect(q.getByText("已缓存 0 条结果，约 0 B")).toBeTruthy();
    expect((q.getByRole("button", { name: "清空" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

