/**
 * Match patterns for a feature's `match` / `exclude` and an entry's `match`: `<scheme>://<host><path>`,
 * where scheme `*` is http or https, host `*` or `*.example.com` (the domain itself included) and
 * `*` in the path matches anything; `<all_urls>` matches every http(s) page.
 */
const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

export function matchUrl(pattern: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.slice(0, -1);
  if (pattern === "<all_urls>") return scheme === "http" || scheme === "https";
  const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
  if (!m) return false;
  const [, s, host = "", path = "/*"] = m;
  if (s === "*" ? scheme !== "http" && scheme !== "https" : s!.toLowerCase() !== scheme) return false;
  const hostname = u.hostname.toLowerCase();
  const h = host.toLowerCase().replace(/:\d+$/, "");
  if (h !== "*") {
    if (h.startsWith("*.")) {
      const base = h.slice(2);
      if (hostname !== base && !hostname.endsWith(`.${base}`)) return false;
    } else if (hostname !== h) return false;
  }
  const re = new RegExp(`^${path.split("*").map(esc).join(".*")}$`);
  return re.test(u.pathname + u.search);
}

export const matchesAny = (patterns: readonly string[] | undefined, url: string) =>
  !!patterns?.some((p) => matchUrl(p, url));

/** Where an entry runs: its own `match`, or the feature's when it has none (an empty list counts as none). */
export const entryMatch = (feature: { match: readonly string[] }, entry: { match?: readonly string[] }): readonly string[] =>
  entry.match?.length ? entry.match : feature.match;
