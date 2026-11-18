/**
 * What each teach turn sends to the user's `chat` engine (R6.2): the rule format (schema and one
 * example), the conversation so far, the current draft, the page URL and title, and the picked
 * elements' outlines. Nothing else from the page is read here.
 */
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

/** Asks the AI to fix the draft it just gave. */
export function repairPrompt(problems: readonly DraftProblem[]): string {
  return [
    `这版草稿没有通过校验，有 ${problems.length} 处问题（字段路径：原因）：`,
    problemList(problems),
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
