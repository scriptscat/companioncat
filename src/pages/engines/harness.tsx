/** Test helpers for the engines page (only *.test.tsx import this). */
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { createStorage, type Storage } from "../../platform/storage";
import { resolveRules } from "../../core/rules";
import type { Resolved } from "../../core/rules/types";
import { ShellCtx, type ShellApi } from "../../shell/context";
import { staticRules, type ShellServices } from "../../shell/services";
import { TipProvider } from "../../ui";
import llm from "../../../rules/packs/official-llm.json";
import translate from "../../../rules/packs/official-translate.json";
import { EnginesPage } from "./EnginesPage";
import enginesPage from "./register";

const LOCAL = {
  schema: 1,
  id: "mine",
  name: "我的规则",
  version: "1.0.0",
  providers: [
    { id: "deep2", name: "我的 DeepSeek", description: "用 DeepSeek 的 Key", extends: "official-llm/deepseek" },
    { id: "orphan", name: "孤儿引擎", extends: "nowhere/none" },
  ],
};

export const OFFICIAL_PACKS = [
  { pack: translate, official: true },
  { pack: llm, official: true },
];

export function official(withLocal = true): Resolved {
  return resolveRules([
    { pack: translate, official: true },
    { pack: llm, official: true },
    ...(withLocal ? [{ pack: LOCAL, local: true }] : []),
  ] as never);
}

export function renderEngines(resolved: Resolved = official(), o: { narrow?: boolean; target?: string; services?: Partial<ShellServices>; storage?: Storage; registered?: boolean } = {}) {
  const fake = createGmStorageFake();
  const storage = o.storage ?? createStorage(fake.tab());
  const api: ShellApi = {
    services: { storage, rules: staticRules(resolved), ...o.services },
    resolved,
    bare: false,
    hostname: "x",
    prefs: {} as never,
    setPref: () => {},
    openSettings: () => {},
    closeSettings: () => {},
    closeBubble: () => {},
    subscribe: { run: vi.fn(), busy: false, error: null, available: true },
    narrow: !!o.narrow,
    root: document as never,
    layer: document.body,
  };
  const view = render(
    <ShellCtx.Provider value={api}>
      <TipProvider>
        {o.registered ? <enginesPage.component narrow={!!o.narrow} target={o.target} /> : <EnginesPage narrow={!!o.narrow} target={o.target} />}
      </TipProvider>
    </ShellCtx.Provider>,
  );
  return { storage, resolved, ...view };
}
