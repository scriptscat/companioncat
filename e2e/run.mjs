#!/usr/bin/env node
/**
 * End-to-end run against the user's real ScriptCat (spec "Testing decisions", E2E row).
 *
 * Prerequisites: `pnpm build`, then dist/companioncat.user.js installed once with
 * `node e2e/install.mjs` (approved in the browser). The first scenarios bring the storage of an
 * earlier run back to a known state.
 *
 *   node e2e/run.mjs              — every scenario, in order (they build on each other)
 *   node e2e/run.mjs --list       — scenario names
 *   node e2e/run.mjs --until N --keep   — debugging: stop after scenario N, leave the window and server up
 *   node e2e/run.mjs --from N     — debugging: start at scenario N on the storage an earlier run left
 *
 * Starts the local fake services (e2e/server.mjs), opens its own browser window, drives it with
 * sctl, writes the R13.4 screenshot set to e2e/artifacts/, and closes the window and server.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Page, sctl, sctlJson, sleep } from "./lib.mjs";
import { spawn } from "node:child_process";
import { E2E_KEY } from "./server.mjs";
import { stripForeign } from "./foreign.mjs";
import { blankReply, buttonKey, chooseReply, DRAFT_BAD, llmLog, resetLlm, scriptLlm, TEACH_CORRECTION, TEACH_DESCRIPTION, TEACH_QUICK_REPLY, teachReplies } from "./script.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(DIR, "artifacts");
const PORT = Number(process.env.E2E_PORT ?? 4719);
const SITE = `http://localhost:${PORT}`;
const OTHER = `http://127.0.0.1:${PORT}`;
const PACK_URL = `${SITE}/pack.json`;

const ENGINE = { a: "e2e/fake-a", b: "e2e/fake-b", key: "e2e/fake-key" };

class Fail extends Error {}
const expect = (cond, msg) => {
  if (!cond) throw new Fail(msg);
};

/** JEV_SECRET_KEY from ~/.env, never printed. */
function jevKey() {
  try {
    const text = readFileSync(path.join(os.homedir(), ".env"), "utf8");
    const m = /^\s*(?:export\s+)?JEV_SECRET_KEY\s*=\s*(.*)$/m.exec(text);
    const v = m?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
    return v || undefined;
  } catch {
    return undefined;
  }
}

let srv;
let page;
let other;
let windowId;
let shotNo = 0;
/** The R7.4 dialog's on-screen box [left, top, width, height], measured while it is open. */
let dialogBox;
/** The R10.1 card header text. */
let cardHeader = "";
const shots = [];

function shot(name, p = page) {
  const file = path.join(ART, `${String(++shotNo).padStart(2, "0")}-${name}.png`);
  p.screenshot(file);
  shots.push(file);
}
/** The fake services run in their own process: the sctl calls here are synchronous and would starve an in-process server. */
const admin = async (path, body, tries = 3) => {
  try {
    const init = { method: body ? "POST" : "GET", headers: { connection: "close" }, body: body ? JSON.stringify(body) : undefined };
    return await (await fetch(`${SITE}/admin/${path}`, init)).json();
  } catch (e) {
    if (tries <= 1) throw e;
    await sleep(200);
    return admin(path, body, tries - 1);
  }
};
const setState = (patch) => admin("state", patch);
const serverLog = () => admin("log");
const mark = async () => (await serverLog()).length;
const since = async (m) => (await serverLog()).slice(m);

// Automation and quiz (R2–R5): the fake video page, the fake quiz page and the fake LLM (e2e/llm.mjs, port + 1).
const VIDEO = `${SITE}/video`;
const QUIZ = `${SITE}/quiz`;
const LLM_ENGINE = "假大模型";
/** The same fake model on 127.0.0.1 (e2e/pack.mjs): another send host for the R3.3 re-consent. */
const OTHER_LLM_ENGINE = "假大模型（另一个地址）";
const SKIP_KEY = buttonKey("跳过广告 5");
const ENTRY_NAME = "自动跳过广告";
const OPEN_BUBBLE = `if (!bubble()) byLabel("button", "陪伴猫").click(); await waitFor(bubble, "bubble");`;
const CLOSE_BUBBLE = `if (bubble()) { byLabel("button", "陪伴猫").click(); await waitFor(() => !bubble(), "bubble closed"); }`;
/** The bubble's switch by its label (the bubble must be open). */
const SWITCH = (label) => `all("[role=switch]").find((s) => s.getAttribute("aria-label") === ${JSON.stringify(label)})`;
const ASK = `R()?.querySelector("[data-cc-ask]")`;
/** The quiz result card (R5.5) and its rows' texts. */
const QUIZ_CARD = `R()?.querySelector("[data-cc-result]")`;
const QUIZ_ROWS = `[...(${QUIZ_CARD}?.querySelectorAll("[data-part=result-item]") ?? [])].map(txt)`;

// 教小猫做件事 (R6): the fake news page and the fake model as the chat engine.
const NEWS = `${SITE}/news`;
const RULE_NAME = "自动展开全文";
const PANEL = `R().querySelector('[role=dialog][aria-label="教小猫做件事"]')`;
/** A button of the open teach panel by its exact text. */
const PANEL_BTN = (t) => `[...${PANEL}.querySelectorAll("button")].find((b) => txt(b) === ${JSON.stringify(t)})`;
const newsClicks = () => page.eval(`return { body: Number(document.body.dataset.bodyClicks), related: Number(document.body.dataset.relatedClicks), replies: Number(document.body.dataset.replyClicks) };`);
/** Marks that a run has seen (and so set) the first-use notice; e2e/scratch is gitignored. */
const NOTICE_SEEN = path.join(DIR, "scratch", "teach-notice-seen");
/**
 * Brings the teach state back to clean (scenarios 36 and 41–42 assume it): the local rules are
 * emptied, which removes an earlier run's saved rule and, with it, its cc:teach:<id> conversation;
 * an unsaved draft (cc:teach:unsaved) is discarded through its reload toast.
 */
function resetTeach() {
  const notes = [];
  const local = page.eval(`await openSettings("规则"); inSettings("button", "编辑本地规则").click(); return (await waitFor(() => byLabel("textarea", "本地规则 JSON"), "local editor")).value;`);
  if (local.trim()) {
    page.fill("textbox", "本地规则 JSON", "");
    page.eval(`inSettings("button", "检查并保存").click(); await sleep(500);`);
    notes.push("emptied the local rules");
  }
  const left = page.eval(`await closeSettings(); await openSettings(); const has = [...settings().querySelectorAll('[aria-label="设置分区"] button')].some((x) => txt(x) === ${JSON.stringify(RULE_NAME)}); await closeSettings(); return has;`);
  expect(!left, `the saved teach rule ${RULE_NAME} is still listed after emptying the local rules`);
  load(NEWS);
  const discarded = page.eval(`const b = await waitFor(() => byText("button", "丢掉"), "unsaved toast", 2500).catch(() => null); if (b) b.click(); return !!b;`);
  if (discarded) notes.push("discarded an unsaved draft");
  const clicks = page.eval(`await sleep(1000); return Number(document.body.dataset.bodyClicks) + Number(document.body.dataset.relatedClicks);`);
  expect(clicks === 0, "a teach rule still clicks on /news after the reset");
  return notes.join("; ") || undefined;
}
/** Types into the panel's message box and presses 发送. */
function say(text) {
  page.fill("textbox", "和小猫说", text);
  page.eval(`${PANEL_BTN("发送")}.click();`);
}
/** Waits until the cat has finished answering (no 停下 button, the draft side shows version v<n> when given). */
const settleTeach = (version, ms = 30000) =>
  page.eval(`await waitFor(() => ${PANEL} && !${PANEL_BTN("停下")} && ${version ? `txt(${PANEL}).includes("草稿 v${version}")` : "true"}, "the cat finished answering", ${ms}); return txt(${PANEL});`, "40s");

// 网页对照 (R7, R9.1): the long article, the same page under the strict CSP, and the batch translator 假整页翻译.
const ARTICLE = `${SITE}/article`;
const ARTICLE_CSP = `${SITE}/article-csp`;
const PAGE_ENGINE = "假整页翻译";
/** In-page helpers for the article scenarios (prepended to each eval body). */
const ARTICLE_JS = `
  const trs = () => [...document.querySelectorAll("companion-cat-tr")];
  const trText = (h) => txt(h.shadowRoot.querySelector(".tr"));
  const doneTrs = () => trs().filter((h) => trText(h).startsWith("[P → "));
  const sourceOf = (h) => h.previousElementSibling;
  const failedTrs = () => trs().filter((h) => h.shadowRoot.querySelector("button")?.textContent === "重试");
  // Where the block was before translations above it pushed it down (they arrive after it was picked).
  const pushed = (el) => trs().filter((h) => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).reduce((n, h) => n + h.getBoundingClientRect().height, 0);
  const nearViewport = (el) => { const r = el.getBoundingClientRect(), d = pushed(el); return r.bottom - d >= -300 && r.top - d <= innerHeight + 300; };
  ${stripForeign}
  const bodyHtml = () => { const c = document.body.cloneNode(true); c.querySelectorAll("companion-cat").forEach((e) => e.remove()); return stripForeign(c).innerHTML; };
  const nextIsTr = (el) => el.nextElementSibling?.localName === "companion-cat-tr";
`;
/** Texts the batch translator has been sent, newest request last. */
const pageRequests = async (m = 0) => (await since(m)).filter((l) => l.path === "/api/page");
/** Opens the bubble and runs 对照翻译这个网页 (the bubble stays closed afterwards). */
const START_COMPARE = `${OPEN_BUBBLE} byText("button", "对照翻译这个网页").click(); ${CLOSE_BUBBLE}`;

/** Loads a local page fresh, so a run's in-memory state never leaks into the next scenario. */
function load(url) {
  page.goto(url);
  page.eval(`await waitFor(() => byLabel("button", "陪伴猫"), "the cat"); await sleep(500);`);
}
const startAd = () => page.eval(`document.getElementById("start-ad").click();`);
const clicks = () => page.eval(`return { skip: Number(document.body.dataset.skipClicks), more: Number(document.body.dataset.moreClicks) };`);
const waitSkips = (n, ms = 12000) => page.eval(`await waitFor(() => Number(document.body.dataset.skipClicks) === ${n}, "${n} skip click(s)", ${ms});`, "30s");
/**
 * The page-compare hotkey the run presses. The user's browser also runs Immersive Translate, whose
 * own Alt+A translates the page too, so the run records another combo through the 快捷键 control
 * (R7.1 lets the person change it) and puts Alt+A back afterwards.
 */
const HOTKEY = { press: "Alt+Shift+KeyY", shown: "Alt + Shift + Y" };
/** Records `press` in the 快捷键 control of the open 翻译 feature page; returns what the row shows. */
function recordHotkey(press) {
  page.eval(`settings().querySelector('button[aria-label="快捷键"]').scrollIntoView({ block: "center" }); await sleep(200);`);
  page.click("button", "快捷键", { exact: true });
  page.eval(`await waitFor(() => txt(settings().querySelector('button[aria-label="快捷键"]')).includes("按下快捷键"), "recording");`);
  page.sctlRun(["page", "press", press, "--tab", page.tab]);
  return page.eval(`await waitFor(() => !txt(settings().querySelector('button[aria-label="快捷键"]')).includes("按下快捷键"), "recorded"); return txt(settings().querySelector('button[aria-label="快捷键"]'));`);
}
/** Picks the fake model in an engine setting on an open feature page. */
function pickEngine(label, engine = LLM_ENGINE) {
  page.click("combobox", label);
  // exact: 假大模型 is also the start of 假大模型（另一个地址）
  page.click("option", engine, { exact: true });
  page.eval(`await waitFor(() => { const t = txt(settings().querySelector('[aria-label=${JSON.stringify(label)}]')); return t.includes(${JSON.stringify(engine)}) && (${JSON.stringify(engine)}.includes("另一个地址") || !t.includes("另一个地址")); }, "engine ${label}");`);
}

/**
 * R9.4: shoots the second-round states again (for the dark and narrow variants), each prefixed. A
 * state that cannot be reached is collected and reported at the end instead of stopping the rest.
 */
async function r94States(prefix) {
  const missed = [];
  const step = async (name, fn) => {
    try {
      await fn();
      shot(`${prefix}-${name}`);
    } catch (e) {
      missed.push(`${name}: ${String(e.message).split("\n")[0].slice(0, 160)}`);
    }
  };
  const tidy = () => page.eval(`await closeSettings(); await closeCards().catch(() => {}); ${CLOSE_BUBBLE}`);
  await step("跳过广告功能页", () => page.eval(`await openSettings("跳过广告");`));
  await step("网页对照功能页", () => page.eval(`await openSettings("翻译"); const k = [...settings().querySelectorAll("*")].find((e) => e.children.length === 0 && txt(e) === "快捷键"); k?.scrollIntoView({ block: "center" }); await sleep(300);`));
  await step("写规则-继续改-功能页", () => page.eval(`await openSettings(${JSON.stringify(RULE_NAME)}); await waitFor(() => byText("button", "继续和小猫改"), "继续和小猫改");`));
  tidy();
  load(VIDEO);
  await step("气泡-自动化", () => page.eval(`${OPEN_BUBBLE} await waitFor(() => txt(bubble()).includes("最近动作"), "最近动作");`));
  page.eval(CLOSE_BUBBLE);
  await resetLlm(SITE);
  await scriptLlm(SITE, [chooseReply(SKIP_KEY, 0.5), chooseReply(SKIP_KEY, 0.95)]);
  startAd();
  await step("跳过广告-先问你", () => page.eval(`await waitFor(() => ${ASK}, "ask bubble", 12000);`, "30s"));
  page.eval(`const b = byText("button", "不用"); if (b) { b.click(); await waitFor(() => !${ASK}, "ask bubble closed"); }`);
  startAd();
  await step("已自动点击", () => page.eval(`await waitFor(() => byText("button", "撤销"), "撤销 on the toast", 12000);`, "30s"));
  await resetLlm(SITE);
  await scriptLlm(SITE, [chooseReply("A", 0.95), chooseReply("B", 0.55), blankReply("Promise", 0.92)]);
  load(QUIZ);
  await step("做题-填好了", () => page.eval(`${OPEN_BUBBLE} byText("button", "帮我做这页的题").click(); await waitFor(() => ${QUIZ_ROWS}.length === 3, "three result rows", 20000); ${CLOSE_BUBBLE} await sleep(500);`, "40s"));
  tidy();
  load(NEWS);
  await step("写规则-继续改", () => page.eval(`await openSettings(${JSON.stringify(RULE_NAME)}); byText("button", "继续和小猫改").click(); await waitFor(() => ${PANEL} && txt(${PANEL}).includes("草稿 v2"), "the saved conversation", 10000);`));
  page.eval(`const p = ${PANEL}; if (p) { [...p.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "关闭").click(); await waitFor(() => !${PANEL}, "panel closed"); }`);
  tidy();
  await setState({ failPage: 0, delayMs: 3000 });
  load(ARTICLE);
  page.eval(START_COMPARE);
  await step("网页对照-进行中", () => page.eval(`${ARTICLE_JS} await waitFor(() => trs().some((h) => h.shadowRoot.querySelector('[aria-label="正在翻译"]')), "a loading placeholder", 10000);`, "20s"));
  await setState({ delayMs: 0 });
  await step("只看译文", async () => {
    page.eval(`${ARTICLE_JS} await waitFor(() => trs().length > 0 && doneTrs().length === trs().length, "translated", 15000); ${OPEN_BUBBLE}`, "30s");
    page.click("combobox", "显示方式");
    page.click("option", "只看译文");
    page.eval(`${ARTICLE_JS} await waitFor(() => doneTrs().every((h) => getComputedStyle(sourceOf(h)).display === "none"), "sources hidden", 8000); ${CLOSE_BUBBLE} window.scrollTo(0, 0); await sleep(300);`);
  });
  try {
    page.eval(OPEN_BUBBLE);
    page.click("combobox", "显示方式");
    page.click("option", "原文下面显示译文");
    page.eval(`byText("button", "恢复原文")?.click(); ${CLOSE_BUBBLE}`);
  } catch (e) {
    missed.push(`back to 原文下面显示译文: ${String(e.message).slice(0, 120)}`);
  }
  expect(missed.length === 0, `states not reached:\n${missed.join("\n")}`);
}

/**
 * R3.2 asks only the first time: an earlier run's consent (cc:auto:consent:<ref>, GM storage that no
 * page can clear) keeps 跳过广告 on. Then the same dialog is reached through R3.3 instead: picking the
 * fake model on another host (127.0.0.1) pauses the entry; its switch asks again, naming that host;
 * 先不打开 leaves it off; picking the fake model again matches the stored consent and it is back on.
 */
function reconsent() {
  page.eval(`await openSettings("跳过广告");`);
  pickEngine("用哪个引擎判断", OTHER_LLM_ENGINE);
  page.eval(`await closeSettings();`);
  load(VIDEO);
  const state = page.eval(`${OPEN_BUBBLE} return ${SWITCH(ENTRY_NAME)}.getAttribute("aria-checked");`);
  expect(state === "false", `跳过广告 stays on after its send host changed (R3.3): ${state}`);
  const dialog = page.eval(`
    ${SWITCH(ENTRY_NAME)}.click();
    const d = await waitFor(() => R().querySelector('[role=alertdialog]'), "re-consent dialog");
    return txt(d);`);
  expect(dialog.includes("要再确认一次") && dialog.includes("会做的动作") && dialog.includes("点击") && dialog.includes("会发出去") && dialog.includes("127.0.0.1"), `the re-consent dialog: ${dialog}`);
  shot("启用确认");
  const off = page.eval(`
    byText('[role=alertdialog] button', "先不打开").click();
    await waitFor(() => !R().querySelector('[role=alertdialog]'), "dialog closed");
    const v = ${SWITCH(ENTRY_NAME)}.getAttribute("aria-checked"); ${CLOSE_BUBBLE} return v;`);
  expect(off === "false", "先不打开 still switched the entry on");
  page.eval(`await openSettings("跳过广告");`);
  pickEngine("用哪个引擎判断");
  page.eval(`await closeSettings();`);
  load(VIDEO);
  const back = page.eval(`${OPEN_BUBBLE} const v = ${SWITCH(ENTRY_NAME)}.getAttribute("aria-checked"); ${CLOSE_BUBBLE} return v;`);
  expect(back === "true", "the fake model again (the consented host) did not bring 跳过广告 back on");
  return "consented in an earlier run: checked the R3.3 re-consent dialog (judge engine moved to 127.0.0.1) instead";
}

/** R7.1: the page-compare hotkey (the run's combo) closes the comparison and the article is exactly as before. */
async function hotkeyRestores() {
  page.eval(`document.activeElement?.blur?.();`);
  page.sctlRun(["page", "press", HOTKEY.press, "--tab", page.tab]);
  const r = page.eval(
    `${ARTICLE_JS}
    await waitFor(() => trs().length === 0, "translations removed", 8000);
    // The appended paragraphs are the page's own; everything else must equal the snapshot taken before opening.
    const t = document.createElement("div");
    t.innerHTML = window.__before;
    t.querySelector("#appended").innerHTML = stripForeign(document.getElementById("appended").cloneNode(true)).innerHTML;
    const now = bodyHtml(), want = t.innerHTML;
    let i = 0;
    while (i < now.length && now[i] === want[i]) i++;
    return {
      same: now === want,
      at: now.slice(Math.max(0, i - 40), i + 80),
      appended: document.querySelectorAll("#appended p").length,
      leftovers: document.querySelectorAll("companion-cat-tr").length,
      styled: document.querySelectorAll('#appended [style]:not([style=""]), article [style]:not([style=""])').length,
    };`,
    "30s",
  );
  expect(r.same, `the page differs from before opening, near: ${r.at}`);
  expect(r.leftovers === 0 && r.styled === 0 && r.appended === 2, `leftovers=${r.leftovers} styled=${r.styled} appended=${r.appended}`);
  expect(page.eval(`${OPEN_BUBBLE} const t = txt(bubble()); ${CLOSE_BUBBLE} return t.includes("对照翻译这个网页") && !t.includes("恢复原文");`), "the bubble command did not go back to 对照翻译这个网页");
}
// ---------------------------------------------------------------- scenarios

const scenarios = [
  [
    "preflight: the installed script mounts its shadow root and adds nothing to <head>",
    async () => {
      const v = page.eval(`
        await waitFor(R, "companion-cat shadow root");
        byLabel("button", "陪伴猫").click();
        await waitFor(bubble, "bubble");
        const out = { head: document.head.querySelectorAll("style").length, sheets: R().adoptedStyleSheets.length, bubble: txt(bubble()) };
        byLabel("button", "陪伴猫").click();
        return out;`);
      expect(v.head === 0, `page <head> has ${v.head} <style> elements`);
      expect(v.sheets > 0, "no stylesheet adopted into the shadow root");
      return v.bubble.includes("翻译成") ? "official packs present" : `bubble: ${v.bubble.slice(0, 60)}`;
    },
  ],
  [
    "reset: light theme, no test pack, no test key, switches on (the script storage may hold an earlier run)",
    async () => {
      page.eval(`await openSettings("通用"); await theme("浅色");`);
      const has = page.eval(`await openSettings("规则"); return txt(settings()).includes("E2E 测试规则");`);
      if (has) {
        page.eval(`
          await openSettings("引擎");
          if (engineButton("带 Key 的假翻译")) { await openEngine("带 Key 的假翻译"); const d = inSettings("button", "删除 Key"); if (d) { d.click(); await waitFor(() => !inSettings("button", "删除 Key"), "key deleted"); } }
          await openSettings("规则");`);
        page.click("button", "E2E 测试规则 的更多操作");
        page.click("menuitem", "取消订阅");
        page.eval(`await waitFor(() => !txt(settings()).includes("E2E 测试规则"), "test pack removed");`);
      }
      // Every official pack must be subscribed; an earlier run may have left some unsubscribed.
      const OFFICIAL = ["翻译", "常见大模型", "跳过广告", "做题"];
      const missing = page.eval(`await openSettings("规则"); const t = txt(settings()); return ${JSON.stringify(OFFICIAL)}.filter((n) => !t.includes(n + " 官方"));`);
      if (missing.length) {
        for (const n of OFFICIAL) if (!missing.includes(n)) { page.click("button", `${n} 的更多操作`, { exact: true }); page.click("menuitem", "取消订阅"); page.eval(`await sleep(200);`); }
        page.eval(`await openSettings("引擎"); (await waitFor(() => inSettings("button", "订阅官方规则"), "订阅官方规则")).click(); await waitFor(() => engineButton("Google 翻译"), "official engines");`);
      }
      page.eval(`
        await openSettings("翻译");
        for (const n of ["启用翻译", "启用划词翻译", "在这个网站划词翻译", "中英互译"]) {
          const sw = settings().querySelector('[role=switch][aria-label="' + n + '"]');
          if (sw.getAttribute("aria-checked") !== "true") { sw.click(); await waitFor(() => sw.getAttribute("aria-checked") === "true", n); }
        }
        [...settings().querySelectorAll("[role=radio]")].find((r) => txt(r) === "先伸出猫爪").click();
        await closeSettings();`);
      return [has && "removed an earlier run's test pack", missing.length && `re-subscribed ${missing.join("、")}`].filter(Boolean).join("; ") || undefined;
    },
  ],
  [
    "R13.4 首次打开: the engines page on first open",
    async () => {
      page.eval(`await openSettings("引擎");`);
      shot("首次打开-引擎");
    },
  ],
  [
    "R2.1 subscribe the test pack; its engines appear at once",
    async () => {
      page.eval(`await openSettings("规则");`);
      shot("规则");
      const m = (await mark());
      page.fill("textbox", "规则订阅地址", PACK_URL);
      page.eval(`inSettings("button", "订阅").click(); await waitFor(() => txt(settings()).includes("E2E 测试规则"), "subscribed pack in the list");`);
      expect((await since(m)).some((r) => r.path === "/pack.json"), "the pack was not fetched from the local server");
      const order = page.eval(`return [...settings().querySelectorAll("main button[aria-label$=' 的更多操作']")].map((b) => b.getAttribute("aria-label").replace(" 的更多操作", ""));`);
      expect(order[0] === "E2E 测试规则" && order.includes("翻译") && order.includes("常见大模型"), `subscription order after subscribing: ${order.join(", ")}`);
      const engines = page.eval(`await openSettings("引擎"); return txt(settings());`);
      for (const n of ["假翻译 A", "假翻译 B", "带 Key 的假翻译"]) expect(engines.includes(n), `engine ${n} missing after subscribing`);
    },
  ],
  [
    "setup: the selection entry shows 假翻译 A (primary) and 假翻译 B instead of Google/Microsoft",
    async () => {
      // A stopped engine drops out of the checklist but stays selected (an earlier run deleted its key):
      // save a key to start it again, untick it, then delete the key.
      const keyed = page.eval(`await openSettings("翻译"); const c = engineBox("带 Key 的假翻译"); return c ? c.getAttribute("aria-checked") : "missing";`);
      if (keyed === "missing") {
        page.eval(`await openEngine("带 Key 的假翻译"); await waitFor(() => settings().querySelector("#secret-apiKey"), "key field");`);
        page.fill("textbox", "API Key", E2E_KEY);
        page.eval(`inSettings("button", "测试并保存").click();`);
        page.eval(`await waitFor(() => txt(settings()).includes("测试通过"), "key saved");`);
        page.eval(`await openSettings("翻译"); await tick("带 Key 的假翻译", false);`);
        page.eval(`await openEngine("带 Key 的假翻译"); (await waitFor(() => inSettings("button", "删除 Key"), "删除 Key")).click(); await waitFor(() => !inSettings("button", "删除 Key"), "key deleted");`);
        // A fresh page: the key test above must not leave its result in the in-memory cache.
        sctl(["page", "reload", "--tab", page.tab]);
        await sleep(2000);
      }
      const picked = page.eval(`
        await openSettings("翻译");
        for (const [n, on] of [["带 Key 的假翻译", false], ["Google 翻译", false], ["微软翻译", false], ["假翻译 A", true], ["假翻译 B", true]]) await tick(n, on);
        return txt(settings().querySelector('[role=group][aria-label="卡片里显示哪些引擎"]'));`);
      expect(/假翻译 A\s*主结果/.test(picked), `假翻译 A is not the primary engine: ${picked}`);
      shot("翻译功能页");
      page.eval(`await closeSettings();`);
    },
  ],
  [
    "R10.1 paw → card with several engines (loading, then results)",
    async () => {
      await setState({ delayMs: 2500 });
      const m = (await mark());
      const v = page.eval(`
        await closeCards();
        selectText("en");
        await waitFor(paw, "paw");
        return { paw: !!paw(), label: paw().querySelector("button").getAttribute("aria-label") };`);
      expect(v.paw && v.label === "翻译选中的文字", "no paw after selecting English text");
      shot("划词-猫爪");
      page.eval(`paw().querySelector("button").click(); await waitFor(card, "card"); await waitFor(() => rows().some((r) => r.state === "loading"), "loading rows");`);
      shot("划词-卡片-加载中");
      const r = page.eval(`await settle(); return { rows: rows(), header: txt(card().querySelector("[data-part=header]")) };`);
      cardHeader = r.header;
      await setState({ delayMs: 0 });
      expect(r.rows.length === 2, `card has ${r.rows.length} rows: ${JSON.stringify(r.rows)}`);
      expect(r.rows[0].engine === ENGINE.a && r.rows[0].primary && r.rows[0].state === "ok", `first row is not 假翻译 A as primary: ${JSON.stringify(r.rows[0])}`);
      expect(r.rows[0].text.includes("[A → zh-CN] JavaScript runs one task"), `A's translation missing: ${r.rows[0].text}`);
      expect(r.rows[1].engine === ENGINE.b && r.rows[1].state === "ok" && r.rows[1].text.includes("[B → zh-CN]"), `B row wrong: ${JSON.stringify(r.rows[1])}`);
      expect(r.header.includes("简体中文"), `card header lacks the target language: ${r.header}`);
      const sent = (await since(m)).filter((x) => x.path.startsWith("/api/"));
      expect(sent.length === 2 && sent.every((x) => x.to === "zh-CN"), `unexpected requests: ${JSON.stringify(sent)}`);
      expect(!sent.some((x) => x.path === "/api/key"), "the keyless-by-default rule was broken: the keyed engine was called");
      shot("划词-卡片-成功");
    },
  ],
  [
    "R10.1 the card header reads 英语 → 简体中文",
    async () => {
      const h = cardHeader;
      expect(h.includes("英语"), `card header is "${h}", R10.1 asks for "英语 → 简体中文" (the source label comes from the language list's English names, src/core/languages.ts:10)`);
    },
  ],
  [
    "R10.3 Chinese selection is translated into English while 中英互译 is on",
    async () => {
      const m = (await mark());
      const r = page.eval(`await translate("zh"); await settle(); return rows();`);
      expect(r[0].text.includes("[A → en] 事件循环"), `Chinese was not translated to English: ${r[0].text}`);
      expect((await since(m)).filter((x) => x.path.startsWith("/api/")).every((x) => x.to === "en"), "requests did not ask for English");
    },
  ],
  [
    "R10.5 one engine failing leaves the others alone; 重试 re-runs only it",
    async () => {
      await setState({ failB: true });
      const m = (await mark());
      const r = page.eval(`await translate("en3"); await settle(); return rows();`);
      expect(r[0].state === "ok", `A should succeed: ${JSON.stringify(r[0])}`);
      expect(r[1].state === "error" && r[1].text.includes("重试"), `B should show an error with 重试: ${JSON.stringify(r[1])}`);
      shot("划词-卡片-失败");
      await setState({ failB: false });
      const m2 = (await mark());
      const again = page.eval(`[...rowEl("${ENGINE.b}").querySelectorAll("button")].find((b) => txt(b) === "重试").click(); await waitFor(() => row("${ENGINE.b}")?.text.includes("[B → zh-CN]"), "B retried"); return rows();`);
      expect(again[1].text.includes("[B → zh-CN] Rendering happens"), `retry did not succeed: ${JSON.stringify(again[1])}`);
      const retried = (await since(m2)).filter((x) => x.path.startsWith("/api/"));
      expect(retried.length === 1 && retried[0].path === "/api/b", `retry sent ${JSON.stringify(retried)}`);
      expect((await since(m)).filter((x) => x.path === "/api/a").length === 1, "A was called again");
    },
  ],
  [
    "R10.5 translating the same text again uses the cache and says so",
    async () => {
      const m = (await mark());
      const r = page.eval(`await translate("en"); await settle(); return rows();`);
      expect(r.every((x) => x.state === "ok"), `not all ok: ${JSON.stringify(r)}`);
      expect(r[0].text.includes("刚才翻译过，直接用了缓存"), `no cache note: ${r[0].text}`);
      expect((await since(m)).filter((x) => x.path.startsWith("/api/")).length === 0, "cached translation still hit the server");
      shot("划词-卡片-缓存");
      page.eval(`await closeCards();`);
    },
  ],
  [
    "R7.2 key test fails with a wrong key, then passes and is saved (masked)",
    async () => {
      page.eval(`await openEngine("带 Key 的假翻译"); await waitFor(() => settings().querySelector("#secret-apiKey"), "key field");`);
      shot("填 Key");
      page.fill("textbox", "API Key", "wrong-key-for-e2e");
      // Actions and checks are separate evals: a check is safe to repeat if the debugger drops.
      page.eval(`inSettings("button", "测试并保存").click();`);
      const failed = page.eval(`await waitFor(() => /测试没通过/.test(txt(settings())), "test failure"); return txt(settings().querySelector("main"));`);
      expect(/测试没通过：.*401/.test(failed), `wrong key not reported with the 401: ${failed.slice(-300)}`);
      shot("Key 测试失败");
      page.fill("textbox", "API Key", E2E_KEY);
      const type = page.eval(`return settings().querySelector("#secret-apiKey").type;`);
      page.eval(`inSettings("button", "测试并保存").click();`);
      const ok = page.eval(`await waitFor(() => /测试通过|测试没通过/.test(txt(settings())), "test result"); return txt(settings().querySelector("main"));`);
      expect(type === "password", "the key field is not masked while typing");
      expect(ok.includes("测试通过"), `the right key did not pass: ${ok.slice(-300)}`);
      expect(!ok.includes(E2E_KEY), "the saved key is shown in full");
      expect(ok.includes("已保存："), "no masked saved-key hint");
      expect((await serverLog()).some((x) => x.path === "/api/key" && x.host === `localhost:${PORT}` && x.auth), "the key test never reached the server");
    },
  ],
  [
    "R7.2 replacing a working key with a wrong one: the test must reach the service, not the result cache",
    async () => {
      page.eval(`await openEngine("带 Key 的假翻译"); await waitFor(() => settings().querySelector("#secret-apiKey"), "key field");`);
      const m = await mark();
      page.fill("textbox", "API Key", "another-wrong-key-e2e");
      page.eval(`inSettings("button", "测试并保存").click();`);
      const t = page.eval(`await waitFor(() => /测试通过|测试没通过/.test(txt(settings())), "test result"); return txt(settings().querySelector("main"));`);
      const reached = (await since(m)).some((x) => x.path === "/api/key");
      // Put the working key back whatever happened (its test may itself be answered from the cache).
      page.fill("textbox", "API Key", E2E_KEY);
      page.eval(`inSettings("button", "测试并保存").click();`);
      page.eval(`await waitFor(() => txt(settings()).includes("测试通过"), "working key restored");`);
      expect(
        t.includes("测试没通过") && reached,
        `the wrong key ${t.includes("测试通过") ? "passed and was saved" : "was not rejected"}; request reached the service: ${reached} — testAndSave calls invoker.invoke, whose translate result cache (keyed by engine, options and input, not the key) answers the sample (src/pages/engines/keys.ts:57), against R7.2`,
      );
    },
  ],
  [
    "R5.6 共用 Key: an engine that inherits another's key says so",
    async () => {
      page.eval(`await openEngine("带 Key 的假翻译（镜像）");`);
      const shared = page.eval(`await waitFor(() => txt(settings()).includes("共用 Key"), "shared-key notice"); return txt(settings().querySelector("main"));`);
      expect(shared.includes("和 带 Key 的假翻译 共用 Key"), `no shared-key notice: ${shared.slice(-300)}`);
      shot("共用 Key");
    },
  ],
  [
    "R13.4 引擎有问题: an engine whose parent is missing is listed under 有问题 with the reason",
    async () => {
      const t = page.eval(`
        await openSettings("引擎");
        const g = await waitFor(() => settings().querySelector('[role=group][aria-label="有问题"]'), "有问题 group");
        g.scrollIntoView({ block: "center" });
        return txt(g);`);
      expect(t.includes("坏掉的假翻译") && t.includes("找不到"), `problem group: ${t}`);
      shot("引擎有问题");
    },
  ],
  [
    "R5.5/R2.6 opening the problem engine's detail keeps the settings window and the cat alive",
    async () => {
      page.eval(`engineButton("坏掉的假翻译").click();`);
      const v = page.eval(`await sleep(800); return { settings: !!settings(), cat: !!byLabel("button", "陪伴猫"), text: txt(settings()?.querySelector("main")).slice(-200) };`);
      expect(v.settings && v.cat, "the shell crashed: settings window and corner cat are gone (TypeError: Cannot convert undefined or null to object — Object.keys(p.def.implements) in contractsOf (src/pages/engines/keys.ts:19), called by EnginesPage.tsx:124 for a provider without implements)");
      shot("引擎有问题-详情");
    },
  ],
  [
    "setup: the keyed engine joins the card",
    async () => {
      page.eval(`
        await openSettings("翻译");
        if ((await tick("带 Key 的假翻译", true)) === "missing") throw new Error("keyed engine not in the checklist");
        await closeSettings();`);
    },
  ],
  [
    "R7.4 a pack update moves the keyed engine to a new host: the request waits for the in-page dialog; 先停用 sends nothing",
    async () => {
      await setState({ packVersion: 2 });
      page.eval(`await openSettings("规则");`);
      page.click("button", "E2E 测试规则 的更多操作");
      page.click("menuitem", "检查更新");
      page.eval(`await waitFor(() => txt(settings()).includes("1.0.2"), "pack v1.0.2");  await closeSettings();`);
      const m = (await mark());
      const d = page.eval(`
        await translate("en4");
        const dlg = await waitFor(() => R().querySelector("[role=alertdialog]"), "host dialog");
        await waitFor(() => row("${ENGINE.a}")?.state === "ok", "A done");
        const box = dlg.getBoundingClientRect();
        return { text: txt(dlg), inLayer: !!R().querySelector("[data-cc-layer]").contains(dlg), key: row("${ENGINE.key}")?.state, box: [box.left, box.top, box.width, box.height] };`);
      dialogBox = d.box;
      expect(d.inLayer, "dialog is not inside the shadow root's layer");
      expect(d.text.includes("带 Key 的假翻译") && d.text.includes("127.0.0.1") && d.text.includes("localhost"), `dialog text: ${d.text}`);
      expect(d.text.includes("1.0.1") && d.text.includes("1.0.2"), `dialog lacks the version change: ${d.text}`);
      expect(d.key === "loading", `keyed row is ${d.key} while waiting`);
      shot("域名变更确认");
      expect(!(await since(m)).some((x) => x.host?.startsWith("127.0.0.1")), "a request reached the new host before confirming");
      const refused = page.eval(`
        [...R().querySelectorAll("[role=alertdialog] button")].find((b) => txt(b) === "先停用这个引擎").click();
        await waitFor(() => row("${ENGINE.key}")?.state === "error", "keyed row error");
        return row("${ENGINE.key}").text;`);
      await sleep(500);
      expect(!(await since(m)).some((x) => x.host?.startsWith("127.0.0.1")), "a request reached the new host after refusing");
      expect(refused.length > 0, "no error text");
      page.eval(`await closeCards();`);
    },
  ],
  [
    "R7.4 the host dialog is laid out on screen (readable, not squeezed into the shadow host)",
    async () => {
      expect(dialogBox, "the dialog was not measured");
      const [left, top, width, height] = dialogBox;
      expect(
        width >= 320 && height >= 200 && left >= 0 && top >= 0,
        `dialog box ${dialogBox.map(Math.round).join("×")}: the R7.4 dialog collapses to a narrow column at the page edge — its overlay is \`absolute inset-0\` inside the 0×0 fixed shadow host (src/pages/engines/confirm.tsx:16), so the text is unreadable (see 域名变更确认.png)`,
      );
    },
  ],
  [
    "R7.4 re-enable the engine; 我认识这个地址，允许 lets the request through to the new host",
    async () => {
      const stopped = page.eval(`await openEngine("带 Key 的假翻译"); await waitFor(() => settings().querySelector('[role=switch][aria-label="启用"]'), "启用 switch"); return txt(settings());`);
      expect(stopped.includes("已停用"), "refusing did not stop the engine");
      page.eval(`const sw = settings().querySelector('[role=switch][aria-label="启用"]'); sw.click(); await waitFor(() => sw.getAttribute("aria-checked") === "true", "enabled"); await closeSettings();`);
      const m = (await mark());
      const r = page.eval(`
        await translate("en4");
        const dlg = await waitFor(() => R().querySelector("[role=alertdialog]"), "host dialog");
        [...dlg.querySelectorAll("button")].find((b) => txt(b) === "我认识这个地址，允许").click();
        await waitFor(() => row("${ENGINE.key}")?.state === "ok", "keyed row ok");
        return row("${ENGINE.key}").text;`);
      expect(r.includes("[K → zh-CN] A timer callback"), `keyed engine result: ${r}`);
      expect((await since(m)).some((x) => x.path === "/api/key" && x.host === `127.0.0.1:${PORT}` && x.auth), "allowed request did not reach the new host");
      page.eval(`await closeCards();`);
    },
  ],
  [
    "R10.5 a ticked engine whose key was deleted shows 填 Key, which opens its settings",
    async () => {
      page.eval(`
        await openEngine("带 Key 的假翻译");
        (await waitFor(() => inSettings("button", "删除 Key"), "删除 Key")).click();
        await waitFor(() => !inSettings("button", "删除 Key"), "key deleted");
        await closeSettings();`);
      const r = page.eval(`await translate("en2"); await settle(); return row("${ENGINE.key}");`);
      shot(r?.state === "needKey" ? "划词-卡片-缺 Key" : "划词-卡片-删除 Key 之后");
      expect(
        r?.state === "needKey" && r.text.includes("填 Key"),
        `keyed row after 删除 Key: ${JSON.stringify(r)} — R7.3 disables the engine on delete and invoke checks the disabled flag before the missing key (src/core/invoke/invoke.ts:189), so R10.5's 「填 Key」 never shows`,
      );
      const opened = page.eval(`[...rowEl("${ENGINE.key}").querySelectorAll("button")].find((b) => txt(b) === "填 Key").click(); await waitFor(settings, "settings"); await sleep(300); return { section: txt(settings().querySelector("main h2")), text: txt(settings()) };`);
      expect(opened.section === "引擎", `填 Key opened ${opened.section}`);
      expect(opened.text.includes("测试并保存"), "填 Key did not open the engine's key form (R10.5: 打开它的详情)");
    },
  ],
  [
    "R10.7 no paw for selections in input, textarea or contenteditable",
    async () => {
      page.eval(`await closeSettings(); await closeCards();`);
      for (const id of ["input", "textarea", "editable"]) {
        const v = page.eval(`selectText("${id}"); await sleep(400); return !!paw();`);
        expect(!v, `paw shown for a selection in #${id}`);
      }
      // A real triple-click selection in the textarea too.
      page.click("textbox", "Textarea");
      sctl(["page", "click", page.ref("textbox", "Textarea"), "--count", "3", "--tab", page.tab]);
      expect(!page.eval(`await sleep(400); return !!paw();`), "paw shown after triple-clicking the textarea");
      expect(page.eval(`selectText("en2"); await waitFor(paw, "paw"); return true;`), "paw missing for normal text (control)");
      page.eval(`clearSelection();`);
    },
  ],
  [
    "R10.6 the site switch turns the paw off on this site only; entry and feature switches turn it off everywhere",
    async () => {
      const toggleBubble = (on) =>
        page.eval(`
          if (!bubble()) byLabel("button", "陪伴猫").click();
          const sw = await waitFor(() => bubble()?.querySelector('[role=switch][aria-label="在这个网站划词翻译"]'), "site switch");
          if ((sw.getAttribute("aria-checked") === "true") !== ${on}) sw.click();
          await waitFor(() => (sw.getAttribute("aria-checked") === "true") === ${on}, "site switch state");
          byLabel("button", "陪伴猫").click();`);
      // Whether selecting text shows the paw; a change made in another tab takes a moment to arrive (R1.8),
      // so poll for the expected answer for a few seconds before reporting the other one.
      const pawFor = async (p, expected = true, id = "en2") => {
        let v;
        for (let i = 0; i < 6; i++) {
          v = p.eval(`clearSelection(); await sleep(100); selectText("${id}"); await sleep(500); const v = !!paw(); clearSelection(); return v;`);
          if (v === expected) break;
          await sleep(400);
        }
        return v;
      };
      toggleBubble(false);
      expect(!(await pawFor(page, false)), "paw still shown on localhost with the site switch off");
      expect(await pawFor(other), "the other site (127.0.0.1) lost its paw");
      toggleBubble(true);
      expect(await pawFor(page), "paw not back on localhost");

      const featureSwitch = (name, on) =>
        page.eval(`
          await openSettings("翻译");
          const sw = settings().querySelector('[role=switch][aria-label="${name}"]');
          if ((sw.getAttribute("aria-checked") === "true") !== ${on}) sw.click();
          await waitFor(() => (sw.getAttribute("aria-checked") === "true") === ${on}, "${name}");
          await closeSettings();`);
      for (const name of ["启用划词翻译", "启用翻译"]) {
        featureSwitch(name, false);
        expect(!(await pawFor(page, false)), `paw on localhost with ${name} off`);
        expect(!(await pawFor(other, false)), `paw on 127.0.0.1 with ${name} off (other tab, R1.8)`);
        featureSwitch(name, true);
        expect(await pawFor(other), `paw not back on 127.0.0.1 after turning ${name} on`);
      }
    },
  ],
  [
    "R13.1 everything works on a page with a strict CSP (no unsafe-eval, no unsafe-inline)",
    async () => {
      sctl(["debug", "start", "--tab", other.tab]);
      other.goto(`${OTHER}/csp`);
      const m = (await mark());
      const v = other.eval(`
        await waitFor(R, "shadow root");
        const cat = byLabel("button", "陪伴猫").getBoundingClientRect();
        await translate("en3"); await settle();
        return { cat: [cat.width, cat.height], rows: rows(), sheets: R().adoptedStyleSheets.length, head: document.head.querySelectorAll("style").length };`);
      expect(v.cat[0] > 20 && v.cat[1] > 20, `cat not styled under CSP: ${v.cat}`);
      expect(v.sheets > 0 && v.head === 0, "stylesheet not adopted under CSP");
      const fakes = v.rows.filter((r) => r.engine === ENGINE.a || r.engine === ENGINE.b);
      expect(fakes.length === 2 && fakes.every((r) => r.state === "ok" && r.text.includes("Rendering happens")), `card under CSP: ${JSON.stringify(v.rows)}`);
      expect((await since(m)).some((x) => x.path.startsWith("/api/")) || v.rows.some((r) => r.text.includes("缓存")), "no translation requests under CSP");
      shot("严格 CSP-卡片", other);
      const out = sctl(["debug", "console", "--tab", other.tab, "--text", "Content Security Policy"]);
      const violations = out.split("\n").filter((l) => /Content Security Policy/i.test(l) && !/favicon/.test(l));
      expect(violations.length === 0, `CSP violations:\n${violations.join("\n")}`);
      sctl(["debug", "stop", "--tab", other.tab]);
      other.eval(`await closeCards();`);
    },
  ],
  [
    "R13.4 规则更新失败 and 本地规则校验出错",
    async () => {
      await setState({ failPack: true });
      page.eval(`await openSettings("规则");`);
      page.click("button", "E2E 测试规则 的更多操作");
      page.click("menuitem", "检查更新");
      const t = page.eval(`await waitFor(() => txt(settings()).includes("最近一次更新失败"), "update failure note"); return txt(settings());`);
      expect(t.includes("HTTP 503"), `update failure lacks the reason: ${t}`);
      shot("规则更新失败");
      await setState({ failPack: false });
      page.eval(`inSettings("button", "编辑本地规则").click(); await waitFor(() => byLabel("textarea", "本地规则 JSON"), "local editor");`);
      const bad = JSON.stringify({ schema: 1, id: "local", providers: [{ id: "x", name: "坏表达式", hosts: ["a.test"], implements: { translate: { http: { request: { method: "GET", url: "https://a.test/?q={{ input.texts[0] + }}" }, response: "json", output: { texts: "{{ response.texts }}" } } } } }] }, null, 2);
      page.fill("textbox", "本地规则 JSON", bad);
      const e = page.eval(`inSettings("button", "检查并保存").click(); await waitFor(() => settings().querySelector("[role=alert], [data-problem]") || txt(settings()).includes("有问题"), "local errors"); return txt(settings());`);
      expect(/第\s*\d+\s*行|行/.test(e), `local rule errors lack a line: ${e.slice(0, 400)}`);
      shot("本地规则校验出错");
      page.fill("textbox", "本地规则 JSON", "");
      page.eval(`inSettings("button", "检查并保存").click(); await sleep(300); await closeSettings();`);
    },
  ],
  [
    "R13.4 深色 and 窄屏",
    async () => {
      page.eval(`await openSettings("通用"); await theme("深色"); `);
      shot("深色-通用");
      page.eval(`await closeSettings(); await translate("en"); await settle();`);
      shot("深色-划词卡片");
      page.eval(`await closeCards(); await openSettings("通用"); await theme("浅色"); await closeSettings();`);
      page.cdp("Emulation.setDeviceMetricsOverride", { width: 400, height: 820, deviceScaleFactor: 2, mobile: false });
      try {
        page.eval(`await sleep(300); await openSettings("引擎"); await sleep(300);`);
        shot("窄屏-引擎");
        page.eval(`await closeSettings(); byLabel("button", "陪伴猫").click(); await waitFor(bubble, "bubble");`);
        shot("窄屏-气泡");
        page.eval(`byLabel("button", "陪伴猫").click();`);
      } finally {
        page.cdp("Emulation.clearDeviceMetricsOverride");
      }
    },
  ],
  [
    "Jev live smoke: test-and-save with JEV_SECRET_KEY from ~/.env (skipped when absent)",
    async () => {
      const key = jevKey();
      if (!key) return "skipped: JEV_SECRET_KEY not in ~/.env";
      page.eval(`await openEngine("Jev"); await waitFor(() => settings().querySelector("#secret-apiKey"), "key field");`);
      page.fill("textbox", "API Key", key);
      const masked = page.eval(`const f = settings().querySelector("#secret-apiKey"); return f.type === "password" && !txt(settings()).includes(f.value.slice(4, 12));`);
      expect(masked, "the Jev key field is not masked");
      shot("Jev-填 Key（遮挡）");
      let r;
      try {
        page.eval(`inSettings("button", "测试并保存").click();`);
        r = page.eval(`await waitFor(() => /测试通过|测试没通过/.test(txt(settings())), "Jev test", 30000); const t = txt(settings()); return { ok: t.includes("测试通过"), failure: (t.match(/测试没通过：[^。]*/) ?? [""])[0] };`, "45s");
      } finally {
        // Remove the real key from the browser again, whatever happened.
        page.eval(`const d = inSettings("button", "删除 Key"); if (d) { d.click(); await waitFor(() => !inSettings("button", "删除 Key"), "deleted"); } await closeSettings();`);
      }
      expect(r.ok, `Jev test-and-save failed: ${r.failure}`);
      return "ran: Jev test-and-save passed against the real API";
    },
  ],
  [
    "R1.6 没有规则: unsubscribing everything empties the cat; 「订阅官方规则」 brings the official packs back",
    async () => {
      page.eval(`
        await openSettings("翻译");
        for (const n of ["假翻译 A", "假翻译 B", "带 Key 的假翻译"]) await tick(n, false);
        await tick("Google 翻译", true); await tick("微软翻译", true);
        await openSettings("规则");`);
      // Every subscription, whatever the round added (the official packs are four now: 翻译, 常见大模型, 跳过广告, 做题).
      const subscribed = () => page.eval(`return [...settings().querySelectorAll("main button[aria-label$=' 的更多操作']")].map((b) => b.getAttribute("aria-label").replace(" 的更多操作", ""));`);
      for (const name of subscribed()) {
        page.click("button", `${name} 的更多操作`, { exact: true });
        page.click("menuitem", "取消订阅");
        page.eval(`await waitFor(() => !settings().querySelector('main button[aria-label=${JSON.stringify(`${name} 的更多操作`)}]'), "unsubscribed ${name}");`);
      }
      expect(subscribed().length === 0, `still subscribed: ${subscribed().join("、")}`);
      const bare = page.eval(`await closeSettings(); byLabel("button", "陪伴猫").click(); await waitFor(bubble, "bubble"); return txt(bubble());`);
      expect(bare.includes("陪伴猫还什么都不会"), `bubble is not empty: ${bare}`);
      shot("没有规则-气泡");
      page.eval(`await openSettings("引擎");`);
      shot("没有规则-引擎");
      const back = page.eval(`inSettings("button", "订阅官方规则").click(); await waitFor(() => txt(settings()).includes("Google 翻译"), "official engines back"); return txt(settings());`);
      expect(back.includes("微软翻译"), "official packs not restored");
      page.eval(`await openSettings("通用"); await theme("跟随系统"); await closeSettings();`);
    },
  ],
  [
    "R4 setup: the test pack is back, 跳过广告 and 做题 are subscribed, and the fake model is their engine",
    async () => {
      // The light screenshots of this round must not follow a dark system theme (the scenario before leaves 跟随系统).
      page.eval(`await openSettings("通用"); await theme("浅色");`);
      const subscribed = page.eval(`await openSettings("规则"); return txt(settings()).includes("E2E 测试规则");`);
      if (!subscribed) {
        page.fill("textbox", "规则订阅地址", PACK_URL);
        page.eval(`inSettings("button", "订阅").click(); await waitFor(() => txt(settings()).includes("E2E 测试规则"), "subscribed pack in the list");`);
      }
      const t = page.eval(`return txt(settings());`);
      for (const n of ["跳过广告", "做题"]) expect(t.includes(n), `official pack ${n} is not in the rules list`);
      page.eval(`await openSettings("跳过广告");`);
      pickEngine("用哪个引擎判断");
      page.eval(`await openSettings("做题");`);
      pickEngine("选择题用哪个引擎");
      pickEngine("填空题用哪个引擎");
      page.eval(`await closeSettings();`);
      return subscribed ? "test pack was already subscribed" : "re-subscribed the test pack";
    },
  ],
  [
    "R3.2 enabling 跳过广告 on the video site goes through the consent dialog: 先不打开 leaves it off, 打开 turns it on",
    async () => {
      load(VIDEO);
      const before = page.eval(`${OPEN_BUBBLE} const sw = ${SWITCH(ENTRY_NAME)}; return { found: !!sw, on: sw?.getAttribute("aria-checked"), text: txt(bubble()) };`);
      expect(before.found, `the bubble has no 自动化 switch for ${ENTRY_NAME}: ${before.text}`);
      if (before.on === "true") return reconsent();
      const dialog = page.eval(`
        ${SWITCH(ENTRY_NAME)}.click();
        const d = await waitFor(() => R().querySelector('[role=alertdialog]'), "consent dialog");
        return txt(d);`);
      expect(dialog.includes("会做的动作") && dialog.includes("点击"), `the consent dialog does not list the acts: ${dialog}`);
      expect(dialog.includes("会发出去") && dialog.includes("localhost"), `the consent dialog does not name the host it sends to: ${dialog}`);
      shot("启用确认");
      const off = page.eval(`
        byText('[role=alertdialog] button', "先不打开").click();
        await waitFor(() => !R().querySelector('[role=alertdialog]'), "dialog closed");
        return ${SWITCH(ENTRY_NAME)}.getAttribute("aria-checked");`);
      expect(off === "false", "先不打开 still switched the entry on");
      const on = page.eval(`
        ${SWITCH(ENTRY_NAME)}.click();
        await waitFor(() => R().querySelector('[role=alertdialog]'), "consent dialog again");
        byText('[role=alertdialog] button', "打开").click();
        await waitFor(() => ${SWITCH(ENTRY_NAME)}.getAttribute("aria-checked") === "true", "switch on");
        ${CLOSE_BUBBLE}
        return true;`);
      expect(on, "the entry did not switch on after 打开");
    },
  ],
  [
    "R4/R2.2 high confidence: the skip button is clicked at once, a toast offers 撤销, and the log has a row",
    async () => {
      await resetLlm(SITE);
      await scriptLlm(SITE, [chooseReply(SKIP_KEY, 0.95)]);
      load(VIDEO);
      startAd();
      waitSkips(1);
      const toast = page.eval(`await waitFor(() => byText("button", "撤销"), "撤销 on the toast"); return txt(R());`);
      expect(toast.includes("小猫帮你点了") && toast.includes("95%"), `toast text: ${toast.slice(0, 200)}`);
      shot("已自动点击");
      page.eval(`await sleep(1500);`);
      const c = await clicks();
      expect(c.skip === 1 && c.more === 0, `clicks after the ad: ${JSON.stringify(c)}`);
      const asked = await llmLog(SITE);
      expect(asked.length === 1, `the fake model was asked ${asked.length} times (the non-skip button must not be asked about)`);
      expect(JSON.stringify(asked[0].body).includes("跳过广告 5"), "the question did not carry the skip button");
      const bubble = page.eval(`${OPEN_BUBBLE} await waitFor(() => txt(bubble()).includes("最近动作"), "最近动作"); return txt(bubble());`);
      expect(bubble.includes("自动") && bubble.includes("95%"), `the bubble's recent actions: ${bubble}`);
      shot("气泡-自动化");
      page.eval(CLOSE_BUBBLE);
      const log = page.eval(`await openSettings("跳过广告"); return txt(settings());`);
      shot("跳过广告功能页");
      page.eval(`await closeSettings();`);
      expect(log.includes("动作记录") && log.includes("自动 · 95%"), `the feature page log lacks the row: ${log.slice(0, 300)}`);
    },
  ],
  [
    "R2.1 low confidence: the 先问你 bubble appears; 不用 leaves the button unclicked",
    async () => {
      await resetLlm(SITE);
      await scriptLlm(SITE, [chooseReply(SKIP_KEY, 0.5)]);
      load(VIDEO);
      startAd();
      const ask = page.eval(`await waitFor(() => ${ASK}, "ask bubble", 12000); return txt(${ASK});`, "30s");
      expect(ask.includes("要点吗") && ask.includes("50%") && ask.includes("门槛 85%"), `ask bubble text: ${ask}`);
      expect(ask.includes("不用") && ask.includes("点吧") && ask.includes("这个网站以后都照做"), `ask bubble lacks its choices: ${ask}`);
      shot("跳过广告-先问你");
      page.eval(`byText("button", "不用").click(); await waitFor(() => !${ASK}, "ask bubble closed"); await sleep(1500);`);
      const c = await clicks();
      expect(c.skip === 0, `不用 still clicked skip (${c.skip})`);
    },
  ],
  [
    "R2.3 点吧 with 以后都照做 clicks, records always-do, and the next ad is clicked without asking; 撤销 on the feature page undoes it",
    async () => {
      await resetLlm(SITE);
      await scriptLlm(SITE, [chooseReply(SKIP_KEY, 0.5), chooseReply(SKIP_KEY, 0.5)]);
      load(VIDEO);
      startAd();
      page.eval(`
        await waitFor(() => ${ASK}, "ask bubble", 12000);
        ${ASK}.querySelector('[role=checkbox][aria-label="这个网站以后都照做"]').click();
        await waitFor(() => ${ASK}.querySelector('[role=checkbox][aria-label="这个网站以后都照做"]').getAttribute("aria-checked") === "true", "ticked");
        byText("button", "点吧").click();`, "30s");
      waitSkips(1);
      const always = page.eval(`await openSettings("跳过广告"); const t = txt(settings()); await closeSettings(); return t;`);
      expect(always.includes("这个网站以后都照做") && always.includes("localhost"), `always-do is not listed for localhost: ${always.slice(0, 300)}`);
      // The second ad: confidence is below the threshold again, but the site is always-do.
      page.eval(`document.getElementById("start-ad").click();`);
      waitSkips(2);
      expect(page.eval(`return !${ASK};`), "the second ad asked again although always-do is on");
      const undone = page.eval(`
        await openSettings("跳过广告");
        const b = [...settings().querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "撤销 localhost");
        if (!b) return "no 撤销 localhost";
        b.click();
        await waitFor(() => ![...settings().querySelectorAll("button")].some((x) => x.getAttribute("aria-label") === "撤销 localhost"), "always-do revoked");
        await closeSettings();
        return "ok";`);
      expect(undone === "ok", `revoking always-do: ${undone}`);
    },
  ],
  [
    "R3.4 pausing in the bubble stops further clicks; resuming lets the same ad through",
    async () => {
      await resetLlm(SITE);
      await scriptLlm(SITE, [chooseReply(SKIP_KEY, 0.95)]);
      load(VIDEO);
      const paused = page.eval(`
        ${OPEN_BUBBLE}
        ${SWITCH("在这个网站暂停自动化")}.click();
        await waitFor(() => ${SWITCH("在这个网站暂停自动化")}.getAttribute("aria-checked") === "true", "paused");
        const t = txt(bubble());
        ${CLOSE_BUBBLE}
        return t;`);
      expect(paused.includes("已在这个网站暂停"), `the bubble does not say it is paused: ${paused}`);
      load(VIDEO);
      startAd();
      page.eval(`await sleep(3000);`);
      const c = await clicks();
      expect(c.skip === 0, `a paused site still got a click (${c.skip})`);
      expect((await llmLog(SITE)).length === 0, "a paused site still asked the fake model");
      page.eval(`
        ${OPEN_BUBBLE}
        ${SWITCH("在这个网站暂停自动化")}.click();
        await waitFor(() => ${SWITCH("在这个网站暂停自动化")}.getAttribute("aria-checked") === "false", "resumed");
        ${CLOSE_BUBBLE}`);
      startAd();
      waitSkips(1);
    },
  ],
  [
    "R5 帮我做这页的题: confident answers are filled with badges, the low-confidence one gets a hint, the result card lists the rows, 提交 is never clicked",
    async () => {
      await resetLlm(SITE);
      // Question order: single (A, sure), multiple (B, unsure), blank (sure).
      await scriptLlm(SITE, [chooseReply("A", 0.95), chooseReply("B", 0.55), blankReply("Promise", 0.92)]);
      load(QUIZ);
      page.eval(`
        ${OPEN_BUBBLE}
        byText("button", "帮我做这页的题").click();
        const consent = await waitFor(() => R().querySelector('[role=alertdialog]') || ${QUIZ_CARD}, "consent dialog or result card", 15000);
        if (consent.getAttribute("role") === "alertdialog") byText('[role=alertdialog] button', "打开").click();`, "30s");
      const r = page.eval(`
        await waitFor(() => ${QUIZ_ROWS}.length === 3, "three result rows", 20000);
        ${CLOSE_BUBBLE}
        await sleep(500);
        return {
          rows: ${QUIZ_ROWS},
          card: txt(${QUIZ_CARD}),
          q1: document.querySelector('input[name=q1][value=a]').checked,
          q2: [...document.querySelectorAll("input[name=q2]")].map((i) => i.checked),
          blank: document.getElementById("blank1").value,
          badges: all("[data-cc-badge]").map(txt),
          hints: all("[data-cc-hint]").map(txt),
          submitClicks: Number(document.body.dataset.submitClicks),
          submitState: txt(document.getElementById("submit-state")),
        };`, "40s");
      shot("做题-填好了");
      expect(r.q1 && r.blank === "Promise", `confident answers not filled: q1=${r.q1} blank=${JSON.stringify(r.blank)}`);
      expect(r.q2.every((x) => !x), `the low-confidence multiple choice was ticked: ${JSON.stringify(r.q2)}`);
      expect(r.badges.includes("小猫填的 95%") && r.badges.includes("小猫填的 92%"), `badges: ${JSON.stringify(r.badges)}`);
      expect(r.hints.some((h) => h.includes("小猫建议 B（55%）") && h.includes("没到门槛 80%") && h.includes("没替你选")), `hints: ${JSON.stringify(r.hints)}`);
      expect(r.hints.some((h) => h.includes("就选 B") && h.includes("我自己来")), `the hint lacks 就选/我自己来: ${JSON.stringify(r.hints)}`);
      expect(r.rows.length === 3 && r.rows[0].includes("第 1 题") && r.rows[1].includes("没到门槛") && r.rows[2].includes("第 3 题"), `result rows: ${JSON.stringify(r.rows)}`);
      expect(r.card.includes("没有点提交"), `the card does not say it did not submit: ${r.card}`);
      expect(r.submitClicks === 0 && r.submitState === "还没提交", `提交 was clicked: ${r.submitClicks} / ${r.submitState}`);
      expect((await llmLog(SITE)).length === 3, "the quiz should have asked the fake model exactly three times");
    },
  ],
  [
    "R6 setup: the fake model is the 对话 engine; an earlier run's teach rule, its conversation and any unsaved draft are cleared",
    async () => {
      const notes = resetTeach();
      page.eval(`await openSettings("通用");`);
      pickEngine("对话先用");
      page.eval(`await closeSettings();`);
      return notes;
    },
  ],
  [
    "R6.1 R6.2 the bubble's 教小猫做件事 opens the panel with the first-use notice, naming the engine and its host",
    async () => {
      await resetLlm(SITE);
      await scriptLlm(SITE, teachReplies());
      load(NEWS);
      page.eval(`${OPEN_BUBBLE} byText("button", "教小猫做件事").click(); await waitFor(() => ${PANEL}, "teach panel");`);
      const t = page.eval(`await waitFor(() => txt(${PANEL}).includes("第一次用，先说清楚"), "first-use notice").catch(() => null); return txt(${PANEL});`);
      expect(t.includes("草稿会出现在这里"), "the draft side has no placeholder before the first draft");
      shot("写规则-对话开始");
      if (!t.includes("第一次用，先说清楚")) {
        // cc:teach-notice lives in the script's GM storage, which no page or sctl command can clear.
        expect(existsSync(NOTICE_SEEN), `no first-use notice and no earlier run saw it: ${t.slice(0, 400)}`);
        return "first-use notice already seen in an earlier run (cc:teach-notice cannot be cleared from the page)";
      }
      expect(t.includes("假大模型") && t.includes("localhost") && t.includes("不含输入框"), `first-use notice: ${t.slice(0, 400)}`);
      mkdirSync(path.dirname(NOTICE_SEEN), { recursive: true });
      writeFileSync(NOTICE_SEEN, new Date().toISOString());
    },
  ],
  [
    "R6.3 the description gets a clarifying question with quick replies, and no draft yet",
    async () => {
      say(TEACH_DESCRIPTION);
      const t = page.eval(`await waitFor(() => ${PANEL_BTN(TEACH_QUICK_REPLY)}, "the quick reply", 30000); return txt(${PANEL});`, "40s");
      expect(t.includes("什么时候帮你点") && t.includes("出现了再点"), `the question: ${t.slice(0, 400)}`);
      expect(!t.includes("通过校验") && t.includes("草稿会出现在这里"), "a draft appeared before the cat had the answer");
      shot("写规则-小猫追问");
    },
  ],
  [
    "R6.5 the quick reply sends the answer; the draft has one schema error, is repaired once (v1), is marked on the page and the dry run clicks nothing",
    async () => {
      page.eval(`${PANEL_BTN(TEACH_QUICK_REPLY)}.click();`);
      const t = await settleTeach(1);
      expect(t.includes("校验发现 1 处问题，已修好"), `the repair line: ${t.slice(0, 600)}`);
      expect(t.includes("通过校验"), "v1 does not say 通过校验");
      const r = page.eval(`
        await waitFor(() => all("[data-cc-mark]").length === 2, "two markers on the page", 15000);
        return { marks: all("[data-cc-mark]").map((m) => m.dataset.ccMark), pane: txt(${PANEL}) };`, "30s");
      expect(r.marks.join() === "1,2", `markers for the two 展开全文 buttons: ${JSON.stringify(r.marks)}`);
      expect(r.pane.includes("试运行没有点任何东西") || r.pane.includes("不会把任何内容发给引擎"), `the dry run line: ${r.pane.slice(0, 600)}`);
      const c = await newsClicks();
      expect(c.body === 0 && c.related === 0 && c.replies === 0, `the dry run clicked: ${JSON.stringify(c)}`);
      expect((await llmLog(SITE)).length === 3, "question, broken draft and its repair should be three model calls");
    },
  ],
  [
    "R6.3 R6.5 R6.6 「只点正文那个」 gives v2 with a diff against v1, v1 stays selectable",
    async () => {
      say(TEACH_CORRECTION);
      const t = await settleTeach(2);
      expect(/比 v1：[加改删] \d 处/.test(t), `no diff against v1: ${t.slice(0, 700)}`);
      const sent = JSON.stringify((await llmLog(SITE)).at(-1)?.body ?? "");
      expect(sent.includes("button.expand") && sent.includes(TEACH_CORRECTION), "the correction did not carry the current draft v1");
      const marks = page.eval(`await waitFor(() => all("[data-cc-mark]").length === 1, "one marker for v2", 15000); return all("[data-cc-mark]").map((m) => m.dataset.ccMark);`, "30s");
      expect(marks.join() === "A", `v2 markers: ${JSON.stringify(marks)}`);
      shot("写规则-草稿和改动");
      expect(page.eval(`return ${PANEL}.querySelector('[role=radiogroup][aria-label="草稿版本"]').querySelectorAll('[role=radio]').length;`) === 2, "the version switch does not list v1 and v2");
    },
  ],
  [
    "R6.7 存进本地规则 saves v2; the panel then says it is saved",
    async () => {
      page.eval(`
        ${PANEL_BTN("存进本地规则")}.click();
        await waitFor(() => txt(${PANEL}).includes("v2 已存进本地规则"), "saved", 10000);`);
      page.eval(`const x = [...${PANEL}.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "关闭"); x.click(); await waitFor(() => !${PANEL}, "panel closed");`);
      const t = page.eval(`await openSettings("规则"); const t = txt(settings()); await closeSettings(); return t;`);
      expect(t.includes("本地规则"), `the rules page: ${t.slice(0, 300)}`);
    },
  ],
  [
    "R6.7 after a reload the saved rule clicks the article's 展开全文 only",
    async () => {
      load(NEWS);
      page.eval(`await waitFor(() => Number(document.body.dataset.bodyClicks) === 1, "the article's 展开全文 clicked", 12000); await sleep(1500);`, "30s");
      const c = await newsClicks();
      expect(c.body === 1 && c.related === 0 && c.replies === 0, `clicks after the reload: ${JSON.stringify(c)}`);
    },
  ],
  [
    "R6.8 the rule's feature page has 继续和小猫改, which shows the whole conversation and both versions",
    async () => {
      page.eval(`await openSettings(${JSON.stringify(RULE_NAME)}); await waitFor(() => byText("button", "继续和小猫改"), "继续和小猫改");`);
      shot("写规则-继续改-功能页");
      page.eval(`byText("button", "继续和小猫改").click(); await waitFor(() => ${PANEL}, "teach panel from the feature page");`);
      const t = page.eval(`await waitFor(() => txt(${PANEL}).includes("草稿 v2"), "saved draft", 10000); return txt(${PANEL});`);
      expect(t.includes(TEACH_DESCRIPTION) && t.includes(TEACH_QUICK_REPLY) && t.includes(TEACH_CORRECTION), `the history is missing: ${t.slice(0, 600)}`);
      expect(t.includes("已存") && t.includes("v1") && t.includes("v2"), `saved state or versions: ${t.slice(0, 300)}`);
      shot("写规则-继续改");
      page.eval(`const x = [...${PANEL}.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "关闭"); x.click(); await waitFor(() => !${PANEL}, "panel closed"); await closeSettings();`);
    },
  ],
  [
    "R9.4 写规则 screenshots: 点选元素 (the picked button is not clicked) and 校验没通过 after three failed repairs",
    async () => {
      await resetLlm(SITE);
      await scriptLlm(SITE, [DRAFT_BAD, DRAFT_BAD, DRAFT_BAD, DRAFT_BAD].map((draft) => ({ json: { message: "这是草稿。", draft } })));
      load(NEWS);
      page.eval(`${OPEN_BUBBLE} byText("button", "教小猫做件事").click(); await waitFor(() => ${PANEL}, "teach panel");`);
      page.eval(`${PANEL_BTN("点选元素")}.click(); await waitFor(() => txt(R()).includes("点选相关元素，按 Esc 完成"), "picker bar");`);
      const picked = page.eval(`
        const at = (el, type) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 })); };
        const related = document.getElementById("expand-related");
        for (const t of ["mouseover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) at(related, t);
        at(document.getElementById("reply-1"), "mouseover");
        await waitFor(() => txt(R()).includes("已选 1 个"), "one element picked");
        return Number(document.body.dataset.relatedClicks);`);
      expect(picked === 0, `picking clicked the page's button (${picked})`);
      shot("写规则-点选元素");
      const chip = page.eval(`byText("button", "完成").click(); await waitFor(() => ${PANEL} && [...${PANEL}.querySelectorAll("button")].some((b) => (b.getAttribute("aria-label") ?? "").startsWith("去掉 ")), "the picked chip"); return txt(${PANEL});`);
      expect(chip.includes("展开全文"), `the chip does not name the picked button: ${chip.slice(0, 300)}`);
      say("出现了再点");
      const t = page.eval(`await waitFor(() => ${PANEL_BTN("让小猫再试")}, "让小猫再试", 30000); return txt(${PANEL});`, "40s");
      expect(t.includes("自己改"), `the rejected turn lacks 自己改: ${t.slice(0, 600)}`);
      expect((await llmLog(SITE)).length === 4, "a draft and three repair rounds should be four model calls");
      shot("写规则-校验没通过");
      const closed = page.eval(`
        [...${PANEL}.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "关闭").click();
        await waitFor(() => !${PANEL} || txt(R()).includes("要丢掉这次的草稿吗"), "closed or asked", 3000);
        if (${PANEL}) { byText("button", "丢掉").click(); await waitFor(() => !${PANEL}, "panel closed"); return "discarded"; }
        return "closed";`);
      return `panel ${closed}`;
    },
  ],
  [
    "R7 setup: 假整页翻译 is the 网页对照 engine; the 翻译 feature page shows the 快捷键 row (Alt + A)",
    async () => {
      await setState({ failPage: 0, delayMs: 0 });
      page.eval(`await openSettings("翻译");`);
      pickEngine("用哪个引擎", PAGE_ENGINE);
      // An earlier run may have left 显示方式 on 只看译文 (the 只看译文 scenario sets it); on the feature page it is a radiogroup.
      page.eval(`
        const both = [...settings().querySelectorAll('[role=radiogroup][aria-label="显示方式"] [role=radio]')].find((r) => txt(r) === "原文下面显示译文");
        if (!both) throw new Error("no 显示方式 option 原文下面显示译文 on the feature page");
        if (both.getAttribute("aria-checked") !== "true") { both.click(); await waitFor(() => both.getAttribute("aria-checked") === "true", "原文下面显示译文"); }`);
      let t = page.eval(`return txt(settings());`);
      // A run that stopped between here and the restore scenario leaves its own combo behind: put the default back first.
      const leftover = t.includes(HOTKEY.shown);
      if (leftover) {
        recordHotkey("Alt+KeyA");
        t = page.eval(`return txt(settings());`);
      }
      expect(t.includes("网页对照翻译") && t.includes("快捷键") && t.includes("Alt + A"), `the 网页对照 settings or the 快捷键 row are missing: ${t.slice(0, 400)}`);
      page.eval(`const k = [...settings().querySelectorAll("*")].find((e) => e.children.length === 0 && txt(e) === "快捷键"); k?.scrollIntoView({ block: "center" }); await sleep(300);`);
      shot("网页对照功能页");
      const shown = recordHotkey(HOTKEY.press);
      expect(shown.includes(HOTKEY.shown), `recording ${HOTKEY.press} shows ${shown}`);
      page.eval(`await closeSettings();`);
      return [leftover && `an earlier run left ${HOTKEY.shown}; set back to Alt + A`, `hotkey re-recorded as ${HOTKEY.shown} for the run (Immersive Translate also takes Alt+A)`].filter(Boolean).join("; ");
    },
  ],
  [
    "R7.1 R7.3 对照翻译这个网页: only the paragraphs in view are translated (with a loading placeholder first); none after nav, pre/code or [translate=no]",
    async () => {
      await setState({ delayMs: 3000 });
      load(ARTICLE);
      page.eval(`${ARTICLE_JS} window.__before = bodyHtml(); window.scrollTo(0, 0);`);
      const m = await mark();
      page.eval(START_COMPARE);
      page.eval(`${ARTICLE_JS} await waitFor(() => trs().some((h) => h.shadowRoot.querySelector('[aria-label="正在翻译"]')), "a loading placeholder", 10000);`, "20s");
      shot("网页对照-进行中");
      await setState({ delayMs: 0 });
      const r = page.eval(
        `${ARTICLE_JS}
        await waitFor(() => trs().length > 0 && doneTrs().length === trs().length, "every placeholder translated", 15000);
        const nav = [...document.querySelectorAll("#site-nav li")];
        const skip = [...nav, ...document.querySelectorAll("pre, pre code, [translate=no]")];
        return {
          total: document.querySelectorAll("article p, article h1").length,
          done: doneTrs().length,
          outside: doneTrs().filter((h) => !nearViewport(sourceOf(h))).length,
          afterSkipped: skip.filter(nextIsTr).length,
          skippedChildren: document.querySelectorAll("pre companion-cat-tr, code companion-cat-tr, nav companion-cat-tr").length,
          lastDone: nextIsTr(document.getElementById("p36")),
          sample: trText(doneTrs()[1]),
        };`,
        "30s",
      );
      expect(r.done >= 3 && r.done < r.total / 2, `translated ${r.done} of ${r.total} blocks; only the ones in view should be`);
      expect(r.outside === 0, `${r.outside} translated blocks are outside the viewport`);
      expect(r.afterSkipped === 0 && r.skippedChildren === 0, `translations after nav/pre/code/[translate=no]: ${r.afterSkipped}/${r.skippedChildren}`);
      expect(!r.lastDone, "the last paragraph, far below, was translated");
      expect(r.sample.startsWith("[P → zh-CN] "), `translation text: ${r.sample}`);
      const reqs = await pageRequests(m);
      const sent = reqs.reduce((n, l) => n + l.count, 0);
      expect(sent === r.done, `sent ${sent} texts for ${r.done} translations`);
      expect(page.eval(`return document.documentElement.dataset.cspViolations;`) === "0", "unexpected CSP violation on the normal page");
    },
  ],
  [
    "R7.4 scrolling down: the paragraphs that came into view get translated too",
    async () => {
      const before = page.eval(`${ARTICLE_JS} return doneTrs().length;`);
      page.eval(`${ARTICLE_JS} const p = document.getElementById("p20"); p.scrollIntoView({ block: "center" });
        await waitFor(() => nextIsTr(p) && trText(p.nextElementSibling).startsWith("[P → "), "paragraph 20 translated", 15000);`, "30s");
      const after = page.eval(`${ARTICLE_JS} return doneTrs().length;`);
      expect(after > before, `scrolling added no translations (${before} -> ${after})`);
      expect(!page.eval(`${ARTICLE_JS} return nextIsTr(document.getElementById("p36"));`), "the last paragraph is still far below and should not be translated yet");
    },
  ],
  [
    "R7.4 the append button adds a paragraph that gets translated, once",
    async () => {
      const m = await mark();
      page.eval(`${ARTICLE_JS} window.scrollTo(0, 0); await sleep(300); document.getElementById("append").click();
        const p = document.querySelector("#appended p");
        await waitFor(() => nextIsTr(p) && trText(p.nextElementSibling).startsWith("[P → "), "the appended paragraph translated", 15000);`, "30s");
      await sleep(800);
      const r = page.eval(`${ARTICLE_JS} const p = document.querySelector("#appended p"); return { text: trText(p.nextElementSibling), copies: trs().filter((h) => sourceOf(h) === p).length };`);
      expect(r.text.includes("Appended paragraph 1"), `appended translation: ${r.text}`);
      expect(r.copies === 1, `the appended paragraph has ${r.copies} translations`);
      const sent = (await pageRequests(m)).filter((l) => l.first.startsWith("Appended paragraph 1"));
      expect(sent.length === 1, `the appended paragraph was sent ${sent.length} times`);
    },
  ],
  [
    "R7.5 one failed batch shows 重试 under its paragraph; clicking it translates that batch",
    async () => {
      await setState({ failPage: 1, delayMs: 0 });
      const m = await mark();
      page.eval(`${ARTICLE_JS} window.scrollTo(0, 0); document.getElementById("append").click();
        await waitFor(() => failedTrs().length === 1, "one failed batch with 重试", 15000);`, "30s");
      const failed = page.eval(`${ARTICLE_JS} const h = failedTrs()[0]; return { text: trText(h), source: sourceOf(h).textContent, others: doneTrs().length > 0 };`);
      expect(failed.source.startsWith("Appended paragraph 2") && failed.text.includes("重试"), `failed batch: ${JSON.stringify(failed)}`);
      expect(failed.others, "the other batches should stay translated");
      shot("网页对照-失败重试");
      page.eval(`${ARTICLE_JS} failedTrs()[0].shadowRoot.querySelector("button").click();
        await waitFor(() => failedTrs().length === 0 && trs().every((h) => trText(h).startsWith("[P → ")), "the retried batch translated", 15000);`, "30s");
      const sent = (await pageRequests(m)).filter((l) => l.first.startsWith("Appended paragraph 2"));
      expect(sent.length === 2, `the failed batch should be sent twice (fail, retry), was ${sent.length}`);
      expect(page.eval(`${ARTICLE_JS} return trs().filter((h) => sourceOf(h).textContent.startsWith("Appended paragraph 2")).length;`) === 1, "the retried paragraph has more than one translation");
    },
  ],
  [
    "R7.4 显示方式 → 只看译文 in the bubble hides the sources and keeps the translations",
    async () => {
      page.eval(OPEN_BUBBLE);
      page.click("combobox", "显示方式");
      page.click("option", "只看译文");
      page.eval(`${ARTICLE_JS}
        await waitFor(() => doneTrs().every((h) => getComputedStyle(sourceOf(h)).display === "none"), "sources hidden", 8000);
        ${CLOSE_BUBBLE}`);
      const r = page.eval(`${ARTICLE_JS} return { hidden: doneTrs().filter((h) => getComputedStyle(sourceOf(h)).display === "none").length, done: doneTrs().length, nav: getComputedStyle(document.querySelector("#site-nav li")).display, pre: getComputedStyle(document.querySelector("pre")).display };`);
      expect(r.hidden === r.done && r.done > 0, `hidden ${r.hidden} of ${r.done} sources`);
      expect(r.nav !== "none" && r.pre !== "none", "nav and pre must stay visible");
      page.eval(`window.scrollTo(0, 0);`);
      shot("只看译文");
    },
  ],
  [
    "R7.1 the hotkey restores the page: body.innerHTML (without the cat) is exactly what it was before",
    async () => {
      try {
        await hotkeyRestores();
      } finally {
        // Back to the default for the next run (recording Alt+A lets Immersive Translate act on this page; the next scenario loads a fresh one).
        page.eval(`await closeCards().catch(() => {}); await openSettings("翻译");`);
        const shown = recordHotkey("Alt+KeyA");
        page.eval(`await closeSettings();`);
        expect(shown.includes("Alt + A"), `the hotkey was not set back to Alt + A: ${shown}`);
      }
    },
  ],
  [
    "R9.1 the same under the strict CSP: opens, translates, restores from the bubble, and the page reports no CSP violation",
    async () => {
      load(ARTICLE_CSP);
      const csp = (await fetch(ARTICLE_CSP, { headers: { connection: "close" } })).headers.get("content-security-policy");
      expect(!!csp && csp.includes("script-src 'self'"), `the CSP variant is not served under a strict CSP: ${csp}`);
      page.eval(`${ARTICLE_JS} window.__before = bodyHtml();`);
      page.eval(START_COMPARE);
      page.eval(`${ARTICLE_JS} await waitFor(() => trs().length > 0 && doneTrs().length === trs().length, "translations under the strict CSP", 20000);`, "30s");
      const during = page.eval(`${ARTICLE_JS} return { done: doneTrs().length, violations: document.documentElement.dataset.cspViolations, last: document.documentElement.dataset.cspLast ?? "" };`);
      expect(during.done >= 3, `only ${during.done} translations under the strict CSP`);
      expect(during.violations === "0", `CSP violations: ${during.violations} (${during.last})`);
      page.eval(`${OPEN_BUBBLE} byText("button", "恢复原文").click(); ${CLOSE_BUBBLE}`);
      const r = page.eval(`${ARTICLE_JS} await waitFor(() => trs().length === 0, "translations removed", 8000);
        const now = bodyHtml(), want = window.__before;
        let i = 0;
        while (i < now.length && now[i] === want[i]) i++;
        return { same: now === want, at: now.slice(Math.max(0, i - 60), i + 80), was: want.slice(Math.max(0, i - 60), i + 80), violations: document.documentElement.dataset.cspViolations };`);
      expect(r.same, `the strict-CSP page is not back to its original DOM after 恢复原文, near: ${r.at}\n     was: ${r.was}`);
      expect(r.violations === "0", `CSP violations after restore: ${r.violations}`);
    },
  ],
  [
    "R9.4 深色: the second-round states in the dark theme (screenshots)",
    async () => {
      page.eval(`await openSettings("通用"); await theme("深色"); await closeSettings();`);
      try {
        return await r94States("深色");
      } finally {
        page.eval(`await openSettings("通用"); await theme("浅色"); await closeSettings();`);
      }
    },
  ],
  [
    "R9.4 窄屏: the second-round states at 400 px wide (screenshots)",
    async () => {
      page.cdp("Emulation.setDeviceMetricsOverride", { width: 400, height: 820, deviceScaleFactor: 2, mobile: false });
      try {
        return await r94States("窄屏");
      } finally {
        page.cdp("Emulation.clearDeviceMetricsOverride");
        page.eval(`await openSettings("通用"); await theme("跟随系统"); await closeSettings();`);
      }
    },
  ],
];

// ---------------------------------------------------------------- runner

async function main() {
  if (process.argv.includes("--list")) {
    scenarios.forEach(([n], i) => console.log(`${i + 1}. ${n}`));
    return 0;
  }
  rmSync(ART, { recursive: true, force: true });
  mkdirSync(ART, { recursive: true });
  srv = spawn(process.execPath, [path.join(DIR, "server.mjs"), String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.once("exit", (code) => reject(new Error(`e2e server exited (${code})`)));
    srv.stdout.once("data", resolve);
  });
  console.log(`e2e server on ${SITE}`);
  const results = [];
  try {
    windowId = sctlJson(["windows", "open", `${SITE}/`]).windowId;
    const tabs = sctlJson(["tabs", "list"]).tabs.filter((t) => t.windowId === windowId);
    page = new Page(tabs[0].tabId);
    sctl(["page", "wait", "--load", "load", "--tab", page.tab]);
    other = new Page(sctlJson(["tabs", "open", `${OTHER}/`, "--background", "--window", String(windowId)]).tabId);
    sctl(["page", "wait", "--load", "load", "--tab", other.tab]);
    await sleep(1500);
    const arg = (flag, fallback) => (process.argv.includes(flag) ? Number(process.argv[process.argv.indexOf(flag) + 1]) || fallback : fallback);
    for (const [name, fn] of scenarios.slice(arg("--from", 1) - 1, arg("--until", scenarios.length))) {
      const reloads = page.recovered ?? 0;
      try {
        let note = await fn();
        if ((page.recovered ?? 0) > reloads) note = [note, "tab reloaded: a password manager frame made it not automatable"].filter(Boolean).join("; ");
        results.push({ name, ok: true, note });
        console.log(`PASS ${name}${note ? ` (${note})` : ""}`);
      } catch (e) {
        results.push({ name, ok: false, error: e.message });
        console.log(`FAIL ${name}\n     ${String(e.message).split("\n").join("\n     ")}`);
        try {
          // Never screenshot the Jev scenario's failure: a saved real key would show (masked) in the panel.
          if (!name.startsWith("Jev")) shot(`FAILED-${results.length}`);
          // A crashed shell (no corner cat) is restarted for the next scenario; the stored state stays.
          // Otherwise the page is kept, so in-memory state such as the result cache carries on.
          for (const p of [page, other]) {
            if (p.eval(`return !!byLabel("button", "陪伴猫");`)) continue;
            sctl(["page", "reload", "--tab", p.tab]);
            await sleep(2500);
          }
        } catch {}
      }
    }
  } finally {
    if (process.argv.includes("--keep")) {
      console.log(`kept: window ${windowId}, page tab ${page?.tab}, other tab ${other?.tab}, server pid ${srv.pid}`);
      srv.stdout.destroy();
      srv.unref();
      return 1;
    }
    for (const p of [page, other]) if (p) try { sctl(["page", "detach", "--tab", p.tab]); } catch {}
    if (windowId) try { sctl(["windows", "close", String(windowId)]); } catch {}
    srv.kill();
  }
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} scenarios passed; ${shots.length} screenshots in ${path.relative(process.cwd(), ART)}/`);
  return results.every((r) => r.ok) ? 0 : 1;
}

process.exitCode = await main();
