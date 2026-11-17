/**
 * Thin helpers over the sctl CLI for the E2E run: page eval with in-page helpers that reach into
 * the 陪伴猫 shadow root, accessibility-snapshot refs for trusted clicks and fills, screenshots.
 */
import { execFileSync } from "node:child_process";

/**
 * Runs one sctl command. A failure is rethrown with sctl's own error line only — never the command
 * line, which can carry a key being typed into a field.
 */
export function sctl(args, opts = {}) {
  try {
    return run(args, opts);
  } catch (e) {
    // The browser can drop the debugger session (e.g. its password manager reacting to a key field); try once more.
    if (!/Detached while handling command|DEBUGGER_DETACHED/.test(e.message)) throw e;
    execFileSync("sleep", ["1"]);
    return run(args, opts);
  }
}

function run(args, opts) {
  try {
    return execFileSync("sctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: opts.timeout ?? 60_000 });
  } catch (e) {
    const err = String(e.stderr ?? "").trim().split("\n").filter((l) => l.startsWith("error:")).join("\n");
    throw new Error(`sctl ${args[0]} ${args[1] ?? ""} failed: ${err || (e.signal ? `killed (${e.signal})` : `exit ${e.status}`)}`);
  }
}
export const sctlJson = (args, opts) => JSON.parse(sctl([...args, "-o", "json"], opts));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Helpers defined inside the page before each evaluated body. */
const PRELUDE = String.raw`
const R = () => document.querySelector("companion-cat")?.shadowRoot;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const all = (sel) => [...(R()?.querySelectorAll(sel) ?? [])];
const txt = (el) => (el?.innerText ?? el?.textContent ?? "").replace(/\s+/g, " ").trim();
const byText = (sel, t) => all(sel).find((el) => txt(el) === t) ?? all(sel).find((el) => txt(el).includes(t));
const byLabel = (sel, name) => all(sel).find((el) => el.getAttribute("aria-label") === name);
const waitFor = async (fn, what = "condition", ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout waiting for " + what);
    await sleep(50);
  }
};
const paw = () => R()?.querySelector("[data-cc-paw]");
const cards = () => all("[data-cc-card]");
const card = () => cards().at(-1);
/** Engine rows of the newest card, in display order. */
const rows = () =>
  [...(card()?.querySelectorAll("[data-part=result-item]") ?? [])].map((el) => ({
    engine: el.dataset.engine,
    state: el.dataset.state,
    primary: el.dataset.primary === "true",
    text: txt(el),
  }));
const row = (engine) => rows().find((r) => r.engine === engine);
const rowEl = (engine) => card()?.querySelector('[data-part=result-item][data-engine="' + engine + '"]');
/** Selects a node's text (or a range of a form field) the way a mouse would, then releases the mouse. */
const selectText = (id, start, end) => {
  const el = document.getElementById(id);
  getSelection().removeAllRanges();
  // A real mouse press on page text moves focus off a previously focused field.
  if (document.activeElement && document.activeElement !== el) document.activeElement.blur?.();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    el.setSelectionRange(start ?? 0, end ?? el.value.length);
  } else {
    const node = el.firstChild;
    const r = document.createRange();
    r.setStart(node, start ?? 0);
    r.setEnd(node, end ?? node.length);
    getSelection().addRange(r);
  }
  const rect = el.getBoundingClientRect();
  const at = { bubbles: true, composed: true, clientX: rect.left + 20, clientY: rect.top + 10 };
  el.dispatchEvent(new MouseEvent("mousedown", at));
  el.dispatchEvent(new MouseEvent("mouseup", at));
};
const settings = () => R()?.querySelector('[role=dialog][aria-label="陪伴猫设置"]');
const bubble = () => R()?.querySelector('[role=dialog][aria-label="陪伴猫"]');
/** Opens the settings window (through the cat's bubble, like a user) at a nav section. */
const openSettings = async (section) => {
  if (!settings()) {
    if (!bubble()) byLabel("button", "陪伴猫").click();
    (await waitFor(() => byText("button", "打开设置"), "打开设置")).click();
    await waitFor(settings, "settings window");
  }
  if (section) {
    // Wide: a nav of buttons with the section title in <main>; narrow (<640px): a radiogroup.
    const navItem = () => [...settings().querySelectorAll('[aria-label="设置分区"] button')].find((x) => txt(x) === section);
    if (!navItem()) throw new Error("no settings section " + section);
    navItem().click();
    await waitFor(() => {
      const h = settings().querySelector("main h2");
      return h ? txt(h) === section : navItem()?.getAttribute("aria-checked") === "true";
    }, "section " + section);
  }
  return settings();
};
const closeSettings = async () => {
  const s = settings();
  if (!s) return;
  [...s.querySelectorAll("button")].find((b) => /^关闭( \(Esc\))?$/.test(b.getAttribute("aria-label") ?? "")).click();
  await waitFor(() => !settings(), "settings closed");
};
const closeCards = async () => {
  for (const c of cards()) [...c.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "关闭")?.click();
  await waitFor(() => cards().length === 0, "cards closed");
};
/** Picks 外观 on the 通用 page (which must be open) and waits for the host class. */
const theme = async (label) => {
  const radio = () => [...settings().querySelectorAll('[role=radiogroup][aria-label="外观"] [role=radio]')].find((r) => txt(r) === label);
  radio().click();
  await waitFor(() => radio().getAttribute("aria-checked") === "true", "theme " + label);
  if (label !== "跟随系统") await waitFor(() => R().host.classList.contains("dark") === (label === "深色"), "theme class " + label);
};
/** An engine in the engines list, by its exact name (the row also holds an avatar letter and a description). */
const engineButton = (name) =>
  [...(settings()?.querySelectorAll("main button") ?? [])].find((b) => [...b.querySelectorAll("*")].some((e) => e.children.length === 0 && txt(e) === name));
const openEngine = async (name) => {
  await openSettings("引擎");
  (await waitFor(() => engineButton(name), "engine " + name)).click();
  await waitFor(() => [...settings().querySelectorAll("main h3, main h2, main p")].some((e) => txt(e) === name), "engine detail " + name);
};
/** The selection entry's engine checklist on the 翻译 feature page (which must be open). */
const engineBox = (name) =>
  [...(settings()?.querySelectorAll('[role=group][aria-label="卡片里显示哪些引擎"] [role=checkbox]') ?? [])].find((c) => c.getAttribute("aria-label") === name);
/** Ticks or unticks an engine; "missing" when the engine is not in the list at all. */
const tick = async (name, on) => {
  const c = engineBox(name);
  if (!c) return "missing";
  if ((c.getAttribute("aria-checked") === "true") !== on) {
    c.click();
    await waitFor(() => (engineBox(name)?.getAttribute("aria-checked") === "true") === on, "tick " + name);
  }
  return "ok";
};
const inSettings = (sel, t) => [...(settings()?.querySelectorAll(sel) ?? [])].find((el) => txt(el) === t) ?? [...(settings()?.querySelectorAll(sel) ?? [])].find((el) => txt(el).startsWith(t));
/** Selects the paragraph, clicks the paw and waits for the card. */
const translate = async (id) => {
  await closeCards();
  selectText(id);
  await waitFor(paw, "paw");
  paw().querySelector("button").click();
  await waitFor(card, "card");
};
const settled = () =>
  rows().length > 0 &&
  rows().every((r) => r.state !== "loading" && r.state !== "streaming") &&
  // views render their templates asynchronously: wait for each finished row's text too
  [...card().querySelectorAll("[data-part=result-item][data-state=ok]")].every((el) => txt(el.querySelector("[data-part=text]")));
const settle = () => waitFor(settled, "card results", 15000);
const clearSelection = () => {
  getSelection().removeAllRanges();
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
  document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }));
};
`;

export class Page {
  constructor(tab) {
    this.tab = String(tab);
  }
  /** Runs `body` (statements, may await, should return JSON) in the page with the prelude in scope. */
  eval(body, timeout = "20s") {
    const expr = `(async () => { ${PRELUDE}\n${body}\n})()`;
    return sctlJson(["page", "eval", expr, "--tab", this.tab, "--timeout", timeout], { timeout: 90_000 }).value;
  }
  goto(url) {
    sctl(["page", "goto", url, "--tab", this.tab, "--wait", "load"]);
  }
  snapshot() {
    return sctl(["page", "snapshot", "--tab", this.tab]);
  }
  /** The ref of the first snapshot node `- role "name…"` (name prefix match). */
  ref(role, name, { exact = false } = {}) {
    for (const line of this.snapshot().split("\n")) {
      const m = /^\s*- (\S+) "([^"]*)"(.*)\[ref=(e\d+)\]/.exec(line);
      if (!m || m[1] !== role) continue;
      if (exact ? m[2] === name : m[2].startsWith(name)) return m[4];
    }
    throw new Error(`no ${role} "${name}" in the snapshot`);
  }
  click(role, name, o) {
    sctl(["page", "click", this.ref(role, name, o), "--tab", this.tab]);
  }
  fill(role, name, text, o) {
    sctl(["page", "fill", this.ref(role, name, o), text, "--tab", this.tab]);
  }
  screenshot(file) {
    sctl(["page", "screenshot", "-f", file, "--tab", this.tab, "--activate"]);
  }
  cdp(method, params = {}) {
    return sctl(["cdp", "send", method, "--params", JSON.stringify(params), "--tab", this.tab]);
  }
}
