import type { FetchFn } from "../core/subscriptions";
import { httpRequest } from "../platform/http";

/** How long a rule pack download may take. */
export const PACK_TIMEOUT_MS = 30_000;

/** The subscription manager's FetchFn over GM_xmlhttpRequest; a request with no response rejects. */
export const gmFetch: FetchFn = async (url, init) => {
  const res = await httpRequest({ method: "GET", url, headers: init?.headers, timeoutMs: PACK_TIMEOUT_MS });
  return { status: res.status, headers: res.headers, text: res.text };
};
