import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";
import builtinPacks from "./build/builtin-packs";
import { PAGE_SAFE_ALIASES } from "./src/ui/page-safe/aliases";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const REPO = "https://github.com/scriptscat/companioncat";
const RELEASE = `${REPO}/releases/latest/download`;

/** Exactly the APIs R1.1 declares; autoGrant is off so nothing else slips in. */
const GRANTS = [
  "GM_xmlhttpRequest",
  "GM_getValue",
  "GM_setValue",
  "GM_deleteValue",
  "GM_listValues",
  "GM_addValueChangeListener",
  "GM_registerMenuCommand",
  "GM_setClipboard",
];

export default defineConfig({
  plugins: [
    // `styles.css?inline` becomes the compiled, px-only stylesheet string the shell adopts into its shadow root.
    tailwindcss(),
    builtinPacks(),
    monkey({
      entry: "src/main.tsx",
      userscript: {
        name: "陪伴猫",
        namespace: "https://github.com/scriptscat/companioncat",
        version: pkg.version,
        license: "GPL-3.0",
        description: "住在网页角落的小猫：划词与网页对照翻译、页面自动化（跳过广告）、做题、教小猫做件事，能力由规则包提供",
        author: "ScriptCat",
        homepage: REPO,
        supportURL: `${REPO}/issues`,
        updateURL: `${RELEASE}/companioncat.meta.js`,
        downloadURL: `${RELEASE}/companioncat.user.js`,
        match: ["http://*/*", "https://*/*"],
        noframes: true,
        connect: ["*"],
        grant: GRANTS,
      },
      build: {
        fileName: "companioncat.user.js",
        metaFileName: true,
        autoGrant: false,
        // R1.2: CSS never goes to GM_addStyle or document.head; the shell puts it into its shadow root.
        cssSideEffects: "() => {}",
      },
    }),
  ],
  resolve: {
    // R1.2: Radix must not write into the host page (<style> in <head>, attributes on <body>).
    alias: PAGE_SAFE_ALIASES,
  },
  build: {
    target: "es2022",
    rollupOptions: {
      onwarn(warning, warn) {
        // Radix ships "use client" directives, meaningless in a userscript bundle.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
});
