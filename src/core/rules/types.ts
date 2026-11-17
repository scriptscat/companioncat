/**
 * Shapes of a rule pack (rules/schema/v1.json) and of the resolved model built from packs.
 * Pack shapes are what the schema allows; resolved definitions have inheritance and
 * local overrides applied, every `null` deletion removed and references made full ids.
 */

export type JsonObject = Record<string, unknown>;

export type ErrorType =
  | "network"
  | "timeout"
  | "auth"
  | "rateLimit"
  | "server"
  | "badInput"
  | "badOutput"
  | "hostUndeclared"
  | "hostUnconfirmed"
  | "missingKey"
  | "disabled";

export interface ContractDef {
  id: string;
  name?: string;
  description?: string;
  input: JsonObject | boolean;
  output: JsonObject | boolean;
  bridgeable?: boolean;
  sample?: unknown;
  view?: ComponentDef;
}

export interface InlineBridgeDef {
  to: string;
  input: unknown;
  output: unknown;
  check?: boolean | string;
  checkMessage?: string;
}

export interface BridgeDef extends InlineBridgeDef {
  id: string;
  name?: string;
  description?: string;
  /** The contract this bridge implements. */
  from: string;
}

export interface RequestDef {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: JsonObject | string;
  text?: string;
}

export interface HttpStepDef {
  id: string;
  request: RequestDef;
  response?: "json" | "text";
  output?: unknown;
  cache?: number;
}

export interface HttpErrorDef {
  status?: number | string | number[];
  when?: boolean | string;
  type: ErrorType;
  message?: string;
}

export interface HttpDef {
  steps?: HttpStepDef[];
  request: RequestDef;
  response?: "json" | "text" | "sse";
  stream?: { delta: string; done?: string };
  output: unknown;
  errors?: HttpErrorDef[];
  batch?: { maxItems?: number; maxChars?: number; join?: string };
  langMap?: Record<string, string>;
}

export interface ImplementationDef {
  when?: boolean | string;
  http?: HttpDef;
  /** Resolved: a full bridge id (`pack/bridge`) or an inline bridge. */
  via?: string | InlineBridgeDef;
  builtin?: string;
}

export interface SecretDef {
  name: string;
  title: string;
  placeholder?: string;
  helpUrl?: string;
  helpLabel?: string;
}

export interface OptionDef {
  type?: "string" | "number" | "boolean" | "enum";
  title?: string;
  description?: string;
  default?: unknown;
  placeholder?: string;
  options?: Record<string, string>;
  min?: number;
  max?: number;
}

export interface LimitsDef {
  timeoutMs?: number;
  retry?: { on: ErrorType[]; max: number };
  concurrency?: number;
  perMinute?: number;
}

export interface ProviderDef {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  secrets?: SecretDef[];
  options?: Record<string, OptionDef>;
  hosts?: string[];
  limits?: LimitsDef;
  implements: Record<string, ImplementationDef | ImplementationDef[]>;
}

export interface SettingDef {
  type: "boolean" | "enum" | "language" | "engine" | "engines" | "string" | "number";
  title: string;
  description?: string;
  default?: unknown;
  scope?: "global" | "site";
  quick?: boolean | "first";
  options?: Record<string, string>;
  capability?: string;
  max?: number;
  min?: number;
  step?: number;
  placeholder?: string;
}

export interface TriggerDef {
  on: "selection" | "command" | "page-load";
  enabled?: boolean | string;
  confirm?: string;
  ignoreIn?: string[];
  minLength?: number;
  maxLength?: number;
  title?: string;
  hotkey?: string;
  quick?: boolean;
}

export interface RunStepDef {
  set?: JsonObject;
  call?: string;
  strategy?: "first" | "race" | "all" | "vote";
  engines?: string[] | string;
  input?: unknown;
  stream?: boolean | string;
  batch?: "blocks";
  as?: string;
}

export interface SelectDef {
  blocks?: "auto" | string[] | string;
  exclude?: string[];
  lazy?: "viewport";
  watch?: "mutations";
}

export interface SurfaceDef {
  type: "near-selection" | "bubble" | "inline-after";
  pinnable?: boolean;
  closeOn?: ("escape" | "outside-click" | "new-selection")[];
  target?: "block";
  hideSource?: boolean | string;
}

export interface ActionDef {
  copy?: string;
  retry?: string;
  rerun?: { vars: JsonObject };
  open?: string;
  surface?: "pin" | "close";
}

export interface ComponentDef {
  type: "card" | "row" | "text" | "icon" | "icon-button" | "button" | "select" | "spacer" | "dots" | "result-list";
  header?: ComponentDef[];
  body?: ComponentDef | ComponentDef[];
  children?: ComponentDef[];
  value?: unknown;
  tone?: "default" | "muted" | "danger" | "success";
  style?: string;
  name?: string;
  icon?: string;
  label?: string;
  action?: ActionDef;
  options?: Record<string, string> | string;
  onChange?: ActionDef;
  from?: string;
  primary?: "first" | "none";
  item?: { ok?: ComponentDef; loading?: ComponentDef; error?: ComponentDef; needKey?: ComponentDef };
  meta?: string[];
  itemActions?: { icon?: string; label: string; action: ActionDef }[];
}

export interface ViewTemplateDef extends ComponentDef {
  params?: string[];
  description?: string;
}

/** Resolved: `use` is a full view id (`pack/view`). */
export interface ViewUseDef {
  use: string;
  with?: JsonObject;
}

export interface EntryDef {
  id: string;
  name: string;
  description?: string;
  match?: string[];
  settings?: Record<string, SettingDef>;
  triggers: TriggerDef[];
  toggle?: boolean;
  select?: SelectDef;
  run: RunStepDef[];
  present: { surface: SurfaceDef; view: ViewUseDef | ComponentDef };
}

export interface FeatureDef {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  match: string[];
  exclude?: string[];
  settings?: Record<string, SettingDef>;
  entries: EntryDef[];
}

export interface SiteDef {
  match: string[];
  /** Full entry id: `pack/feature.entry`. */
  for: string;
  blocks?: string[];
  skip?: boolean | string;
  [key: string]: unknown;
}

export interface RulePack {
  $schema?: string;
  schema: number | string;
  id: string;
  name?: string;
  description?: string;
  version?: string;
  homepage?: string;
  author?: string;
  contracts?: ContractDef[];
  bridges?: BridgeDef[];
  providers?: JsonObject[];
  views?: Record<string, ViewTemplateDef | null>;
  features?: FeatureDef[];
  sites?: SiteDef[];
  overrides?: Record<string, JsonObject>;
}

/** One pack handed to resolveRules. Subscriptions keep their list order; local rules always come first. */
export interface PackSource {
  /** Parsed pack JSON (validated inside resolveRules). */
  pack: unknown;
  /** From an official subscription: its contract ids cannot be taken over by other packs. */
  official?: boolean;
  /** The local rules: highest priority, and the only pack whose `overrides` apply. */
  local?: boolean;
}

/** Where an expression error sits inside the template string at `path`. */
export interface ExprLocation {
  template: string;
  /** Expression source between `{{` and `}}`. */
  source: string;
  /** Offsets into `template`. */
  start: number;
  end: number;
}

export interface Diagnostic {
  severity: "error" | "warning";
  /** Index of the pack in the resolveRules input. */
  source: number;
  /** Id of that pack ("" when it has none). */
  pack: string;
  /** Full id of the affected item; absent for pack-level problems. */
  item?: string;
  /** JSON pointer into that pack's JSON. */
  path: string;
  message: string;
  expr?: ExprLocation;
}

export interface ResolvedItem<T> {
  /** Full id: `pack/item`, entries `pack/feature.entry`, contracts their contract id. */
  ref: string;
  id: string;
  pack: string;
  source: number;
  def: T;
  /** False when any problem is an error (R2.6). */
  enabled: boolean;
  problems: Diagnostic[];
}

export interface ResolvedProvider extends ResolvedItem<ProviderDef> {
  /** Inherited providers, nearest first. */
  ancestors: string[];
  /** Provider whose saved keys this one uses: the nearest in the chain that declares `secrets`. */
  secretsFrom: string;
}

export type ResolvedEntry = ResolvedItem<EntryDef>;

export interface ResolvedFeature extends ResolvedItem<Omit<FeatureDef, "entries">> {
  entries: ResolvedEntry[];
}

export interface ResolvedContract extends ResolvedItem<ContractDef> {
  official: boolean;
}

export interface ResolvedSite {
  pack: string;
  source: number;
  def: SiteDef;
}

export interface Resolved {
  features: ResolvedFeature[];
  /** Concrete providers only; abstract ones exist just to be inherited. */
  providers: ResolvedProvider[];
  views: ResolvedItem<ViewTemplateDef>[];
  bridges: ResolvedItem<BridgeDef>[];
  contracts: ResolvedContract[];
  sites: ResolvedSite[];
  /** Every problem, local rules first, then subscriptions in list order. */
  diagnostics: Diagnostic[];
}
