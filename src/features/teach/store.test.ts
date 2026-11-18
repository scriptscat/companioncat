import { describe, expect, it, vi } from "vitest";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { composeApp } from "../../app/app";
import { createRulesSource } from "../../app/rules-source";
import { isAutomationEntry } from "../../core/rules/automation";
import { createStorage } from "../../platform/storage";
import { LOCAL_RULES_KEY } from "../../pages/rules/RulesPage";
import { enabledKey, gateOf } from "../page/enabled";
import { fromJSON, type SavedConversation, type Version } from "./conversation";
import {
  HAND_EDIT_TURN,
  UNSAVED_KEY,
  deleteTeachRule,
  discardUnsaved,
  isHandEdited,
  listTeachRules,
  loadConversation,
  loadUnsaved,
  pruneTeachRecords,
  saveDraft,
  saveUnsaved,
  teachKey,
  watchTeachRecords,
} from "./store";

const draft = (name = "自动展开全文", id = "auto-expand") => ({
  id,
  name,
  match: ["*://news.example.cn/*"],
  entries: [
    {
      id: "expand",
      name: "展开全文",
      triggers: [{ on: "page-load" }],
      run: [
        { find: "article > .fold-btn", as: "fold" },
        { act: "click", target: "{{ vars.fold }}" },
      ],
    },
  ],
});

const version = (n: number, d: unknown): Version => ({ n, draft: d, turn: `t${n}`, at: n });
const saved = (drafts: unknown[], current = drafts.length): SavedConversation => ({
  v: 1,
  turns: drafts.map((_, i) => ({
    id: `t${i + 1}`,
    at: i + 1,
    kind: "message",
    text: `第 ${i + 1} 句`,
    attachments: [],
    base: i,
    status: "done",
    version: i + 1,
  })),
  versions: drafts.map((d, i) => version(i + 1, d)),
  current,
});
const conv = (s: SavedConversation) => ({ toJSON: () => structuredClone(s) });

/** Hand-written local rules the teach saves must leave alone. */
const HAND = JSON.stringify(
  {
    schema: 1,
    id: "local",
    features: [{ ...draft("我写的"), id: "mine" }],
    overrides: { "official-translate/translate": { name: "改过的名字" } },
  },
  null,
  2,
);

function setup(local?: string) {
  const gm = createGmStorageFake();
  const storage = createStorage(gm.tab());
  if (local !== undefined) storage.set(LOCAL_RULES_KEY, local);
  const localPack = () => JSON.parse(storage.get<string>(LOCAL_RULES_KEY)!) as { features: { id: string; name: string }[] };
  return { gm, storage, localPack };
}

const ok = <T extends { ok: boolean }>(r: T) => {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r as Extract<T, { ok: true }>;
};

describe("saveDraft: the first save", () => {
  it("appends a new teach-<slug> feature, keeps the other rules and stores the conversation under cc:teach:<id> (R6.7, R6.8)", () => {
    const { storage, localPack } = setup(HAND);
    const c = saved([draft()]);
    const { featureId } = ok(saveDraft(storage, conv(c), draft()));
    expect(featureId).toBe("teach-auto-expand");
    const pack = localPack();
    expect(pack.features.map((f) => f.id)).toEqual(["mine", "teach-auto-expand"]);
    expect(pack.features[1]).toEqual({ ...draft(), id: "teach-auto-expand" });
    expect({ ...pack, features: pack.features.slice(0, 1) }).toEqual(JSON.parse(HAND));
    expect(storage.get(teachKey(featureId))).toEqual(c);
  });

  it("creates the local pack when there are no local rules yet", () => {
    const { storage, localPack } = setup();
    const { featureId } = ok(saveDraft(storage, conv(saved([draft()])), draft()));
    expect(localPack()).toEqual({ schema: 1, id: "local", features: [{ ...draft(), id: featureId }] });
  });

  it("never reuses an id taken by a feature, an orphan conversation or a leftover off switch", () => {
    const { storage } = setup(HAND);
    storage.set(teachKey("teach-auto-expand"), saved([]));
    storage.set(enabledKey("local/teach-auto-expand-2.expand"), false);
    const a = ok(saveDraft(storage, conv(saved([draft()])), draft()));
    expect(a.featureId).toBe("teach-auto-expand-3");
    const b = ok(saveDraft(storage, conv(saved([draft()])), draft()));
    expect(b.featureId).toBe("teach-auto-expand-4");
  });

  it("is on straight away: local automation needs no consent and the rules re-resolve (R3.4)", () => {
    const { storage } = setup(HAND);
    const rules = createRulesSource(storage, { sources: () => [] });
    const changed = vi.fn();
    rules.subscribe(changed);
    storage.set(enabledKey("local/teach-auto-expand.expand"), false); // a deleted rule's switch
    const { featureId } = ok(saveDraft(storage, conv(saved([draft()])), draft()));
    expect(changed).toHaveBeenCalled();
    const entry = rules.get().features.find((f) => f.ref === `local/${featureId}`)!.entries[0]!;
    expect(isAutomationEntry(entry.def)).toBe(true);
    expect(gateOf(storage, entry, { local: true })).toBe("on");
    rules.dispose();
  });

  it("refuses to touch invalid local rules or write a draft the local pack cannot hold", () => {
    const { storage } = setup("{ broken");
    const r = saveDraft(storage, conv(saved([draft()])), draft());
    expect(r).toEqual({ ok: false, error: expect.stringContaining("JSON") });
    expect(storage.get(LOCAL_RULES_KEY)).toBe("{ broken");
    expect(storage.keys("cc:teach:")).toEqual([]);

    const fine = setup(HAND);
    const bad = saveDraft(fine.storage, conv(saved([])), { ...draft(), entries: "nope" });
    expect(bad.ok).toBe(false);
    expect(fine.storage.get(LOCAL_RULES_KEY)).toBe(HAND);
    expect(fine.storage.keys("cc:teach:")).toEqual([]);
  });

  it("drops the unsaved-draft record once the conversation is saved", () => {
    const { storage } = setup();
    saveUnsaved(storage, conv(saved([draft()])));
    ok(saveDraft(storage, conv(saved([draft()])), draft()));
    expect(storage.get(UNSAVED_KEY)).toBeUndefined();
  });
});

describe("saveDraft: later saves", () => {
  it("overwrite only that feature and the conversation (R6.8)", () => {
    const { storage, localPack } = setup(HAND);
    const { featureId } = ok(saveDraft(storage, conv(saved([draft()])), draft()));
    const other = ok(saveDraft(storage, conv(saved([draft("别的")])), draft("别的", "other")));
    const before = localPack();

    const later = saved([draft(), draft("展开全文 v2")]);
    expect(ok(saveDraft(storage, conv(later), draft("展开全文 v2"), { featureId })).featureId).toBe(featureId);
    const after = localPack();
    expect(after.features.map((f) => f.id)).toEqual(["mine", featureId, other.featureId]);
    expect(after.features[1]).toEqual({ ...draft("展开全文 v2"), id: featureId });
    expect(after.features[0]).toEqual(before.features[0]);
    expect(after.features[2]).toEqual(before.features[2]);
    expect(storage.get(teachKey(featureId))).toEqual(later);
    expect(storage.get(teachKey(other.featureId))).toEqual(saved([draft("别的")]));
  });

  it("append again under the same id when the feature was deleted meanwhile", () => {
    const { storage, localPack } = setup(HAND);
    storage.set(teachKey("teach-gone"), saved([draft()])); // its own record, not yet pruned
    const r = ok(saveDraft(storage, conv(saved([draft()])), draft(), { featureId: "teach-gone" }));
    expect(r.featureId).toBe("teach-gone");
    expect(localPack().features.map((f) => f.id)).toEqual(["mine", "teach-gone"]);
  });
});

describe("loadConversation", () => {
  it("returns the stored conversation when the rule is as saved; nothing without a record or a rule", () => {
    const { storage } = setup(HAND);
    const c = saved([draft(), draft("v2")], 1);
    const { featureId } = ok(saveDraft(storage, conv(c), draft()));
    expect(loadConversation(storage, featureId)).toEqual(c);
    expect(loadConversation(storage, "mine")).toBeUndefined();
    storage.set(LOCAL_RULES_KEY, HAND);
    expect(loadConversation(storage, featureId)).toBeUndefined();
  });

  it("ignores key order differences in the editor text", () => {
    const { storage } = setup();
    const c = saved([draft()]);
    const { featureId } = ok(saveDraft(storage, conv(c), draft()));
    const pack = JSON.parse(storage.get<string>(LOCAL_RULES_KEY)!);
    const reordered = Object.fromEntries(Object.entries(pack.features[0]).reverse());
    storage.set(LOCAL_RULES_KEY, JSON.stringify({ ...pack, features: [reordered] }));
    expect(loadConversation(storage, featureId)).toEqual(c);
  });

  it("makes a hand edit in the editor the current draft, as a new version marked hand-edited (R6.8)", () => {
    const { storage } = setup(HAND);
    const c = saved([draft(), draft("v2")], 1);
    const { featureId } = ok(saveDraft(storage, conv(c), draft()));
    const pack = JSON.parse(storage.get<string>(LOCAL_RULES_KEY)!);
    const edited = { ...pack.features[1], name: "我手改过" };
    pack.features[1] = edited;
    storage.set(LOCAL_RULES_KEY, JSON.stringify(pack, null, 2));

    const loaded = loadConversation(storage, featureId, { now: () => 99 })!;
    expect(loaded.versions).toHaveLength(3);
    expect(loaded.versions.slice(0, 2)).toEqual(c.versions);
    expect(loaded.versions[2]).toEqual({ n: 3, draft: edited, turn: HAND_EDIT_TURN, at: 99 });
    expect(isHandEdited(loaded.versions[2]!)).toBe(true);
    expect(isHandEdited(loaded.versions[0]!)).toBe(false);
    expect(loaded.current).toBe(3);
    expect(loaded.turns).toEqual(c.turns);

    const restored = fromJSON(loaded, { invoker: { invoke: vi.fn() }, schema: {}, example: {}, validate: () => [] });
    expect(restored.current).toBe(3);
    expect(restored.versions[2]!.draft).toEqual(edited);
  });
});

describe("listTeachRules and deleteTeachRule", () => {
  it("lists the local features that have a conversation, in editor order", () => {
    const { storage } = setup(HAND);
    const a = ok(saveDraft(storage, conv(saved([draft()])), draft("甲", "a")));
    const b = ok(saveDraft(storage, conv(saved([draft()])), draft("乙", "b")));
    expect(listTeachRules(storage)).toEqual([
      { featureId: a.featureId, name: "甲" },
      { featureId: b.featureId, name: "乙" },
    ]);
    expect(listTeachRules(setup("{ broken").storage)).toEqual([]);
  });

  it("deleting the rule deletes its conversation and nothing else (R6.8)", () => {
    const { storage, localPack } = setup(HAND);
    const a = ok(saveDraft(storage, conv(saved([draft()])), draft("甲", "a")));
    const b = ok(saveDraft(storage, conv(saved([draft()])), draft("乙", "b")));
    ok(deleteTeachRule(storage, a.featureId));
    expect(localPack().features.map((f) => f.id)).toEqual(["mine", b.featureId]);
    expect(storage.get(teachKey(a.featureId))).toBeUndefined();
    expect(storage.get(teachKey(b.featureId))).toBeDefined();
    expect(listTeachRules(storage)).toEqual([{ featureId: b.featureId, name: "乙" }]);
  });

  it("refuses to delete while the local rules are invalid JSON, keeping the conversation", () => {
    const { storage } = setup(HAND);
    const { featureId } = ok(saveDraft(storage, conv(saved([draft()])), draft()));
    storage.set(LOCAL_RULES_KEY, "{ broken");
    expect(deleteTeachRule(storage, featureId)).toEqual({ ok: false, error: expect.stringContaining("JSON") });
    expect(storage.get(teachKey(featureId))).toBeDefined();
  });
});

describe("deleting the feature in the local rules editor", () => {
  it("pruneTeachRecords drops conversations whose feature is gone, keeps the unsaved record, skips invalid text", () => {
    const { storage } = setup(HAND);
    const a = ok(saveDraft(storage, conv(saved([draft()])), draft("甲", "a")));
    const b = ok(saveDraft(storage, conv(saved([draft()])), draft("乙", "b")));
    saveUnsaved(storage, conv(saved([draft()])));
    const pack = JSON.parse(storage.get<string>(LOCAL_RULES_KEY)!);
    const withoutA = JSON.stringify({ ...pack, features: pack.features.filter((f: { id: string }) => f.id !== a.featureId) });

    storage.set(LOCAL_RULES_KEY, "{ broken");
    pruneTeachRecords(storage);
    expect(storage.get(teachKey(a.featureId))).toBeDefined();

    storage.set(LOCAL_RULES_KEY, withoutA);
    pruneTeachRecords(storage);
    expect(storage.get(teachKey(a.featureId))).toBeUndefined();
    expect(storage.get(teachKey(b.featureId))).toBeDefined();
    expect(storage.get(UNSAVED_KEY)).toBeDefined();

    storage.delete(LOCAL_RULES_KEY); // 「已保存，本地规则已清空」
    pruneTeachRecords(storage);
    expect(storage.keys("cc:teach:")).toEqual([UNSAVED_KEY]);
  });

  it("watchTeachRecords prunes when the editor saves, until stopped", () => {
    const { storage } = setup(HAND);
    const a = ok(saveDraft(storage, conv(saved([draft()])), draft("甲", "a")));
    const stop = watchTeachRecords(storage);
    const b = ok(saveDraft(storage, conv(saved([draft()])), draft("乙", "b")));
    expect(storage.get(teachKey(b.featureId))).toBeDefined();
    storage.set(LOCAL_RULES_KEY, HAND); // the editor saved text without the teach features
    expect(storage.keys("cc:teach:")).toEqual([]);
    stop();
    ok(saveDraft(storage, conv(saved([draft()])), draft("丙", "c")));
    storage.set(LOCAL_RULES_KEY, HAND);
    expect(storage.keys("cc:teach:")).toHaveLength(1);
    expect(storage.get(teachKey(a.featureId))).toBeUndefined();
  });
  it("the app prunes when the local rules editor saves without the feature, and stops on dispose", () => {
    const { storage } = setup(HAND);
    const app = composeApp({ storage, fetch: vi.fn(), builtin: { commit: "test", packs: [] }, confirmHost: () => false });
    const a = ok(saveDraft(storage, conv(saved([draft()])), draft("甲", "a")));
    storage.set(LOCAL_RULES_KEY, HAND);
    expect(storage.get(teachKey(a.featureId))).toBeUndefined();
    app.dispose();
    const b = ok(saveDraft(storage, conv(saved([draft()])), draft("乙", "b")));
    storage.set(LOCAL_RULES_KEY, HAND);
    expect(storage.get(teachKey(b.featureId))).toBeDefined();
  });
});

describe("the unsaved-draft record (R6.9)", () => {
  it("restores the conversation after a reload, with the rule it continues, and can be discarded", () => {
    const { gm, storage } = setup();
    const c = saved([draft()]);
    saveUnsaved(storage, conv(c), { featureId: "teach-x", now: () => 5 });

    const reloaded = createStorage(gm.tab());
    expect(loadUnsaved(reloaded)).toEqual({ conversation: c, featureId: "teach-x", at: 5 });
    saveUnsaved(reloaded, conv(c), { now: () => 6 });
    expect(loadUnsaved(reloaded)).toEqual({ conversation: c, at: 6 });

    discardUnsaved(reloaded);
    expect(loadUnsaved(reloaded)).toBeUndefined();
    expect(reloaded.get(UNSAVED_KEY)).toBeUndefined();
  });

  it("ignores a record that is not a saved conversation", () => {
    const { storage } = setup();
    storage.set(UNSAVED_KEY, { conversation: { v: 2 }, at: 1 });
    expect(loadUnsaved(storage)).toBeUndefined();
    storage.set(UNSAVED_KEY, "junk");
    expect(loadUnsaved(storage)).toBeUndefined();
  });
});
