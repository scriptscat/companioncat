// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://news.example.cn/a/1"}
/**
 * Live smoke test of 教小猫做件事: the real conversation core, the real invoker and the official
 * DeepSeek engine, on a jsdom article with two 「展开全文」 buttons (body and related news). The key
 * is read from ~/.env (DEEPSEEK_API_KEY) and never printed: assertion messages go through mask().
 *
 * Either outcome passes, within the repair rounds: a clarifying question, or a draft that passes
 * validation, is an automation entry and, dry run on this page, finds the body's button.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import officialLlm from "../../../rules/packs/official-llm.json";
import v1 from "../../../rules/schema/v1.json";
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { installFetchGm } from "../../../test/fakes/gm-http";
import { elementHandle, elementOf, type PageHost, renderTemplate } from "../../core/expr";
import { createInvoker } from "../../core/invoke";
import { POSITIONS, resolveRules } from "../../core/rules";
import { isAutomationEntry } from "../../core/rules/automation";
import type { RunStepDef } from "../../core/rules/types";
import { createSecretStore } from "../../core/stores";
import { createStorage } from "../../platform/storage";
import { questionFinders } from "../automation/questions";
import { runAutomation } from "../automation/run";
import { createConversation, REPAIR_ROUNDS, validateDraft } from "./conversation";

function envKey(name: string): string | undefined {
  try {
    const env = readFileSync(join(homedir(), ".env"), "utf8");
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`, "m").exec(env);
    const v = m?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
    return v || undefined;
  } catch {
    return undefined;
  }
}

const key = envKey("DEEPSEEK_API_KEY");
const mask = (s: string) => (key ? s.split(key).join("sk-***") : s);
const ENGINE = "official-llm/deepseek";

/** The example feature the panel sends with the schema (mirrors EXAMPLE_FEATURE in Panel.tsx). */
const EXAMPLE = {
  id: "example-skip",
  name: "自动点掉「跳过」按钮",
  match: ["*://*/*"],
  entries: [
    {
      id: "skip",
      name: "点掉「跳过」按钮",
      triggers: [{ on: "page-load" }],
      run: [
        { find: "button.skip", as: "skip" },
        { act: "click", target: "{{ vars.skip }}" },
      ],
    },
  ],
};

const ARTICLE = `
<main>
  <article id="article">
    <h1>事件循环为什么让页面变卡</h1>
    <div class="body" id="body">
      <p>长任务会占住主线程，渲染要等它跑完才能进行。</p>
      <p class="more" hidden>展开后的正文：把长任务拆成小块，每块之间让出主线程。</p>
      <button type="button" class="expand" id="expand-body">展开全文</button>
    </div>
  </article>
  <aside id="related">
    <h3>相关新闻</h3>
    <div id="related-body">
      <p>浏览器如何安排渲染和任务。</p>
      <p class="more" hidden>展开后的相关新闻摘要。</p>
      <button type="button" class="expand" id="expand-related">展开全文</button>
    </div>
  </aside>
  <section id="comments">
    <h3>评论</h3>
    <div class="comment">小王：写得清楚。 <button type="button" class="reply-more" id="reply-1">展开 3 条回复</button></div>
  </section>
</main>`;

/** jsdom has no layout: visible = not hidden and not display:none up the tree. */
const host: PageHost = {
  text: (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim(),
  visible: (el) => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      if ((e as HTMLElement).hidden || getComputedStyle(e).display === "none") return false;
    }
    return true;
  },
};

/** Draft settings at their defaults, as the draft pane's try-out uses them. */
function defaults(draft: Record<string, unknown>, entry: Record<string, unknown>): Record<string, unknown> {
  const defs = { ...(draft.settings as object | undefined), ...(entry.settings as object | undefined) } as Record<string, { default?: unknown }>;
  return Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, d?.default]));
}

describe.skipIf(!key)("教小猫做件事 live smoke (DeepSeek)", () => {
  const gm = installFetchGm();
  afterAll(() => gm.restore());

  it("asks a clarifying question, or writes a valid automation draft that finds the body's 「展开全文」", { timeout: 600_000 }, async () => {
    document.title = "事件循环为什么让页面变卡 - 示例新闻";
    document.body.innerHTML = ARTICLE;
    const bodyButton = document.getElementById("expand-body")!;
    const relatedButton = document.getElementById("expand-related")!;

    // the official pack as JSON (testkit's file read does not work under jsdom's import.meta.url)
    const rules = resolveRules([{ pack: officialLlm, official: true }]);
    expect(rules.diagnostics).toEqual([]);
    const storage = createStorage(createGmStorageFake().tab());
    const secrets = createSecretStore(storage, () => rules);
    secrets.set(ENGINE, "apiKey", key!, ["api.deepseek.com"]);
    const invoker = createInvoker({ rules: () => rules, secrets });

    // the attachment the picker would send for the body's button (Picker.tsx describePicked)
    const outline = (await renderTemplate("{{ outline(trigger, 600) }}", { trigger: elementHandle(bodyButton, host) }, POSITIONS.autoRun)) as string;

    const conv = createConversation({
      invoker,
      engine: ENGINE,
      schema: v1,
      example: EXAMPLE,
      validate: (d) => validateDraft(d),
      page: () => ({ url: location.href, title: document.title }),
    });
    await conv.send("打开这个网站的文章时自动点开正文里的『展开全文』", [outline]);

    const s = conv.snapshot();
    const turn = s.turns[0]!;
    expect(turn.status, mask(JSON.stringify(turn.error ?? null))).toBe("done");
    const rounds = turn.check?.rounds ?? 0;
    expect(rounds).toBeLessThanOrEqual(REPAIR_ROUNDS);
    // Rejected after every repair round: the exact problems left are the finding.
    const remaining = turn.check?.remaining ?? [];
    const why = `after ${rounds} repair rounds, first found ${JSON.stringify(turn.check?.found)}, still ${JSON.stringify(remaining)}; draft ${JSON.stringify(turn.rejected)}`;
    expect(remaining.length, mask(why)).toBe(0);

    if (turn.version === undefined) {
      const asked = (turn.reply?.questions?.length ?? 0) > 0 || turn.reply?.askPick !== undefined;
      expect(asked, mask(`neither a question nor a draft: ${JSON.stringify(turn.reply)}`)).toBe(true);
      console.info(`[teach live] question; ${JSON.stringify(turn.reply)}`);
      return;
    }

    const draft = s.versions[turn.version - 1]!.draft as Record<string, unknown>;
    expect(validateDraft(draft)).toEqual([]);
    const entries = (Array.isArray(draft.entries) ? draft.entries : []) as Record<string, unknown>[];
    const auto = entries.filter((e) => isAutomationEntry(e));
    expect(auto.length, mask(JSON.stringify(draft))).toBeGreaterThan(0);

    const found = new Set<Element>();
    const ends: string[] = [];
    for (const entry of auto) {
      const report = await runAutomation(
        entry.run as RunStepDef[],
        { settings: defaults(draft, entry), page: { url: location.href, title: document.title }, site: {} },
        {
          invoker,
          mode: "dry",
          host,
          finders: questionFinders,
          act: () => {
            throw new Error("试运行不会动手");
          },
        },
      );
      ends.push(report.end);
      for (const step of report.steps) {
        // found holds handles (a finder's data items are reported by their handle)
        for (const h of step.found ?? []) found.add(elementOf(h));
      }
    }
    expect(found.has(bodyButton), mask(`dry run (${ends.join(",")}) missed the body button; draft: ${JSON.stringify(draft)}`)).toBe(true);
    console.info(
      `[teach live] draft v${turn.version}; repair rounds ${rounds}; found ${JSON.stringify(turn.check?.found ?? [])}; ` +
        `dry run ${ends.join(",")}, body button found, related button ${found.has(relatedButton) ? "also found" : "not found"}; ` +
        `run ${JSON.stringify(auto.map((e) => e.run))}`,
    );
  });
});
