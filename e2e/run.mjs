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
 *
 * Starts the local fake services (e2e/server.mjs), opens its own browser window, drives it with
 * sctl, writes the R13.4 screenshot set to e2e/artifacts/, and closes the window and server.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Page, sctl, sctlJson, sleep } from "./lib.mjs";
import { spawn } from "node:child_process";
import { E2E_KEY } from "./server.mjs";

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
      // Both official packs must be subscribed; an earlier run may have left them unsubscribed.
      const missing = page.eval(`await openSettings("规则"); const t = txt(settings()); return ["翻译", "常见大模型"].filter((n) => !t.includes(n + " 官方"));`);
      if (missing.length) {
        for (const n of ["翻译", "常见大模型"]) if (!missing.includes(n)) { page.click("button", `${n} 的更多操作`); page.click("menuitem", "取消订阅"); }
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
      for (const name of ["E2E 测试规则", "翻译", "常见大模型"]) {
        page.click("button", `${name} 的更多操作`);
        page.click("menuitem", "取消订阅");
        page.eval(`await sleep(200);`);
      }
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
    const until = Number(process.argv[process.argv.indexOf("--until") + 1]) || scenarios.length;
    for (const [name, fn] of scenarios.slice(0, process.argv.includes("--until") ? until : scenarios.length)) {
      try {
        const note = await fn();
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
