import { describe, expect, it } from "vitest";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { createStorage } from "../../platform/storage";
import { createActionLog, createAutomationPrefs, type ActionRecordInput } from "./automation";

const rec = (over: Partial<ActionRecordInput> = {}): ActionRecordInput => ({
  site: "a.com",
  rule: "official/skip-ad",
  entry: "auto",
  action: "click",
  target: "按钮「跳过广告」",
  confidence: 0.93,
  mode: "auto",
  ...over,
});

function setup() {
  const fake = createGmStorageFake();
  const storage = createStorage(fake.tab());
  let t = 1000;
  return { fake, storage, log: createActionLog(storage, () => t++), prefs: createAutomationPrefs(storage) };
}

describe("action log (R3.7)", () => {
  it("stores time, site, refs, action, target, confidence, mode and failure reason under cc:auto:", () => {
    const { log, storage } = setup();
    log.append(rec({ mode: "failed", failure: "找不到元素" }));
    const [r] = log.list("a.com");
    expect(r).toMatchObject({ time: 1000, site: "a.com", rule: "official/skip-ad", entry: "auto", action: "click", target: "按钮「跳过广告」", confidence: 0.93, mode: "failed", failure: "找不到元素" });
    expect(storage.keys("cc:auto:").length).toBe(1);
  });

  it("keeps each record short: a long describe or error message is cut, not stored whole 20 times", () => {
    const { log } = setup();
    const r = log.append(rec({ target: "题".repeat(100_000), failure: "错".repeat(100_000), mode: "failed" }));
    const [kept] = log.list("a.com");
    expect(kept!.target.length).toBeLessThanOrEqual(200);
    expect(kept!.failure!.length).toBeLessThanOrEqual(500);
    expect(kept!.target.endsWith("…")).toBe(true);
    expect(r).toEqual(kept);
  });

  it("keeps the newest 20 per site, newest first, without touching other sites", () => {
    const { log } = setup();
    for (let i = 0; i < 25; i++) log.append(rec({ target: `t${i}` }));
    log.append(rec({ site: "b.com", target: "other" }));
    const list = log.list("a.com");
    expect(list).toHaveLength(20);
    expect(list[0]!.target).toBe("t24");
    expect(list[19]!.target).toBe("t5");
    expect(log.list("b.com")).toHaveLength(1);
  });

  it("accepts every mode", () => {
    const { log } = setup();
    for (const mode of ["auto", "asked-yes", "asked-no", "hint", "skip", "not-applicable", "failed"] as const) log.append(rec({ mode }));
    expect(log.list("a.com").map((r) => r.mode)).toHaveLength(7);
  });

  it("never stores a fill value or key even if a caller sneaks one in", () => {
    const { log, storage } = setup();
    const sneaky = { ...rec({ action: "fill" }), value: "hunter2-secret", key: "sk-abc", secret: "x" } as unknown as ActionRecordInput;
    log.append(sneaky);
    const raw = JSON.stringify(storage.keys("cc:auto:").map((k) => storage.get(k)));
    expect(raw).not.toContain("hunter2-secret");
    expect(raw).not.toContain("sk-abc");
    expect(Object.keys(log.list("a.com")[0]!).sort()).toEqual(["action", "confidence", "entry", "id", "mode", "rule", "site", "target", "time"]);
  });

  it("marks a record wrong", () => {
    const { log } = setup();
    const r = log.append(rec());
    log.markWrong("a.com", r.id);
    expect(log.list("a.com")[0]!.wrong).toBe(true);
  });
});

describe("automation prefs", () => {
  it("pauses per site (R3.6)", () => {
    const { prefs } = setup();
    expect(prefs.isPaused("a.com")).toBe(false);
    prefs.setPaused("a.com", true);
    expect(prefs.isPaused("a.com")).toBe(true);
    expect(prefs.isPaused("b.com")).toBe(false);
    prefs.setPaused("a.com", false);
    expect(prefs.isPaused("a.com")).toBe(false);
  });

  it("always-do is per site and per rule (R2.3)", () => {
    const { prefs } = setup();
    prefs.setAlwaysDo("a.com", "r1", true);
    expect(prefs.isAlwaysDo("a.com", "r1")).toBe(true);
    expect(prefs.isAlwaysDo("a.com", "r2")).toBe(false);
    expect(prefs.isAlwaysDo("b.com", "r1")).toBe(false);
    prefs.setAlwaysDo("a.com", "r1", false);
    expect(prefs.isAlwaysDo("a.com", "r1")).toBe(false);
  });

  it("markWrong switches the rule back to ask and flags the record (R2.4)", () => {
    const { prefs, log } = setup();
    const r = log.append(rec());
    prefs.setAlwaysDo("a.com", "r1", true);
    prefs.setAlwaysDo("a.com", "r2", true);
    prefs.markWrong("a.com", "r1", r.id);
    expect(prefs.isAlwaysDo("a.com", "r1")).toBe(false);
    expect(prefs.isAlwaysDo("a.com", "r2")).toBe(true);
    expect(log.list("a.com")[0]!.wrong).toBe(true);
  });
});

describe("cross-tab", () => {
  it("another tab sees pause, always-do and log changes through subscribe", () => {
    const fake = createGmStorageFake();
    const s1 = createStorage(fake.tab());
    const s2 = createStorage(fake.tab());
    const p1 = createAutomationPrefs(s1);
    const l1 = createActionLog(s1);
    const p2 = createAutomationPrefs(s2);
    const l2 = createActionLog(s2);
    let hits = 0;
    const off = p2.subscribe(() => hits++);
    let logHits = 0;
    const offLog = l2.subscribe("a.com", () => logHits++);
    p1.setPaused("a.com", true);
    p1.setAlwaysDo("a.com", "r1", true);
    l1.append(rec());
    expect(p2.isPaused("a.com")).toBe(true);
    expect(p2.isAlwaysDo("a.com", "r1")).toBe(true);
    expect(l2.list("a.com")).toHaveLength(1);
    expect(hits).toBe(2);
    expect(logHits).toBe(1);
    off();
    offLog();
    p1.setPaused("a.com", false);
    expect(hits).toBe(2);
  });
});
