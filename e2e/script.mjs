/**
 * Helpers for scripting the fake LLM (e2e/llm.mjs) from a scenario: what a choose or blank-filling
 * model answers, and the admin calls that queue or clear those answers. The fake listens on the
 * site's port + 1.
 */
const unit = (confidence) => {
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) throw new Error(`confidence must be 0..1, got ${confidence}`);
  return confidence;
};

/** The option key the skip-ads rule uses for a button: describe() of `<button>text</button>`. */
export const buttonKey = (text) => `「${text}」按钮`;

/** A choose answer: the model's text is `{"choice", "confidence"}`. */
export const chooseReply = (choice, confidence) => ({ json: { choice, confidence: unit(confidence) } });

/** A blank-filling chat answer: `{"answer", "confidence"}`. */
export const blankReply = (answer, confidence) => ({ json: { answer, confidence: unit(confidence) } });

const llmBase = (siteUrl) => {
  const u = new URL(siteUrl);
  return `${u.protocol}//${u.hostname}:${Number(u.port) + 1}`;
};
const post = async (url, body, tries = 3) => {
  try {
    const r = await fetch(url, { method: "POST", headers: { connection: "close", "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    return await r.json();
  } catch (e) {
    if (tries <= 1) throw e;
    await new Promise((r) => setTimeout(r, 200));
    return post(url, body, tries - 1);
  }
};

/** Queues replies on the fake LLM next to the site at `siteUrl`; they are served in order. */
export const scriptLlm = (siteUrl, replies) => post(`${llmBase(siteUrl)}/admin/script`, { replies });
/** Empties the fake LLM's queue and request log. */
export const resetLlm = (siteUrl) => post(`${llmBase(siteUrl)}/admin/reset`, {});
/** The fake LLM's request log. */
export const llmLog = async (siteUrl) => (await fetch(`${llmBase(siteUrl)}/admin/log`, { headers: { connection: "close" } })).json();

// ---- 教小猫做件事 (R6): what the fake chat engine says on /news ----------------------------

export const TEACH_DESCRIPTION = "文章页上的「展开全文」帮我自动点开";
export const TEACH_QUICK_REPLY = "一打开页面就点";
export const TEACH_CORRECTION = "只点正文那个";
export const TEACH_FEATURE_ID = "teach-auto-expand";

const feature = (run, description) => ({
  id: TEACH_FEATURE_ID,
  name: "自动展开全文",
  description,
  match: ["*://localhost/*"],
  entries: [{ id: "expand", name: "点开「展开全文」", triggers: [{ on: "page-load" }], run }],
});

/** v1: every 「展开全文」 on the page (the article's and the related-news box's). */
export const DRAFT_V1 = feature(
  [
    { find: "button.expand", all: true, as: "buttons" },
    { act: "click", target: "{{ vars.buttons }}" },
  ],
  "打开页面时点开所有「展开全文」",
);
/** v2: only the one inside the article body. */
export const DRAFT_V2 = feature(
  [
    { find: "article button.expand", as: "button" },
    { act: "click", target: "{{ vars.button }}" },
  ],
  "打开页面时只点开正文里的「展开全文」",
);
/** One schema error (an act field that does not exist) — the single repair round of the scenario. */
export const DRAFT_BAD = feature(
  [
    { find: "button.expand", all: true, as: "buttons" },
    { act: "click", target: "{{ vars.buttons }}", times: 1 },
  ],
  DRAFT_V1.description,
);

/** The four replies, in order: a question, the broken draft, its repair (v1), and v2 after the correction. */
export const teachReplies = () => [
  { json: { message: "好的，想先确认一下时机。", questions: [{ text: "什么时候帮你点？", quickReplies: [TEACH_QUICK_REPLY, "出现了再点"] }] } },
  { json: { message: "这是第一版草稿。", draft: DRAFT_BAD } },
  { json: { message: "修好了：页面上的「展开全文」都会被点开。", draft: DRAFT_V1 } },
  { json: { message: "改成只点正文里的那个。", draft: DRAFT_V2 } },
];
