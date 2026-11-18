import { describe, expect, it } from "vitest";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { createStorage } from "../../platform/storage";
import { createSettingsStore } from "../stores";
import { createSubscriptionManager, officialUrls, type FetchFn, type FetchResponse } from "./index";

const pack = (id: string, version = "1", extra: object = {}) => ({ schema: 1, id, name: id, version, ...extra });
const ok = (body: unknown, headers: Record<string, string> = {}): FetchResponse => ({
  status: 200,
  headers,
  text: typeof body === "string" ? body : JSON.stringify(body),
});

function fakeNet(routes: Record<string, (h: Record<string, string>) => FetchResponse | Error>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchFn = async (url, init) => {
    const headers = init?.headers ?? {};
    calls.push({ url, headers });
    const r = routes[url]?.(headers) ?? { status: 404, headers: {}, text: "" };
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

const HOUR = 3600_000;
function setup(routes: Parameters<typeof fakeNet>[0] = {}, now = { t: 1_000_000_000_000 }) {
  const fake = createGmStorageFake();
  const net = fakeNet(routes);
  const make = () =>
    createSubscriptionManager({ storage: createStorage(fake.tab()), fetch: net.fetch, now: () => now.t });
  return { fake, net, now, make, mgr: make() };
}

describe("subscribe (R2.1)", () => {
  it("adds a valid pack at the front of the list and returns it", async () => {
    const { mgr } = setup({ "https://a/x.json": () => ok(pack("x")), "https://a/y.json": () => ok(pack("y")) });
    expect(await mgr.subscribe("https://a/x.json")).toMatchObject({ ok: true, id: "x" });
    await mgr.subscribe("https://a/y.json");
    expect(mgr.list().map((s) => s.id)).toEqual(["y", "x"]);
    expect(mgr.sources().map((s) => (s.pack as any).id)).toEqual(["y", "x"]);
  });

  it("rejects an HTTP error with the status code and adds nothing", async () => {
    const { mgr } = setup({ "https://a/x.json": () => ({ status: 503, headers: {}, text: "" }) });
    const r = await mgr.subscribe("https://a/x.json");
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.message).toContain("503");
    expect(mgr.list()).toEqual([]);
  });

  it("rejects a network error", async () => {
    const { mgr } = setup({ "https://a/x.json": () => new Error("boom") });
    const r = await mgr.subscribe("https://a/x.json");
    expect(!r.ok && r.message).toMatch(/网络.*boom/);
  });

  it("rejects non-JSON content", async () => {
    const { mgr } = setup({ "https://a/x.json": () => ok("<html>") });
    const r = await mgr.subscribe("https://a/x.json");
    expect(!r.ok && r.message).toContain("JSON");
    expect(mgr.list()).toEqual([]);
  });

  it("rejects a schema violation naming the field path", async () => {
    const { mgr } = setup({ "https://a/x.json": () => ok({ ...pack("x"), schema: 2 }) });
    const r = await mgr.subscribe("https://a/x.json");
    if (r.ok) throw new Error("expected failure");
    expect(r.errors?.length).toBeGreaterThan(0);
    expect(r.message).toContain(r.errors![0]!.path || "规则包");
    expect(mgr.list()).toEqual([]);
  });

  it("rejects a pack nested too deeply, naming the reason", async () => {
    const deep = `{"schema":1,"id":"x","name":"x","views":{"v":{"type":"text","value":${"[".repeat(5000)}1${"]".repeat(5000)}}}}`;
    const { mgr } = setup({ "https://a/x.json": () => ok(deep) });
    const r = await mgr.subscribe("https://a/x.json");
    expect(!r.ok && r.message).toContain("64");
    expect(mgr.list()).toEqual([]);
  });

  it("refuses a pack whose id is the local rules' id", async () => {
    const { mgr } = setup({ "https://a/l.json": () => ok(pack("local")) });
    const r = await mgr.subscribe("https://a/l.json");
    expect(!r.ok && r.message).toContain("local");
    expect(mgr.list()).toEqual([]);
    mgr.seed({ commit: "c", packs: [pack("local")] });
    expect(mgr.list()).toEqual([]);
  });

  it("refuses a pack id that is already subscribed", async () => {
    const { mgr } = setup({ "https://a/x.json": () => ok(pack("x")) });
    await mgr.subscribe("https://a/x.json");
    const r = await mgr.subscribe("https://a/x.json");
    expect(!r.ok && r.message).toContain("已订阅");
    expect(mgr.list()).toHaveLength(1);
  });
});

describe("mirror order (R2.2)", () => {
  const [primary, mirror] = officialUrls("official-translate");
  it("builds the primary and jsDelivr mirror addresses", () => {
    expect(primary).toBe("https://raw.githubusercontent.com/scriptscat/companioncat-rules/main/packs/official-translate.json");
    expect(mirror).toBe("https://cdn.jsdelivr.net/gh/scriptscat/companioncat-rules@main/packs/official-translate.json");
  });

  async function seeded(routes: Parameters<typeof fakeNet>[0]) {
    const s = setup(routes);
    s.mgr.seed({ commit: "c1", packs: [pack("official-translate", "1")] });
    return s;
  }

  it("does not touch the mirror when the primary works", async () => {
    const s = await seeded({ [primary]: () => ok(pack("official-translate", "2")), [mirror]: () => ok(pack("official-translate", "9")) });
    await s.mgr.refresh("official-translate");
    expect(s.net.calls.map((c) => c.url)).toEqual([primary]);
    expect(s.mgr.get("official-translate")?.pack).toMatchObject({ version: "2" });
  });

  it("falls back to the mirror only after the primary fails", async () => {
    const s = await seeded({ [primary]: () => new Error("blocked"), [mirror]: () => ok(pack("official-translate", "3")) });
    await s.mgr.refresh("official-translate");
    expect(s.net.calls.map((c) => c.url)).toEqual([primary, mirror]);
    expect(s.mgr.get("official-translate")).toMatchObject({ pack: { version: "3" }, error: undefined });
  });
});

describe("auto update (R2.3)", () => {
  const [primary] = officialUrls("official-llm");
  const routes = () => ({ [primary]: (h: Record<string, string>) => (h["If-None-Match"] === "e1" ? { status: 304, headers: {}, text: "" } : ok(pack("official-llm", "2"), { etag: "e1", "last-modified": "Mon" })) });

  it("only checks packs that were last checked more than 24 h ago", async () => {
    const s = setup(routes());
    s.mgr.seed({ commit: "c", packs: [pack("official-llm", "1")] });
    await s.mgr.checkDue();
    expect(s.net.calls).toHaveLength(1); // never checked → due
    s.now.t += 23 * HOUR;
    await s.mgr.checkDue();
    expect(s.net.calls).toHaveLength(1);
    s.now.t += 2 * HOUR;
    await s.mgr.checkDue();
    expect(s.net.calls).toHaveLength(2);
  });

  it("sends the stored ETag and Last-Modified and keeps the pack on 304", async () => {
    const s = setup(routes());
    s.mgr.seed({ commit: "c", packs: [pack("official-llm", "1")] });
    await s.mgr.refresh("official-llm");
    expect(s.mgr.get("official-llm")?.pack).toMatchObject({ version: "2" });
    await s.mgr.refresh("official-llm");
    expect(s.net.calls[1]!.headers).toMatchObject({ "If-None-Match": "e1", "If-Modified-Since": "Mon" });
    expect(s.mgr.get("official-llm")).toMatchObject({ pack: { version: "2" }, lastChecked: s.now.t });
  });

  it("is skipped when auto update is off", async () => {
    const fake = createGmStorageFake();
    const net = fakeNet(routes());
    const mgr = createSubscriptionManager({ storage: createStorage(fake.tab()), fetch: net.fetch, autoUpdate: () => false });
    mgr.seed({ commit: "c", packs: [pack("official-llm", "1")] });
    await mgr.checkDue();
    expect(net.calls).toEqual([]);
  });

  it("fetches a due pack once when several tabs open at the same time", async () => {
    const s = setup(routes());
    s.mgr.seed({ commit: "c", packs: [pack("official-llm", "1")] });
    const tabB = s.make();
    const tabC = s.make();
    await Promise.all([s.mgr.checkDue(), tabB.checkDue(), tabC.checkDue()]);
    expect(s.net.calls).toHaveLength(1);
    // the result is visible to the other tab
    expect(tabB.get("official-llm")?.pack).toMatchObject({ version: "2" });
    // and still not due for a later tab inside the period
    await s.make().checkDue();
    expect(s.net.calls).toHaveLength(1);
  });

  it("marks a failed update, keeps the last good version and does not retry within the period", async () => {
    const s = setup({ [primary]: () => ({ status: 500, headers: {}, text: "" }) });
    s.mgr.seed({ commit: "c", packs: [pack("official-llm", "1")] });
    s.now.t += 5;
    await s.mgr.refresh("official-llm");
    const sub = s.mgr.get("official-llm")!;
    expect(sub.pack).toMatchObject({ version: "1" });
    expect(sub.error?.message).toContain("500");
    expect(sub.error?.at).toBe(s.now.t);
    expect(sub.goodAt).toBeGreaterThan(0);
    expect(sub.goodVersion).toBe("1");
    expect(s.net.calls).toHaveLength(2); // primary, then mirror
    await s.mgr.checkDue();
    expect(s.net.calls).toHaveLength(2);
  });

  it("keeps the last good pack when the new content fails the schema, then clears the mark on success", async () => {
    let bad = true;
    const s = setup({ [primary]: () => (bad ? ok({ ...pack("official-llm", "2"), schema: 7 }) : ok(pack("official-llm", "3"))) });
    s.mgr.seed({ commit: "c", packs: [pack("official-llm", "1")] });
    await s.mgr.refresh("official-llm");
    expect(s.mgr.get("official-llm")).toMatchObject({ pack: { version: "1" } });
    expect(s.mgr.get("official-llm")?.error).toBeDefined();
    bad = false;
    await s.mgr.refresh("official-llm");
    expect(s.mgr.get("official-llm")).toMatchObject({ pack: { version: "3" }, goodVersion: "3" });
    expect(s.mgr.get("official-llm")?.error).toBeUndefined();
  });

  it("a 304 that lands after another tab upgraded the pack keeps the upgrade", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup({ [primary]: () => ({ status: 304, headers: {}, text: "" }) });
    const slow: typeof s.net.fetch = async (url, init) => {
      await gate;
      return s.net.fetch(url, init);
    };
    const tabA = createSubscriptionManager({ storage: createStorage(s.fake.tab()), fetch: slow, now: () => s.now.t });
    s.mgr.seed({ commit: "c", packs: [pack("official-llm", "1")] });
    const pending = tabA.refresh("official-llm");
    s.make().seed({ commit: "c", packs: [pack("official-llm", "2")] }); // another tab upgrades meanwhile
    release();
    await pending;
    expect(s.mgr.get("official-llm")).toMatchObject({ pack: { version: "2" }, builtin: "2" });
  });

  it("rejects an updated pack whose id changed", async () => {
    const s = setup({ [primary]: () => ok(pack("other", "2")) });
    s.mgr.seed({ commit: "c", packs: [pack("official-llm", "1")] });
    await s.mgr.refresh("official-llm");
    expect(s.mgr.get("official-llm")?.error?.message).toContain("other");
  });
});

describe("manual management (R2.4)", () => {
  async function three() {
    const s = setup({ "https://a/1": () => ok(pack("a")), "https://a/2": () => ok(pack("b")), "https://a/3": () => ok(pack("c")) });
    for (const u of ["1", "2", "3"]) await s.mgr.subscribe(`https://a/${u}`);
    return s;
  }

  it("reorders subscriptions, which changes the order of sources", async () => {
    const s = await three();
    expect(s.mgr.list().map((x) => x.id)).toEqual(["c", "b", "a"]);
    s.mgr.reorder(["a", "c", "b"]);
    expect(s.mgr.sources().map((x) => (x.pack as any).id)).toEqual(["a", "c", "b"]);
    s.mgr.move("b", -1);
    expect(s.mgr.list().map((x) => x.id)).toEqual(["a", "b", "c"]);
    s.mgr.move("a", -1); // already first
    expect(s.mgr.list().map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("ignores unknown ids in reorder and keeps unlisted ones at the end", async () => {
    const s = await three();
    s.mgr.reorder(["zzz", "a"]);
    expect(s.mgr.list().map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  it("unsubscribes while keeping settings and keys, and resubscribing restores them", async () => {
    const s = await three();
    const storage = createStorage(s.fake.tab());
    const settings = createSettingsStore(storage);
    const def = { type: "string", title: "t" } as const;
    settings.set("b/f", "name", def, "kept");
    storage.set("cc:secret:b/key", "sk-1");
    expect(s.mgr.unsubscribe("b")).toBe(true);
    expect(s.mgr.list().map((x) => x.id)).toEqual(["c", "a"]);
    expect(s.mgr.sources()).toHaveLength(2);
    expect(settings.get("b/f", "name", def)).toBe("kept");
    expect(storage.get("cc:secret:b/key")).toBe("sk-1");
    await s.mgr.subscribe("https://a/2");
    expect(settings.get("b/f", "name", def)).toBe("kept");
    expect(s.mgr.unsubscribe("nope")).toBe(false);
  });

  it("exposes the subscription address to copy", async () => {
    const s = await three();
    expect(s.mgr.get("a")?.urls).toEqual(["https://a/1"]);
  });

  it("is shared between tabs and notifies listeners", async () => {
    const s = await three();
    const other = s.make();
    expect(other.list().map((x) => x.id)).toEqual(["c", "b", "a"]);
    s.mgr.unsubscribe("c");
    expect(other.list().map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("built-in snapshot (R2.2)", () => {
  const snap = (v: string, commit = "c1") => ({ commit, packs: [pack("official-translate", v), pack("official-llm", v), pack("official-skip-ads", v), pack("official-quiz", v)] });

  it("subscribes both official packs on first run without any network", () => {
    const s = setup();
    s.mgr.seed(snap("1"));
    expect(s.mgr.list().map((x) => x.id)).toEqual(["official-translate", "official-llm", "official-skip-ads", "official-quiz"]);
    expect(s.mgr.get("official-llm")).toMatchObject({ official: true, builtin: "1", urls: officialUrls("official-llm"), goodVersion: "1" });
    expect(s.mgr.sources().every((x) => x.official)).toBe(true);
    expect(s.net.calls).toEqual([]);
  });

  it("re-subscribing an official pack by its address makes it official again (R2.4, R2.5)", async () => {
    const [primary, mirror] = officialUrls("official-llm");
    const s = setup({ [primary]: () => ok(pack("official-llm", "1")) });
    s.mgr.seed(snap("1"));
    s.mgr.unsubscribe("official-llm");
    expect(await s.mgr.subscribe(primary)).toMatchObject({ ok: true, id: "official-llm" });
    expect(s.mgr.get("official-llm")).toMatchObject({ official: true, urls: [primary, mirror] });
    expect(s.mgr.sources().find((x) => (x.pack as { id: string }).id === "official-llm")?.official).toBe(true);
  });

  it("a pack from any other address is not official, whatever its id", async () => {
    const s = setup({ "https://a/llm.json": () => ok(pack("official-llm", "1")) });
    await s.mgr.subscribe("https://a/llm.json");
    expect(s.mgr.get("official-llm")?.official).toBeFalsy();
  });

  it("does not re-add an official pack the user unsubscribed", () => {
    const s = setup();
    s.mgr.seed(snap("1"));
    s.mgr.unsubscribe("official-llm");
    s.make().seed(snap("1"));
    expect(s.mgr.list().map((x) => x.id)).toEqual(["official-translate", "official-skip-ads", "official-quiz"]);
  });

  it("never re-adds a pack the user removed, even one first subscribed by address before any seed record (R8.3)", async () => {
    const s = setup({ "https://a/llm.json": () => ok(pack("official-llm", "1")) });
    await s.mgr.subscribe("https://a/llm.json");
    s.mgr.unsubscribe("official-llm");
    s.make().seed(snap("1"));
    expect(s.mgr.list().map((x) => x.id)).toEqual(["official-translate", "official-skip-ads", "official-quiz"]);
  });

  it("on upgrade adds a new official pack once, appended after the user's order and other subscriptions (R8.3)", async () => {
    const s = setup({ "https://a/mine.json": () => ok(pack("mine", "1")) });
    const old = (v: string) => ({ commit: "c", packs: [pack("official-translate", v), pack("official-llm", v)] });
    s.mgr.seed(old("1"));
    await s.mgr.subscribe("https://a/mine.json");
    s.mgr.reorder(["mine", "official-llm", "official-translate"]);
    s.make().seed(snap("1", "c2"));
    expect(s.mgr.list().map((x) => x.id)).toEqual(["mine", "official-llm", "official-translate", "official-skip-ads", "official-quiz"]);
    s.mgr.unsubscribe("official-quiz");
    s.make().seed(snap("1", "c3"));
    expect(s.mgr.list().map((x) => x.id)).not.toContain("official-quiz");
  });

  it("keeps the order and a newer cached copy when the snapshot is not newer", async () => {
    const s = setup({ [officialUrls("official-llm")[0]]: () => ok(pack("official-llm", "2026.12.1")) });
    s.mgr.seed(snap("2026.11.16"));
    s.mgr.reorder(["official-llm", "official-translate"]);
    await s.mgr.refresh("official-llm");
    s.make().seed(snap("2026.11.16"));
    s.make().seed(snap("2026.12.1", "c2"));
    expect(s.mgr.get("official-llm")?.pack).toMatchObject({ version: "2026.12.1" });
    expect(s.mgr.list().map((x) => x.id)).toEqual(["official-llm", "official-translate", "official-skip-ads", "official-quiz"]);
  });

  it("replaces the cached copy on upgrade only when the snapshot is newer", () => {
    const s = setup();
    s.mgr.seed(snap("2026.9.5"));
    s.mgr.reorder(["official-llm", "official-translate"]);
    s.make().seed(snap("2026.9.5"));
    expect(s.mgr.get("official-llm")?.pack).toMatchObject({ version: "2026.9.5" });
    s.make().seed(snap("2026.11.16", "c2")); // numeric compare: 11 > 9
    expect(s.mgr.get("official-llm")).toMatchObject({ pack: { version: "2026.11.16" }, builtin: "2026.11.16", goodVersion: "2026.11.16" });
    expect(s.mgr.list().map((x) => x.id)).toEqual(["official-llm", "official-translate", "official-skip-ads", "official-quiz"]);
    s.make().seed(snap("2026.2.1", "c0")); // older snapshot: ignored
    expect(s.mgr.get("official-llm")?.pack).toMatchObject({ version: "2026.11.16" });
  });

  it("does not touch a non-official subscription with the same kind of id", async () => {
    const s = setup({ "https://a/x": () => ok(pack("official-llm", "0")) });
    await s.mgr.subscribe("https://a/x");
    s.mgr.seed(snap("5"));
    expect(s.mgr.get("official-llm")).toMatchObject({ pack: { version: "0" } });
  });
});
