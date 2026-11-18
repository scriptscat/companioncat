import { afterEach, describe, expect, it, vi } from "vitest";
import * as builtin from "virtual:builtin-packs";
import { installGmHttp } from "../../test/fakes/gm-http";
import { createGmStorageFake } from "../../test/fakes/gm-storage";
import { createStorage } from "../platform/storage";
import { ORDER_KEY, SEEDED_KEY, SUB_PREFIX, officialUrls, type FetchFn, type Subscription } from "../core/subscriptions";
import { AUTO_UPDATE_KEY, preferredKey } from "../pages/general/prefs";
import { LOCAL_RULES_KEY } from "../pages/rules/RulesPage";
import { composeApp } from "./app";
import { gmFetch } from "./fetch";

const OFFICIAL = ["official-llm", "official-quiz", "official-skip-ads", "official-translate"];

const pack = (id: string, version = "1.0.0", host = "fake.test", secrets = false) => ({
  schema: 1,
  id,
  name: `pack ${id}`,
  version,
  providers: [
    {
      id: "echo",
      name: `Echo ${id}`,
      hosts: [host],
      ...(secrets ? { secrets: [{ name: "apiKey", title: "API Key" }] } : {}),
      implements: {
        translate: {
          http: {
            request: { method: "GET", url: `https://${host}/t?q={{ urlencode(input.texts[0]) }}` },
            response: "json",
            output: { texts: "{{ response.texts }}" },
          },
        },
      },
    },
  ],
});

/** A FetchFn that answers 304 for official packs (nothing new) and serves `served` by URL. */
function fakeFetch(served: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const fetch: FetchFn = async (url) => {
    calls.push(url);
    if (url in served) return { status: 200, headers: {}, text: JSON.stringify(served[url]) };
    return { status: 304, headers: {}, text: "" };
  };
  return { fetch, calls };
}

function setup(o: { gm?: ReturnType<typeof createGmStorageFake>; served?: Record<string, unknown>; confirmHost?: () => boolean } = {}) {
  const gm = o.gm ?? createGmStorageFake();
  const storage = createStorage(gm.tab());
  const net = fakeFetch(o.served);
  const app = composeApp({ storage, fetch: net.fetch, builtin, confirmHost: o.confirmHost ?? (() => false) });
  return { gm, storage, net, app, s: app.services };
}

const providerRefs = (s: ReturnType<typeof setup>["s"]) => s.rules.get().providers.map((p) => p.ref);

describe("composeApp: subscriptions and the built-in snapshot", () => {
  it("seeds both official packs from the built-in snapshot on first run, before any network", () => {
    const { s, net } = setup();
    expect(s.subscriptions.list().map((x) => x.id).sort()).toEqual(OFFICIAL);
    expect(providerRefs(s)).toContain("official-translate/google");
    expect(net.calls).toEqual([]);
  });

  it("start() checks due packs over the FetchFn, honouring the auto-update setting", async () => {
    const on = setup();
    await on.app.start();
    expect(on.net.calls.sort()).toEqual(OFFICIAL.map((id) => officialUrls(id)[0]).sort());

    const gm = createGmStorageFake();
    createStorage(gm.tab()).set(AUTO_UPDATE_KEY, false);
    const off = setup({ gm });
    await off.app.start();
    expect(off.net.calls).toEqual([]);
  });

  it("replaces an older cached official pack with the newer built-in one on upgrade", () => {
    const gm = createGmStorageFake();
    const first = setup({ gm });
    const id = "official-translate";
    const old = first.storage.get<Subscription>(SUB_PREFIX + id)!;
    first.storage.set(SUB_PREFIX + id, { ...old, pack: { ...old.pack, version: "2000.1.1", name: "old copy" }, builtin: "2000.1.1" });
    first.app.dispose();

    const again = setup({ gm });
    expect(again.s.subscriptions.get(id)!.pack.name).not.toBe("old copy");
    expect(again.s.subscriptions.get(id)!.pack.version).toBe((builtin.packs as { id: string; version: string }[]).find((p) => p.id === id)!.version);
  });

  it("「订阅官方规则」 brings the official packs back after they were unsubscribed", async () => {
    const { s } = setup();
    for (const id of OFFICIAL) s.subscriptions.unsubscribe(id);
    expect(s.rules.get().providers).toEqual([]);
    await s.subscribeOfficial();
    expect(s.subscriptions.list().map((x) => x.id).sort()).toEqual(OFFICIAL);
    expect(providerRefs(s)).toContain("official-translate/google");
  });
});

describe("composeApp: the rules source", () => {
  it("returns one stable snapshot until the rules change", () => {
    const { s, storage } = setup();
    const a = s.rules.get();
    expect(s.rules.get()).toBe(a);
    storage.set("cc:shell:theme", "dark");
    expect(s.rules.get()).toBe(a);
  });

  it("keeps the snapshot when an update check finds nothing new (only lastChecked moves)", async () => {
    const { s, app, net } = setup();
    const seen = vi.fn();
    s.rules.subscribe(seen);
    const a = s.rules.get();
    await app.start();
    expect(net.calls.length).toBe(4);
    expect(s.subscriptions.get("official-translate")!.lastChecked).toBeDefined();
    expect(s.rules.get()).toBe(a);
    expect(seen).not.toHaveBeenCalled();
  });

  it("re-resolves when a pack is subscribed, and notifies", async () => {
    const url = "https://packs.test/x.json";
    const { s } = setup({ served: { [url]: pack("x") } });
    const seen = vi.fn();
    s.rules.subscribe(seen);
    const before = s.rules.get();
    expect(await s.subscriptions.subscribe(url)).toEqual({ ok: true, id: "x" });
    expect(seen).toHaveBeenCalled();
    expect(s.rules.get()).not.toBe(before);
    expect(providerRefs(s)).toContain("x/echo");
    s.subscriptions.unsubscribe("x");
    expect(providerRefs(s)).not.toContain("x/echo");
  });

  it("includes the local rules from cc:rules:local with local priority, and ignores invalid text", () => {
    const { s, storage } = setup();
    const seen = vi.fn();
    s.rules.subscribe(seen);
    storage.set(LOCAL_RULES_KEY, JSON.stringify(pack("local")));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(providerRefs(s)).toContain("local/echo");

    storage.set(LOCAL_RULES_KEY, "{ not json");
    expect(providerRefs(s)).not.toContain("local/echo");
    expect(providerRefs(s)).toContain("official-translate/google");
  });

  it("picks up rule changes made in another tab (R1.8)", () => {
    const gm = createGmStorageFake();
    const a = setup({ gm });
    const other = createStorage(gm.tab());
    const seen = vi.fn();
    a.s.rules.subscribe(seen);
    other.set(LOCAL_RULES_KEY, JSON.stringify(pack("local")));
    expect(seen).toHaveBeenCalled();
    expect(providerRefs(a.s)).toContain("local/echo");
    other.set(ORDER_KEY, ["official-llm"]);
    expect(providerRefs(a.s)).not.toContain("official-translate/google");
  });

  it("migrates setting values when the rules change (R9.4)", () => {
    const { s, storage } = setup();
    const stale = "cc:set:official-translate/translate/gone";
    const kept = "cc:set:official-translate/translate/to";
    storage.set(stale, 1);
    storage.set(kept, "ja");
    storage.set(LOCAL_RULES_KEY, JSON.stringify(pack("local")));
    expect(storage.get(stale)).toBeUndefined();
    expect(storage.get(kept)).toBe("ja");
  });

  it("stops listening after dispose()", () => {
    const { s, storage, app } = setup();
    const before = s.rules.get();
    app.dispose();
    storage.set(LOCAL_RULES_KEY, JSON.stringify(pack("local")));
    expect(s.rules.get()).toBe(before);
  });
});

describe("composeApp: the shared invoker", () => {
  it("uses the 通用 page's preferred engine (R5.7)", () => {
    const { s, storage } = setup();
    storage.set(preferredKey("translate"), "official-translate/microsoft");
    expect(s.invoker.preferredEngines("translate").preferred).toBe("official-translate/microsoft");
  });

  it("pauses a keyed engine on an unconfirmed host through confirmHost; refusing sends nothing (R7.4)", async () => {
    const http = installGmHttp([]);
    try {
      const asked: string[][] = [];
      const { s, storage } = setup({ confirmHost: () => false });
      storage.set(LOCAL_RULES_KEY, JSON.stringify(pack("local", "1", "new.test", true)));
      s.secrets.set("local/echo", "apiKey", "k-123");
      const confirmHost = (req: { hosts: string[] }) => (asked.push(req.hosts), false);
      const res = await s.invoker.invoke({ contract: "translate", input: { texts: ["hi"], to: "zh-CN" }, engines: ["local/echo"] }, { confirmHost });
      expect(asked).toEqual([["new.test"]]);
      expect(res.ok).toBe(false);
      expect(res.results[0]).toMatchObject({ ok: false, error: { type: "hostUnconfirmed" } });
      expect(http.calls).toEqual([]);
    } finally {
      http.restore();
    }
  });

  it("calls the services' confirmHost by default, and exposes it", async () => {
    const http = installGmHttp([{ url: /^https:\/\/new\.test\//, json: { texts: ["你好"] } }]);
    try {
      const hook = vi.fn(() => true);
      const { s, storage } = setup({ confirmHost: hook });
      expect(s.confirmHost).toBe(hook);
      storage.set(LOCAL_RULES_KEY, JSON.stringify(pack("local", "1", "new.test", true)));
      s.secrets.set("local/echo", "apiKey", "k-123");
      const res = await s.invoker.invoke({ contract: "translate", input: { texts: ["hi"], to: "zh-CN" }, engines: ["local/echo"] });
      expect(hook).toHaveBeenCalledTimes(1);
      expect(res).toMatchObject({ ok: true, output: { texts: ["你好"] } });
      expect(s.secrets.isHostConfirmed("local/echo", "new.test")).toBe(true);
    } finally {
      http.restore();
    }
  });

  it("remembers which version a pack came from, for the host dialog", async () => {
    const url = "https://packs.test/x.json";
    const served: Record<string, unknown> = { [url]: pack("x", "1.0.0") };
    const { s, app } = setup({ served });
    await s.subscriptions.subscribe(url);
    expect(app.versions("x")).toEqual({ to: "1.0.0" });
    served[url] = pack("x", "1.1.0", "moved.test");
    await s.subscriptions.refresh("x");
    expect(app.versions("x")).toEqual({ from: "1.0.0", to: "1.1.0" });
  });
});

describe("gmFetch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetches over GM_xmlhttpRequest with the given headers", async () => {
    const http = installGmHttp([{ url: "https://packs.test/a.json", status: 200, headers: { ETag: '"v1"' }, body: '{"a":1}' }]);
    try {
      const res = await gmFetch("https://packs.test/a.json", { headers: { "If-None-Match": '"v0"' } });
      expect(res).toEqual({ status: 200, headers: { etag: '"v1"' }, text: '{"a":1}' });
      expect(http.calls[0]).toMatchObject({ method: "GET", headers: { "If-None-Match": '"v0"' } });
    } finally {
      http.restore();
    }
  });

  it("rejects on a network failure so the manager reports 网络错误", async () => {
    const http = installGmHttp([{ url: "https://packs.test/a.json", error: "network" }]);
    try {
      await expect(gmFetch("https://packs.test/a.json")).rejects.toThrow();
    } finally {
      http.restore();
    }
  });
});

it("keeps the seeded marker so an unsubscribed official pack is not re-seeded on the next start", () => {
  const gm = createGmStorageFake();
  const a = setup({ gm });
  a.s.subscriptions.unsubscribe("official-llm");
  a.app.dispose();
  const b = setup({ gm });
  expect(b.s.subscriptions.get("official-llm")).toBeUndefined();
  expect(b.storage.get<string[]>(SEEDED_KEY)).toContain("official-llm");
});
