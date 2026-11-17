import type { Storage } from "../../platform/storage";
import type { Resolved, ResolvedProvider } from "../rules/types";

/**
 * Keys: `cc:secret:<provider>/<field>` (provider = the one declaring `secrets`),
 * `cc:hosts:<provider>` (confirmed hosts), `cc:disabled:<provider>`.
 * Values never go into logs or events; show them only through mask().
 */
export const SECRET_PREFIX = "cc:secret:";
export const HOSTS_PREFIX = "cc:hosts:";
export const DISABLED_PREFIX = "cc:disabled:";

/** First 3 chars + 8 bullets + last 4. Keys too short to hide anything are fully masked. */
export function mask(value: string): string {
  if (!value) return "";
  const bullets = "••••••••";
  return value.length < 12 ? bullets : value.slice(0, 3) + bullets + value.slice(-4);
}

export interface SecretLookup {
  /** The provider whose saved keys are used. */
  from: string;
  inherited: boolean;
  /** Declared fields that have no saved value. */
  missing: string[];
}

export function createSecretStore(storage: Storage, getResolved: () => Resolved) {
  /**
   * The providers whose keys are saved under `own`: `own` itself, or the children of an abstract
   * parent that declares the secrets (abstract providers are not in `providers`).
   */
  const usersOf = (own: string): ResolvedProvider[] => getResolved().providers.filter((p) => p.ref === own || p.secretsFrom === own);
  /** The provider whose saved keys `ref` reads: its own ref for an (abstract) declaring provider. */
  const owner = (ref: string): string => {
    const users = usersOf(ref);
    const self = users.find((p) => p.ref === ref);
    if (self) return self.secretsFrom;
    if (users.length > 0) return ref;
    throw new Error(`unknown provider ${ref}`);
  };
  const secretKey = (own: string, name: string) => `${SECRET_PREFIX}${own}/${name}`;
  /** Declared secret names; a child's merged def carries the declaring provider's list. */
  const fields = (own: string) => {
    const users = usersOf(own);
    const p = users.find((x) => x.ref === own) ?? users[0];
    if (!p) throw new Error(`unknown provider ${own}`);
    return p.def.secrets?.map((s) => s.name) ?? [];
  };

  const store = {
    /** R5.6: reads through to the nearest ancestor that declares the secret. */
    get(ref: string, name: string): string | undefined {
      return storage.get<string>(secretKey(owner(ref), name));
    },

    lookup(ref: string): SecretLookup {
      const from = owner(ref);
      return { from, inherited: from !== ref, missing: fields(from).filter((n) => storage.get(secretKey(from, n)) === undefined) };
    },

    /**
     * Saves a key for the provider that declares it. `hosts` is recorded as the confirmed
     * hosts only when none are recorded yet (R7.4: first successful save).
     */
    set(ref: string, name: string, value: string, hosts?: string[]) {
      const own = owner(ref);
      if (own !== ref) throw new Error(`${ref} uses the keys saved on ${own}; save them there`);
      if (!fields(ref).includes(name)) throw new Error(`${ref} does not declare secret "${name}"`);
      storage.set(secretKey(ref, name), value);
      if (hosts && storage.get(HOSTS_PREFIX + ref) === undefined) storage.set(HOSTS_PREFIX + ref, [...new Set(hosts)]);
    },

    /** R7.3: removes the key and its confirmed hosts, and disables every provider that uses it. */
    delete(ref: string, name: string) {
      const own = owner(ref);
      storage.delete(secretKey(own, name));
      storage.delete(HOSTS_PREFIX + own);
      for (const p of getResolved().providers) if (p.secretsFrom === own) store.setDisabled(p.ref, true);
    },

    hostsConfirmed(ref: string): string[] {
      return storage.get<string[]>(HOSTS_PREFIX + owner(ref)) ?? [];
    },
    isHostConfirmed(ref: string, host: string): boolean {
      return store.hostsConfirmed(ref).includes(host);
    },
    confirmHosts(ref: string, hosts: string[]) {
      const own = owner(ref);
      storage.set(HOSTS_PREFIX + own, [...new Set([...store.hostsConfirmed(own), ...hosts])]);
    },

    isDisabled: (ref: string) => storage.get(DISABLED_PREFIX + ref) === true,
    setDisabled(ref: string, disabled: boolean) {
      if (disabled) storage.set(DISABLED_PREFIX + ref, true);
      else storage.delete(DISABLED_PREFIX + ref);
    },
  };
  return store;
}

export type SecretStore = ReturnType<typeof createSecretStore>;
