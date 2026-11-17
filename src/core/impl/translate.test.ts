import { afterEach, describe, expect, it } from "vitest";
import { installGmHttp, recording, type FakeGm, type SentRequest } from "../../../test/fakes/gm-http";
import { createStepCache, executeImpl } from "./index";
import { ctxFor, official, providerOf, testProvider } from "./testkit";

let fake: FakeGm | undefined;
afterEach(() => {
  expect(fake?.unmatched ?? []).toEqual([]);
  fake?.restore();
  fake = undefined;
});

const rules = official();
const google = providerOf(rules, "official-translate/google");
const microsoft = providerOf(rules, "official-translate/microsoft");

describe("Google (R5.2 json response, join batch)", () => {
  it("joins texts into one request and splits the translation back", async () => {
    fake = installGmHttp(recording("google-translate"));
    const out = await executeImpl(google, "translate", { texts: ["Hello, world", "Good morning"], to: "zh-CN" }, ctxFor(rules));
    expect(out).toEqual({ texts: ["你好，世界", "早上好"] });
    expect(fake.calls).toHaveLength(1);
  });

  it("passes the source language through", async () => {
    fake = installGmHttp(recording("google-translate"));
    const out = await executeImpl(google, "translate", { texts: ["Good morning"], from: "en", to: "ja" }, ctxFor(rules));
    expect(out).toEqual({ texts: ["おはよう"] });
  });
});

describe("Microsoft via the Bing web translator (R5.2 steps with cache, match, form body, langMap, errors)", () => {
  const PAGE = "https://www.bing.com/translator";
  const API = "https://www.bing.com/ttranslatev3?isVertical=1&IG=499CA6CF7EF54C87AB09328325CCE329&IID=translator.5028";
  const KEY = "1794880939726";
  const TOKEN = "T7zGFZuLvBM6bmm4rjL2fy0DiWPNjo20";
  const form = (req: SentRequest) => Object.fromEntries(new URLSearchParams(req.data));
  const [page, zh, ja, badToken, badLang, rejected] = recording("microsoft-translate");

  it("reads IG / key / token from the page once, posts forms and reuses the cached step", async () => {
    fake = installGmHttp([page!, zh!, ja!]);
    const ctx = ctxFor(rules, { stepCache: createStepCache() });
    const a = await executeImpl(microsoft, "translate", { texts: ["Hello, world", "Good morning"], to: "zh-CN" }, ctx);
    const b = await executeImpl(microsoft, "translate", { texts: ["Good morning"], from: "en", to: "ja" }, ctx);
    expect(a).toEqual({ texts: ["你好，世界", "早上好"] });
    expect(b).toEqual({ texts: ["おはようございます"] });
    expect(fake.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${PAGE}`, `POST ${API}`, `POST ${API}`]);
    expect(form(fake.calls[1]!)).toEqual({ fromLang: "auto-detect", to: "zh-Hans", text: "Hello, world\nGood morning", token: TOKEN, key: KEY });
    expect(form(fake.calls[2]!)).toEqual({ fromLang: "en", to: "ja", text: "Good morning", token: TOKEN, key: KEY });
    expect(fake.calls[1]!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(ctx.trace).toContainEqual(expect.objectContaining({ type: "cache", step: "page", hit: true }));
  });

  it("fetches the page again once the 600 s cache entry expires", async () => {
    fake = installGmHttp([page!, { ...ja!, repeat: true }, page!]);
    let now = 1_000_000;
    const ctx = ctxFor(rules, { stepCache: createStepCache(() => now) });
    const input = { texts: ["Good morning"], from: "en", to: "ja" };
    await executeImpl(microsoft, "translate", input, ctx);
    now += 599_000;
    await executeImpl(microsoft, "translate", input, ctx);
    expect(fake.calls.filter((c) => c.url === PAGE)).toHaveLength(1);
    now += 2_000;
    await executeImpl(microsoft, "translate", input, ctx);
    expect(fake.calls.filter((c) => c.url === PAGE)).toHaveLength(2);
  });

  it("maps auto, zh-CN and zh-TW to Bing's codes", async () => {
    fake = installGmHttp([{ ...page!, repeat: true }, { ...zh!, repeat: true }]);
    await executeImpl(microsoft, "translate", { texts: ["Hello, world", "Good morning"], from: "auto", to: "zh-CN" }, ctxFor(rules));
    await expect(
      executeImpl(microsoft, "translate", { texts: ["Hello, world", "Good morning"], from: "zh-TW", to: "zh-CN" }, ctxFor(rules)),
    ).resolves.toEqual({ texts: ["你好，世界", "早上好"] });
    expect(form(fake.calls[1]!)).toMatchObject({ fromLang: "auto-detect", to: "zh-Hans" });
    expect(form(fake.calls[3]!)).toMatchObject({ fromLang: "zh-Hant", to: "zh-Hans" });
  });

  it("splits texts over 1000 characters into separate requests", async () => {
    const long = "a".repeat(998);
    fake = installGmHttp([page!, { method: "POST", url: API, repeat: true, respond: (req) => ({ json: [{ translations: [{ text: form(req).text!.toUpperCase() }] }] }) }]);
    const out = await executeImpl(microsoft, "translate", { texts: [long, "bb", "cc"], to: "ja" }, ctxFor(rules, { stepCache: createStepCache() }));
    expect(out).toEqual({ texts: [long.toUpperCase(), "BB", "CC"] });
    expect(fake.calls.slice(1).map((c) => form(c).text)).toEqual([long, "bb\ncc"]);
  });

  it("reports a rejected token (statusCode 205) as auth and a bad language (statusCode 400) as badInput", async () => {
    fake = installGmHttp([page!, badToken!]);
    const input = { texts: ["Good morning"], from: "en", to: "ja" };
    await expect(executeImpl(microsoft, "translate", input, ctxFor(rules))).rejects.toMatchObject({
      type: "auth",
      message: expect.stringContaining("token"),
    });
    fake.restore();
    fake = installGmHttp([page!, badLang!]);
    await expect(executeImpl(microsoft, "translate", { ...input, to: "xx" }, ctxFor(rules))).rejects.toMatchObject({ type: "badInput" });
  });

  it("fails as badOutput without caching when the page carries no token", async () => {
    const blocked = { ...page!, body: "<html><body>captcha</body></html>" };
    fake = installGmHttp([blocked, page!, ja!]);
    const ctx = ctxFor(rules, { stepCache: createStepCache() });
    const input = { texts: ["Good morning"], from: "en", to: "ja" };
    await expect(executeImpl(microsoft, "translate", input, ctx)).rejects.toMatchObject({ type: "badOutput" });
    await expect(executeImpl(microsoft, "translate", input, ctx)).resolves.toEqual({ texts: ["おはようございます"] });
    expect(fake.calls.filter((c) => c.url === PAGE)).toHaveLength(2);
  });

  it("reports a rejected request (401 with ShowCaptcha false) as auth and a captcha demand as rateLimit", async () => {
    const input = { texts: ["Good morning"], from: "en", to: "ja" };
    fake = installGmHttp([page!, rejected!]);
    await expect(executeImpl(microsoft, "translate", input, ctxFor(rules))).rejects.toMatchObject({ type: "auth" });
    fake.restore();
    fake = installGmHttp([page!, { method: "POST", url: API, json: { ShowCaptcha: true } }]);
    await expect(executeImpl(microsoft, "translate", input, ctxFor(rules))).rejects.toMatchObject({ type: "rateLimit" });
  });

  it("maps HTTP 429 and 5xx to rateLimit and server", async () => {
    const input = { texts: ["Good morning"], from: "en", to: "ja" };
    for (const [status, type] of [
      [429, "rateLimit"],
      [503, "server"],
    ] as const) {
      fake?.restore();
      fake = installGmHttp([page!, { method: "POST", url: API, status, body: "" }]);
      await expect(executeImpl(microsoft, "translate", input, ctxFor(rules))).rejects.toMatchObject({ type });
    }
  });
});

/** An engine whose service upper-cases every text it gets. */
function echo(batch: { maxItems?: number; maxChars?: number; join?: string }) {
  const join = batch.join !== undefined;
  const provider = testProvider({
    id: "echo",
    hosts: ["echo.test"],
    implements: {
      translate: {
        http: {
          batch,
          request: { method: "POST", url: "https://echo.test/t", json: { texts: "{{ input.texts }}" } },
          response: "json",
          output: { texts: join ? "{{ [response.texts[0]] }}" : "{{ response.texts }}" },
        },
      },
    },
  });
  const respond = (req: SentRequest) => ({
    json: { texts: (JSON.parse(req.data!) as { texts: string[] }).texts.map((t) => t.toUpperCase()) },
  });
  fake = installGmHttp([{ url: "https://echo.test/t", repeat: true, respond }]);
  const sent = () => fake!.calls.map((c) => (JSON.parse(c.data!) as { texts: string[] }).texts);
  return { provider, sent };
}

describe("batch (R5.2)", () => {
  it("splits by maxItems", async () => {
    const { provider, sent } = echo({ maxItems: 2 });
    const out = await executeImpl(provider, "translate", { texts: ["a", "b", "c"], to: "x" }, ctxFor(rules));
    expect(out).toEqual({ texts: ["A", "B", "C"] });
    expect(sent()).toEqual([["a", "b"], ["c"]]);
  });

  it("splits by maxChars and sends an over-long text on its own", async () => {
    const { provider, sent } = echo({ maxChars: 8 });
    const out = await executeImpl(provider, "translate", { texts: ["aaaa", "bbbb", "cc", "dddddddddd", "e"], to: "x" }, ctxFor(rules));
    expect(out).toEqual({ texts: ["AAAA", "BBBB", "CC", "DDDDDDDDDD", "E"] });
    expect(sent()).toEqual([["aaaa", "bbbb"], ["cc"], ["dddddddddd"], ["e"]]);
  });

  it("joins within maxChars (counting separators) and splits each reply back", async () => {
    const { provider, sent } = echo({ join: "\n", maxChars: 5 });
    const out = await executeImpl(provider, "translate", { texts: ["aa", "bb", "cc"], to: "x" }, ctxFor(rules));
    expect(out).toEqual({ texts: ["AA", "BB", "CC"] });
    expect(sent()).toEqual([["aa\nbb"], ["cc"]]);
  });

  it("never joins a text that already contains the separator", async () => {
    const { provider, sent } = echo({ join: "\n" });
    const out = await executeImpl(provider, "translate", { texts: ["a", "b\nc", "d"], to: "x" }, ctxFor(rules));
    expect(out).toEqual({ texts: ["A", "B\nC", "D"] });
    expect(sent()).toEqual([["a"], ["b\nc"], ["d"]]);
  });

  it("fails as badOutput when a joined reply splits into the wrong count", async () => {
    const provider = testProvider({
      id: "short",
      hosts: ["echo.test"],
      implements: {
        translate: {
          http: {
            batch: { join: "\n" },
            request: { url: "https://echo.test/t" },
            response: "json",
            output: { texts: "{{ [response.text] }}" },
          },
        },
      },
    });
    fake = installGmHttp([{ url: "https://echo.test/t", json: { text: "only one line" } }]);
    await expect(executeImpl(provider, "translate", { texts: ["a", "b"], to: "x" }, ctxFor(rules))).rejects.toMatchObject({
      type: "badOutput",
    });
  });
});
