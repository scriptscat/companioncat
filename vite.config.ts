import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";
import builtinPacks from "./build/builtin-packs";
import { PAGE_SAFE_ALIASES } from "./src/ui/page-safe/aliases";

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
        version: "0.1.0",
        description: "住在网页角落的小猫：划词翻译，能力由规则包提供",
        author: "ScriptCat",
        homepage: "https://github.com/scriptscat/companioncat",
        match: ["http://*/*", "https://*/*"],
        noframes: true,
        connect: ["*"],
        grant: GRANTS,
      },
      build: {
        fileName: "companioncat.user.js",
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
