import { type Schema, Validator } from "@cfworker/json-schema";

const validators = new WeakMap<object, Validator>();
const TRUE = new Validator(true as unknown as Schema, "2020-12");
const FALSE = new Validator(false as unknown as Schema, "2020-12");

function validatorFor(schema: object | boolean): Validator {
  if (typeof schema === "boolean") return schema ? TRUE : FALSE;
  let v = validators.get(schema);
  if (!v) {
    // cfworker annotates the schema objects it dereferences, so it gets its own copy.
    v = new Validator(structuredClone(schema) as Schema, "2020-12", true);
    validators.set(schema, v);
  }
  return v;
}

/** Checks `value` against a contract input/output schema; returns a problem description or null. */
export function schemaProblem(schema: object | boolean, value: unknown): string | null {
  const r = validatorFor(schema).validate(value);
  if (r.valid) return null;
  const leaf = r.errors.at(-1) ?? r.errors[0];
  const at = leaf?.instanceLocation.replace(/^#/, "") || "/";
  return `${at}：${leaf?.error ?? "不符合 Schema"}`;
}
