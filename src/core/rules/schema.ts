import { type OutputUnit, type Schema, Validator } from "@cfworker/json-schema";
import v1 from "../../../rules/schema/v1.json";
import { nestedTooDeep, NESTING_MESSAGE } from "./json";
import type { RulePack } from "./types";

export interface SchemaIssue {
  /** JSON pointer of the offending field. */
  path: string;
  message: string;
}

export type DefKind = "contract" | "bridge" | "provider" | "viewTemplate" | "feature" | "site";

const SCHEMA = v1 as unknown as Schema & { $defs: Record<string, Schema> };
// cfworker annotates the schema objects it dereferences, so each validator gets its own copy.
const packValidator = new Validator(structuredClone(SCHEMA), "2020-12", false);
const defValidators = new Map<DefKind, Validator>();

function defValidator(kind: DefKind): Validator {
  let v = defValidators.get(kind);
  if (!v) {
    v = new Validator({ $defs: structuredClone(SCHEMA.$defs), $ref: `#/$defs/${kind}` }, "2020-12", false);
    defValidators.set(kind, v);
  }
  return v;
}

// Keywords that only say "something inside me failed"; the inner error says what.
const CONTAINERS = new Set([
  "$ref",
  "properties",
  "items",
  "prefixItems",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "patternProperties",
  "propertyNames",
  "allOf",
  "anyOf",
  "oneOf",
  "if",
  "then",
  "else",
  "contains",
  "dependentSchemas",
]);

function describe(unit: { path: string; keyword: string; message: string }): string {
  const { keyword, message } = unit;
  if (keyword === "required") {
    const m = /property "(.+)"/.exec(message);
    return `缺少必填字段 ${m?.[1] ?? ""}`.trim();
  }
  if (keyword === "false") return `不认识的字段 ${unit.path.slice(unit.path.lastIndexOf("/") + 1).replaceAll("~1", "/").replaceAll("~0", "~")}`;
  if (keyword === "enum") {
    const m = /any of (\[.*\])\.?$/.exec(message);
    try {
      if (m) return `取值不对，只能是 ${(JSON.parse(m[1]!) as unknown[]).map((v) => JSON.stringify(v)).join("、")}`;
    } catch {
      // fall through to the validator's own words
    }
  }
  if (keyword === "const") return "取值不对";
  if (keyword === "pattern") return "格式不对";
  return message;
}

/**
 * Reduces cfworker's error tree to the problems a person can act on: container errors are
 * dropped, and type mismatches left over from anyOf branches are dropped when the value
 * matched another branch deeper down, or merged into one "should be A or B" message.
 */
function issues(errors: OutputUnit[]): SchemaIssue[] {
  const units = errors
    .map((e) => ({ path: e.instanceLocation.replace(/^#/, ""), keyword: e.keyword, message: e.error }))
    .filter((u) => !CONTAINERS.has(u.keyword));
  const deeper = (p: string) => units.some((o) => o.path.startsWith(`${p}/`));
  const out: SchemaIssue[] = [];
  const typesAt = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const u of units) {
    if (u.keyword === "type") {
      if (deeper(u.path) || units.some((o) => o.path === u.path && o.keyword !== "type")) continue;
      const expected = /Expected "(.+?)"/.exec(u.message)?.[1] ?? "";
      const list = typesAt.get(u.path);
      if (list) {
        list.push(expected);
        continue;
      }
      typesAt.set(u.path, [expected]);
      out.push({ path: u.path, message: "" });
      continue;
    }
    const message = describe(u);
    const key = `${u.path}\n${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: u.path, message });
  }
  for (const issue of out) {
    const types = typesAt.get(issue.path);
    if (issue.message === "" && types) issue.message = `类型不对，应该是 ${[...new Set(types)].join(" 或 ")}`;
  }
  return out;
}

export type PackValidation = { ok: true; pack: RulePack; errors: [] } | { ok: false; errors: SchemaIssue[] };

/** Checks a parsed pack against rules/schema/v1.json. */
export function validatePack(json: unknown): PackValidation {
  // Validation, expression checks and merging all recurse; refuse the whole pack up front.
  if (nestedTooDeep(json)) return { ok: false, errors: [{ path: "", message: NESTING_MESSAGE }] };
  const result = packValidator.validate(json);
  if (result.valid) return { ok: true, pack: json as RulePack, errors: [] };
  const errors = issues(result.errors);
  return { ok: false, errors: errors.length > 0 ? errors : [{ path: "", message: "规则包格式不对" }] };
}

/** Checks one (merged) definition against its schema definition; paths are relative to it. */
export function validateDef(kind: DefKind, value: unknown): SchemaIssue[] {
  const result = defValidator(kind).validate(value);
  if (result.valid) return [];
  const errors = issues(result.errors);
  return errors.length > 0 ? errors : [{ path: "", message: "格式不对" }];
}
