/** Test-only helpers for the invoke tests (not imported by runtime code). */
import { createGmStorageFake } from "../../../test/fakes/gm-storage";
import { installGmHttp, type FakeGm, type FakeOptions, type Recorded } from "../../../test/fakes/gm-http";
import { createStorage } from "../../platform/storage";
import { official, testProvider } from "../impl/testkit";
import type { ProviderDef, Resolved, ResolvedProvider } from "../rules";
import { createSecretStore, type SecretStore } from "../stores";
import { createInvoker, type InvokerDeps } from "./index";

export const KEY = "sk-test-0000000000abcd";
const base = official();

type Extra = Partial<Omit<ProviderDef, "implements">>;

/** A translate engine at https://<id>.test/t answering texts as "<id>:<text>". */
export function translator(id: string, extra: Extra = {}): ResolvedProvider {
  return testProvider({
    id,
    name: id.toUpperCase(),
    hosts: [`${id}.test`],
    ...extra,
    implements: {
      translate: {
        http: {
          request: { method: "POST", url: `https://${id}.test/t`, json: { texts: "{{ input.texts }}", to: "{{ input.to }}" } },
          response: "json",
          output: { texts: "{{ response.texts }}" },
        },
      },
    },
  });
}

/** A keyed translate engine (one `apiKey` secret). */
export const keyedTranslator = (id: string, extra: Extra = {}) =>
  translator(id, { secrets: [{ name: "apiKey", title: "API Key" }], ...extra });

/** A streaming chat engine at https://<id>.test/c (SSE with `d` deltas). */
export function chatter(id: string, extra: Extra = {}): ResolvedProvider {
  return testProvider({
    id,
    name: id.toUpperCase(),
    hosts: [`${id}.test`],
    ...extra,
    implements: {
      chat: {
        http: {
          request: { method: "POST", url: `https://${id}.test/c`, json: { messages: "{{ input.messages }}" } },
          response: "sse",
          stream: { delta: "{{ response.d }}", done: "[DONE]" },
          output: { text: "{{ stream.text }}" },
        },
      },
    },
  });
}

/** A choose engine at https://<id>.test/q answering `choice` with `confidence`. */
export function chooser(id: string): ResolvedProvider {
  return testProvider({
    id,
    name: id.toUpperCase(),
    hosts: [`${id}.test`],
    implements: {
      choose: {
        http: {
          request: { method: "POST", url: `https://${id}.test/q`, json: { q: "{{ input.question }}" } },
          response: "json",
          output: { choice: "{{ response.choice }}", confidence: "{{ response.confidence }}" },
        },
      },
    },
  });
}

/** Answers every POST to https://<id>.test/t by prefixing the texts. */
export const translates = (id: string, extra: Partial<Recorded> = {}): Recorded => ({
  url: `https://${id}.test/t`,
  repeat: true,
  respond: (req) => ({ json: { texts: (JSON.parse(req.data!) as { texts: string[] }).texts.map((t) => `${id}:${t}`) } }),
  ...extra,
});

export const sse = (...pieces: string[]) => pieces.map((d) => `data: ${JSON.stringify({ d })}\n\n`).join("") + "data: [DONE]\n\n";

export const hello = { messages: [{ role: "user", content: "hi" }] };
export const text = (t = "hello") => ({ texts: [t], to: "zh-CN" });

export interface Setup {
  rules: Resolved;
  secrets: SecretStore;
  fake: FakeGm;
  invoker: ReturnType<typeof createInvoker>;
}

/** Official contracts plus `providers`, a fresh secret store and a fake GM_xmlhttpRequest. */
export function setup(
  providers: ResolvedProvider[],
  opts: {
    routes?: Recorded[];
    http?: FakeOptions;
    deps?: Partial<InvokerDeps>;
    /** apiKey per keyed engine. */
    keys?: Record<string, string>;
    /** Confirmed hosts per keyed engine; default its declared hosts. */
    hosts?: Record<string, string[]>;
  } = {},
): Setup {
  const rules: Resolved = { ...base, providers };
  const storage = createStorage(createGmStorageFake().tab());
  const secrets = createSecretStore(storage, () => rules);
  for (const [ref, key] of Object.entries(opts.keys ?? {})) {
    secrets.set(ref, "apiKey", key, opts.hosts?.[ref] ?? providers.find((p) => p.ref === ref)?.def.hosts);
  }
  const fake = installGmHttp(opts.routes ?? [], opts.http);
  const invoker = createInvoker({ rules: () => rules, secrets, ...opts.deps });
  return { rules, secrets, fake, invoker };
}
