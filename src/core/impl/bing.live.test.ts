/**
 * Live smoke test of the official Microsoft engine against the real Bing web translator.
 * Runs only when www.bing.com answers within a few seconds, and never under CI unless
 * LIVE_SMOKE=1, so offline runs and CI stay deterministic. Requests carry a browser
 * User-Agent, as GM_xmlhttpRequest does in the browser: Bing answers 401 to Node's default one.
 */
import { afterAll, describe, expect, it } from "vitest";
import { installFetchGm } from "../../../test/fakes/gm-http";
import { createStepCache, executeImpl } from "./index";
import { ctxFor, official, providerOf } from "./testkit";

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** installFetchGm, with the browser's User-Agent added to every request. */
function installBrowserFetchGm(): { restore(): void } {
  const gm = installFetchGm();
  const g =globalThis as { GM_xmlhttpRequest?: (d: { headers?: Record<string, string> }) => unknown };
  const send = g.GM_xmlhttpRequest!;
  g.GM_xmlhttpRequest = (d) => send({ ...d, headers: { "User-Agent": BROWSER_UA, ...d.headers } });
  return gm;
}

const optedOut = !!process.env.CI && process.env.LIVE_SMOKE !== "1";
const online = !optedOut && (await reachable("https://www.bing.com/translator"));

describe.skipIf(!online)("Bing (微软翻译) live smoke", () => {
  const gm = installBrowserFetchGm();
  afterAll(() => gm.restore());

  it("translates through the page token step and ttranslatev3, reusing the cached token", { timeout: 30_000 }, async () => {
    const r = official();
    const ms = providerOf(r, "official-translate/microsoft");
    const ctx = ctxFor(r, { stepCache: createStepCache() });
    const fail = (e: unknown) => {
      throw new Error(`${(e as { type?: string }).type}: ${(e as Error).message}`);
    };
    const zh = await executeImpl(ms, "translate", { texts: ["Good morning", "Thank you"], to: "zh-CN" }, ctx).catch(fail);
    const ja = await executeImpl(ms, "translate", { texts: ["Good morning"], from: "en", to: "ja" }, ctx).catch(fail);
    const texts = (zh as { texts: string[] }).texts;
    expect(texts).toHaveLength(2);
    for (const t of texts) expect(t).toMatch(/[一-鿿]/);
    expect((ja as { texts: string[] }).texts[0]).toMatch(/[぀-ヿ]/);
    expect(ctx.trace.filter((e) => e.type === "request" && e.step === "page")).toHaveLength(1);
  });
});
