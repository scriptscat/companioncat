import { checkTemplate, position, type ExprError, type Position, type VarName } from "../expr";
import { isObject } from "./merge";

const ENGINE: VarName[] = ["input", "options", "secret", "steps"];
const PAGE: VarName[] = ["settings", "vars", "selection", "page", "site"];

/**
 * Where each rule field is evaluated and which variables it may use (R8.3).
 * The runtime renders templates with these same positions.
 */
export const POSITIONS = {
  hosts: position("引擎 hosts", ["options"]),
  when: position("引擎 when", ["options"]),
  request: position("引擎请求", ENGINE),
  stepOutput: position("引擎步骤 output", [...ENGINE, "response"]),
  stream: position("引擎 stream", [...ENGINE, "response", "stream"]),
  output: position("引擎 output", [...ENGINE, "response", "stream"]),
  errors: position("引擎 errors", [...ENGINE, "response"]),
  bridgeInput: position("桥接 input", ["input", "options"]),
  bridgeOutput: position("桥接 output", ["input", "result"]),
  trigger: position("触发器", ["settings", "site", "page"]),
  select: position("段落选择", ["settings", "site", "page"]),
  run: position("功能 run", PAGE),
  surface: position("展示位置", PAGE),
  view: position("视图", [...PAGE, "result"]),
  viewTemplate: position("视图模板", ["params"]),
  contractView: position("契约视图", ["result"]),
  site: position("网站规则", ["page"]),
} as const;

/** A component position with extra variables: `item` inside result-list items, `value` inside onChange. */
export function withVars(pos: Position, ...extra: VarName[]): Position {
  return position(pos.name, [...new Set([...pos.vars, ...extra])]);
}

export type Path = readonly (string | number)[];
export type ExprSink = (error: ExprError, path: Path) => void;
type Walker = (value: unknown, path: Path, sink: ExprSink) => void;

const expr =
  (pos: Position): Walker =>
  (value, path, sink) => {
    for (const e of checkTemplate(value, pos)) sink(e, [...path, ...e.path]);
  };

const fields =
  (spec: Record<string, Walker>): Walker =>
  (value, path, sink) => {
    if (!isObject(value)) return;
    for (const [k, w] of Object.entries(spec)) if (k in value) w(value[k], [...path, k], sink);
  };

const each =
  (w: Walker): Walker =>
  (value, path, sink) => {
    if (Array.isArray(value)) value.forEach((v, i) => w(v, [...path, i], sink));
  };

const oneOrEach =
  (w: Walker): Walker =>
  (value, path, sink) =>
    Array.isArray(value) ? each(w)(value, path, sink) : w(value, path, sink);

const values =
  (w: Walker): Walker =>
  (value, path, sink) => {
    if (isObject(value)) for (const [k, v] of Object.entries(value)) w(v, [...path, k], sink);
  };

function component(pos: Position): Walker {
  const withItem = withVars(pos, "item");
  return (value, path, sink) =>
    fields({
      header: each(component(pos)),
      body: oneOrEach(component(pos)),
      children: each(component(pos)),
      value: expr(pos),
      style: expr(pos),
      label: expr(pos),
      options: expr(pos),
      from: expr(pos),
      action: expr(pos),
      onChange: expr(withVars(pos, "value")),
      item: values(component(withItem)),
      meta: expr(withItem),
      itemActions: expr(withItem),
    })(value, path, sink);
}

const inlineBridge = fields({
  input: expr(POSITIONS.bridgeInput),
  output: expr(POSITIONS.bridgeOutput),
  check: expr(POSITIONS.bridgeOutput),
  checkMessage: expr(POSITIONS.bridgeOutput),
});

const http = fields({
  steps: each(fields({ request: expr(POSITIONS.request), output: expr(POSITIONS.stepOutput) })),
  request: expr(POSITIONS.request),
  stream: fields({ delta: expr(POSITIONS.stream) }),
  output: expr(POSITIONS.output),
  errors: each(expr(POSITIONS.errors)),
});

const implementation = fields({
  when: expr(POSITIONS.when),
  http,
  via: (value, path, sink) => {
    if (isObject(value)) inlineBridge(value, path, sink);
  },
});

const view: Walker = (value, path, sink) =>
  isObject(value) && "use" in value
    ? fields({ with: expr(POSITIONS.view) })(value, path, sink)
    : component(POSITIONS.view)(value, path, sink);

export type ItemKind = "contract" | "bridge" | "provider" | "view" | "feature" | "entry" | "site";

/** Expression checkers for each kind of item, applied to a raw definition or an override patch. */
export const CHECKS: Record<ItemKind, Walker> = {
  contract: fields({ view: component(POSITIONS.contractView) }),
  bridge: inlineBridge,
  provider: fields({ hosts: expr(POSITIONS.hosts), implements: values(oneOrEach(implementation)) }),
  view: component(POSITIONS.viewTemplate),
  entry: fields({
    triggers: each(fields({ enabled: expr(POSITIONS.trigger), confirm: expr(POSITIONS.trigger) })),
    select: expr(POSITIONS.select),
    run: expr(POSITIONS.run),
    present: fields({ surface: expr(POSITIONS.surface), view }),
  }),
  feature: (value, path, sink) => fields({ entries: each(CHECKS.entry) })(value, path, sink),
  site: fields({ skip: expr(POSITIONS.site) }),
};
