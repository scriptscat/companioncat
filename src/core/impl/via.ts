/** The `via` implementation (R5.3): map onto another contract, call it, map back, check. */
import type { InlineBridgeDef } from "../rules";
import { POSITIONS } from "../rules";
import { fail, holds, isObject, render, trace, type Run } from "./run";

export const MAX_VIA_DEPTH = 4;
const DEFAULT_CHECK_MESSAGE = "上一次的结果没有通过检查，请按要求重新回答。";

export type CallContract = (run: Run, contract: string, input: unknown) => Promise<unknown>;

export async function executeVia(
  run: Run,
  contract: string,
  via: string | InlineBridgeDef,
  input: unknown,
  call: CallContract,
): Promise<unknown> {
  let bridge: InlineBridgeDef;
  let ref = "inline";
  if (typeof via === "string") {
    const found = run.ctx.rules.bridges.find((b) => b.ref === via);
    if (!found) throw fail(run, "disabled", `桥接 ${via} 找不到`);
    if (!found.enabled) throw fail(run, "disabled", `桥接 ${via} 已停用`);
    bridge = found.def;
    ref = via;
  } else {
    bridge = via;
  }
  if (run.depth >= MAX_VIA_DEPTH) throw fail(run, "disabled", `桥接嵌套超过 ${MAX_VIA_DEPTH} 层`);

  // Bridged calls never stream to the caller: their text is not this contract's output.
  const inner: Run = { ...run, depth: run.depth + 1, onDelta: undefined };
  let toInput = await render(run, bridge.input, { input, options: run.options }, POSITIONS.bridgeInput, "badInput");
  let reason = DEFAULT_CHECK_MESSAGE;
  for (let attempt = 0; attempt < 2; attempt++) {
    trace(run, { type: "bridge", bridge: ref, from: contract, to: bridge.to, attempt, input: toInput });
    const result = await call(inner, bridge.to, toInput);
    const scope = { input, result };
    if (bridge.check === undefined || (await holds(run, bridge.check, scope, POSITIONS.bridgeOutput))) {
      return render(run, bridge.output, scope, POSITIONS.bridgeOutput, "badOutput");
    }
    if (bridge.checkMessage !== undefined) {
      const m = await render(run, bridge.checkMessage, scope, POSITIONS.bridgeOutput, "badOutput").catch(() => undefined);
      if (typeof m === "string" && m) reason = m;
    }
    if (attempt === 0) toInput = withReason(toInput, result, reason);
  }
  throw fail(run, "badOutput", `结果重试后仍没有通过检查：${reason}`, { raw: run.shared.lastRaw });
}

/**
 * The retry carries the failure reason. For message-based contracts (chat) the previous reply and
 * the reason are appended as a conversation turn; other inputs are sent again unchanged.
 */
function withReason(toInput: unknown, result: unknown, reason: string): unknown {
  if (!isObject(toInput) || !Array.isArray(toInput.messages)) return toInput;
  const reply = isObject(result) && typeof result.text === "string" ? [{ role: "assistant", content: result.text }] : [];
  return { ...toInput, messages: [...toInput.messages, ...reply, { role: "user", content: reason }] };
}
