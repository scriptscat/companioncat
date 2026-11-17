import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { checkTemplate, position, renderTemplate } from "./index";

const POS = position("test", ["input", "settings", "page", "site", "options"]);
const run = (expr: string, scope: Record<string, unknown> = {}) => renderTemplate(`{{ ${expr} }}`, scope, POS);

describe("whitelisted functions (R8.1)", () => {
  it("only the whitelist and the standard macros can be called; other CEL library functions are refused", async () => {
    for (const expr of ["'a'.matches('a')", "'ab'.startsWith('a')", "int(1.5)", "type(input) == map", "string(1)", "'A'.lowerAscii()"]) {
      await expect(run(expr, { input: {} }), expr).rejects.toMatchObject({ code: "syntax", message: expect.stringContaining("白名单") });
      expect(checkTemplate(`{{ ${expr} }}`, POS), expr).toEqual([expect.objectContaining({ code: "syntax" })]);
    }
    await expect(run("[1, 2].map(x, x * 2).filter(x, x > 2).exists(x, x == 4) && [1].all(x, x > 0) && [1].exists_one(x, x == 1)")).resolves.toBe(true);
    await expect(run("has(input.a) || size(input) == 0", { input: {} })).resolves.toBe(true);
  });

  it("concat joins lists or strings", async () => {
    await expect(run("concat([1, 2], [3])")).resolves.toEqual([1, 2, 3]);
    await expect(run("concat('a', 'b')")).resolves.toBe("ab");
    await expect(run("concat(input.a, input.b)", { input: { a: ["x"], b: ["y"] } })).resolves.toEqual(["x", "y"]);
  });

  it("replace / split / join / contains work as globals and as methods", async () => {
    await expect(run("replace('a-b-c', '-', '+')")).resolves.toBe("a+b+c");
    await expect(run("'a-b'.replace('-', '')")).resolves.toBe("ab");
    await expect(run("split('a,b', ',')")).resolves.toEqual(["a", "b"]);
    await expect(run("join(['a', 'b'], '|')")).resolves.toBe("a|b");
    await expect(run("join(['a', 'b'])")).resolves.toBe("ab");
    await expect(run("['a', 'b'].join('-')")).resolves.toBe("a-b");
    await expect(run("contains('hello', 'ell')")).resolves.toBe(true);
    await expect(run("contains(['a', 'b'], 'c')")).resolves.toBe(false);
    await expect(run("page.url.contains('/blob/')", { page: { url: "https://x/blob/y" } })).resolves.toBe(true);
  });

  it("urlencode encodes strings and maps", async () => {
    await expect(run("urlencode('a b&c=中')")).resolves.toBe("a%20b%26c%3D%E4%B8%AD");
    await expect(run("urlencode({'q': 'a b', 'n': 1, 'l': ['x', 'y']})")).resolves.toBe("q=a%20b&n=1&l=x&l=y");
  });

  it("base64 and hex encode strings (UTF-8) and bytes", async () => {
    await expect(run("base64('中a')")).resolves.toBe(Buffer.from("中a").toString("base64"));
    await expect(run("base64(b'hi')")).resolves.toBe("aGk=");
    await expect(run("hex('hi')")).resolves.toBe("6869");
    await expect(run("hex(b'\\xff')")).resolves.toBe("ff");
  });

  it("md5 / sha256 / hmacSha256 return hex by default, base64 or bytes on request", async () => {
    const md5 = createHash("md5").update("中a").digest("hex");
    const sha = createHash("sha256").update("abc").digest();
    const hmac = createHmac("sha256", "key").update("data").digest();
    await expect(run("md5('中a')")).resolves.toBe(md5);
    await expect(run("md5('x', 'base64')")).resolves.toBe(createHash("md5").update("x").digest("base64"));
    await expect(run("sha256('abc')")).resolves.toBe(sha.toString("hex"));
    await expect(run("sha256('abc', 'base64')")).resolves.toBe(sha.toString("base64"));
    await expect(run("hmacSha256('key', 'data')")).resolves.toBe(hmac.toString("hex"));
    await expect(run("hmacSha256('key', 'data', 'base64')")).resolves.toBe(hmac.toString("base64"));
    // chained HMAC (e.g. TC3 signing) keys on raw bytes
    const inner = createHmac("sha256", "k").update("d1").digest();
    const outer = createHmac("sha256", inner).update("d2").digest("hex");
    await expect(run("hmacSha256(hmacSha256('k', 'd1', 'bytes'), 'd2')")).resolves.toBe(outer);
    await expect(run("sha256('a', 'nope')")).rejects.toMatchObject({ code: "runtime" });
  });

  it("now / unix return the clock in ms / seconds as numbers", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-02T03:04:05.678Z"), toFake: ["Date"] });
    try {
      await expect(run("now()")).resolves.toBe(Date.parse("2026-01-02T03:04:05.678Z"));
      await expect(run("unix()")).resolves.toBe(Math.floor(Date.parse("2026-01-02T03:04:05.678Z") / 1000));
    } finally {
      vi.useRealTimers();
    }
  });

  it("uuid returns a v4 uuid; random returns a double or an inclusive int", async () => {
    await expect(run("uuid()")).resolves.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const d = (await run("random()")) as number;
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThan(1);
    const ints = await Promise.all(Array.from({ length: 50 }, () => run("random(1, 3)")));
    for (const n of ints) expect([1, 2, 3]).toContain(n);
  });

  it("json stringifies; extractJson parses the first JSON value out of text", async () => {
    await expect(run("json(input.texts)", { input: { texts: ["Hello, world"] } })).resolves.toBe('["Hello, world"]');
    await expect(run("json({'n': 1})")).resolves.toBe('{"n":1}');
    await expect(run("extractJson(input.s)", { input: { s: 'Sure!\n```json\n{"texts": ["你好"], "n": 2}\n```' } })).resolves.toEqual({
      texts: ["你好"],
      n: 2,
    });
    await expect(run("extractJson('[1, {\"a\": \"]\"}] trailing')")).resolves.toEqual([1, { a: "]" }]);
    await expect(run("extractJson(input.s).n + 1", { input: { s: '{"n": 2}' } })).resolves.toBe(3);
    await expect(run("extractJson('no json here')")).rejects.toMatchObject({ code: "runtime" });
  });

  it("langName / languages / lang use the shared language list", async () => {
    await expect(run("langName('zh-CN')")).resolves.toBe("简体中文");
    // R10.1: card headers read 英语 → 简体中文, so langName gives the Chinese name
    await expect(run("langName('en')")).resolves.toBe("英语");
    await expect(run("langName('ja')")).resolves.toBe("日语");
    await expect(run("langName('auto')")).resolves.toBe("自动检测");
    await expect(run("languages()")).resolves.toContainEqual({ value: "en", label: "English" });
    await expect(run("lang('こんにちは')")).resolves.toBe("ja");
  });

  it("host extracts the hostname; bad URLs fail", async () => {
    await expect(run("host(options.baseUrl)", { options: { baseUrl: "https://api.deepseek.com/v1" } })).resolves.toBe("api.deepseek.com");
    await expect(run("host('not a url')")).rejects.toMatchObject({ code: "runtime" });
  });

  it("match returns the first match's capture groups, or an empty list", async () => {
    const page = { input: { s: 'x IG:"AB12" y; var h = [1794880713455,"tok_-1",3600000]; IG:"FFFF"' } };
    await expect(run(`match(input.s, 'IG:"([0-9A-F]+)"')`, page)).resolves.toEqual(["AB12"]);
    await expect(run(`match(input.s, 'h = [[]([0-9]+),"([^"]+)"')`, page)).resolves.toEqual(["1794880713455", "tok_-1"]);
    await expect(run(`match(input.s, 'h = [[]([0-9]+),"([^"]+)"')[1]`, page)).resolves.toBe("tok_-1");
    await expect(run("match('abc', 'z(.)')")).resolves.toEqual([]);
    await expect(run("size(match('abc', 'z(.)')) == 0")).resolves.toBe(true);
    // a group that did not take part in the match is an empty string; no groups -> empty list
    await expect(run("match('ac', 'a(b)?(c)')")).resolves.toEqual(["", "c"]);
    await expect(run("match('abc', 'b')")).resolves.toEqual([]);
    await expect(run(String.raw`match('a1b22', r'(\d+)\D(\d+)')`)).resolves.toEqual(["1", "22"]);
  });

  it("match rejects invalid regexes, regexes over 200 chars and input over 1 MB", async () => {
    await expect(run("match('abc', '(')")).rejects.toMatchObject({ code: "runtime", message: expect.stringContaining("正则") });
    const re200 = `(${"a".repeat(198)})`;
    await expect(run(`match(input.s, '${re200}')`, { input: { s: "a".repeat(198) } })).resolves.toEqual(["a".repeat(198)]);
    await expect(run(`match('a', '${re200}a')`)).rejects.toMatchObject({ code: "runtime", message: expect.stringContaining("200") });
    const mb = 1024 * 1024;
    await expect(run("size(match(input.s, '(b)$'))", { input: { s: `${"a".repeat(mb - 1)}b` } })).resolves.toBe(1);
    await expect(run("match(input.s, '(b)')", { input: { s: `${"a".repeat(mb)}b` } })).rejects.toMatchObject({
      code: "runtime",
      message: expect.stringContaining("1 MB"),
    });
    await expect(run("match(1, 'a')")).rejects.toMatchObject({ code: "syntax" });
  });

  it("match refuses regexes that can backtrack exponentially, and keeps the safe ones", async () => {
    const s = `${"a".repeat(40)}!`;
    for (const re of ["^(a+)+$", "(a*)*b", "(a|a)*b", "(a|aa)+$", "(?:a+){2,}$", "(a{1,3})+$", String.raw`(\w+\s?)+$`, String.raw`(a)\1`, String.raw`(?<x>a)\k<x>`]) {
      const t0 = performance.now();
      await expect(run("match(input.s, input.re)", { input: { s, re } }), re).rejects.toMatchObject({
        code: "runtime",
        message: expect.stringContaining("回溯"),
      });
      expect(performance.now() - t0, re).toBeLessThan(500);
    }
    // the official translate pack's patterns, plain classes and non-repeated groups stay allowed
    const page = { input: { s: 'IG:"AB12" params_AbusePreventionHelper = [17948,"tok"' } };
    await expect(run(`match(input.s, 'IG:"([0-9A-Fa-f]+)"')`, page)).resolves.toEqual(["AB12"]);
    await expect(run(`match(input.s, 'params_AbusePreventionHelper *= *[[]([0-9]+),"([^"]+)"')`, page)).resolves.toEqual(["17948", "tok"]);
    await expect(run(String.raw`match('ab-ab', r'((?:ab)+)-([(+)]*)')`)).resolves.toEqual(["ab", ""]);
    await expect(run(String.raw`match('x1', r'(a|x)(\d)?')`)).resolves.toEqual(["x", "1"]);
    await expect(run(String.raw`match('a+b', r'(a\+b)+')`)).resolves.toEqual(["a+b"]);
  });

  it("string results over the text limit fail before they are built", async () => {
    const s = "x".repeat(2000);
    const t0 = performance.now();
    await expect(run("size(replace(input.s, '', input.s))", { input: { s } })).rejects.toMatchObject({ code: "runtime", message: expect.stringContaining("1 MB") });
    await expect(run("size(input.s.replace('x', input.s))", { input: { s } })).rejects.toMatchObject({ code: "runtime" });
    const half = "y".repeat(600 * 1024);
    await expect(run("size(concat(input.s, input.s))", { input: { s: half } })).rejects.toMatchObject({ code: "runtime" });
    await expect(run("size(join([input.s, input.s], ','))", { input: { s: half } })).rejects.toMatchObject({ code: "runtime" });
    await expect(run("size(split(input.s, ''))", { input: { s: `${half}${half}` } })).rejects.toMatchObject({ code: "runtime" });
    expect(performance.now() - t0).toBeLessThan(1500);
    await expect(run("replace('aXbX', 'X', '--')")).resolves.toBe("a--b--");
    await expect(run("size(concat(input.s, 'z'))", { input: { s: half } })).resolves.toBe(600 * 1024 + 1);
  });

  it("extractJson stays fast on unbalanced brackets and refuses text over the limit", async () => {
    const t0 = performance.now();
    // a slow host may also hit the 50 ms budget; either way it ends quickly instead of running for seconds
    const failed = { code: expect.stringMatching(/^(runtime|timeout)$/) };
    await expect(run("extractJson(input.s)", { input: { s: "{".repeat(40_000) } })).rejects.toMatchObject(failed);
    await expect(run("extractJson(input.s)", { input: { s: '{"a":1'.repeat(20_000) } })).rejects.toMatchObject(failed);
    expect(performance.now() - t0).toBeLessThan(1500);
    await expect(run("extractJson(input.s)", { input: { s: `${"x".repeat(1024 * 1024)}{}` } })).rejects.toMatchObject({
      code: "runtime",
      message: expect.stringContaining("1 MB"),
    });
    await expect(run("extractJson(input.s)", { input: { s: '[ {"a": 1 junk ] then {"b": 2}' } })).resolves.toEqual({ b: 2 });
  });

  it("has / size and standard macros are available", async () => {
    await expect(run("has(site.blocks) ? site.blocks : 'auto'", { site: {} })).resolves.toBe("auto");
    await expect(run("size(input.l)", { input: { l: [1, 2] } })).resolves.toBe(2);
    await expect(run("input.l.map(b, b.text)", { input: { l: [{ text: "a" }, { text: "b" }] } })).resolves.toEqual(["a", "b"]);
    await expect(run("input.l.filter(x, x > 1).size()", { input: { l: [1, 2, 3] } })).resolves.toBe(2);
  });

  it("offers nothing outside the whitelist and no host object properties", async () => {
    for (const expr of ["fetch('x')", "document()", "eval('1')", "localStorage()"]) {
      await expect(run(expr)).rejects.toMatchObject({ code: "syntax" });
    }
    await expect(run("settings.constructor", { settings: {} })).rejects.toMatchObject({ code: "runtime" });
    await expect(run("settings.__proto__", { settings: {} })).rejects.toMatchObject({ code: "runtime" });
  });
});
