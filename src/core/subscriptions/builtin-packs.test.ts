import { describe, expect, it } from "vitest";
import { commit, packs } from "virtual:builtin-packs";
import official from "../../../build/builtin-packs";
import { validatePack } from "../rules";
import { createSubscriptionManager } from "./index";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { createStorage } from "../../platform/storage";
import fs from "node:fs";

describe("virtual:builtin-packs", () => {
  it("bakes the packs in rules/packs with a commit marker", () => {
    expect(packs.map((p: any) => p.id).sort()).toEqual(["official-llm", "official-translate"]);
    for (const p of packs) expect(validatePack(p).ok).toBe(true);
    expect(commit).toMatch(/^[0-9a-f]{7,40}$/);
    const onDisk = JSON.parse(fs.readFileSync("rules/packs/official-llm.json", "utf8"));
    expect(packs.find((p: any) => p.id === "official-llm")).toEqual(onDisk);
  });

  it("is a vite plugin resolving only its own virtual id", () => {
    const plugin = official() as any;
    expect(plugin.resolveId("virtual:builtin-packs")).toBe("\0virtual:builtin-packs");
    expect(plugin.resolveId("other")).toBeUndefined();
    expect(plugin.load.call({ addWatchFile() {} }, "\0virtual:builtin-packs")).toContain("official-translate");
    expect(plugin.load.call({ addWatchFile() {} }, "other")).toBeUndefined();
  });

  it("seeds a manager end to end", () => {
    const mgr = createSubscriptionManager({ storage: createStorage(createGmStorageFake().tab()), fetch: async () => ({ status: 404, headers: {}, text: "" }) });
    mgr.seed({ commit, packs });
    expect(mgr.list().map((s) => s.id).sort()).toEqual(["official-llm", "official-translate"]);
  });
});
