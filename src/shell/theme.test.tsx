import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGmStorageFake } from "../../test/fakes/gm-storage";
import { createStorage } from "../platform/storage";
import { setup, unmountAll } from "./testing";
import { useShell } from "./context";
import { definePage } from "./registry";

let systemDark = false;
const mqListeners = new Set<() => void>();
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  systemDark = false;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes("dark") ? systemDark : false;
    },
    media: query,
    addEventListener: (_: string, cb: () => void) => mqListeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => mqListeners.delete(cb),
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  unmountAll();
  mqListeners.clear();
  window.matchMedia = realMatchMedia;
});

const flipSystem = (dark: boolean) =>
  act(() => {
    systemDark = dark;
    mqListeners.forEach((cb) => cb());
  });

describe("appearance (R1.7)", () => {
  it("follows the system by default, live", () => {
    systemDark = true;
    const { handle } = setup();
    expect(handle.host.classList.contains("dark")).toBe(true);
    flipSystem(false);
    expect(handle.host.classList.contains("dark")).toBe(false);
  });

  it("light and dark override the system; the 通用 page sets it through the shell", () => {
    systemDark = true;
    let setTheme!: (t: "system" | "light" | "dark") => void;
    const General = () => {
      const shell = useShell();
      setTheme = (t) => shell.setPref("theme", t);
      return <p>theme: {shell.prefs.theme}</p>;
    };
    const { handle, storage } = setup({ registrations: [definePage({ id: "general", group: "companion", component: General })] });
    act(() => handle.openSettings("general"));
    act(() => setTheme("light"));
    expect(handle.host.classList.contains("dark")).toBe(false);
    expect(storage.get("cc:shell:theme")).toBe("light");
    act(() => setTheme("dark"));
    flipSystem(false);
    expect(handle.host.classList.contains("dark")).toBe(true);
    expect(handle.root.textContent).toContain("theme: dark");
  });

  it("works without matchMedia (treated as light)", () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    const { handle } = setup();
    expect(handle.host.classList.contains("dark")).toBe(false);
  });

  it("a change in another tab applies without reload (R1.8)", () => {
    const fake = createGmStorageFake();
    const { handle } = setup({ storage: createStorage(fake.tab()) });
    const other = createStorage(fake.tab());
    act(() => other.set("cc:shell:theme", "dark"));
    expect(handle.host.classList.contains("dark")).toBe(true);
    act(() => other.set("cc:shell:show-cat", false));
    expect(handle.root.querySelector("[aria-label='陪伴猫']")).toBeNull();
  });
});
