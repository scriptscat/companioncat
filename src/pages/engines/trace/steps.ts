import type { TraceEvent } from "../../../core/impl";

export interface TraceStep {
  /** Request step id; absent for a bridge or a preparation step. */
  id?: string;
  kind: "bridge" | "request" | "prepare";
  bridge?: Extract<TraceEvent, { type: "bridge" }>;
  request?: Extract<TraceEvent, { type: "request" }>;
  response?: Extract<TraceEvent, { type: "response" }>;
  cached?: boolean;
  exprs: Extract<TraceEvent, { type: "expr" }>[];
}

/** Groups the flat event list into the numbered steps of the try-run view (R12.1). */
export function groupSteps(events: readonly TraceEvent[]): TraceStep[] {
  const steps: TraceStep[] = [];
  const current = () => steps[steps.length - 1] ?? (steps.push({ kind: "prepare", exprs: [] }), steps[0]!);
  for (const ev of events) {
    switch (ev.type) {
      case "bridge":
        steps.push({ kind: "bridge", bridge: ev, exprs: [] });
        break;
      case "request":
        steps.push({ kind: "request", id: ev.step, request: ev, exprs: [] });
        break;
      case "response": {
        const own = [...steps].reverse().find((s) => s.request && s.id === ev.step && !s.response);
        (own ?? current()).response = ev;
        break;
      }
      case "cache":
        steps.push({ kind: "request", id: ev.step, cached: true, exprs: [] });
        break;
      case "expr":
        current().exprs.push(ev);
        break;
      default:
        break;
    }
  }
  return steps;
}

/** The index of the step to mark as failed, or -1. `stepId` is CallErrorDetail.step. */
export function failedStep(steps: readonly TraceStep[], stepId: string | undefined, hasExprFailure: boolean): number {
  const withExpr = steps.findIndex((s) => s.exprs.some((e) => e.error !== undefined));
  if (hasExprFailure && withExpr >= 0) return withExpr;
  if (stepId && stepId !== "request") {
    const i = steps.findIndex((s) => s.id === stepId);
    if (i >= 0) return i;
  }
  if (stepId === "request") {
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.request) return i;
  }
  return withExpr >= 0 ? withExpr : steps.length - 1;
}
