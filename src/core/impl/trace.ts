import type { CallErrorDetail, ErrorType } from "../errors";

/** One step of a call, for the try-run view (R12.1). Keys are masked before an event is emitted. */
export type TraceEvent =
  /** A `via` implementation handed the call to another contract. */
  | { type: "bridge"; bridge: string; from: string; to: string; attempt: number; input: unknown }
  | { type: "request"; step: string; method: string; url: string; headers: Record<string, string>; body?: string }
  /** `chunks` counts SSE events for streamed responses, otherwise delivered body chunks. */
  | { type: "response"; step: string; status: number; ms: number; chunks: number; body: string }
  /** A step result came from the step cache instead of a request. */
  | { type: "cache"; step: string; hit: true }
  /** A rule field rendered at `position`: its template and the value (or the error). */
  | { type: "expr"; position: string; template: unknown; value?: unknown; error?: string }
  | { type: "output"; contract: string; output: unknown }
  | { type: "error"; contract: string; errorType: ErrorType; message: string; detail: CallErrorDetail };

/** A piece of streamed text (R9.11 streaming updates). */
export interface Delta {
  text: string;
}
