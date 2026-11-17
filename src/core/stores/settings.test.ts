import { describe, expect, it } from "vitest";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { createStorage } from "../../platform/storage";
import { makeResolved } from "./fixtures";
import { createSettingsStore } from "./settings";

const defs = {
  on: { type: "boolean", title: "on", default: true },
  mode: { type: "enum", title: "mode", options: { a: "A", b: "B" }, default: "a" },
  n: { type: "number", title: "n", min: 1, max: 5, default: 3 },
  zoom: { type: "number", title: "zoom", scope: "site", default: 1 },
} as const;

function setup(settings: Record<string, any> = defs) {
  const fake = createGmStorageFake();
  const storage = createStorage(fake.tab());
  const store = createSettingsStore(storage);
  return { fake, storage, store, resolved: makeResolved({ settings, entrySettings: { e: { type: "string", title: "e", default: "x" } } }) };
}

describe("SettingsStore key layout (R9.3)", () => {
  it("keys settings by pack/feature, entry and setting name", () => {
    const { store, storage } = setup();
    store.set("p/translate", "mode", defs.mode, "b");
    store.set("p/translate.select", "e", { type: "string", title: "e" }, "hi");
    expect(storage.keys("cc:set:").sort()).toEqual([
      "cc:set:p/translate.select/e",
      "cc:set:p/translate/mode",
    ]);
  });

  it("returns the default until a valid value is stored", () => {
    const { store } = setup();
    expect(store.get("p/translate", "mode", defs.mode)).toBe("a");
    store.set("p/translate", "mode", defs.mode, "b");
    expect(store.get("p/translate", "mode", defs.mode)).toBe("b");
  });

  it("rejects values that do not fit the type", () => {
    const { store } = setup();
    expect(store.set("p/translate", "mode", defs.mode, "zzz")).toBe(false);
    expect(store.set("p/translate", "n", defs.n, 9)).toBe(false);
    expect(store.get("p/translate", "n", defs.n)).toBe(3);
  });

  it("stores scope:site settings per hostname", () => {
    const { store, storage } = setup();
    store.set("p/translate", "zoom", defs.zoom, 2, "a.com");
    store.set("p/translate", "zoom", defs.zoom, 4, "b.com");
    expect(store.get("p/translate", "zoom", defs.zoom, "a.com")).toBe(2);
    expect(store.get("p/translate", "zoom", defs.zoom, "b.com")).toBe(4);
    expect(store.get("p/translate", "zoom", defs.zoom, "c.com")).toBe(1);
    expect(storage.keys("cc:set:").sort()).toEqual([
      "cc:set:p/translate/zoom@a.com",
      "cc:set:p/translate/zoom@b.com",
    ]);
  });

  it("ignores the hostname for global settings and requires it for site ones", () => {
    const { store } = setup();
    store.set("p/translate", "mode", defs.mode, "b", "a.com");
    expect(store.get("p/translate", "mode", defs.mode, "z.com")).toBe("b");
    expect(() => store.set("p/translate", "zoom", defs.zoom, 2)).toThrow();
  });
});

describe("migrate on rule update (R9.4)", () => {
  it("keeps valid values, drops removed settings, resets invalid or retyped ones", () => {
    const { store, storage } = setup();
    store.set("p/translate", "on", defs.on, false);
    store.set("p/translate", "mode", defs.mode, "b");
    store.set("p/translate", "n", defs.n, 5);
    store.set("p/translate", "zoom", defs.zoom, 2, "a.com");
    storage.set("cc:set:p/translate/gone", 1);
    storage.set("cc:set:p/removedfeature/x", 1);
    storage.set("cc:set:other/f/x", 1);

    // update: enum lost "b", n became boolean, `on` unchanged, `gone` removed, new setting `fresh`
    const next = makeResolved({
      settings: {
        on: defs.on,
        mode: { type: "enum", title: "mode", options: { a: "A", c: "C" }, default: "a" },
        n: { type: "boolean", title: "n", default: false },
        zoom: defs.zoom,
        fresh: { type: "string", title: "f", default: "d" },
      },
    });
    const report = store.migrate(next);
    expect(storage.get("cc:set:p/translate/on")).toBe(false);
    expect(storage.get("cc:set:p/translate/zoom@a.com")).toBe(2);
    expect(storage.get("cc:set:p/translate/mode")).toBeUndefined();
    expect(storage.get("cc:set:p/translate/n")).toBeUndefined();
    expect(storage.get("cc:set:p/translate/gone")).toBeUndefined();
    expect(storage.get("cc:set:p/removedfeature/x")).toBeUndefined();
    expect(storage.get("cc:set:p/translate/fresh")).toBeUndefined();
    expect(store.get("p/translate", "fresh", next.features[0]!.def.settings!.fresh!)).toBe("d");
    // a pack that is not in the resolved set at all (unsubscribed or not loaded) is left alone
    expect(storage.get("cc:set:other/f/x")).toBe(1);
    expect(report.removed.length).toBe(2);
    expect(report.reset.length).toBe(2);
  });
});

describe("migrate when only the type changed (R9.4)", () => {
  it("resets a value whose setting changed type even when the old value still fits the new type", () => {
    const { store, storage } = setup();
    const before = makeResolved({ settings: { style: { type: "string", title: "s", default: "x" } } });
    store.migrate(before);
    store.set("p/translate", "style", before.features[0]!.def.settings!.style!, "a");
    const after = makeResolved({ settings: { style: { type: "enum", title: "s", options: { a: "A", b: "B" }, default: "b" } } });
    const report = store.migrate(after);
    expect(storage.get("cc:set:p/translate/style")).toBeUndefined();
    expect(report.reset).toEqual(["cc:set:p/translate/style"]);
    expect(store.get("p/translate", "style", after.features[0]!.def.settings!.style!)).toBe("b");
    // the new type is remembered: a value set now survives the next update with the same type
    store.set("p/translate", "style", after.features[0]!.def.settings!.style!, "a");
    expect(store.migrate(after).reset).toEqual([]);
    expect(storage.get("cc:set:p/translate/style")).toBe("a");
  });
});

describe("cross-tab change events (R1.8)", () => {
  it("reports local writes as local and other-tab writes as remote", () => {
    const fake = createGmStorageFake();
    const a = createStorage(fake.tab());
    const b = createStorage(fake.tab());
    const events: unknown[] = [];
    a.onChange((key, _o, n, remote) => key.startsWith("cc:set:") && events.push([key, n, remote]));
    const sa = createSettingsStore(a);
    const sb = createSettingsStore(b);
    sa.set("p/translate", "mode", defs.mode, "b");
    sb.set("p/translate", "on", defs.on, false);
    sb.set("p/translate", "zoom", defs.zoom, 2, "a.com");
    expect(events).toEqual([
      ["cc:set:p/translate/mode", "b", false],
      ["cc:set:p/translate/on", false, true],
      ["cc:set:p/translate/zoom@a.com", 2, true],
    ]);
    expect(sa.get("p/translate", "on", defs.on)).toBe(false);
  });

  it("reports remote deletions", () => {
    const fake = createGmStorageFake();
    const a = createStorage(fake.tab());
    const b = createStorage(fake.tab());
    b.set("cc:x", 1);
    const events: unknown[] = [];
    a.onChange((key, o, n, remote) => events.push([key, o, n, remote]));
    b.delete("cc:x");
    expect(events).toEqual([["cc:x", 1, undefined, true]]);
  });
});
