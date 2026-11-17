import { defineConfig } from "vitest/config";
import builtinPacks from "./build/builtin-packs";
import { PAGE_SAFE_ALIASES } from "./src/ui/page-safe/aliases";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [builtinPacks()],
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        plugins: [builtinPacks()],
        // the userscript build's page-safe stand-ins for Radix's helpers (see vite.config.ts);
        // Radix is inlined so its imports go through these aliases too
        resolve: { alias: PAGE_SAFE_ALIASES, mainFields: ["module", "browser", "main"] },
        test: {
          name: "jsdom",
          server: { deps: { inline: [/@radix-ui/, /radix-ui/, /react-remove-scroll/] } },
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["test/setup.ts"],
          // UI tests chain several findBy waits; under load the 5 s default is hit on timing alone
          testTimeout: 20_000,
        },
      },
    ],
  },
});
