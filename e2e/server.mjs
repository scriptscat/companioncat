/**
 * The E2E fake services: test pages (one under a strict CSP), the test rule pack and three fake
 * translators. Every request is logged so scenarios can prove what did, and did not, reach it.
 *
 *   node e2e/server.mjs [port]      — standalone
 *   import { startServer } from "./server.mjs"
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeLlm } from "./llm.mjs";
import { testPack } from "./pack.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const E2E_KEY = "e2e-fake-key-0123456789";
/** No unsafe-eval, no unsafe-inline, nothing from other origins (R13.1). */
export const STRICT_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";

export function startServer(port = 4719) {
  const state = { packVersion: 1, failB: false, failPack: false, delayMs: 0, failPage: 0 };
  const log = [];

  const send = (res, status, body, headers = {}) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json", "cache-control": "no-store", ...headers });
    res.end(text);
  };
  const page = (name) => readFileSync(path.join(DIR, "pages", name), "utf8");
  const readBody = (req) =>
    new Promise((resolve) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => resolve(body));
    });
  const fake = (label, to, q) => ({ texts: [`[${label} → ${to}] ${q}`] });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    // /api/page logs itself (it knows its text count)
    if ((p.startsWith("/api/") && p !== "/api/page") || p === "/pack.json") {
      log.push({ at: Date.now(), method: req.method, host: req.headers.host, path: p, to: url.searchParams.get("to"), q: url.searchParams.get("q"), auth: !!req.headers.authorization });
    }
    const reply = (fn) => setTimeout(fn, p.startsWith("/api/") ? state.delayMs : 0);

    if (p === "/" || p === "/index.html") return send(res, 200, page("index.html"));
    if (p === "/csp") return send(res, 200, page("index.html"), { "content-security-policy": STRICT_CSP });
    if (p === "/video") return send(res, 200, page("video.html"));
    if (p === "/quiz") return send(res, 200, page("quiz.html"));
    if (p === "/news") return send(res, 200, page("news.html"));
    // The long article for 网页对照 (R7), and the same page under the strict CSP (R9.1): its script and style are files.
    if (p === "/article") return send(res, 200, page("article.html"));
    if (p === "/article-csp") return send(res, 200, page("article.html"), { "content-security-policy": STRICT_CSP });
    if (p === "/article.js") return send(res, 200, page("article.js"), { "content-type": "text/javascript; charset=utf-8" });
    if (p === "/article.css") return send(res, 200, page("article.css"), { "content-type": "text/css" });
    if (p === "/page.css") return send(res, 200, page("page.css"), { "content-type": "text/css" });
    if (p === "/pack.json" && state.failPack) return send(res, 503, { error: "maintenance" });
    if (p === "/pack.json") return send(res, 200, testPack(port, state.packVersion), { etag: `"v${state.packVersion}"` });

    const to = url.searchParams.get("to") ?? "";
    const q = url.searchParams.get("q") ?? "";
    if (p === "/api/a") return reply(() => send(res, 200, fake("A", to, q)));
    if (p === "/api/b") return reply(() => (state.failB ? send(res, 500, { error: "boom" }) : send(res, 200, fake("B", to, q))));
    if (p === "/api/key") {
      if (req.headers.authorization !== `Bearer ${E2E_KEY}`) return send(res, 401, { error: "bad key" });
      return reply(() => send(res, 200, fake("K", to, q)));
    }

    if (p === "/api/page" && req.method === "POST") {
      // The batch translator of 网页对照: one translation per text. `failPage: n` fails the next n requests with a 500.
      readBody(req).then((body) => {
        let input;
        try {
          input = JSON.parse(body);
          if (!Array.isArray(input?.texts)) throw new Error("texts");
        } catch {
          return send(res, 400, { error: "expected { texts: string[], to }" });
        }
        log.push({ at: Date.now(), method: req.method, host: req.headers.host, path: p, to: input.to ?? null, count: input.texts.length, first: String(input.texts[0] ?? "") });
        reply(() => {
          if (state.failPage > 0) {
            state.failPage--;
            return send(res, 500, { error: "boom" });
          }
          send(res, 200, { texts: input.texts.map((t) => `[P → ${input.to ?? ""}] ${t}`) });
        });
      });
      return;
    }

    if (p === "/admin/log") return send(res, 200, log);
    if (p === "/admin/state" && req.method === "POST") {
      readBody(req).then((body) => {
        let patch;
        try {
          patch = JSON.parse(body || "{}");
        } catch {
          return send(res, 400, { error: "invalid JSON" });
        }
        if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return send(res, 400, { error: "expected an object" });
        Object.assign(state, patch);
        send(res, 200, state);
      });
      return;
    }
    send(res, 404, { error: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(port, async () => {
      // The scriptable OpenAI-compatible fake (e2e/llm.mjs) listens on the next port; scenarios that
      // need it reach it at http://localhost:<port+1>/v1 and script it over its /admin endpoints.
      // A busy port only costs that fake, never the existing scenarios.
      const llm = await startFakeLlm(port + 1).catch((e) => {
        console.error(`fake llm not started on ${port + 1}: ${e.code ?? e.message}`);
        return null;
      });
      resolve({
        port,
        state,
        log,
        llm,
        close: async () => {
          await llm?.close();
          await new Promise((r) => (server.closeAllConnections?.(), server.close(() => r())));
        },
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startServer(Number(process.argv[2] ?? 4719));
  console.log(`e2e server on http://localhost:${s.port}/ (strict CSP: /csp); fake llm on http://localhost:${s.llm?.port}/v1`);
}
