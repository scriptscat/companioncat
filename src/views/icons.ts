import {
  ArrowRight, Check, Circle, Copy, ExternalLink, Globe, Languages, Pin, RotateCw, Settings2, Sparkles, X,
  ArrowLeft, Info, Key, Pencil, Play, Search, Trash2, Volume2,
  type LucideIcon,
} from "lucide-react";

/** Icons rules may name (lucide kebab-case). Unknown names render a plain dot. */
const ICONS: Record<string, LucideIcon> = {
  "arrow-right": ArrowRight, "arrow-left": ArrowLeft, check: Check, copy: Copy, "external-link": ExternalLink,
  globe: Globe, languages: Languages, pin: Pin, "rotate-cw": RotateCw, "settings-2": Settings2, settings: Settings2,
  sparkles: Sparkles, x: X, info: Info, key: Key, pencil: Pencil, play: Play, search: Search, "trash-2": Trash2,
  "volume-2": Volume2,
};

/** The icon a rule names, or undefined for names this build does not know. */
export const knownIcon = (name: unknown): LucideIcon | undefined => {
  const key = String(name);
  // own keys only: "constructor", "toString", … must not resolve to Object.prototype members
  return Object.hasOwn(ICONS, key) ? ICONS[key] : undefined;
};

export const iconFor = (name: unknown): LucideIcon => knownIcon(name) ?? Circle;
