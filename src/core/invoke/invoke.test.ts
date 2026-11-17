import { afterEach, describe, expect, it, vi } from "vitest";
import { ERROR_TYPES, type ErrorType } from "../errors";
import { chooser, hello, keyedTranslator, KEY, setup, text, translates, translator, type Setup } from "./fixtures";
import type { HostConfirmRequest, UsageRecord } from "./index";

let current: Setup | undefined;
const use = (s: Setup) => ((current = s), s);
afterEach(() => {
  current?.fake.restore();
  current = undefined;
});

const settle = () => new Promise((r) => setTimeout(r, 20));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("pipeline order (R6.1)", () => {
  it("validates input first: nothing is confirmed, read from cache or sent", async () => {
    const confirmHost = vi.fn(() => true);
    const { invoker, fake } = use(setup([keyedTranslator("k")], { keys: { "test/k": KEY }, hosts: { "test/k": [] } }));
    const r = await invoker.invoke({ contract: "translate", input: { texts: [] }, engines: ["test/k"] }, { confirmHost });
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe("badInput");
    expect(r.results).toEqual([expect.objectContaining({ engine: "test/k", ok: false, error: expect.objectContaining({ type: "badInput" }) })]);
    expect(confirmHost).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it("confirms hosts before reading the cache", async () => {
    const s = use(setup([keyedTranslator("k")], { keys: { "test/k": KEY }, routes: [translates("k")] }));
    const req = { contract: "translate", input: text(), engines: ["test/k"] };
    expect((await s.invoker.invoke(req)).ok).toBe(true);
    // A rule update adds a host: the cached translation must not be served before it is confirmed.
    s.rules.providers[0] = keyedTranslator("k", { hosts: ["k.test", "new.test"] });
    const confirmHost = vi.fn(() => false);
    const r = await s.invoker.invoke(req, { confirmHost });
    expect(confirmHost).toHaveBeenCalledOnce();
    expect(r.error?.type).toBe("hostUnconfirmed");
    expect(s.fake.calls).toHaveLength(1);
  });

  it("validates output before writing the cache, and records usage last", async () => {
    const events: string[] = [];
    const s = use(setup([translator("a")], { routes: [{ url: "https://a.test/t", json: { texts: "oops" } }, translates("a")] }));
    const req = { contract: "translate", input: text(), engines: ["test/a"] };
    const onResult = () => {
      const u = s.invoker.usage().at(-1)!;
      events.push(`usage:${u.ok}:${u.cached}`, "result");
    };
    expect((await s.invoker.invoke(req, { onResult })).error?.type).toBe("badOutput");
    expect(s.invoker.cacheStats().entries).toBe(0);
    expect((await s.invoker.invoke(req, { onResult })).output).toEqual({ texts: ["a:hello"] });
    expect((await s.invoker.invoke(req, { onResult })).cached).toBe(true);
    expect(s.fake.calls).toHaveLength(2);
    expect(events).toEqual(["usage:false:false", "result", "usage:true:false", "result", "usage:true:true", "result"]);
  });
});

describe("error types (R6.3)", () => {
  const route = (status: number) => ({ url: "https://a.test/t", status, json: {} });
  const cases: [ErrorType, () => Setup, string?][] = [
    ["network", () => setup([translator("a")], { routes: [{ url: "https://a.test/t", error: "network" }] })],
    ["timeout", () => setup([translator("a")], { routes: [{ url: "https://a.test/t", error: "timeout" }] })],
    ["auth", () => setup([translator("a")], { routes: [route(401)] })],
    ["rateLimit", () => setup([translator("a")], { routes: [route(429)] })],
    ["server", () => setup([translator("a")], { routes: [route(503)] })],
    ["badInput", () => setup([translator("a")]), "bad"],
    ["badOutput", () => setup([translator("a")], { routes: [{ url: "https://a.test/t", json: { texts: 1 } }] })],
    ["hostUndeclared", () => setup([translator("a", { hosts: ["other.test"] })])],
    ["hostUnconfirmed", () => setup([keyedTranslator("a")], { keys: { "test/a": KEY }, hosts: { "test/a": [] } })],
    ["missingKey", () => setup([keyedTranslator("a")])],
    ["disabled", () => setup([translator("a")])],
  ];

  it("covers every type", () => {
    expect(cases.map(([t]) => t).sort()).toEqual(Object.keys(ERROR_TYPES).sort());
  });

  it.each(cases)("surfaces %s as the engine's error", async (type, make, input) => {
    const s = use(make());
    if (type === "disabled") s.secrets.setDisabled("test/a", true);
    const r = await s.invoker.invoke(
      { contract: "translate", input: input === "bad" ? { texts: "x" } : text(), engines: ["test/a"] },
      { confirmHost: () => false },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ type, message: expect.any(String) });
    expect(r.results[0]).toMatchObject({ engine: "test/a", ok: false, error: { type } });
  });

  it("R10.5/R7.3: an engine stopped because its key was deleted reports the missing key, not disabled", async () => {
    const s = use(setup([keyedTranslator("a")], { keys: { "test/a": KEY } }));
    s.secrets.delete("test/a", "apiKey");
    expect(s.secrets.isDisabled("test/a")).toBe(true);
    const r = await s.invoker.invoke({ contract: "translate", input: text(), engines: ["test/a"] });
    expect(r.results[0]).toMatchObject({ engine: "test/a", ok: false, error: { type: "missingKey" } });
    expect(s.fake.calls).toEqual([]);
  });

  it("reports unknown engines and contracts as disabled", async () => {
    const s = use(setup([translator("a")]));
    expect((await s.invoker.invoke({ contract: "translate", input: text(), engines: ["test/nope"] })).error?.type).toBe("disabled");
    expect((await s.invoker.invoke({ contract: "nope", input: {}, engines: ["test/a"] })).error?.type).toBe("disabled");
    expect((await s.invoker.invoke({ contract: "chat", input: hello, engines: ["test/a"] })).error?.type).toBe("disabled");
    expect(s.fake.calls).toEqual([]);
  });
});

describe("host confirmation (R7.4, R7.5)", () => {
  const unconfirmed = (extra: Parameters<typeof setup>[1] = {}) =>
    use(setup([keyedTranslator("k")], { keys: { "test/k": KEY }, hosts: { "test/k": [] }, routes: [translates("k")], ...extra }));
  const req = { contract: "translate", input: text(), engines: ["test/k"] };

  it("pauses until the user allows, sends nothing meanwhile, then records the host", async () => {
    const s = unconfirmed();
    const answer = deferred<boolean>();
    const asked: HostConfirmRequest[] = [];
    const pending = s.invoker.invoke(req, { confirmHost: (q) => (asked.push(q), answer.promise) });
    await settle();
    expect(asked).toEqual([{ provider: s.rules.providers[0], hosts: ["k.test"], confirmed: [] }]);
    expect(s.fake.calls).toEqual([]);
    answer.resolve(true);
    const r = await pending;
    expect(r).toMatchObject({ ok: true, output: { texts: ["k:hello"] } });
    expect(s.fake.calls).toHaveLength(1);
    expect(s.secrets.hostsConfirmed("test/k")).toEqual(["k.test"]);
  });

  it("fails with hostUnconfirmed and disables the engine when the user refuses", async () => {
    const s = unconfirmed();
    const r = await s.invoker.invoke(req, { confirmHost: () => Promise.resolve(false) });
    expect(r.error).toMatchObject({ type: "hostUnconfirmed", detail: { host: "k.test" } });
    expect(s.fake.calls).toEqual([]);
    expect(s.secrets.isDisabled("test/k")).toBe(true);
    expect(s.secrets.hostsConfirmed("test/k")).toEqual([]);
    const confirmHost = vi.fn(() => true);
    expect((await s.invoker.invoke(req, { confirmHost })).error?.type).toBe("disabled");
    expect(confirmHost).not.toHaveBeenCalled();
  });

  it("fails without asking or disabling when there is no confirm hook", async () => {
    const s = unconfirmed();
    expect((await s.invoker.invoke(req)).error?.type).toBe("hostUnconfirmed");
    expect(s.fake.calls).toEqual([]);
    expect(s.secrets.isDisabled("test/k")).toBe(false);
  });

  it("uses the invoker's default hook, asks once for concurrent calls and never for confirmed or keyless engines", async () => {
    const answer = deferred<boolean>();
    const confirmHost = vi.fn(() => answer.promise);
    const s = use(
      setup([keyedTranslator("k"), keyedTranslator("ok"), translator("free")], {
        keys: { "test/k": KEY, "test/ok": KEY },
        hosts: { "test/k": [] },
        routes: [translates("k"), translates("ok"), translates("free")],
        deps: { confirmHost },
      }),
    );
    const both = [s.invoker.invoke(req), s.invoker.invoke({ ...req, input: text("other") })];
    await settle();
    expect(confirmHost).toHaveBeenCalledOnce();
    answer.resolve(true);
    expect((await Promise.all(both)).map((r) => r.ok)).toEqual([true, true]);
    for (const engine of ["test/ok", "test/free"]) {
      expect((await s.invoker.invoke({ ...req, engines: [engine] })).ok).toBe(true);
    }
    expect(confirmHost).toHaveBeenCalledOnce();
  });

  it("lets a pending confirmation be cancelled", async () => {
    const s = unconfirmed();
    const ctrl = new AbortController();
    const pending = s.invoker.invoke(req, { confirmHost: () => new Promise<boolean>(() => {}), signal: ctrl.signal });
    await settle();
    ctrl.abort(new Error("closed"));
    await expect(pending).rejects.toThrow("closed");
    expect(s.fake.calls).toEqual([]);
  });
});

describe("preferred engine per capability (R5.7)", () => {
  const engines = () => [translator("free"), keyedTranslator("keyed"), keyedTranslator("nokey"), chooser("pick")];

  it("puts the chosen engine first, then every other ready engine", () => {
    const s = use(setup(engines(), { keys: { "test/keyed": KEY }, deps: { preferred: (c) => (c === "translate" ? "test/keyed" : undefined) } }));
    expect(s.invoker.preferredEngines("translate")).toEqual({ engines: ["test/keyed", "test/free"], preferred: "test/keyed", using: "test/keyed" });
    expect(s.invoker.preferredEngines("choose")).toEqual({ engines: ["test/pick"], using: "test/pick" });
  });

  it("falls back to the next engine that has a key, with a notice", () => {
    const s = use(setup(engines(), { keys: { "test/keyed": KEY }, deps: { preferred: () => "test/nokey" } }));
    expect(s.invoker.preferredEngines("translate")).toEqual({
      engines: ["test/free", "test/keyed"],
      preferred: "test/nokey",
      using: "test/free",
      notice: "还没填 Key，现在先用「FREE」",
    });
  });

  it("skips disabled engines and keeps a keyless choice when nothing else is ready", () => {
    const s = use(setup([keyedTranslator("nokey"), translator("off")], { deps: { preferred: () => "test/nokey" } }));
    s.secrets.setDisabled("test/off", true);
    expect(s.invoker.preferredEngines("translate")).toEqual({ engines: ["test/nokey"], preferred: "test/nokey", notice: "还没填 Key" });
    expect(s.invoker.preferredEngines("chat")).toEqual({ engines: [] });
  });

  it("is what invoke uses when no engines are given, with the first strategy", async () => {
    const s = use(
      setup(engines(), {
        keys: { "test/keyed": KEY },
        routes: [{ url: "https://free.test/t", status: 503 }, translates("keyed")],
        deps: { preferred: () => "test/nokey" },
      }),
    );
    const r = await s.invoker.invoke({ contract: "translate", input: text() });
    expect(r).toMatchObject({ ok: true, strategy: "first", engine: "test/keyed", notice: "还没填 Key，现在先用「FREE」" });
    expect(r.results.map((x) => [x.engine, x.ok])).toEqual([
      ["test/free", false],
      ["test/keyed", true],
    ]);
  });

  it("reports when no engine can serve the capability", async () => {
    const s = use(setup([]));
    expect((await s.invoker.invoke({ contract: "translate", input: text() })).error?.type).toBe("disabled");
  });
});

describe("usage log (R6.5)", () => {
  it("records engine, contract, time, cache hit and tokens when the service reports them", async () => {
    const p = translator("u");
    (p.def.implements.translate as { http: { output: unknown } }).http.output = {
      texts: "{{ response.texts }}",
      usage: "{{ response.usage }}",
    };
    const s = use(
      setup([p, translator("a")], {
        routes: [{ url: "https://u.test/t", json: { texts: ["x"], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } } }, translates("a")],
      }),
    );
    await s.invoker.invoke({ contract: "translate", input: text(), engines: ["test/u"] });
    await s.invoker.invoke({ contract: "translate", input: text(), engines: ["test/a"] });
    await s.invoker.invoke({ contract: "translate", input: text(), engines: ["test/a"] });
    const records: UsageRecord[] = s.invoker.usage();
    expect(records).toEqual([
      { at: expect.any(Number), engine: "test/u", contract: "translate", ms: expect.any(Number), cached: false, ok: true, tokens: 7 },
      { at: expect.any(Number), engine: "test/a", contract: "translate", ms: expect.any(Number), cached: false, ok: true },
      { at: expect.any(Number), engine: "test/a", contract: "translate", ms: expect.any(Number), cached: true, ok: true },
    ]);
  });

  it("records failures with their type", async () => {
    const s = use(setup([translator("a")], { routes: [{ url: "https://a.test/t", status: 401 }] }));
    await s.invoker.invoke({ contract: "translate", input: text(), engines: ["test/a"] });
    expect(s.invoker.usage()).toEqual([expect.objectContaining({ engine: "test/a", ok: false, errorType: "auth", cached: false })]);
  });
});
