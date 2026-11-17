/** The shell's own preferences (not rule settings): stored under cc:shell:*, shared by all tabs. */
import type { Storage } from "../platform/storage";
import type { CatBreed } from "../ui/cat";

export const PREF_PREFIX = "cc:shell:";

export type Theme = "system" | "light" | "dark";
export interface CatPos {
  right: number;
  bottom: number;
}

export interface ShellPrefs {
  /** R1.7, default 跟随系统. */
  theme: Theme;
  /** 「在所有网站显示小猫」. */
  showCat: boolean;
  /** The cat is switched off on the current site. */
  catOffHere: boolean;
  /** Where the cat was dragged to (distance from the right/bottom edges); null = default corner. */
  catPos: CatPos | null;
  breed: CatBreed;
}

const KEYS = {
  theme: () => `${PREF_PREFIX}theme`,
  showCat: () => `${PREF_PREFIX}show-cat`,
  catOffHere: (host: string) => `${PREF_PREFIX}cat-off@${host}`,
  catPos: () => `${PREF_PREFIX}cat-pos`,
  breed: () => `${PREF_PREFIX}breed`,
} satisfies Record<keyof ShellPrefs, (host: string) => string>;

const isPos = (v: unknown): v is CatPos =>
  !!v && typeof v === "object" && Number.isFinite((v as CatPos).right) && Number.isFinite((v as CatPos).bottom);

export function readPrefs(storage: Storage, host: string): ShellPrefs {
  const theme = storage.get(KEYS.theme());
  const showCat = storage.get(KEYS.showCat());
  const pos = storage.get(KEYS.catPos());
  const breed = storage.get(KEYS.breed());
  return {
    theme: theme === "light" || theme === "dark" ? theme : "system",
    showCat: typeof showCat === "boolean" ? showCat : true,
    catOffHere: storage.get(KEYS.catOffHere(host)) === true,
    catPos: isPos(pos) ? { right: pos.right, bottom: pos.bottom } : null,
    breed: breed === "calico" ? "calico" : "ginger",
  };
}

export function writePref<K extends keyof ShellPrefs>(storage: Storage, host: string, key: K, value: ShellPrefs[K]) {
  const k = KEYS[key](host);
  if (value === null) storage.delete(k);
  else storage.set(k, value);
}
