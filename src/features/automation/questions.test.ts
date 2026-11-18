// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { elementOf, isElementHandle, renderTemplate, type PageHost } from "../../core/expr";
import { POSITIONS } from "../../core/rules/positions";
import { NO_QUESTIONS, questionFinders, type Question } from "./questions";

/** jsdom has no layout or innerText: text is textContent, hidden is the `hidden` attribute. */
const host: PageHost = {
  text: (el) => el.textContent ?? "",
  visible: (el) => !el.closest("[hidden]"),
};

const find = (): Question[] => questionFinders["auto:questions"](document.body, host);
const page = (html: string) => {
  document.body.innerHTML = html;
};
const $ = (sel: string) => document.querySelector(sel)!;
const summary = (qs: Question[]) => qs.map((q) => ({ no: q.no, stem: q.stem, kind: q.kind, options: q.options.map((o) => o.text) }));

beforeEach(() => page(""));

describe("auto:questions (R5.2)", () => {
  it("exports the not-found message and the finder name", () => {
    expect(NO_QUESTIONS).toBe("这一页没找到题目");
    expect(Object.keys(questionFinders)).toEqual(["auto:questions"]);
  });

  it("fieldset/legend: a radio group is a single choice, the legend is the stem", () => {
    page(`<form><fieldset id="q1"><legend>1. TCP 属于哪一层？</legend>
      <label><input type="radio" name="q1" value="a"> 网络层</label>
      <label><input type="radio" name="q1" value="b"> 传输层</label>
      <label><input type="radio" name="q1" value="c"> 应用层</label></fieldset></form>`);
    const qs = find();
    expect(summary(qs)).toEqual([{ no: 1, stem: "TCP 属于哪一层？", kind: "single", options: ["网络层", "传输层", "应用层"] }]);
    expect(elementOf(qs[0]!.handle)).toBe($("#q1"));
  });

  it("a checkbox group sharing a name is a multiple choice; option handles are the inputs, ids are letters", () => {
    page(`<fieldset><legend>第2题 下列哪些是 TCP 的特点？</legend>
      <label><input type="checkbox" name="q2"> 可靠</label>
      <label><input type="checkbox" name="q2"> 面向连接</label>
      <label><input type="checkbox" name="q2"> 无连接</label></fieldset>`);
    const [q] = find();
    expect(q).toMatchObject({ no: 2, stem: "下列哪些是 TCP 的特点？", kind: "multiple" });
    expect(q!.options.map((o) => o.id)).toEqual(["A", "B", "C"]);
    const inputs = Array.from(document.querySelectorAll("input"));
    expect(q!.options.map((o) => elementOf(o.handle))).toEqual(inputs);
    expect(q!.input).toBeUndefined();
    // what choose picks from (R5.3): every non-empty set of options, smallest first
    expect(q!.choices.map((c) => c.id)).toEqual(["A", "B", "C", "A、B", "A、C", "B、C", "A、B、C"]);
    expect(q!.choices[4]).toMatchObject({ id: "A、C", text: "可靠；无连接" });
    expect(q!.choices[4]!.handles.map(elementOf)).toEqual([inputs[0], inputs[2]]);
  });

  it("a single choice offers its options as the choices; a multiple choice with too many options offers them one by one", () => {
    page(`<fieldset><legend>1. 单选</legend>${["a", "b"].map((v) => `<label><input type="radio" name="s" value="${v}"> ${v}</label>`).join("")}</fieldset>
      <fieldset><legend>2. 多选</legend>${[..."abcdefg"].map((v) => `<label><input type="checkbox" name="m" value="${v}"> ${v}</label>`).join("")}</fieldset>`);
    const [single, many] = find();
    expect(single!.choices.map((c) => c.id)).toEqual(["A", "B"]);
    expect(many!.options).toHaveLength(7);
    expect(many!.choices.map((c) => c.id)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
  });

  it("an ordered list with labels: one question per item, numbered by position", () => {
    page(`<ol start="3">
      <li><p>三次握手的第二步是？</p>
        <label for="a1">SYN</label><input id="a1" type="radio" name="x1">
        <label for="a2">SYN+ACK</label><input id="a2" type="radio" name="x1"></li>
      <li><p>TCP 使用什么控制拥塞？</p>
        <ul><li><label><input type="radio" name="x2"> 滑动窗口</label></li><li><label><input type="radio" name="x2"> 慢启动</label></li></ul></li></ol>`);
    const qs = find();
    expect(summary(qs)).toEqual([
      { no: 3, stem: "三次握手的第二步是？", kind: "single", options: ["SYN", "SYN+ACK"] },
      { no: 4, stem: "TCP 使用什么控制拥塞？", kind: "single", options: ["滑动窗口", "慢启动"] },
    ]);
    expect(elementOf(qs[1]!.handle)).toBe(document.querySelectorAll("ol > li")[1]);
  });

  it("table based options, with the stem in a row above", () => {
    page(`<table><tbody>
      <tr><td colspan="2">1. 端口号有多少位？</td></tr>
      <tr><td><input type="radio" name="t1"></td><td>8 位</td></tr>
      <tr><td><input type="radio" name="t1"></td><td>16 位</td></tr>
      <tr><td colspan="2">2. UDP 可靠吗？</td></tr>
      <tr><td><input type="radio" name="t2"></td><td>可靠</td></tr>
      <tr><td><input type="radio" name="t2"></td><td>不可靠</td></tr></tbody></table>`);
    expect(summary(find())).toEqual([
      { no: 1, stem: "端口号有多少位？", kind: "single", options: ["8 位", "16 位"] },
      { no: 2, stem: "UDP 可靠吗？", kind: "single", options: ["可靠", "不可靠"] },
    ]);
  });

  it("a blank: a text input with the stem in the paragraph above, a textarea too", () => {
    page(`<div><p>3. HTTP 默认端口是什么？</p><input type="text" id="b1"></div>
      <div><h4>Q4 简述三次握手。</h4><textarea id="b2"></textarea></div>`);
    const qs = find();
    expect(summary(qs)).toEqual([
      { no: 3, stem: "HTTP 默认端口是什么？", kind: "blank", options: [] },
      { no: 4, stem: "简述三次握手。", kind: "blank", options: [] },
    ]);
    expect(elementOf(qs[0]!.input!)).toBe($("#b1"));
    expect(elementOf(qs[1]!.input!)).toBe($("#b2"));
    expect(elementOf(qs[0]!.handle)).toBe($("#b1").parentElement);
  });

  it("an inline blank takes the text before it in the same paragraph", () => {
    page(`<p>5. 1 + 1 = <input type="text"></p>`);
    expect(summary(find())).toEqual([{ no: 5, stem: "1 + 1 =", kind: "blank", options: [] }]);
  });

  it("mixed numbering: 1. / 第1题 / Q1 / (1) / none", () => {
    page(`<div><p>1. 甲</p><input type="text"></div>
      <div><p>第2题 乙</p><input type="text"></div>
      <div><p>Q3： 丙</p><input type="text"></div>
      <div><p>（4）丁</p><input type="text"></div>
      <div><p>没有题号的戊</p><input type="text"></div>`);
    expect(find().map((q) => [q.no, q.stem])).toEqual([
      [1, "甲"],
      [2, "乙"],
      [3, "丙"],
      [4, "丁"],
      [undefined, "没有题号的戊"],
    ]);
  });

  it("drops a kind badge after the number and caps the stem length", () => {
    page(`<div><p>1. <span>单选</span>${"长".repeat(500)}</p><input type="text"></div>`);
    const [q] = find();
    expect(q!.stem.startsWith("长")).toBe(true);
    expect(q!.stem.length).toBeLessThanOrEqual(200);
    expect(q!.stem.endsWith("…")).toBe(true);
  });

  it("a text input without any stem text, a lone checkbox and a lone radio are not questions", () => {
    page(`<input type="text" name="q"><label><input type="checkbox" name="agree"> 我同意</label>
      <p>性别</p><label><input type="radio" name="g"> 男</label>`);
    expect(find()).toEqual([]);
  });

  it("skips hidden questions and the cat's own UI", () => {
    page(`<fieldset hidden><legend>1. 隐藏题</legend><label><input type="radio" name="h"> 甲</label><label><input type="radio" name="h"> 乙</label></fieldset>
      <fieldset><legend>2. 看得见</legend><label><input type="radio" name="v"> 甲</label><label><input type="radio" name="v"> 乙</label></fieldset>
      <companion-cat><div><p>3. 小猫的题</p><input type="text"></div></companion-cat>
      <div data-cc-card=""><p>4. 卡片里的题</p><input type="text"></div>
      <div hidden><p>5. 隐藏填空</p><input type="text"></div>`);
    expect(find().map((q) => q.no)).toEqual([2]);
  });

  it("returns questions of every kind in document order", () => {
    page(`<div><p>1. 填空</p><input type="text"></div>
      <fieldset><legend>2. 单选</legend><label><input type="radio" name="a"> 甲</label><label><input type="radio" name="a"> 乙</label></fieldset>
      <p>3. 多选</p><div><label><input type="checkbox" name="b"> 甲</label><label><input type="checkbox" name="b"> 乙</label></div>
      <div><p>4. 填空</p><input type="text"></div>`);
    expect(find().map((q) => [q.no, q.kind])).toEqual([
      [1, "blank"],
      [2, "single"],
      [3, "multiple"],
      [4, "blank"],
    ]);
  });

  it("a page with no questions returns []", () => {
    page(`<h1>文章</h1><p>一些文字</p><button>提交</button>`);
    expect(find()).toEqual([]);
  });

  it("converts for CEL: expressions read plain fields and pass handles to page functions", async () => {
    page(`<fieldset><legend>1. 题</legend><label><input type="radio" name="a"> 甲</label><label><input type="radio" name="a"> 乙</label></fieldset>
      <div><p>2. 空</p><input type="text"></div>`);
    const qs = find();
    expect(qs.every((q) => isElementHandle(q.handle))).toBe(true);
    const scope = { settings: {}, page: { url: "https://q.test/", title: "Q" }, site: {}, vars: { qs } };
    const r = (t: string) => renderTemplate(t, scope, POSITIONS.autoRun);
    expect(await r("{{ vars.qs[0].no }}")).toBe(1);
    expect(await r("{{ vars.qs[0].kind }}")).toBe("single");
    expect(await r("{{ vars.qs[0].options[1].text }}")).toBe("乙");
    expect(await r("{{ vars.qs[1].kind == 'blank' }}")).toBe(true);
    expect(await r("{{ text(vars.qs[0].handle).contains('甲') }}")).toBe(true);
    expect(await r("{{ text(vars.qs[1].handle) }}")).toBe("2. 空");
    expect(await r("{{ vars.qs.map(q, q.stem) }}")).toEqual(["题", "空"]);
  });
});
