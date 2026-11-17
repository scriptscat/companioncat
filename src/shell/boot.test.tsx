import { act, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmStorageFake } from "../../test/fakes/gm-storage";
import { boot, type GmApi } from "./boot";
import type { ShellHandle } from "./mount";

const handles: ShellHandle[] = [];
afterEach(() => {
  handles.splice(0).forEach((h) => act(() => h.unmount()));
});

function gm(): GmApi & { commands: Map<string, () => void> } {
  const commands = new Map<string, () => void>();
  return {
    ...createGmStorageFake().tab(),
    GM_registerMenuCommand: (name: string, fn: () => void) => {
      commands.set(name, fn);
      return name;
    },
    commands,
  };
}

describe("userscript entry (R1.4)", () => {
  it("registers 「打开陪伴猫设置」 in the ScriptCat menu, which opens the settings window", () => {
    const api = gm();
    let h!: ShellHandle;
    act(() => {
      h = boot({ gm: api, hostname: "example-blog.dev" })!;
    });
    handles.push(h);
    const q = within(h.root as unknown as HTMLElement);
    expect([...api.commands.keys()]).toEqual(["打开陪伴猫设置"]);
    act(() => api.commands.get("打开陪伴猫设置")!());
    expect(q.getByRole("dialog", { name: "陪伴猫设置" })).toBeTruthy();
  });

  it("still opens settings when the cat is hidden", () => {
    const api = gm();
    api.GM_setValue("cc:shell:show-cat", false);
    let h!: ShellHandle;
    act(() => {
      h = boot({ gm: api, hostname: "example-blog.dev" })!;
    });
    handles.push(h);
    const q = within(h.root as unknown as HTMLElement);
    expect(q.queryByRole("button", { name: "陪伴猫" })).toBeNull();
    act(() => api.commands.get("打开陪伴猫设置")!());
    expect(q.getByRole("dialog", { name: "陪伴猫设置" })).toBeTruthy();
  });

  it("does nothing inside an iframe (R1.1)", () => {
    const api = gm();
    expect(boot({ gm: api, top: false })).toBeNull();
    expect(api.commands.size).toBe(0);
    expect(document.querySelector("companion-cat")).toBeNull();
  });

  it("main.tsx boots from the GM globals with the globbed registrations", async () => {
    const api = gm();
    for (const [k, v] of Object.entries(api)) vi.stubGlobal(k, v);
    try {
      await import("../main");
      expect(api.commands.has("打开陪伴猫设置")).toBe(true);
      const host = document.querySelector("companion-cat");
      expect(host?.shadowRoot?.querySelector("[aria-label='陪伴猫']")).toBeTruthy();
      host?.remove();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
