/**
 * The E2E rule pack. Every engine points at the local fake translator (e2e/server.mjs).
 * Version 1 sends the keyed engine to `localhost`; version 2 moves it to `127.0.0.1`, which is
 * the "rule update changed the address" case of R7.4.
 */
export const PACK_ID = "e2e";

const translate = (url, extra = {}) => ({
  http: {
    request: { method: "GET", url, ...extra },
    response: "json",
    output: { texts: "{{ response.texts }}" },
    errors: [
      { status: 401, type: "auth", message: "假服务说 Key 不对" },
      { status: "5xx", type: "server", message: "假服务出错了" },
    ],
  },
});

const q = "to={{ input.to }}&q={{ urlencode(input.texts[0]) }}";

export function testPack(port, version = 1) {
  const keyHost = version >= 2 ? "127.0.0.1" : "localhost";
  return {
    schema: 1,
    id: PACK_ID,
    name: "E2E 测试规则",
    description: "指向本地假翻译服务的测试规则包",
    version: `1.0.${version}`,
    providers: [
      {
        id: "fake-a",
        name: "假翻译 A",
        description: "本地假服务，不用 Key",
        icon: "languages",
        hosts: ["localhost"],
        limits: { timeoutMs: 5000 },
        implements: { translate: translate(`http://localhost:${port}/api/a?${q}`) },
      },
      {
        id: "fake-b",
        name: "假翻译 B",
        description: "本地假服务，不用 Key；可以让它出错",
        icon: "languages",
        hosts: ["localhost"],
        limits: { timeoutMs: 5000 },
        implements: { translate: translate(`http://localhost:${port}/api/b?${q}`) },
      },
      {
        id: "fake-key",
        name: "带 Key 的假翻译",
        description: "本地假服务，需要 Key",
        icon: "key-round",
        secrets: [{ name: "apiKey", title: "API Key", placeholder: "e2e-…" }],
        hosts: [keyHost],
        limits: { timeoutMs: 5000 },
        implements: {
          translate: translate(`http://${keyHost}:${port}/api/key?${q}`, {
            headers: { Authorization: "Bearer {{ secret.apiKey }}" },
          }),
        },
      },
      {
        // Inherits fake-key's secrets: the "共用 Key" state (R5.6).
        id: "fake-key-mirror",
        extends: "fake-key",
        name: "带 Key 的假翻译（镜像）",
        description: "和「带 Key 的假翻译」共用 Key",
      },
      {
        // Extends an engine from a pack nobody subscribed: the "引擎有问题" state (R2.6).
        id: "fake-broken",
        extends: "e2e-missing/engine",
        name: "坏掉的假翻译",
        description: "继承了一个不存在的引擎",
      },
    ],
  };
}
