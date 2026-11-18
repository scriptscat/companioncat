import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** The real ESM entry of a package that radix-ui depends on (pnpm keeps it out of our own node_modules). */
function radixDep(name: string): string {
  const fromRadix = createRequire(createRequire(import.meta.url).resolve("radix-ui"));
  return fromRadix.resolve(name).replace(/index\.js$/, "index.mjs");
}

/**
 * Module replacements that keep Radix from writing to the host page (R1.2). Used by
 * vite.config.ts for the userscript build. Exact-name matches only, so subpath imports such as
 * `react-remove-scroll-bar/constants` still resolve to the real package.
 */
export const PAGE_SAFE_ALIASES = [
  // the scroll lock must not write a <style> into the page's <head>
  { find: /^react-style-singleton$/, replacement: here("../../app/no-page-styles.ts") },
  // nor mark the page's <body> as scroll-locked
  { find: /^react-remove-scroll-bar$/, replacement: here("./remove-scroll-bar.ts") },
  // nor set aria-hidden on every child of the page's <body>
  { find: /^aria-hidden$/, replacement: here("./aria-hidden.ts") },
  // nor insert focus-guard <span>s into the page's <body>
  { find: /^@radix-ui\/react-focus-guards$/, replacement: here("./focus-guards.ts") },
  // nor set pointer-events: none on the page's <body> while a select is open
  { find: /^@radix-ui\/react-dismissable-layer$/, replacement: here("./dismissable-layer.ts") },
  { find: /^cc-real-dismissable-layer$/, replacement: radixDep("@radix-ui/react-dismissable-layer") },
];
