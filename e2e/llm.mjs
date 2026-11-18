/**
 * A scriptable local OpenAI-compatible fake for the E2E run: Chat Completions (SSE when stream=true)
 * and Responses (SSE), Bearer key checking, a request log and a queue of scripted replies.
 * It does not prove real providers' wire formats.
 *
 *   node e2e/llm.mjs [port]                 — standalone
 *   const llm = await startFakeLlm(port, script)
 *   llm.queue("text", { json: {...} }, { status: 500, body: {...} }, (req) => "text")
 *   llm.log, llm.reset(), llm.close()
 *
 * Over HTTP (for a test process other than the one that started the fake):
 *   POST /admin/script {"replies":[...]}   queue replies (strings, {json}, {status, body}, objects = JSON text)
 *   GET  /admin/log                        the request log      POST /admin/reset   clear queue and log
 *
 * A reply is: a string (the answer text); { json } (that value as JSON text); { status, body } (an HTTP
 * failure); { delayMs, ... } before any of the above; any other object (its JSON as the answer text);
 * or, in-process only, a function (parsedRequest) => reply. With nothing queued the defaults apply: for
 * the llm-translate bridge a JSON string array of the input's length, for llm-choose a choose-shaped
 * object, otherwise text.
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LLM_KEY = "sk-e2e-fake-llm-0000000000000000";
export const DEFAULT_TEXT = "【假模型】事件循环一次处理一个任务。";

/** The prompt shapes come from the bridges in rules/packs/official-llm.json. */
function defaultAnswer(messages) {
  const sys = String(messages.find((m) => m.role === "system")?.content ?? "");
  const user = String(messages.findLast((m) => m.role === "user")?.content ?? "");
  if (/JSON 字符串数组/.test(sys)) {
    let texts = [];
    try {
      texts = JSON.parse(user);
    } catch {}
    return JSON.stringify((Array.isArray(texts) ? texts : []).map((t) => "【假模型译文】" + String(t).slice(0, 40)));
  }
  if (/choice/.test(sys) && /confidence/.test(sys)) {
    let ids = [];
    try {
      ids = Object.keys(JSON.parse(user.slice(user.indexOf("选项（id 到说明）：") + "选项（id 到说明）：".length)));
    } catch {}
    return JSON.stringify({ choice: ids[0] ?? "yes", confidence: 0.95 });
  }
  return DEFAULT_TEXT;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startFakeLlm(port = 4720, script = []) {
  const queue = [...script];
  const log = [];

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const chunks = (s) => s.match(/[\s\S]{1,6}/gu) ?? [""];

  async function answer(req, res, url, body) {
    const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
    let reply = queue.shift();
    const source = reply === undefined ? "default" : "script";
    if (typeof reply === "function") reply = reply({ ...body, messages });
    if (reply === undefined || reply === null) reply = defaultAnswer(messages);
    if (reply && typeof reply === "object" && reply.delayMs) await sleep(reply.delayMs);
    log.push({ at: Date.now(), method: req.method, path: url.pathname, auth: true, stream: !!body.stream, model: body.model, body, source });
    if (reply && typeof reply === "object" && reply.status) return json(res, reply.status, reply.body ?? { error: { message: "scripted failure" } });
    const out =
      typeof reply === "string" ? reply : reply && typeof reply === "object" && "json" in reply ? JSON.stringify(reply.json) : reply && typeof reply === "object" && typeof reply.text === "string" ? reply.text : JSON.stringify(reply);
    const pieces = chunks(out);
    const chat = url.pathname.endsWith("/chat/completions");
    if (!chat && !url.pathname.endsWith("/responses")) return json(res, 404, { error: { message: "not found" } });
    if (!body.stream) {
      return json(
        res,
        200,
        chat
          ? { choices: [{ message: { role: "assistant", content: out } }], usage: { prompt_tokens: 10, completion_tokens: pieces.length } }
          : { output: [{ type: "message", content: [{ type: "output_text", text: out }] }], output_text: out, usage: { input_tokens: 10, output_tokens: pieces.length } },
      );
    }
    res.writeHead(200, { "content-type": "text/event-stream", "access-control-allow-origin": "*", "cache-control": "no-store" });
    for (const piece of pieces) {
      res.write(
        chat
          ? `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`
          : `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: piece })}\n\n`,
      );
      await sleep(5);
    }
    res.write(chat ? "data: [DONE]\n\n" : `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { output_text: out } })}\n\n`);
    res.end();
  }

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
        return res.end();
      }
      if (url.pathname === "/admin/log") return json(res, 200, log);
      if (url.pathname === "/admin/reset") {
        queue.length = 0;
        log.length = 0;
        return json(res, 200, {});
      }
      if (url.pathname === "/admin/script" && req.method === "POST") {
        try {
          const { replies } = JSON.parse(raw || "{}");
          if (!Array.isArray(replies)) throw new Error();
          queue.push(...replies);
          return json(res, 200, { queued: queue.length });
        } catch {
          return json(res, 400, { error: "expected {\"replies\":[...]}" });
        }
      }
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {}
      if (req.headers.authorization !== `Bearer ${LLM_KEY}`) {
        // The key itself is never logged.
        log.push({ at: Date.now(), method: req.method, path: url.pathname, auth: false, stream: !!body.stream, model: body.model, source: "401" });
        return json(res, 401, { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } });
      }
      answer(req, res, url, body).catch(() => res.destroy());
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () =>
      resolve({
        port: server.address().port,
        key: LLM_KEY,
        log,
        queue: (...replies) => queue.push(...replies),
        reset: () => {
          queue.length = 0;
          log.length = 0;
        },
        close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r()))),
      }),
    );
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startFakeLlm(Number(process.argv[2] ?? 4720));
  console.log(`e2e fake llm on http://localhost:${s.port}/v1`);
}
