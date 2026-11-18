import { describe, expect, it } from "vitest";
import { checkLocalRules, type PackSource } from "./index";

const head = `{
  "schema": 1,
  "id": "local",
  "name": "本地规则",`;

const SUBSCRIPTIONS: PackSource[] = [
  {
    official: true,
    pack: {
      schema: 1,
      id: "official-llm",
      name: "llm",
      contracts: [{ id: "translate", input: { type: "object" }, output: { type: "object" } }],
      providers: [
        {
          id: "openai-compatible",
          name: "OpenAI 兼容",
          abstract: true,
          hosts: ["{{ host(options.baseUrl) }}"],
          options: { baseUrl: { type: "string", title: "地址" } },
          implements: { translate: { http: { request: { url: "{{ options.baseUrl }}/t" }, output: { texts: "{{ [response.t] }}" } } } },
        },
      ],
    },
  },
];

describe("checkLocalRules (R3.2)", () => {
  it("saves valid rules without problems", () => {
    const text = `${head}
  "providers": [{ "id": "kimi", "extends": "official-llm/openai-compatible", "name": "Kimi",
    "options": { "baseUrl": { "default": "https://api.moonshot.test/v1" } } }]
}`;
    expect(checkLocalRules(text, SUBSCRIPTIONS)).toMatchObject({ canSave: true, problems: [] });
  });

  it("reports a JSON syntax error with its line and blocks saving", () => {
    const text = `{
  "schema": 1,
  "id": "local"
  "name": "x"
}`;
    const result = checkLocalRules(text);
    expect(result.canSave).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ severity: "error", line: 4, path: "", message: expect.stringContaining("JSON") })]);
  });

  it("reports schema errors with line, field path and reason and blocks saving", () => {
    const text = `${head}
  "features": [{
    "id": "demo", "name": "示例", "match": ["*://*/*"],
    "entries": [{
      "id": "sel", "name": "划词",
      "triggers": [{ "on": "hover" }],
      "run": [{ "set": { "to": "{{ settings.to }}" } }],
      "present": { "surface": { "type": "near-selection" }, "view": { "type": "text", "value": "{{ vars.to }}" } }
    }]
  }]
}`;
    const result = checkLocalRules(text);
    expect(result.canSave).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({
        severity: "error",
        line: 9,
        path: "/features/0/entries/0/triggers/0/on",
        message: expect.stringContaining("selection"),
      }),
    ]);
  });

  it("requires the local rules id to be local", () => {
    const result = checkLocalRules(`{ "schema": 1, "id": "mine" }`);
    expect(result.canSave).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ line: 1, path: "/id", message: "本地规则的 id 必须是 local" })]);
  });

  it("lists expression errors with the expression text and position, but still allows saving", () => {
    const text = `${head}
  "features": [{
    "id": "demo", "name": "示例", "match": ["*://*/*"],
    "entries": [{
      "id": "sel", "name": "划词",
      "triggers": [{ "on": "selection" }],
      "run": [{ "set": { "to": "{{ settings.to + }}", "key": "{{ secret.apiKey }}" } }],
      "present": { "surface": { "type": "near-selection" }, "view": { "type": "text", "value": "{{ vars.to }}" } }
    }]
  }, {
    "id": "fine", "name": "好的", "match": ["*://*/*"],
    "entries": [{
      "id": "sel", "name": "划词",
      "triggers": [{ "on": "selection" }],
      "run": [{ "set": { "to": "{{ settings.to }}" } }],
      "present": { "surface": { "type": "near-selection" }, "view": { "type": "text", "value": "{{ vars.to }}" } }
    }]
  }]
}`;
    const result = checkLocalRules(text);
    expect(result.canSave).toBe(true);
    expect(result.problems).toEqual([
      expect.objectContaining({
        severity: "error",
        line: 10,
        path: "/features/0/entries/0/run/0/set/to",
        expr: expect.objectContaining({ template: "{{ settings.to + }}", source: " settings.to + " }),
      }),
      expect.objectContaining({
        line: 10,
        path: "/features/0/entries/0/run/0/set/key",
        message: expect.stringContaining("变量 secret 不能在「功能 run」里使用"),
        expr: { template: "{{ secret.apiKey }}", source: " secret.apiKey ", start: 3, end: 9 },
      }),
    ]);
  });

  it("allows page functions only in an automation entry's triggers and run (R1.4, R1.7)", () => {
    const text = `${head}
  "features": [{
    "id": "demo", "name": "示例", "match": ["*://*/*"],
    "entries": [{
      "id": "skip", "name": "跳过广告",
      "triggers": [{ "on": "appear", "selector": "button", "enabled": "{{ visible(trigger.element) }}" }],
      "run": [{ "find": "button", "where": "{{ contains(text(item), '跳过') }}", "as": "b" },
              { "act": "click", "target": "{{ vars.b }}", "describe": "{{ describe(vars.b) }}" }]
    }, {
      "id": "sel", "name": "划词",
      "triggers": [{ "on": "selection" }],
      "run": [{ "set": { "to": "{{ text(vars.b) }}" } }],
      "present": { "surface": { "type": "near-selection" }, "view": { "type": "text", "value": "{{ vars.to }}" } }
    }]
  }]
}`;
    const result = checkLocalRules(text);
    expect(result.canSave).toBe(true);
    expect(result.problems).toEqual([
      expect.objectContaining({
        severity: "error",
        line: 15,
        path: "/features/0/entries/1/run/0/set/to",
        message: expect.stringContaining("text()"),
        expr: { template: "{{ text(vars.b) }}", source: " text(vars.b) ", start: 3, end: 15 },
      }),
    ]);
  });

  it("lists inheritance errors against the subscriptions, but still allows saving", () => {
    const text = `${head}
  "providers": [
    { "id": "kimi", "extends": "community/kimi-base", "name": "Kimi" }
  ]
}`;
    const result = checkLocalRules(text, SUBSCRIPTIONS);
    expect(result.canSave).toBe(true);
    expect(result.problems).toEqual([
      expect.objectContaining({ severity: "error", line: 6, path: "/providers/0/extends", message: "继承的 community/kimi-base 找不到" }),
    ]);
  });

  it("lists expression errors in overrides at their own line", () => {
    const text = `${head}
  "overrides": {
    "official-llm/openai-compatible": {
      "hosts": ["{{ vars.host }}"]
    }
  }
}`;
    const result = checkLocalRules(text, SUBSCRIPTIONS);
    expect(result.canSave).toBe(true);
    expect(result.problems).toEqual([
      expect.objectContaining({
        line: 7,
        path: "/overrides/official-llm~1openai-compatible/hosts/0",
        message: expect.stringContaining("变量 vars 不能在「引擎 hosts」里使用"),
      }),
    ]);
  });
});

describe("deeply nested local rules", () => {
  it("reports nesting beyond 64 levels as a syntax problem instead of crashing", () => {
    const text = `${head} "views": { "v": { "type": "text", "value": ${"[".repeat(5000)}1${"]".repeat(5000)} } } }`;
    const r = checkLocalRules(text, SUBSCRIPTIONS);
    expect(r.canSave).toBe(false);
    expect(r.problems).toEqual([expect.objectContaining({ severity: "error", line: 4, message: expect.stringContaining("64") })]);
  });
});

describe("no keys in local rules (R3.3)", () => {
  it("warns about a literal that looks like an API key, without blocking saving", () => {
    const text = `${head}
  "overrides": {
    "official-llm/openai-compatible": {
      "implements": { "translate": { "http": {
        "request": { "url": "https://x.test", "headers": { "Authorization": "Bearer sk-abcdefghijklmnop1234" } },
        "output": { "texts": "{{ [response.t] }}" } } } },
      "secrets": [{ "name": "apiKey", "title": "API Key", "placeholder": "sk-…" }]
    }
  }
}`;
    const result = checkLocalRules(text, SUBSCRIPTIONS);
    expect(result.canSave).toBe(true);
    expect(result.problems).toEqual([
      {
        severity: "warning",
        line: 8,
        column: expect.any(Number),
        path: "/overrides/official-llm~1openai-compatible/implements/translate/http/request/headers/Authorization",
        message: "API Key 请在引擎页面填写",
      },
    ]);
  });
});
