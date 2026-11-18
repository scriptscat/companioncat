import { beforeEach, describe, expect, it } from "vitest";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import type { EntryDef, ResolvedEntry } from "../../core/rules/types";
import { createStorage } from "../../platform/storage";
import { consentKey, disable, enableWithConsent, fingerprint, gateOf } from "./enabled";

const resolved = (def: unknown): ResolvedEntry => ({ ref: "p/f.e", id: "e", pack: "p", source: 0, enabled: true, problems: [], def: def as EntryDef });

const auto = (act: string, extra: Record<string, unknown> = {}) => ({
  id: "e",
  triggers: [{ on: "appear", selector: "button" }],
  run: [{ find: "button", as: "b" }, { act, target: "{{ vars.b }}", minConfidence: "{{ settings.t }}", confidence: "{{ 1 }}", ...extra }],
});
const withAsk = (host: string) => ({
  id: "e",
  settings: { engine: { type: "engine", title: "e", capability: "choose" } },
  run: [{ ask: "choose", engine: "x/y", input: { question: "q", options: [] }, as: "r" }],
  // hosts come from the describe ctx
  _host: host,
});
const ctxFor = (host: string) => ({ providers: [{ ref: "x/y", id: "y", def: { id: "y", name: "Y", hosts: [host], implements: {} } }] as never, hosts: { "x/y": [host] } });
const selection = { id: "e", triggers: [{ on: "selection" }], run: [{ call: "c" }], present: { surface: { type: "near-selection" } } };

let storage: ReturnType<typeof createStorage>;
beforeEach(() => {
  storage = createStorage(createGmStorageFake().tab());
});

describe("automation gate (R3.1, R3.3, R3.4, R3.5)", () => {
  it("R3.1: a subscribed automation entry is not on until consent", () => {
    expect(gateOf(storage, resolved(auto("click")))).toBe("needs-consent");
  });

  it("R3.4: a local automation entry is on without consent", () => {
    expect(gateOf(storage, resolved(auto("click")), { local: true })).toBe("on");
    expect(storage.keys("cc:auto:")).toEqual([]);
  });

  it("enableWithConsent records the fingerprint and turns it on; disable turns it off, keeping consent", () => {
    const e = resolved(auto("click"));
    const fp = fingerprint(e.def);
    enableWithConsent(storage, e.ref, fp);
    expect(storage.get(consentKey(e.ref))).toBe(fp);
    expect(gateOf(storage, e)).toBe("on");
    disable(storage, e.ref);
    expect(gateOf(storage, e)).toBe("off");
    expect(storage.get(consentKey(e.ref))).toBe(fp);
    enableWithConsent(storage, e.ref, fp);
    expect(gateOf(storage, e)).toBe("on");
  });

  it("consent lives outside cc:set: and cc:on:", () => {
    expect(consentKey("p/f.e").startsWith("cc:auto:consent:")).toBe(true);
  });

  it("R3.3: changed act kinds pause the entry until reconsent", () => {
    const old = resolved(auto("click"));
    enableWithConsent(storage, old.ref, fingerprint(old.def));
    const updated = resolved(auto("fill"));
    expect(gateOf(storage, updated)).toBe("paused-by-update");
    enableWithConsent(storage, updated.ref, fingerprint(updated.def));
    expect(gateOf(storage, updated)).toBe("on");
  });

  it("R3.3: changed send hosts pause the entry", () => {
    const e = resolved(withAsk("a.test"));
    enableWithConsent(storage, e.ref, fingerprint(e.def, ctxFor("a.test")));
    expect(gateOf(storage, e, { describe: ctxFor("a.test") })).toBe("on");
    expect(gateOf(storage, e, { describe: ctxFor("b.test") })).toBe("paused-by-update");
  });

  it("text-only and threshold changes keep it on", () => {
    const old = resolved(auto("click"));
    enableWithConsent(storage, old.ref, fingerprint(old.def));
    const edited = resolved({ ...auto("click", { minConfidence: "{{ 0.5 }}" }), name: "新名字", description: "x" });
    expect(gateOf(storage, edited)).toBe("on");
  });

  it("the fingerprint is the sorted act kinds plus the sorted hosts", () => {
    const e = { id: "e", run: [{ act: "fill", target: "x" }, { act: "click", target: "x" }, { ask: "choose", engine: "x/y", input: {}, as: "r" }] } as never;
    expect(fingerprint(e, { ...ctxFor("z.test"), hosts: { "x/y": ["z.test", "a.test"] } })).toBe("acts:click,fill|hosts:a.test,z.test");
  });

  it("a user who switched a local automation entry off keeps it off", () => {
    const e = resolved(auto("click"));
    disable(storage, e.ref);
    expect(gateOf(storage, e, { local: true })).toBe("off");
  });

  it("R3.5: a non-automation entry defaults on and keeps phase-1 switching, subscribed or not", () => {
    const e = resolved(selection);
    expect(gateOf(storage, e)).toBe("on");
    disable(storage, e.ref);
    expect(gateOf(storage, e)).toBe("off");
    expect(storage.get("cc:on:p/f.e")).toBe(false);
  });
});
