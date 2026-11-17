import { act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmStorageFake } from "../../test/fakes/gm-storage";
import type { FetchFn } from "../core/subscriptions";
import { collect } from "../shell/registry";
import { startApp } from "./start";

const registrations = collect(
  import.meta.glob("../pages/*/register.tsx", { eager: true }),
  import.meta.glob("../features/*/register.tsx", { eager: true }),
);

const started: { unmount(): void }[] = [];
afterEach(() => {
  for (const h of started.splice(0)) act(() => h.unmount());
  document.querySelectorAll("companion-cat").forEach((el) => el.remove());
});

function start() {
  const gm = { ...createGmStorageFake().tab(), GM_registerMenuCommand: vi.fn() };
  const calls: string[] = [];
  const fetch: FetchFn = async (url) => (calls.push(url), { status: 304, headers: {}, text: "" });
  let out!: NonNullable<ReturnType<typeof startApp>>;
  act(() => {
    out = startApp({ gm, fetch, registrations, hostname: "example-blog.dev", top: true })!;
  });
  started.push(out.handle);
  return { ...out, calls, q: within(out.handle.root as unknown as HTMLElement) };
}

describe("startApp", () => {
  it("boots with the official packs seeded and runs the update check over the FetchFn", async () => {
    const { app, calls } = start();
    expect(app.services.rules.get().providers.map((p) => p.ref)).toContain("official-translate/google");
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it("renders the R7.4 dialog of the shared confirmHost inside the shell's shadow root", async () => {
    const user = userEvent.setup();
    const { app, handle, q } = start();
    const provider = app.services.rules.get().providers.find((p) => p.ref === "official-llm/deepseek")!;
    let answer: boolean | undefined;
    void Promise.resolve(app.services.confirmHost({ provider, hosts: ["api.new.test"], confirmed: ["api.deepseek.com"] })).then((a) => (answer = a));
    const dialog = await q.findByRole("alertdialog");
    expect(handle.root.querySelector("[data-cc-layer]")!.contains(dialog)).toBe(true);
    expect(document.body.contains(dialog)).toBe(false);
    expect(dialog.textContent).toContain("api.new.test");
    expect(dialog.textContent).toContain(`更新到 v${app.versions("official-llm")!.to}`);
    await user.click(q.getByRole("button", { name: "我认识这个地址，允许" }));
    await waitFor(() => expect(answer).toBe(true));
  });

  it("makes 「订阅官方规则」 in the empty engines page work", async () => {
    const user = userEvent.setup();
    const { app, handle, q } = start();
    act(() => {
      for (const s of app.services.subscriptions.list()) app.services.subscriptions.unsubscribe(s.id);
      handle.openSettings("engines");
    });
    await user.click(await q.findByRole("button", { name: "订阅官方规则" }));
    await waitFor(() => expect(app.services.rules.get().providers.length).toBeGreaterThan(0));
    expect(app.services.subscriptions.list().map((s) => s.id).sort()).toEqual(["official-llm", "official-translate"]);
  });

  it("does nothing inside an iframe (R1.1)", () => {
    const gm = { ...createGmStorageFake().tab(), GM_registerMenuCommand: vi.fn() };
    expect(startApp({ gm, top: false, fetch: vi.fn() })).toBeNull();
    expect(gm.GM_registerMenuCommand).not.toHaveBeenCalled();
  });
});
