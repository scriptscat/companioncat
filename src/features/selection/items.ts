/** Adapts invoke progress (deltas, per-engine results) to the views' ResultItem states (R10.5). */
import type { EngineResult, InvokeDelta } from "../../core/invoke";
import type { ResultItem } from "../../views";

export function pendingItems(engines: readonly string[], nameOf: (ref: string) => string | undefined): ResultItem[] {
  return engines.map((engine) => {
    const name = nameOf(engine);
    return name === undefined ? { engine, state: "loading" } : { engine, engineName: name, state: "loading" };
  });
}

const update = (items: ResultItem[], engine: string, patch: (it: ResultItem) => ResultItem) =>
  items.map((it) => (it.engine === engine ? patch(it) : it));

/** Streamed text so far, shaped like the contract's output (translate: `texts`, others: `text`). */
const partial = (contract: string, full: string) => (contract === "translate" ? { texts: [full] } : { text: full });

export function applyDelta(items: ResultItem[], d: InvokeDelta, contract: string): ResultItem[] {
  return update(items, d.engine, (it) =>
    it.state === "ok" || it.state === "error" || it.state === "needKey" ? it : { ...it, state: "streaming", output: partial(contract, d.full) },
  );
}

export function applyResult(items: ResultItem[], r: EngineResult): ResultItem[] {
  return update(items, r.engine, ({ engine, engineName }) => {
    const base = engineName === undefined ? { engine } : { engine, engineName };
    if (r.ok) return { ...base, state: "ok", output: r.output, cached: r.cached };
    if (r.error.type === "missingKey") return { ...base, state: "needKey", error: { type: r.error.type, message: r.error.message } };
    return { ...base, state: "error", error: { type: r.error.type, message: r.error.message } };
  });
}

/** Sets the items of `engines` back to loading (retry). */
export function reload(items: ResultItem[], engine: string): ResultItem[] {
  return update(items, engine, ({ engine: e, engineName }) => (engineName === undefined ? { engine: e, state: "loading" } : { engine: e, engineName, state: "loading" }));
}
