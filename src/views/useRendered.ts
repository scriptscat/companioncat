import { useEffect, useRef, useState } from "react";
import { renderTemplate, type Position, type Scope } from "../core/expr";

export const hasTemplate = (v: unknown): boolean =>
  typeof v === "string"
    ? v.includes("{{")
    : Array.isArray(v)
      ? v.some(hasTemplate)
      : v !== null && typeof v === "object"
        ? Object.values(v).some(hasTemplate)
        : false;

export interface Rendered<T> {
  value: T | undefined;
  /** Set when the latest evaluation failed (the last good value is kept). */
  error?: Error;
}

/**
 * Evaluates templates asynchronously. Static values are returned synchronously; for templates the
 * previous result stays on screen until the new one is ready (no blank frame), stale results are
 * dropped, and a failing evaluation keeps the last good value.
 */
export function useRendered<T = unknown>(value: unknown, scope: Scope, pos: Position): Rendered<T> {
  const dynamic = hasTemplate(value);
  const key = dynamic ? JSON.stringify([value, scope]) : "";
  const latest = useRef({ value, scope, pos });
  latest.current = { value, scope, pos };
  const [state, setState] = useState<Rendered<T>>({ value: undefined });
  useEffect(() => {
    if (!dynamic) return;
    let live = true;
    const { value: v, scope: s, pos: p } = latest.current;
    renderTemplate(v, s, p).then(
      (r) => live && setState({ value: r as T }),
      (e: unknown) => live && setState((prev) => ({ value: prev.value, error: e as Error })),
    );
    return () => {
      live = false;
    };
  }, [dynamic, key]);
  return dynamic ? state : { value: value as T };
}
