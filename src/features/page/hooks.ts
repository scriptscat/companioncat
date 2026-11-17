import { useEffect, useMemo, useState } from "react";
import { createSecretStore, createSettingsStore } from "../../core/stores";
import type { ResolvedEntry } from "../../core/rules/types";
import { useShell } from "../../shell";
import { enabledKey, isEnabled } from "./enabled";

/** Settings and secret stores for the shell's storage; re-renders the caller on any storage change. */
export function useStores() {
  const { services, resolved } = useShell();
  const { storage } = services;
  const [, bump] = useState(0);
  useEffect(() => storage.onChange(() => bump((n) => n + 1)), [storage]);
  const settings = useMemo(() => createSettingsStore(storage), [storage]);
  const secrets = useMemo(() => createSecretStore(storage, () => resolved), [storage, resolved]);
  return { storage, settings, secrets, resolved };
}

export function useEnabled(ref: string) {
  const { storage } = useStores();
  return {
    on: isEnabled(storage, ref),
    set(on: boolean) {
      if (on) storage.delete(enabledKey(ref));
      else storage.set(enabledKey(ref), false);
    },
  };
}

/** The page entry (网页对照) is not run in this version (R10.8). */
export const isUnsupported = (e: ResolvedEntry) => e.id === "page" || e.def.present.surface.type === "inline-after";
