export type ExprErrorCode = "syntax" | "limit" | "timeout" | "runtime" | "int-range";

export type ValuePath = readonly (string | number)[];

/** A failed `{{ }}` expression, positioned inside the template string it came from. */
export class ExprError extends Error {
  override readonly name = "ExprError";
  constructor(
    readonly code: ExprErrorCode,
    message: string,
    /** The expression source between `{{` and `}}`. */
    readonly expr: string,
    /** Offsets into the template string (not into `expr`). */
    readonly start: number,
    readonly end: number,
    /** Where the template string sits inside the rendered value. */
    readonly path: ValuePath = [],
  ) {
    super(message);
  }

  withPath(path: ValuePath): ExprError {
    return new ExprError(this.code, this.message, this.expr, this.start, this.end, path);
  }
}
