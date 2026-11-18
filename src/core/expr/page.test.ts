// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  BASE_FUNCTIONS,
  checkTemplate,
  elementHandle,
  ElementHandle,
  elementOf,
  ExprError,
  PAGE_FUNCTIONS,
  type PageHost,
  position,
  renderTemplate,
} from "./index";

/** jsdom has no layout or innerText: text is textContent, hidden is the `hidden` attribute. */
const host: PageHost = {
  text: (el) => el.textContent ?? "",
  visible: (el) => !el.closest("[hidden]"),
};

const AUTO = position("自动化 run", ["vars", "trigger"], [...BASE_FUNCTIONS, ...PAGE_FUNCTIONS]);
const PHASE1 = position("功能 run", ["settings", "vars", "selection", "page", "site"]);

let player: Element;
let skip: Element;

beforeEach(() => {
  document.body.innerHTML = `
    <div class="player" id="p">
      <button class="skip" aria-label="跳过广告">  跳过
        广告 </button>
      <button class="mute" hidden>静音</button>
      <a href="/next" title="下一集">下一集</a>
    </div>`;
  player = document.querySelector(".player")!;
  skip = document.querySelector(".skip")!;
});

const vars = () => ({ player: elementHandle(player, host), skip: elementHandle(skip, host) });
const run = (tpl: unknown, scope: Record<string, unknown> = { vars: vars() }) => renderTemplate(tpl, scope, AUTO);

describe("page functions on element handles (R1.4)", () => {
  it("text, attr, visible, closest and within read the page", async () => {
    expect(await run("{{ text(vars.skip) }}")).toBe("跳过 广告");
    expect(await run("{{ attr(vars.skip, 'aria-label') }}")).toBe("跳过广告");
    expect(await run("{{ attr(vars.skip, 'data-none') }}")).toBe("");
    expect(await run("{{ within(vars.player, 'button').map(b, visible(b)) }}")).toEqual([true, false]);
    expect(await run("{{ closest(vars.skip, '.player') == vars.player }}")).toBe(true);
    expect(await run("{{ closest(vars.skip, '.nowhere') == null }}")).toBe(true);
    expect(await run("{{ size(within(vars.player, 'a, button')) }}")).toBe(3);
  });

  it("returns handles that act targets can unwrap, one handle per element", async () => {
    const [first] = (await run("{{ within(vars.player, 'button') }}")) as unknown[];
    expect(first).toBeInstanceOf(ElementHandle);
    expect(elementOf(first as ElementHandle)).toBe(skip);
    expect(elementHandle(skip, host)).toBe(elementHandle(skip, host));
    expect(await run("{{ within(vars.player, '.skip')[0] == vars.skip }}")).toBe(true);
  });

  it("describe gives a short human phrase", async () => {
    expect(await run("{{ describe(vars.skip) }}")).toBe("「跳过广告」按钮");
    expect(await run("{{ describe(within(vars.player, 'a')[0]) }}")).toBe("「下一集」链接");
    document.body.innerHTML = `<input type="text" placeholder="你的名字" value="王小明"><div></div>`;
    const input = elementHandle(document.querySelector("input")!, host);
    const div = elementHandle(document.querySelector("div")!, host);
    expect(await run("{{ describe(vars.input) }}", { vars: { input } })).toBe("「你的名字」输入框");
    expect(await run("{{ describe(vars.div) }}", { vars: { div } })).toBe("元素");
  });

  it("reports an invalid selector as a runtime error", async () => {
    // jsdom's first selector error is slow to build; keep that out of the 50 ms budget
    expect(() => document.querySelector("[[")).toThrow();
    await expect(run("{{ within(vars.player, '[[') }}")).rejects.toMatchObject({ code: "runtime" });
  });

  it("reads the trigger variable", async () => {
    const trigger = { on: "appear", element: elementHandle(skip, host) };
    expect(await run("{{ text(trigger.element) }}", { trigger })).toBe("跳过 广告");
  });
});

describe("page functions outside automation (R1.4, R1.7)", () => {
  it("are a positioned syntax error in phase-1 positions", () => {
    const tpl = "x {{ size(text(vars.skip)) }}";
    const [e, ...rest] = checkTemplate(tpl, PHASE1);
    expect(rest).toEqual([]);
    expect(e).toBeInstanceOf(ExprError);
    expect(e).toMatchObject({ code: "syntax" });
    expect(tpl.slice(e!.start, e!.end)).toBe("text(vars.skip)");
    expect(e!.message).toContain("text()");
    expect(e!.message).toContain("功能 run");
    for (const fn of PAGE_FUNCTIONS) {
      expect(checkTemplate(`{{ ${fn}(vars.a, 'b') }}`, PHASE1)).toEqual([expect.objectContaining({ code: "syntax" })]);
    }
  });

  it("refuses them at render time too, and the trigger variable elsewhere", async () => {
    await expect(renderTemplate("{{ text(vars.skip) }}", { vars: vars() }, PHASE1)).rejects.toMatchObject({ code: "syntax" });
    expect(checkTemplate("{{ trigger.on }}", PHASE1)).toEqual([
      expect.objectContaining({ code: "syntax", message: "变量 trigger 不能在「功能 run」里使用" }),
    ]);
  });

  it("keeps exactly the phase-1 functions in a default position", () => {
    expect(PHASE1.functions).toEqual(new Set(BASE_FUNCTIONS));
    expect(checkTemplate("{{ size(vars.a) > 0 && contains('ab', 'a') }}", PHASE1)).toEqual([]);
  });
});

describe("element handles are opaque (R1.4)", () => {
  it("have no fields, cannot be built from CEL and expose nothing to JS", () => {
    const h = elementHandle(skip, host);
    expect(Object.keys(h)).toEqual([]);
    expect(Object.getOwnPropertyNames(h)).toEqual([]);
    expect(Object.getOwnPropertySymbols(h)).toEqual([]);
    expect(() => new (ElementHandle as unknown as new (el: Element) => unknown)(skip)).toThrow();
    expect(checkTemplate("{{ text(Element{}) }}", AUTO)).toEqual([expect.objectContaining({ code: "syntax" })]);
  });

  it.each([
    "{{ vars.skip.textContent }}",
    "{{ vars.skip.constructor }}",
    "{{ vars.skip['__proto__'] }}",
    "{{ vars.skip.outerHTML }}",
    "{{ json(vars.skip) }}",
    "{{ json({'a': [vars.skip]}) }}",
    "{{ join([vars.skip], ',') }}",
    "{{ urlencode({'a': vars.skip}) }}",
    "点击 {{ vars.skip }}",
    "{{ text(vars.player.firstElementChild) }}",
  ])("refuses %s at run time", async (tpl) => {
    await expect(run(tpl)).rejects.toMatchObject({ name: "ExprError", code: "runtime" });
  });

  it.each(["{{ text('<b>x</b>') }}", "{{ string(vars.skip) }}", "{{ vars.skip + 'x' == 'x' }}", "{{ type(vars.skip) }}"])(
    "refuses %s",
    async (tpl) => {
      await expect(run(tpl)).rejects.toBeInstanceOf(ExprError);
    },
  );
});

describe("outline (R1.4, R9.2)", () => {
  const FORM = `
    <form class="quiz">
      <label for="n">姓名</label>
      <input id="n" name="who" type="text" placeholder="写名字" value="ATTR-SECRET">
      <input type="password" value="PW-SECRET">
      <input type="hidden" name="token" value="HIDDEN-SECRET">
      <textarea placeholder="说点什么">AREA-SECRET</textarea>
      <select name="pick"><option value="OPT-SECRET-A">甲</option><option value="OPT-SECRET-B" selected>乙</option></select>
      <input type="checkbox" value="BOX-SECRET" checked> 同意
      <script>SCRIPT-SECRET</script>
      <p>第一题：1 + 1 = ?</p>
    </form>`;

  it("has tags, text and safe attributes, and never an input's value", async () => {
    document.body.innerHTML = FORM;
    const form = document.querySelector("form")!;
    (form.querySelector("#n") as HTMLInputElement).value = "TYPED-SECRET";
    (form.querySelector("textarea") as HTMLTextAreaElement).value = "TYPED-AREA-SECRET";
    const out = (await run("{{ outline(vars.form, 2000) }}", { vars: { form: elementHandle(form, host) } })) as string;
    expect(out).toContain('<form class="quiz">');
    expect(out).toContain('placeholder="写名字"');
    expect(out).toContain("<label");
    expect(out).toContain("姓名");
    expect(out).toContain("甲");
    expect(out).toContain("第一题：1 + 1 = ?");
    expect(out).not.toMatch(/SECRET|value=|selected|checked/);
  });

  it("attr and text never read a field's value either (R9.2)", async () => {
    document.body.innerHTML = FORM;
    const vars = {
      text: elementHandle(document.querySelector("#n")!, host),
      pw: elementHandle(document.querySelector("[type=password]")!, host),
      hidden: elementHandle(document.querySelector("[type=hidden]")!, host),
      area: elementHandle(document.querySelector("textarea")!, host),
      pick: elementHandle(document.querySelector("select")!, host),
    };
    for (const name of ["text", "pw", "hidden", "area", "pick"])
      for (const a of ["value", "VALUE"])
        await expect(run(`{{ attr(vars.${name}, '${a}') }}`, { vars })).rejects.toMatchObject({ code: "runtime", message: expect.not.stringMatching(/SECRET/) });
    expect(await run("{{ attr(vars.text, 'placeholder') }}", { vars })).toBe("写名字");
    expect(await run("{{ text(vars.area) }}", { vars })).toBe("");
    expect(await run("{{ text(vars.text) }}", { vars })).toBe("");
  });

  it("stays within n characters", async () => {
    document.body.innerHTML = FORM;
    const form = elementHandle(document.querySelector("form")!, host);
    for (const n of [0, 5, 20, 60, 120]) {
      const out = (await run(`{{ outline(vars.form, ${n}) }}`, { vars: { form } })) as string;
      expect(out.length).toBeLessThanOrEqual(n);
      expect(out).not.toMatch(/SECRET/);
    }
    expect(((await run("{{ outline(vars.form, 60) }}", { vars: { form } })) as string).startsWith("<form")).toBe(true);
    await expect(run("{{ outline(vars.form, -1) }}", { vars: { form } })).rejects.toMatchObject({ code: "runtime" });
  });
});

describe("page functions and the 50 ms budget (R8.4)", () => {
  it("charges a slow page function like any native call", async () => {
    const slow: PageHost = {
      ...host,
      text: (el) => {
        const end = performance.now() + 80;
        while (performance.now() < end) {
          // busy
        }
        return el.textContent ?? "";
      },
    };
    const scope = { vars: { skip: elementHandle(skip, slow) } };
    await expect(renderTemplate("{{ text(vars.skip) }}", scope, AUTO)).rejects.toMatchObject({ code: "timeout" });
    expect(await renderTemplate("{{ attr(vars.skip, 'class') }}", scope, AUTO)).toBe("skip");
  });
});
