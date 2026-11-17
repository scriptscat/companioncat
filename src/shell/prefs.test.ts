import { describe, expect, it } from "vitest";
import { createGmStorageFake } from "../../test/fakes/gm-storage";
import { createStorage } from "../platform/storage";
import { readPrefs, writePref } from "./prefs";

const storage = () => createStorage(createGmStorageFake().tab());

describe("shell prefs", () => {
  it("defaults: follow system, cat shown, default spot, ginger", () => {
    expect(readPrefs(storage(), "a.dev")).toEqual({ theme: "system", showCat: true, catOffHere: false, catPos: null, breed: "ginger" });
  });

  it("round-trips values; cat-off is per site", () => {
    const s = storage();
    writePref(s, "a.dev", "theme", "dark");
    writePref(s, "a.dev", "catPos", { right: 40, bottom: 60 });
    writePref(s, "a.dev", "catOffHere", true);
    expect(readPrefs(s, "a.dev")).toMatchObject({ theme: "dark", catPos: { right: 40, bottom: 60 }, catOffHere: true });
    expect(readPrefs(s, "b.dev").catOffHere).toBe(false);
    expect(s.get("cc:shell:cat-off@a.dev")).toBe(true);
  });

  it("ignores malformed stored values", () => {
    const s = storage();
    s.set("cc:shell:theme", "purple");
    s.set("cc:shell:cat-pos", { right: "x" });
    s.set("cc:shell:show-cat", "no");
    expect(readPrefs(s, "a.dev")).toMatchObject({ theme: "system", catPos: null, showCat: true });
  });
});
