import { type Environment, EvaluationError } from "@marcbachmann/cel-js";

/**
 * R1.4 read-only page functions for automation entries. Elements reach an expression only as
 * opaque ElementHandles: CEL sees a message type with no fields, JS sees an object with no own
 * properties, and the element itself is only reachable through elementOf() (for act targets).
 */

/** The page operations jsdom cannot do (layout, innerText); injected so tests can fake them. */
export interface PageHost {
  /** The element's visible text. */
  text(el: Element): string;
  visible(el: Element): boolean;
}

/** The real page: innerText and the browser's visibility check. */
export const domHost: PageHost = {
  text: (el) => (el as HTMLElement).innerText ?? el.textContent ?? "",
  visible: (el) => {
    const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
    if (typeof check === "function") return check.call(el, { checkOpacity: true, checkVisibilityCSS: true });
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  },
};

const TOKEN = Symbol("element-handle");
const handles = new WeakMap<ElementHandle, { el: Element; host: PageHost }>();
const byHost = new WeakMap<PageHost, WeakMap<Element, ElementHandle>>();

/** An element inside an expression. Only the page functions and `act` targets can use it. */
export class ElementHandle {
  /** Type-only brand (never emitted): keeps the class nominal although it has no members. */
  private declare readonly brand: never;
  constructor(token: typeof TOKEN) {
    if (token !== TOKEN) throw new TypeError("ElementHandle 只能由 elementHandle() 创建");
    Object.freeze(this);
  }
}
Object.freeze(ElementHandle.prototype);

/** The handle of `el`; the same element and host always give the same handle. */
export function elementHandle(el: Element, host: PageHost = domHost): ElementHandle {
  let cache = byHost.get(host);
  if (!cache) byHost.set(host, (cache = new WeakMap()));
  let h = cache.get(el);
  if (!h) {
    h = new ElementHandle(TOKEN);
    handles.set(h, { el, host });
    cache.set(el, h);
  }
  return h;
}

export const isElementHandle = (v: unknown): v is ElementHandle => v instanceof ElementHandle && handles.has(v);

/** The element behind a handle, for act targets. */
export function elementOf(h: ElementHandle): Element {
  const entry = handles.get(h);
  if (!entry) throw new TypeError("不是元素句柄");
  return entry.el;
}

const fail = (message: string): never => {
  throw new EvaluationError(message);
};

function open(h: ElementHandle): { el: Element; host: PageHost } {
  return handles.get(h) ?? fail("不是元素句柄");
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Most text a page function returns, as for the R8.1 text functions. */
const TEXT_MAX = 1024 * 1024;
/** Most elements within() returns (the R8.4 list size). */
const WITHIN_MAX = 1000;

function query<T>(selector: string, run: () => T): T {
  try {
    return run();
  } catch {
    return fail(`选择器无效：${selector}`);
  }
}

/** Fields whose content or `value` attribute is (or starts as) what someone typed (R9.2). */
const FIELDS = new Set(["input", "textarea", "select"]);
const isField = (el: Element) => FIELDS.has(el.localName);

function text(h: ElementHandle): string {
  const { el, host } = open(h);
  // a textarea's text is its default value; an input has none of its own
  if (el.localName === "textarea" || el.localName === "input") return "";
  return collapse(host.text(el)).slice(0, TEXT_MAX);
}

const ROLE_WORDS: Record<string, string> = {
  button: "按钮",
  link: "链接",
  checkbox: "复选框",
  radio: "单选项",
  combobox: "下拉框",
  listbox: "下拉框",
  textbox: "输入框",
  img: "图片",
  heading: "标题",
  dialog: "对话框",
  listitem: "列表项",
};

function roleOf(el: Element): string | undefined {
  const role = el.getAttribute("role");
  if (role && role in ROLE_WORDS) return role;
  const tag = el.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "img") return "img";
  if (tag === "dialog") return "dialog";
  if (tag === "li") return "listitem";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
    if (type === "checkbox" || type === "radio") return type;
    return type === "hidden" ? undefined : "textbox";
  }
  return undefined;
}

const DESCRIBE_NAME_MAX = 20;

/** The element's name as a person would call it; never what someone typed into a field. */
function nameOf(el: Element, host: PageHost, role: string | undefined): string {
  const attr = (n: string) => collapse(el.getAttribute(n) ?? "");
  const labelled = attr("aria-label");
  if (labelled) return labelled;
  const isField = role === "textbox" || role === "combobox" || role === "checkbox" || role === "radio";
  if (isField) {
    const label = (el as HTMLInputElement).labels?.[0];
    const fromLabel = label ? collapse(host.text(label)) : "";
    return fromLabel || attr("placeholder") || attr("title") || attr("name");
  }
  // An input button's value is its caption, not something typed.
  if (el.tagName === "INPUT") return role === "button" ? attr("value") || attr("alt") || attr("title") : "";
  return collapse(host.text(el)) || attr("title") || attr("alt");
}

function describe(h: ElementHandle): string {
  const { el, host } = open(h);
  const role = roleOf(el);
  const word = role ? ROLE_WORDS[role]! : "元素";
  const name = clip(nameOf(el, host, role), DESCRIBE_NAME_MAX);
  return name ? `「${name}」${word}` : word;
}

/** describe() for code: what the action log calls an act's target when the rule gives no describe (R3.6). */
export const describeElement = (h: ElementHandle): string => describe(h);

/** Attributes outline() may show; never `value`, `checked` or `selected` (R9.2). */
const SAFE_ATTRS = ["id", "class", "role", "type", "name", "for", "aria-label", "title", "alt", "placeholder"];
const ATTR_MAX = 40;
const SKIPPED = new Set(["script", "style", "noscript", "template"]);
/** Elements whose content is (or holds) what someone typed. */
const NO_CONTENT = new Set(["textarea", "svg", "canvas", "iframe", "object"]);
const VOID = new Set(["input", "img", "br", "hr", "area", "embed", "source", "track", "wbr", "col", "meta", "link"]);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * The element as compact markup of at most `n` characters: tags, text and a few safe
 * attributes. Never contains the value of an input, textarea or select (R9.2).
 */
function outline(h: ElementHandle, n: bigint): string {
  const { el: root } = open(h);
  if (n < 0n) return fail("outline 的长度不能是负数");
  let left = Number(n > BigInt(TEXT_MAX) ? BigInt(TEXT_MAX) : n);
  const out: string[] = [];

  /** Writes `el`; false once there is no room left, which ends the whole outline. */
  const element = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (SKIPPED.has(tag)) return true;
    let attrs = "";
    for (const a of SAFE_ATTRS) {
      const v = collapse(el.getAttribute(a) ?? "");
      if (v) attrs += ` ${a}="${esc(clip(v, ATTR_MAX))}"`;
    }
    const head = `<${tag}${attrs}>`;
    const tail = VOID.has(tag) ? "" : `</${tag}>`;
    if (head.length + tail.length > left) return false;
    left -= head.length + tail.length;
    out.push(head);
    let room = true;
    if (!VOID.has(tag) && !NO_CONTENT.has(tag)) {
      for (const child of el.childNodes) {
        if (child.nodeType === 1) room = element(child as Element);
        else if (child.nodeType === 3) room = textNode(child.textContent ?? "");
        if (!room) break;
      }
    }
    out.push(tail);
    return room;
  };

  const textNode = (raw: string): boolean => {
    const t = esc(collapse(raw));
    if (!t) return true;
    if (t.length <= left) {
      out.push(t);
      left -= t.length;
      return true;
    }
    if (left > 0) out.push(`${t.slice(0, left - 1)}…`);
    left = 0;
    return false;
  };

  element(root);
  return out.join("");
}

function closest(h: ElementHandle, selector: string): ElementHandle | null {
  const { el, host } = open(h);
  const found = query(selector, () => el.closest(selector));
  return found ? elementHandle(found, host) : null;
}

function within(h: ElementHandle, selector: string): ElementHandle[] {
  const { el, host } = open(h);
  const found = query(selector, () => el.querySelectorAll(selector));
  return Array.from({ length: Math.min(found.length, WITHIN_MAX) }, (_, i) => elementHandle(found[i]!, host));
}

function visible(h: ElementHandle): boolean {
  const { el, host } = open(h);
  return el.isConnected && host.visible(el);
}

function attr(h: ElementHandle, name: string): string {
  const { el } = open(h);
  // getAttribute matches HTML attribute names case-insensitively
  if (isField(el) && name.toLowerCase() === "value") return fail("attr() 不能读输入框、下拉框的 value");
  return el.getAttribute(name) ?? "";
}

type Handler = (this: unknown, ...args: never[]) => unknown;

export const PAGE_FUNCTIONS = ["text", "attr", "describe", "outline", "closest", "within", "visible"] as const;
export type PageFunction = (typeof PAGE_FUNCTIONS)[number];

const SIGNATURES: Record<PageFunction, [signature: string, handler: Handler]> = {
  text: ["text(Element): string", text],
  attr: ["attr(Element, string): string", attr],
  describe: ["describe(Element): string", describe],
  outline: ["outline(Element, int): string", outline],
  closest: ["closest(Element, string): dyn", closest],
  // a plain list, so its items compare with handles from vars (Element == dyn has no overload)
  within: ["within(Element, string): list", within],
  visible: ["visible(Element): bool", visible],
};

/** Makes handles a CEL value with no fields; every environment knows the type. */
export function registerElementType(env: Environment): void {
  env.registerType("Element", { ctor: ElementHandle, fields: {} });
}

export function registerPageFunctions(env: Environment, names: Iterable<string>, wrap: (h: Handler) => Handler): void {
  for (const name of names) {
    const entry = SIGNATURES[name as PageFunction];
    if (entry) env.registerFunction(entry[0], wrap(entry[1]) as never);
  }
}
