import { describe, expect, it } from "vitest";
import { createGmStorageFake } from "../../test/fakes/gm-storage";
import { createStorage, type GmStorageApi } from "./storage";

/** A tab whose GM_listValues calls (one per rescan of the other tabs' writes) are counted. */
function countingTab(gm: ReturnType<typeof createGmStorageFake>, removable = true) {
  const tab = gm.tab();
  if (!removable) delete tab.GM_removeValueChangeListener;
  const counted = { scans: 0 };
  const api: GmStorageApi = {
    ...tab,
    GM_listValues: () => (counted.scans++, tab.GM_listValues()),
  };
  return { api, counted };
}

describe("storage change watching (R1.8)", () => {
  it.each([
    ["with", true],
    ["without", false],
  ])("stops watching other tabs once the last listener unsubscribes, and resumes on a new one (%s GM_removeValueChangeListener)", (_, removable) => {
    const gm = createGmStorageFake();
    const a = countingTab(gm, removable);
    const mine = createStorage(a.api);
    const other = createStorage(gm.tab());

    const seen: string[] = [];
    const stop = mine.onChange((k, _o, n, remote) => seen.push(`${k}=${String(n)}:${remote}`));
    other.set("cc:x", 1);
    expect(seen).toEqual(["cc:x=1:true"]);

    stop();
    const scans = a.counted.scans;
    other.set("cc:x", 2);
    other.set("cc:y", 3);
    expect(a.counted.scans).toBe(scans);

    mine.onChange((k, _o, n, remote) => seen.push(`${k}=${String(n)}:${remote}`));
    other.set("cc:x", 4);
    expect(seen).toEqual(["cc:x=1:true", "cc:x=4:true"]);
  });
});
