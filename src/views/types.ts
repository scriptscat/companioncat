import type { ComponentDef, ViewTemplateDef } from "../core/rules";

/** One engine's slot in a `result-list`. `streaming` shows the `ok` view with the partial `output`. */
export interface ResultItem {
  engine: string;
  engineName?: string;
  state: "loading" | "streaming" | "ok" | "error" | "needKey";
  output?: unknown;
  error?: { type?: string; message: string };
  cached?: boolean;
}

/** A resolved action (R9.12): templates already evaluated. */
export type ViewAction =
  | { copy: string }
  | { retry: string }
  | { rerun: { vars: Record<string, unknown> } }
  | { open: string }
  | { surface: "pin" | "close" };

export type OnAction = (action: ViewAction) => void;

export interface ViewOptions {
  /** View templates by the id used in `use`. */
  views?: Readonly<Record<string, ViewTemplateDef | ComponentDef | null | undefined>>;
  /** Output JSON Schema of the contract: drives the auto view when no node is given. */
  outputSchema?: unknown;
  /** Writes text to the clipboard (default: navigator.clipboard, then GM_setClipboard). */
  clipboard?: (text: string) => Promise<void> | void;
}

export type Node = Record<string, unknown>;
