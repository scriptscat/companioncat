// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import v1 from "../../../rules/schema/v1.json";
import { CallError } from "../../core/errors";
import { elementHandle, type PageHost, renderTemplate } from "../../core/expr";
import type { InvokeOptions, InvokeRequest, InvokeResult } from "../../core/invoke";
import { POSITIONS } from "../../core/rules";
import { createConversation, fromJSON, validateDraft, type ConversationOptions } from "./conversation";
import { parseReply } from "./reply";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A scripted reply: chat text, a failure, or a call that only ends when aborted. */
type Script = string | CallError | "hang";

function fakeInvoker(script: Script[]) {
  const calls: { messages: ChatMessage[]; engines: InvokeRequest["engines"]; contract: string }[] = [];
  const invoke = vi.fn(async (req: InvokeRequest, opts: InvokeOptions = {}): Promise<InvokeResult> => {
    calls.push({ messages: (req.input as { messages: ChatMessage[] }).messages, engines: req.engines, contract: req.contract });
    const next = script.shift();
    if (next === undefined) throw new Error("no scripted reply left");
    if (next === "hang") {
      return new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal!.reason)));
    }
    if (next instanceof CallError) return { ok: false, strategy: "first", contract: "chat", error: next, results: [] };
    return { ok: true, strategy: "first", contract: "chat", engine: "x/chat", output: { text: next }, results: [] };
  });
  return { invoker: { invoke }, calls };
}

const feature = (run: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "auto-expand",
  name: "自动展开全文",
  match: ["*://news.example.cn/*"],
  entries: [{ id: "expand", name: "展开全文", triggers: [{ on: "page-load" }], run }],
  ...extra,
});

const GOOD = feature([
  { find: "article > .fold-btn", as: "fold" },
  { act: "click", target: "{{ vars.fold }}" },
]);
const GOOD2 = feature([
  { find: "article > .fold-btn", where: "{{ text(item) == '展开全文' }}", as: "fold" },
  { act: "click", target: "{{ vars.fold }}" },
]);
const GOOD3 = feature([{ find: "#comments .reply-more", as: "more" }, { act: "click", target: "{{ vars.more }}" }]);
/** Two expression problems: unknown variables in two fields. */
const TWO_BAD = feature([
  { find: "article > .fold-btn", where: "{{ nope }}", as: "fold" },
  { act: "click", target: "{{ alsoNope }}" },
]);
/** One schema problem: an act kind that does not exist. */
const SCHEMA_BAD = feature([{ find: "article > .fold-btn", as: "fold" }, { act: "hover", target: "{{ vars.fold }}" }]);

const EXAMPLE = feature([{ find: ".skip", as: "skip" }, { act: "click", target: "{{ vars.skip }}" }], { id: "example-skip" });

const reply = (r: Record<string, unknown>) => JSON.stringify(r);
const fenced = (r: Record<string, unknown>) => "好的，草稿如下：\n```json\n" + JSON.stringify(r, null, 2) + "\n```\n";

function setup(script: Script[], extra: Partial<ConversationOptions> = {}) {
  const fake = fakeInvoker(script);
  let t = 1000;
  const opts: ConversationOptions = {
    invoker: fake.invoker,
    engine: "official-llm/deepseek",
    schema: v1,
    example: EXAMPLE,
    validate: (d) => validateDraft(d),
    now: () => t++,
    page: () => ({ url: "https://news.example.cn/a/1", title: "一篇新闻" }),
    ...extra,
  };
  return { ...fake, opts, conv: createConversation(opts) };
}

const lastUser = (messages: ChatMessage[]) => messages[messages.length - 1]!;

describe("validateDraft (R6.5)", () => {
  it("accepts a valid automation feature, page functions included", () => {
    expect(validateDraft(GOOD)).toEqual([]);
    expect(validateDraft(GOOD2)).toEqual([]);
  });

  it("reports expression problems with paths relative to the feature", () => {
    const problems = validateDraft(TWO_BAD);
    expect(problems.map((p) => p.path)).toEqual(["entries[0].run[0].where", "entries[0].run[1].target"]);
    expect(problems[0]!.message).toContain("nope");
  });

  it("reports schema problems and refuses a non-object draft", () => {
    expect(validateDraft(SCHEMA_BAD).length).toBeGreaterThan(0);
    expect(validateDraft("not a feature").length).toBeGreaterThan(0);
  });
});

describe("reply kinds (R6.3)", () => {
  it("a question-only reply carries quick replies and askPick and makes no draft", async () => {
    const { conv } = setup([
      reply({
        message: "好。写之前先问两件事：",
        questions: [{ text: "只在 news.example.cn，还是所有新闻网站？", quickReplies: ["只在 news.example.cn", "所有新闻网站"] }],
        askPick: { text: "「展开全文」长什么样？点给我看一下。" },
      }),
    ]);
    expect(conv.snapshot().current).toBe(0);
    await conv.send("打开文章时帮我点「展开全文」");
    const s = conv.snapshot();
    expect(s.current).toBe(0);
    expect(s.versions).toEqual([]);
    expect(s.pending).toBe(false);
    expect(s.turns).toHaveLength(1);
    const turn = s.turns[0]!;
    expect(turn.text).toBe("打开文章时帮我点「展开全文」");
    expect(turn.status).toBe("done");
    expect(turn.reply).toEqual({
      message: "好。写之前先问两件事：",
      questions: [{ text: "只在 news.example.cn，还是所有新闻网站？", quickReplies: ["只在 news.example.cn", "所有新闻网站"] }],
      askPick: { text: "「展开全文」长什么样？点给我看一下。" },
    });
    expect(turn.version).toBeUndefined();
  });

  it("a draft reply becomes v1 and the current draft", async () => {
    const { conv } = setup([reply({ message: "写好了草稿 v1。", draft: GOOD })]);
    await conv.send("帮我点展开全文");
    const s = conv.snapshot();
    expect(s.versions).toEqual([{ n: 1, draft: GOOD, turn: s.turns[0]!.id, at: expect.any(Number) }]);
    expect(s.current).toBe(1);
    expect(conv.current).toBe(1);
    expect(conv.versions).toBe(s.versions);
    expect(s.turns[0]!.version).toBe(1);
    expect(s.turns[0]!.check).toEqual({ found: [], rounds: 0, fixed: 0, remaining: [] });
    expect(s.turns[0]!.reply?.draft).toBeUndefined();
  });

  it("a reply can carry both a draft and a question", async () => {
    const { conv } = setup([reply({ message: "先写了一版。", draft: GOOD, questions: [{ text: "没把握时要先问你吗？", quickReplies: ["要", "不用"] }] })]);
    await conv.send("帮我点展开全文");
    const s = conv.snapshot();
    expect(s.current).toBe(1);
    expect(s.turns[0]!.reply?.questions).toEqual([{ text: "没把握时要先问你吗？", quickReplies: ["要", "不用"] }]);
  });

  it("notifies subscribers with a new snapshot on every change", async () => {
    const { conv } = setup([reply({ message: "好", draft: GOOD })]);
    const seen: boolean[] = [];
    const before = conv.snapshot();
    const off = conv.subscribe(() => seen.push(conv.snapshot().pending));
    await conv.send("帮我点");
    off();
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
    expect(conv.snapshot()).not.toBe(before);
    expect(conv.snapshot()).toBe(conv.snapshot());
  });

  it("refuses a second message while one is in flight, and an empty one", async () => {
    const { conv } = setup(["hang"]);
    const first = conv.send("一");
    await expect(conv.send("二")).rejects.toThrow();
    conv.stop();
    await first;
    await expect(conv.send("  ")).rejects.toThrow();
  });
});

describe("prompt (R6.2, R9.2)", () => {
  it("sends the schema, one example, the page, the attachments and the reply format", async () => {
    const { conv, calls } = setup([reply({ message: "好" })]);
    await conv.send("帮我点展开全文", ['<button class="fold-btn">展开全文</button>']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.contract).toBe("chat");
    expect(calls[0]!.engines).toBe("official-llm/deepseek");
    const [system, ...rest] = calls[0]!.messages;
    expect(system!.role).toBe("system");
    expect(system!.content).toContain(JSON.stringify(v1));
    expect(system!.content).toContain(JSON.stringify(EXAMPLE, null, 2));
    for (const key of ['"message"', '"questions"', '"quickReplies"', '"askPick"', '"draft"']) expect(system!.content).toContain(key);
    expect(rest).toHaveLength(1);
    const user = lastUser(calls[0]!.messages);
    expect(user.role).toBe("user");
    expect(user.content).toContain("https://news.example.cn/a/1");
    expect(user.content).toContain("一篇新闻");
    expect(user.content).toContain('<button class="fold-btn">展开全文</button>');
    expect(user.content).toContain("帮我点展开全文");
    expect(user.content).toContain("还没有草稿");
  });

  it("later turns carry the conversation so far and the current draft", async () => {
    const { conv, calls } = setup([reply({ message: "写好了 v1。", draft: GOOD }), reply({ message: "改好了。", draft: GOOD2 })]);
    await conv.send("帮我点展开全文", ["<a>附件一</a>"]);
    await conv.send("只点正文那个");
    const messages = calls[1]!.messages;
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[1]!.content).toContain("帮我点展开全文");
    expect(messages[1]!.content).toContain("<a>附件一</a>");
    expect(messages[2]!.content).toContain("写好了 v1。");
    const user = lastUser(messages).content;
    expect(user).toContain("只点正文那个");
    expect(user).toContain("v1");
    expect(user).toContain(JSON.stringify(GOOD, null, 2));
    expect(user).not.toContain("<a>附件一</a>");
  });

  it("an attachment made by outline() never puts an input's value in the prompt", async () => {
    document.body.innerHTML = `<form id="f"><label>邮箱<input name="mail" value="me-secret@example.cn"></label>
      <input type="password" value="hunter2-secret"><textarea>draft-secret</textarea><button>登录</button></form>`;
    const host: PageHost = { text: (el) => el.textContent ?? "", visible: () => true };
    const form = elementHandle(document.getElementById("f")!, host);
    // the expression time budget can run out on a loaded machine; that is not what this test checks
    let outline = "";
    for (let i = 0; !outline; i++) {
      try {
        outline = (await renderTemplate("{{ outline(vars.form, 2000) }}", { vars: { form } }, POSITIONS.autoRun)) as string;
      } catch (e) {
        if (i >= 2 || (e as { code?: string }).code !== "timeout") throw e;
      }
    }
    expect(outline).toContain("登录");
    const { conv, calls } = setup([reply({ message: "好" })]);
    await conv.send("帮我登录", [outline]);
    const all = calls[0]!.messages.map((m) => m.content).join("\n");
    expect(all).toContain(outline);
    for (const secret of ["me-secret", "hunter2", "draft-secret"]) expect(all).not.toContain(secret);
  });
});

describe("validation and repair (R6.5)", () => {
  it("re-prompts with the field paths and reasons, then records what was fixed", async () => {
    const { conv, calls } = setup([reply({ message: "写好了草稿。", draft: TWO_BAD }), fenced({ message: "修好了。", draft: GOOD })]);
    await conv.send("帮我点展开全文");
    expect(calls).toHaveLength(2);
    const repair = lastUser(calls[1]!.messages).content;
    expect(repair).toContain("entries[0].run[0].where");
    expect(repair).toContain("entries[0].run[1].target");
    expect(repair).toContain("nope");
    expect(calls[1]!.messages.some((m) => m.role === "assistant" && m.content.includes("nope"))).toBe(true);
    const s = conv.snapshot();
    expect(s.current).toBe(1);
    expect(s.versions[0]!.draft).toEqual(GOOD);
    const turn = s.turns[0]!;
    expect(turn.reply?.message).toBe("写好了草稿。");
    expect(turn.check?.found).toHaveLength(2);
    expect(turn.check).toMatchObject({ rounds: 1, fixed: 2, remaining: [] });
    expect(s.errors).toEqual([]);
  });

  it("repairs a schema error", async () => {
    const { conv, calls } = setup([reply({ message: "草稿", draft: SCHEMA_BAD }), reply({ message: "修好", draft: GOOD })]);
    await conv.send("帮我点展开全文");
    expect(lastUser(calls[1]!.messages).content).toContain("entries[0].run[1]");
    expect(conv.snapshot().turns[0]!.check).toMatchObject({ rounds: 1, fixed: 1 });
    expect(conv.snapshot().current).toBe(1);
  });

  it("a repair reply without a draft counts as a failed round", async () => {
    const { conv, calls } = setup([reply({ message: "草稿", draft: TWO_BAD }), "我改不动了", reply({ message: "修好", draft: GOOD })]);
    await conv.send("帮我点展开全文");
    expect(calls).toHaveLength(3);
    expect(conv.snapshot().turns[0]!.check).toMatchObject({ rounds: 2, fixed: 2 });
  });

  it("after 3 failed rounds keeps the last valid draft and exposes the remaining errors", async () => {
    const bad = reply({ message: "加了一个触发。", draft: TWO_BAD });
    const { conv, calls } = setup([reply({ message: "v1", draft: GOOD }), bad, bad, bad, bad]);
    await conv.send("帮我点展开全文");
    await conv.send("评论里新出现的也点开");
    expect(calls).toHaveLength(5);
    const s = conv.snapshot();
    expect(s.versions).toHaveLength(1);
    expect(s.current).toBe(1);
    const turn = s.turns[1]!;
    expect(turn.status).toBe("done");
    expect(turn.version).toBeUndefined();
    expect(turn.check).toMatchObject({ rounds: 3, fixed: 0 });
    expect(turn.check?.remaining.map((p) => p.path)).toEqual(["entries[0].run[0].where", "entries[0].run[1].target"]);
    expect(turn.rejected).toEqual(TWO_BAD);
    expect(s.errors).toEqual(turn.check?.remaining);
  });

  it("「让小猫再试」 repairs the rejected draft in a new turn", async () => {
    const bad = reply({ message: "草稿", draft: TWO_BAD });
    const { conv, calls } = setup([bad, bad, bad, bad, reply({ message: "修好了：变量名写错了。", draft: GOOD })]);
    await conv.send("帮我点展开全文");
    expect(conv.snapshot().current).toBe(0);
    await conv.retry();
    expect(calls).toHaveLength(5);
    const prompt = lastUser(calls[4]!.messages).content;
    expect(prompt).toContain(JSON.stringify(TWO_BAD, null, 2));
    expect(prompt).toContain("entries[0].run[1].target");
    const s = conv.snapshot();
    expect(s.turns).toHaveLength(2);
    expect(s.turns[1]!.kind).toBe("retry");
    expect(s.turns[1]!.version).toBe(1);
    expect(s.current).toBe(1);
    expect(s.errors).toEqual([]);
  });
});

describe("versions (R6.6)", () => {
  it("rolls back with select and continues from the selected version", async () => {
    const { conv, calls } = setup([
      reply({ message: "v1", draft: GOOD }),
      reply({ message: "v2", draft: GOOD2 }),
      reply({ message: "v3", draft: GOOD3 }),
    ]);
    await conv.send("一");
    await conv.send("二");
    expect(conv.snapshot().current).toBe(2);
    conv.select(1);
    expect(conv.snapshot().current).toBe(1);
    await conv.send("三");
    const prompt = lastUser(calls[2]!.messages).content;
    expect(prompt).toContain(JSON.stringify(GOOD, null, 2));
    expect(prompt).not.toContain(JSON.stringify(GOOD2, null, 2));
    const s = conv.snapshot();
    expect(s.turns[2]!.base).toBe(1);
    expect(s.versions.map((v) => v.n)).toEqual([1, 2, 3]);
    expect(s.current).toBe(3);
  });

  it("refuses an unknown version", async () => {
    const { conv } = setup([reply({ message: "v1", draft: GOOD })]);
    expect(() => conv.select(1)).toThrow();
    await conv.send("一");
    expect(() => conv.select(2)).toThrow();
    expect(() => conv.select(0)).toThrow();
  });
});

describe("stop (R6.3)", () => {
  it("aborts the turn and keeps the previous draft", async () => {
    const { conv, invoker, calls } = setup([reply({ message: "v1", draft: GOOD }), "hang", reply({ message: "v2", draft: GOOD2 })]);
    await conv.send("一");
    const p = conv.send("二");
    expect(conv.snapshot().pending).toBe(true);
    conv.stop();
    expect(conv.snapshot().pending).toBe(false);
    await p;
    const signal = (invoker.invoke.mock.calls[1]![1] as InvokeOptions).signal!;
    expect(signal.aborted).toBe(true);
    let s = conv.snapshot();
    expect(s.turns[1]!.status).toBe("stopped");
    expect(s.versions).toHaveLength(1);
    expect(s.current).toBe(1);
    await conv.send("三");
    expect(calls[2]!.messages.slice(1).map((m) => m.content).join("\n")).not.toContain("二");
    s = conv.snapshot();
    expect(s.current).toBe(2);
  });

  it("stopping during a repair round makes no version", async () => {
    const { conv, calls } = setup([reply({ message: "草稿", draft: TWO_BAD }), "hang"]);
    const p = conv.send("一");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    conv.stop();
    await p;
    expect(conv.snapshot().versions).toEqual([]);
    expect(conv.snapshot().turns[0]!.status).toBe("stopped");
  });
});

describe("AI failure (R6.11)", () => {
  it("reports the error type on the turn, keeps history, and can retry the turn", async () => {
    const { conv, calls } = setup([
      reply({ message: "v1", draft: GOOD }),
      new CallError("rateLimit"),
      reply({ message: "v2", draft: GOOD2 }),
    ]);
    await conv.send("一");
    const before = conv.snapshot();
    await conv.send("二", ["<b>附件</b>"]);
    let s = conv.snapshot();
    expect(s.turns[1]!.status).toBe("failed");
    expect(s.turns[1]!.error).toEqual({ type: "rateLimit", message: "请求太频繁了，过一会儿再试" });
    expect(s.turns[0]).toEqual(before.turns[0]);
    expect(s.versions).toEqual(before.versions);
    expect(s.current).toBe(1);
    await conv.retry();
    s = conv.snapshot();
    expect(s.turns).toHaveLength(2);
    expect(s.turns[1]!.status).toBe("done");
    expect(s.turns[1]!.error).toBeUndefined();
    expect(s.current).toBe(2);
    expect(lastUser(calls[2]!.messages).content).toContain("<b>附件</b>");
    expect(lastUser(calls[2]!.messages).content).toContain("二");
  });

  it("a thrown CallError or a reply without text also fails the turn", async () => {
    const { conv, invoker } = setup([]);
    invoker.invoke.mockRejectedValueOnce(new CallError("network"));
    await conv.send("一");
    expect(conv.snapshot().turns[0]!.error?.type).toBe("network");
    invoker.invoke.mockResolvedValueOnce({ ok: true, strategy: "first", contract: "chat", output: {}, results: [] });
    await conv.retry();
    expect(conv.snapshot().turns[0]!.error?.type).toBe("badOutput");
    expect(conv.snapshot().pending).toBe(false);
  });

  it("refuses retry when the last turn neither failed nor gave up repairing", async () => {
    const { conv } = setup([reply({ message: "v1", draft: GOOD })]);
    await expect(conv.retry()).rejects.toThrow();
    await conv.send("一");
    await expect(conv.retry()).rejects.toThrow();
  });
});

describe("malformed replies", () => {
  it("a non-JSON reply becomes a plain message", async () => {
    const { conv } = setup(["你想在哪个网站上用？"]);
    await conv.send("一");
    expect(conv.snapshot().turns[0]!.reply).toEqual({ message: "你想在哪个网站上用？" });
    expect(conv.snapshot().current).toBe(0);
  });

  it("parses bare, fenced and surrounded JSON", () => {
    expect(parseReply('{"message":"好"}')).toEqual({ message: "好" });
    expect(parseReply(fenced({ message: "好", draft: GOOD }))).toEqual({ message: "好", draft: GOOD });
    expect(parseReply('我想好了 {"message":"好","askPick":{"text":"点给我看"}} 就这样')).toEqual({
      message: "好",
      askPick: { text: "点给我看" },
    });
  });

  it("tolerates loose shapes and drops what it cannot use", () => {
    expect(parseReply('{"message":"好","questions":["哪个网站？",{"text":"要先问吗？","quickReplies":["要",1,""]},{"x":1}],"askPick":"点一下"}')).toEqual({
      message: "好",
      questions: [{ text: "哪个网站？" }, { text: "要先问吗？", quickReplies: ["要"] }],
      askPick: { text: "点一下" },
    });
    expect(parseReply('{"draft":{"id":"a"}}')).toEqual({ message: "", draft: { id: "a" } });
    expect(parseReply('说明文字\n```json\n{"draft":{"id":"a"}}\n```')).toEqual({ message: "说明文字", draft: { id: "a" } });
  });

  it("broken or unrelated JSON stays a plain message", () => {
    expect(parseReply('{"message": "好", ')).toEqual({ message: '{"message": "好",' });
    expect(parseReply("[1, 2]")).toEqual({ message: "[1, 2]" });
    expect(parseReply('{"foo": 1}')).toEqual({ message: '{"foo": 1}' });
    expect(parseReply("  ")).toEqual({ message: "" });
  });
});

describe("serialisation (R6.8)", () => {
  it("round-trips through JSON and continues where it left off", async () => {
    const { conv, opts } = setup([
      reply({ message: "问一下", questions: [{ text: "哪个网站？", quickReplies: ["这个"] }] }),
      reply({ message: "v1", draft: GOOD }),
      reply({ message: "v2", draft: GOOD2 }),
      new CallError("timeout"),
    ]);
    await conv.send("一", ["<p>附件</p>"]);
    await conv.send("二");
    await conv.send("三");
    conv.select(1);
    await conv.send("四");
    const saved = JSON.parse(JSON.stringify(conv.toJSON()));
    const fake = fakeInvoker([reply({ message: "v3", draft: GOOD3 })]);
    const restored = fromJSON(saved, { ...opts, invoker: fake.invoker });
    const { pending: _p, ...was } = conv.snapshot();
    const { pending, ...now } = restored.snapshot();
    expect(pending).toBe(false);
    expect(now).toEqual(was);
    await restored.retry();
    expect(restored.snapshot().versions.map((v) => v.n)).toEqual([1, 2, 3]);
    expect(lastUser(fake.calls[0]!.messages).content).toContain(JSON.stringify(GOOD, null, 2));
  });

  it("saves an in-flight turn as stopped", async () => {
    const { conv, opts } = setup(["hang"]);
    const p = conv.send("一");
    const saved = conv.toJSON();
    conv.stop();
    await p;
    expect(fromJSON(JSON.parse(JSON.stringify(saved)), opts).snapshot().turns[0]!.status).toBe("stopped");
  });

  it("rejects data that is not a saved conversation", () => {
    const { opts } = setup([]);
    for (const bad of [null, 1, {}, { v: 1, turns: "x", versions: [], current: 0 }, { v: 1, turns: [], versions: [], current: 3 }]) {
      expect(() => fromJSON(bad, opts)).toThrow();
    }
  });
});
