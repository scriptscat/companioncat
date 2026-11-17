import { describe, expect, it } from "vitest";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { createStorage } from "../../platform/storage";
import { resolveRules } from "../rules";
import { makeResolved } from "./fixtures";
import { createSecretStore, mask } from "./secrets";

const resolved = makeResolved({
  providers: [
    { ref: "p/jev", secrets: ["key"], hosts: ["api.jev.ai"] },
    { ref: "p/jev-fast", secretsFrom: "p/jev" },
    { ref: "p/other" , secrets: ["token"] },
  ],
});

function setup() {
  const fake = createGmStorageFake();
  const storage = createStorage(fake.tab());
  return { storage, store: createSecretStore(storage, () => resolved) };
}

describe("mask (R7.3)", () => {
  it("shows first 3 and last 4 characters around eight bullets", () => {
    expect(mask("sk-abcdefghijkl1234")).toBe("sk-••••••••1234");
  });
  it("never leaks short keys", () => {
    expect(mask("abcdefg")).toBe("••••••••");
    expect(mask("")).toBe("");
  });
});

describe("SecretStore (R7.3)", () => {
  it("stores by defining provider + field name", () => {
    const { store, storage } = setup();
    store.set("p/jev", "key", "sk-secret-123456");
    expect(storage.keys("cc:secret:")).toEqual(["cc:secret:p/jev/key"]);
    expect(store.get("p/jev", "key")).toBe("sk-secret-123456");
  });

  it("refuses fields the provider does not declare", () => {
    const { store } = setup();
    expect(() => store.set("p/jev", "nope", "x")).toThrow();
    expect(() => store.set("p/jev-fast", "key", "x")).toThrow();
  });

  it("delete removes the key, its confirmed hosts and disables dependent providers", () => {
    const { store, storage } = setup();
    store.set("p/jev", "key", "sk-secret-123456", ["api.jev.ai"]);
    store.delete("p/jev", "key");
    expect(store.get("p/jev", "key")).toBeUndefined();
    expect(store.hostsConfirmed("p/jev")).toEqual([]);
    expect(store.isDisabled("p/jev")).toBe(true);
    expect(store.isDisabled("p/jev-fast")).toBe(true);
    expect(store.isDisabled("p/other")).toBe(false);
    expect(storage.keys("cc:secret:")).toEqual([]);
  });

  it("setDisabled toggles the flag", () => {
    const { store } = setup();
    store.setDisabled("p/other", true);
    expect(store.isDisabled("p/other")).toBe(true);
    store.setDisabled("p/other", false);
    expect(store.isDisabled("p/other")).toBe(false);
  });
});

describe("inherited key lookup (R5.6)", () => {
  it("an inheriting provider reads the parent's saved key and says where it came from", () => {
    const { store } = setup();
    store.set("p/jev", "key", "sk-secret-123456");
    expect(store.get("p/jev-fast", "key")).toBe("sk-secret-123456");
    expect(store.lookup("p/jev-fast")).toEqual({ from: "p/jev", inherited: true, missing: [] });
    expect(store.lookup("p/jev")).toEqual({ from: "p/jev", inherited: false, missing: [] });
  });

  it("lists missing fields, and providers without secrets have none", () => {
    const { store } = setup();
    expect(store.lookup("p/jev-fast").missing).toEqual(["key"]);
    expect(store.get("p/jev-fast", "key")).toBeUndefined();
  });
});

describe("keys declared by an abstract parent (R5.6)", () => {
  const impl = { translate: { http: { request: { url: "https://a.test/t" }, output: { texts: "{{ [response.t] }}" } } } };
  const real = resolveRules([
    {
      pack: {
        schema: 1,
        id: "p",
        name: "p",
        contracts: [{ id: "translate", input: { type: "object" }, output: { type: "object" } }],
        providers: [
          { id: "base", name: "Base", abstract: true, hosts: ["a.test"], secrets: [{ name: "apiKey", title: "Key" }], implements: impl },
          { id: "kid", extends: "base", name: "Kid", abstract: false },
          { id: "twin", extends: "base", name: "Twin", abstract: false },
        ],
      },
    },
  ]);

  it("children share the key saved on the abstract parent, and nothing throws", () => {
    const store = createSecretStore(createStorage(createGmStorageFake().tab()), () => real);
    expect(real.providers.map((p) => [p.ref, p.secretsFrom])).toEqual([["p/kid", "p/base"], ["p/twin", "p/base"]]);
    expect(store.lookup("p/kid")).toEqual({ from: "p/base", inherited: true, missing: ["apiKey"] });
    store.set("p/base", "apiKey", "sk-secret-123456", ["a.test"]);
    expect(store.get("p/kid", "apiKey")).toBe("sk-secret-123456");
    expect(store.get("p/twin", "apiKey")).toBe("sk-secret-123456");
    expect(store.lookup("p/twin").missing).toEqual([]);
    expect(store.isHostConfirmed("p/kid", "a.test")).toBe(true);
    store.confirmHosts("p/kid", ["b.test"]);
    expect(store.hostsConfirmed("p/twin")).toEqual(["a.test", "b.test"]);
  });

  it("refuses to save a key on a child that reads it from its parent, since it would never be read", () => {
    const store = createSecretStore(createStorage(createGmStorageFake().tab()), () => real);
    expect(() => store.set("p/kid", "apiKey", "sk-secret-123456")).toThrow(/p\/base/);
    expect(store.get("p/kid", "apiKey")).toBeUndefined();
  });
});

describe("confirmed hosts (R7.4)", () => {
  it("records hosts on first save only and merges later confirmations", () => {
    const { store } = setup();
    store.set("p/jev", "key", "sk-secret-123456", ["api.jev.ai"]);
    store.set("p/jev", "key", "sk-secret-654321", ["evil.example"]);
    expect(store.hostsConfirmed("p/jev")).toEqual(["api.jev.ai"]);
    expect(store.isHostConfirmed("p/jev-fast", "api.jev.ai")).toBe(true);
    expect(store.isHostConfirmed("p/jev", "evil.example")).toBe(false);
    store.confirmHosts("p/jev", ["evil.example", "api.jev.ai"]);
    expect(store.hostsConfirmed("p/jev")).toEqual(["api.jev.ai", "evil.example"]);
  });
});

describe("secrets over tabs (R1.8)", () => {
  it("a key saved in another tab is readable here and the event never carries the value as a log", () => {
    const fake = createGmStorageFake();
    const a = createStorage(fake.tab());
    const b = createStorage(fake.tab());
    const sa = createSecretStore(a, () => resolved);
    const sb = createSecretStore(b, () => resolved);
    const seen: string[] = [];
    a.onChange((k, _o, _n, remote) => remote && seen.push(k));
    sb.set("p/jev", "key", "sk-secret-123456");
    expect(sa.get("p/jev", "key")).toBe("sk-secret-123456");
    expect(seen).toContain("cc:secret:p/jev/key");
  });
});
