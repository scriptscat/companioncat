/**
 * What each teach turn sends to the user's `chat` engine (R6.2): the rule format (schema and one
 * example), the conversation so far, the current draft, the page URL and title, and the picked
 * elements' outlines. Nothing else from the page is read here.
 */
import { PAGE_FUNCTIONS, type PageFunction, type Position } from "../../core/expr";
import { POSITIONS } from "../../core/rules";
import type { Reply } from "./reply";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PageInfo {
  url: string;
  title: string;
}

/** A field path and why it failed validation. */
export interface DraftProblem {
  path: string;
  message: string;
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const block = (v: unknown) => "```json\n" + pretty(v) + "\n```";

const REPLY_FORMAT = `{
  "message": "给用户看的一段话（必填）",
  "questions": [{ "text": "追问", "quickReplies": ["可以一点就发出去的回答"] }],
  "askPick": { "text": "请用户点选元素时说的话" },
  "draft": { "...": "完整的功能 JSON" }
}`;

/** One line per page function, kept next to the list so a new function must be described here. */
const PAGE_FUNCTION_HELP: Record<PageFunction, string> = {
  text: "text(el)：元素的文字",
  attr: "attr(el, 'x')：元素的 x 属性（读不了输入框的 value）",
  describe: "describe(el)：元素的简短描述",
  outline: "outline(el, n)：元素 n 层的精简结构",
  closest: "closest(el, 'css')：最近的匹配祖先元素，没有则 null",
  within: "within(el, 'css')：元素内匹配的子元素列表",
  visible: "visible(el)：元素当前是否可见",
};

const ITEM_RULE = "find 的 where 和 repeat 列表的 steps 里，当前元素叫 item";

const pageFunctionLines = () => PAGE_FUNCTIONS.map((f) => `  ${PAGE_FUNCTION_HELP[f]}`);

function automationSummary(): string[] {
  const { autoTrigger, autoRun } = POSITIONS;
  return [
    "自动化入口里表达式可用的东西（只有这些，写别的会校验失败）：",
    `- triggers 里的变量：${autoTrigger.vars.join("、")}`,
    `- run 里的变量：${autoRun.vars.join("、")}`,
    `- ${ITEM_RULE}，只在那里可用。`,
    `- 函数白名单：${[...autoRun.functions].filter((f) => !(PAGE_FUNCTIONS as readonly string[]).includes(f)).join("、")}`,
    "- 读页面的函数（el 是元素）：",
    ...pageFunctionLines(),
    "- 元素是不透明的句柄，没有属性：不能写 item.textContent 这样的点号取值，也没有 document、element；读文字用 text(item)，读属性用 attr(item, 'x')。",
  ];
}

export function systemPrompt(schema: unknown, example: unknown): string {
  return [
    "你是「陪伴猫」里帮用户写规则的小猫。用户用几句话描述想让小猫在网页上做的事，你和用户一起写出一条规则。",
    "你不会自己读网页：只能看到页面的网址和标题，以及用户点选的元素的精简结构。需要看某个元素时，请用户点选。",
    "",
    "规则是一个「功能」（feature）JSON，格式是下面 Schema 里的 $defs/feature。只写这一个功能，不要写整个规则包。",
    "规则 Schema：",
    JSON.stringify(schema),
    "",
    "一个范例功能：",
    block(example),
    "",
    ...automationSummary(),
    "",
    "每次回复只输出一个 JSON 对象，不要输出别的内容，格式：",
    REPLY_FORMAT,
    "- questions、askPick、draft 都可以省略；要求说不清时先追问，不要猜。",
    "- 能列出几个答案的追问，在 quickReplies 里给出这些答案。",
    "- 给出或修改草稿时，draft 必须是完整的功能 JSON，在当前草稿的基础上改。",
    "- 不需要改草稿时省略 draft。",
  ].join("\n");
}

function draftSection(draft: { n: number; draft: unknown } | undefined): string {
  return draft ? `当前草稿（v${draft.n}）：\n${block(draft.draft)}` : "当前还没有草稿。";
}

function attachmentsSection(attachments: readonly string[]): string[] {
  if (!attachments.length) return [];
  return ["用户点选的元素（精简结构）：", ...attachments.map((a, i) => `[${i + 1}] ${a}`)];
}

/** A user message as it appears in the conversation history. */
export function historyUser(text: string, attachments: readonly string[]): string {
  return [...attachmentsSection(attachments), text].join("\n");
}

/** The AI's earlier reply as history; drafts are left out (only the current one is sent). */
export function historyAssistant(reply: Reply, version: number | undefined): string {
  const { draft: _draft, ...rest } = reply;
  return JSON.stringify(rest) + (version ? `\n（这一轮给出了草稿 v${version}）` : "");
}

export interface TurnInput {
  page: PageInfo;
  draft: { n: number; draft: unknown } | undefined;
  text: string;
  attachments: readonly string[];
}

/** The newest user message: page, current draft, attachments, then what the user said. */
export function turnPrompt({ page, draft, text, attachments }: TurnInput): string {
  return [
    `页面标题：${page.title}`,
    `页面网址：${page.url}`,
    draftSection(draft),
    ...attachmentsSection(attachments),
    `用户说：${text}`,
  ].join("\n");
}

function problemList(problems: readonly DraftProblem[]): string {
  return problems.map((p) => `- ${p.path || "（整个草稿）"}：${p.message}`).join("\n");
}

const NAME_PROBLEM = /未知变量|不在白名单|不能在|未定义|undeclared|unknown/i;

/** The position a failing field path is evaluated in, and whether it sees `item`. */
function positionOf(path: string): { pos: Position; item: boolean } | undefined {
  if (/\.triggers\[/.test(path)) return { pos: POSITIONS.autoTrigger, item: false };
  if (!/\.run(\[|$)/.test(path)) return undefined;
  const item = /\.where$/.test(path) || /\.steps\[/.test(path);
  return { pos: POSITIONS.autoRun, item };
}

function allowedHint(problems: readonly DraftProblem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of problems) {
    if (!NAME_PROBLEM.test(p.message)) continue;
    const at = positionOf(p.path);
    if (!at) continue;
    const vars = [...at.pos.vars, ...(at.item ? ["item"] : [])];
    const fns = [...at.pos.functions].join("、");
    const key = `${vars.join()}|${at.item}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      `「${p.path}」这个位置${at.pos.name}可用的变量：${vars.join("、")}`,
      `可用的函数：${fns}`,
      "读页面的函数：",
      ...pageFunctionLines(),
      at.item ? "提示：这里当前元素叫 item，读文字用 text(item)，读属性用 attr(item, 'x')，不能用点号取属性。" : "提示：这里没有 item，元素要先用 find 找到。",
    );
  }
  return out;
}

/** Asks the AI to fix the draft it just gave. */
export function repairPrompt(problems: readonly DraftProblem[]): string {
  return [
    `这版草稿没有通过校验，有 ${problems.length} 处问题（字段路径：原因）：`,
    problemList(problems),
    ...allowedHint(problems),
    "请修好这些问题，按同样的 JSON 格式回复，draft 给出完整的功能 JSON。",
  ].join("\n");
}

/** 「让小猫再试」: repair a draft that failed every round of the previous turn. */
export function retryPrompt(page: PageInfo, rejected: unknown, problems: readonly DraftProblem[]): string {
  return [
    `页面标题：${page.title}`,
    `页面网址：${page.url}`,
    `上一轮的草稿自动返修后仍没有通过校验：\n${block(rejected)}`,
    repairPrompt(problems),
  ].join("\n");
}
