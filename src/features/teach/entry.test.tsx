import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => [] as { ctx: unknown; opts: Record<string, unknown> }[]);
vi.mock("./Panel", async (orig) => {
  const real = await orig<typeof import("./Panel")>();
  return {
    ...real,
    openTeachPanel: (ctx: never, opts: Record<string, unknown> = {}) => {
      opened.push({ ctx, opts });
      return real.openTeachPanel(ctx, opts);
    },
  };
});
import { draftSlots } from "./Draft";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import type { InvokeResult } from "../../core/invoke";
import type { ResolvedFeature } from "../../core/rules/types";
import { createStorage } from "../../platform/storage";
import { RulesPage, LOCAL_RULES_KEY } from "../../pages/rules/RulesPage";
import { ShellCtx, type ShellApi } from "../../shell/context";
import { EMPTY_RESOLVED, staticRules } from "../../shell/services";
import type { Command, RuntimeContext } from "../../shell";
import type { ToastSpec } from "../../shell/registry";
import { TipProvider } from "../../ui";
import { FeaturePage } from "../page/FeaturePage";
import { createConversation } from "./conversation";
import registration from "./register";
import { loadUnsaved, saveDraft, saveUnsaved } from "./store";

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});

const FEATURE = {
  id: "auto-expand",
  name: "自动展开全文",
  match: ["*://news.example.cn/*"],
  entries: [{ id: "expand", name: "展开全文", triggers: [{ on: "page-load" }], run: [{ act: "click", target: "{{ vars.x }}" }] }],
};

async function seed(text: string, reply: string) {
  const c = createConversation({
    invoker: {
      invoke: async () => ({ ok: true, strategy: "first", contract: "chat", output: { text: JSON.stringify({ message: reply, draft: FEATURE }) }, results: [] }) as InvokeResult,
    },
    schema: {},
    example: {},
    validate: () => [],
  });
  await c.send(text);
  return c;
}

function world() {
  const storage = createStorage(createGmStorageFake().tab());
  const layer = document.createElement("div");
  document.body.append(layer);
  const commands: Command[] = [];
  const toasts: ToastSpec[] = [];
  const ctx = {
    layer,
    root: layer as unknown as ShadowRoot,
    hostname: "news.example.cn",
    services: {
      storage,
      rules: staticRules(EMPTY_RESOLVED),
      invoker: { invoke: vi.fn(), preferredEngines: () => ({ engines: [], notice: "还没填 Key" }) },
    },
    setAwake: vi.fn(),
    toast: (t: ToastSpec) => {
      toasts.push(t);
      return () => {};
    },
    commands: {
      register: (c: Command) => {
        commands.push(c);
        return () => {};
      },
    },
    openSettings: vi.fn(),
  } as unknown as RuntimeContext;
  return { storage, layer, ctx, commands, toasts };
}

const feature = registration as unknown as { start(ctx: RuntimeContext): () => void };
const panel = (layer: HTMLElement) => layer.querySelector('[role="dialog"]');
const shellApi = (w: ReturnType<typeof world>): ShellApi => ({
  services: w.ctx.services,
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
  layer: w.layer,
});

let stop: (() => void) | undefined;
afterEach(() => {
  opened.length = 0;
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
});

describe("bubble command (R6.1)", () => {
  it("offers 教小猫做件事 as a quick command that opens the panel with the draft pane", async () => {
    const w = world();
    stop = feature.start(w.ctx);
    const cmd = w.commands.find((c) => c.title === "教小猫做件事");
    expect(cmd).toMatchObject({ quick: true });
    act(() => cmd!.run());
    expect(await within(w.layer).findByRole("dialog")).toBeTruthy();
    expect(opened.at(-1)).toEqual({ ctx: w.ctx, opts: draftSlots });
  });

  it("does not open on the bubble when the feature is torn down", () => {
    const w = world();
    feature.start(w.ctx)();
    expect(panel(w.layer)).toBeNull();
  });
});

describe("rules page button (R6.1)", () => {
  it("让小猫写一条规则 opens the panel", async () => {
    const w = world();
    stop = feature.start(w.ctx);
    render(
      <ShellCtx.Provider value={shellApi(w)}>
        <TipProvider>
          <RulesPage />
        </TipProvider>
      </ShellCtx.Provider>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "让小猫写一条规则" }));
    expect(await within(w.layer).findByRole("dialog")).toBeTruthy();
    expect(opened.at(-1)).toEqual({ ctx: w.ctx, opts: draftSlots });
  });
});

describe("feature page 继续和小猫改 (R6.8)", () => {
  const local = (id = "auto-expand") => ({ ...FEATURE, id, ref: `local/${id}`, pack: "local", source: 0, def: { ...FEATURE, id }, enabled: true, problems: [], entries: [] }) as unknown as ResolvedFeature;
  const page = (w: ReturnType<typeof world>, f: ResolvedFeature) =>
    render(
      <ShellCtx.Provider value={shellApi(w)}>
        <TipProvider>
          <FeaturePage feature={f} narrow={false} />
        </TipProvider>
      </ShellCtx.Provider>,
    );

  it("opens the saved conversation of an AI-written rule", async () => {
    const w = world();
    stop = feature.start(w.ctx);
    const c = await seed("原来的话", "原来的回复");
    const saved = saveDraft(w.storage, c, c.versions[0]!.draft);
    const id = (saved as { featureId: string }).featureId;
    page(w, local(id));
    await userEvent.setup().click(screen.getByRole("button", { name: "继续和小猫改" }));
    expect(await within(w.layer).findByText("原来的回复")).toBeTruthy();
    expect(opened.at(-1)?.opts).toEqual({ ...draftSlots, featureId: id });
  });

  it("is absent for rules the AI did not write", () => {
    const w = world();
    stop = feature.start(w.ctx);
    w.storage.set(LOCAL_RULES_KEY, JSON.stringify({ schema: 1, id: "local", features: [FEATURE] }));
    page(w, local("auto-expand"));
    expect(screen.queryByRole("button", { name: "继续和小猫改" })).toBeNull();
    // nor for a subscribed pack's feature that happens to share the id
    page(w, { ...local("auto-expand"), pack: "official-x", ref: "official-x/auto-expand" });
    expect(screen.queryByRole("button", { name: "继续和小猫改" })).toBeNull();
  });
});

describe("reload strip 接着上次没写完的 (R6.9)", () => {
  it("shows nothing when there is no unsaved conversation", () => {
    const w = world();
    stop = feature.start(w.ctx);
    expect(w.toasts).toHaveLength(0);
  });

  it("继续 reopens the unsaved conversation", async () => {
    const w = world();
    saveUnsaved(w.storage, await seed("没写完", "没写完的回复"));
    stop = feature.start(w.ctx);
    expect(w.toasts).toHaveLength(1);
    expect(w.toasts[0]!.text).toContain("接着上次没写完的");
    act(() => w.toasts[0]!.links!.find((l: { label: string }) => l.label === "继续")!.onClick());
    expect(await within(w.layer).findByText("没写完的回复")).toBeTruthy();
    expect(opened.at(-1)?.opts).toEqual({ ...draftSlots, resume: true });
  });

  it("丢掉 discards it without opening the panel", async () => {
    const w = world();
    saveUnsaved(w.storage, await seed("没写完", "没写完的回复"));
    stop = feature.start(w.ctx);
    act(() => w.toasts[0]!.links!.find((l: { label: string }) => l.label === "丢掉")!.onClick());
    expect(loadUnsaved(w.storage)).toBeUndefined();
    expect(panel(w.layer)).toBeNull();
  });

  it("stays up long enough to be noticed", async () => {
    const w = world();
    saveUnsaved(w.storage, await seed("没写完", "x"));
    stop = feature.start(w.ctx);
    expect(w.toasts[0]!.ms ?? 5000).toBeGreaterThanOrEqual(60_000);
  });
});
