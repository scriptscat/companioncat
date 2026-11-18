// 网页对照的分批翻译（R7.4、R7.5）：按条数和字数把段落分批，每批走共享 invoker（缓存在 invoker 里），
// 一批一批地交回结果；一批失败不影响其他批。

import { CallError, isCallError } from "../../core/errors";
import type { Invoker } from "../../core/invoke";
import type { Block } from "./blocks";

export const DEFAULT_MAX_ITEMS = 20;
export const DEFAULT_MAX_CHARS = 2000;

export interface BatchLimits {
  maxItems: number;
  maxChars: number;
}

export interface TranslatedBlock {
  block: Block;
  text: string;
}

export type BatchResult =
  | { index: number; ok: true; blocks: Block[]; items: TranslatedBlock[]; cached: boolean }
  | { index: number; ok: false; blocks: Block[]; error: CallError };

export interface TranslateBlocksOptions extends Partial<BatchLimits> {
  /** Full provider ref. */
  engine: string;
  to: string;
  /** Called as soon as each batch settles (success or failure). */
  onBatch?: (result: BatchResult) => void;
  /** Aborting rejects translateBlocks with the signal's reason; no more batches are started. */
  signal?: AbortSignal;
}

/** Split by item count and total characters; a block larger than maxChars goes alone. */
export function splitBatches(blocks: readonly Block[], { maxItems, maxChars }: BatchLimits): Block[][] {
  const out: Block[][] = [];
  let cur: Block[] = [];
  let chars = 0;
  for (const b of blocks) {
    const len = b.text.length;
    if (cur.length > 0 && (cur.length >= maxItems || chars + len > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(b);
    chars += len;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Results come back in batch order; batches run in parallel and the invoker's limiter paces them. */
export async function translateBlocks(
  blocks: readonly Block[],
  opts: TranslateBlocksOptions,
  invoker: Pick<Invoker, "invoke">,
): Promise<BatchResult[]> {
  const { engine, to, onBatch, signal } = opts;
  signal?.throwIfAborted();
  const batches = splitBatches(blocks, {
    maxItems: opts.maxItems ?? DEFAULT_MAX_ITEMS,
    maxChars: opts.maxChars ?? DEFAULT_MAX_CHARS,
  });

  const runOne = async (batch: Block[], index: number): Promise<BatchResult> => {
    let result: BatchResult;
    try {
      const r = await invoker.invoke(
        { contract: "translate", input: { texts: batch.map((b) => b.text), to }, strategy: "first", engines: [engine] },
        { signal },
      );
      const texts = (r.output as { texts?: unknown } | undefined)?.texts;
      if (!r.ok) {
        result = { index, ok: false, blocks: batch, error: r.error ?? new CallError("server") };
      } else if (!Array.isArray(texts) || texts.length !== batch.length || texts.some((t) => typeof t !== "string")) {
        result = { index, ok: false, blocks: batch, error: new CallError("badOutput") };
      } else {
        const items = batch.map((block, i) => ({ block, text: texts[i] as string }));
        result = { index, ok: true, blocks: batch, items, cached: r.cached === true };
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      result = { index, ok: false, blocks: batch, error: isCallError(e) ? e : new CallError("server", String(e)) };
    }
    if (signal?.aborted) throw signal.reason;
    onBatch?.(result);
    return result;
  };

  return Promise.all(batches.map(runOne));
}
