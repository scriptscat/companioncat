/** Test helpers for shell component tests (not shipped: only *.test.tsx import this). */
import { act, within } from "@testing-library/react";
import { createGmStorageFake } from "../../test/fakes/gm-storage";
import { createStorage, type Storage } from "../platform/storage";
import type { Resolved, ResolvedFeature } from "../core/rules/types";
import { mount, type MountOptions, type ShellHandle } from "./mount";
import { staticRules, type RulesSource } from "./services";

export const EMPTY: Resolved = { features: [], providers: [], views: [], bridges: [], contracts: [], sites: [], diagnostics: [] };

export function feature(pack: string, id: string, name: string, source = 0): ResolvedFeature {
  return {
    ref: `${pack}/${id}`,
    id,
    pack,
    source,
    enabled: true,
    problems: [],
    def: { id, name, icon: "languages", match: ["*://*/*"] },
    entries: [],
  };
}

export const withFeatures = (...features: ResolvedFeature[]): Resolved => ({ ...EMPTY, features });

/** A rules source whose value tests can change. */
export function rulesSource(initial: Resolved) {
  let value = initial;
  const subs = new Set<() => void>();
  const source: RulesSource & { set(r: Resolved): void } = {
    get: () => value,
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    set(r) {
      value = r;
      subs.forEach((cb) => cb());
    },
  };
  return source;
}

const mounted = new Set<ShellHandle>();

export function setup(
  opts: Partial<Omit<MountOptions, "services">> & {
    resolved?: Resolved;
    rules?: RulesSource;
    storage?: Storage;
    subscribeOfficial?: () => unknown;
  } = {},
) {
  const fake = createGmStorageFake();
  const storage = opts.storage ?? createStorage(fake.tab());
  const rules = opts.rules ?? staticRules(opts.resolved ?? withFeatures(feature("official-translate", "translate", "翻译")));
  let handle!: ShellHandle;
  act(() => {
    handle = mount({
      hostname: "example-blog.dev",
      ...opts,
      services: { storage, rules, subscribeOfficial: opts.subscribeOfficial },
    });
  });
  mounted.add(handle);
  const q = within(handle.root as unknown as HTMLElement);
  const cat = () => q.getByRole("button", { name: "陪伴猫" });
  return { handle, storage, fake, q, cat, root: handle.root };
}

export function unmountAll() {
  for (const h of mounted) act(() => h.unmount());
  mounted.clear();
}

/** The element focused inside the shadow root (document.activeElement is the host). */
export const focused = (root: ShadowRoot) => root.activeElement;
