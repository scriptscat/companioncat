import { BASE_FUNCTIONS, checkTemplate, PAGE_FUNCTIONS, position, type ExprError, type Position, type VarName } from "../expr";
import { isAutomationEntry } from "./automation";
import { isObject } from "./merge";

const ENGINE: VarName[] = ["input", "options", "secret", "steps"];
const PAGE: VarName[] = ["settings", "vars", "selection", "page", "site"];
const TRIGGER: VarName[] = ["settings", "site", "page"];
/** R1.4: automation triggers and run also read the page through element handles. */
const AUTOMATION = [...BASE_FUNCTIONS, ...PAGE_FUNCTIONS];

/**
 * Where each rule field is evaluated and which variables it may use (R8.3).
 * The runtime renders templates with these same positions.
 */
export const POSITIONS = {
  hosts: position("引擎 hosts", ["options"]),
  when: position("引擎 when", ["options"]),
  /** `landed.<id>` is where an earlier step ended up after redirects (its own, too, in its output). */
  request: position("引擎请求", [...ENGINE, "landed"]),
  stepOutput: position("引擎步骤 output", [...ENGINE, "response", "landed"]),
  stream: position("引擎 stream", [...ENGINE, "response", "stream"]),
  output: position("引擎 output", [...ENGINE, "response", "stream"]),
  errors: position("引擎 errors", [...ENGINE, "response"]),
  bridgeInput: position("桥接 input", ["input", "options"]),
  bridgeOutput: position("桥接 output", ["input", "result"]),
  trigger: position("触发器", TRIGGER),
  /** An automation entry's triggers: `trigger` is the event (for appear, its element). */
  autoTrigger: position("自动化触发器", [...TRIGGER, "trigger"], AUTOMATION),
  /** An automation entry's run; `item` is added inside repeat-each steps and find's where. */
  autoRun: position("自动化 run", [...PAGE, "trigger"], AUTOMATION),
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
  return position(pos.name, [...new Set([...pos.vars, ...extra])], [...pos.functions]);
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

/** Automation steps: `item` is the current element in a repeat-each body and in find's `where`. */
function autoSteps(pos: Position): Walker {
  const withItem = withVars(pos, "item");
  const step: Walker = (value, path, sink) => {
    if (!isObject(value)) return expr(pos)(value, path, sink);
    for (const [k, v] of Object.entries(value)) {
      const at = [...path, k];
      if (k === "then" || k === "else") autoSteps(pos)(v, at, sink);
      else if (k === "steps" && "repeat" in value) autoSteps(value.repeat === true ? pos : withItem)(v, at, sink);
      else if (k === "where" && "find" in value) expr(withItem)(v, at, sink);
      else expr(pos)(v, at, sink);
    }
  };
  return each(step);
}

export type ItemKind = "contract" | "bridge" | "provider" | "view" | "feature" | "entry" | "site";

/** Expression checkers for each kind of item, applied to a raw definition or an override patch. */
export const CHECKS: Record<ItemKind, Walker> = {
  contract: fields({ view: component(POSITIONS.contractView) }),
  bridge: inlineBridge,
  provider: fields({ hosts: expr(POSITIONS.hosts), implements: values(oneOrEach(implementation)) }),
  view: component(POSITIONS.viewTemplate),
  entry: (value, path, sink) => {
    const auto = isAutomationEntry(value);
    const trigger = expr(auto ? POSITIONS.autoTrigger : POSITIONS.trigger);
    fields({
      triggers: each(fields({ enabled: trigger, confirm: trigger, hotkey: trigger })),
      select: expr(POSITIONS.select),
      run: auto ? autoSteps(POSITIONS.autoRun) : expr(POSITIONS.run),
      present: fields({ surface: expr(POSITIONS.surface), view }),
    })(value, path, sink);
  },
  feature: (value, path, sink) => fields({ entries: each(CHECKS.entry) })(value, path, sink),
  site: fields({ skip: expr(POSITIONS.site) }),
};
