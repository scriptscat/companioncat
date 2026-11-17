/**
 * Userscript entry. Pages and features self-register: each src/pages/<name>/register.tsx and
 * src/features/<name>/register.tsx default-exports definePage(...) / defineFeature(...).
 * Every shared service (rules, subscriptions, keys, the invoker, the host dialog) is built by the
 * composition root in src/app/.
 */
import { startApp } from "./app/start";
import { collect } from "./shell/registry";

const registrations = collect(
  import.meta.glob("./pages/*/register.tsx", { eager: true }),
  import.meta.glob("./features/*/register.tsx", { eager: true }),
);

const info = (globalThis as { GM_info?: { script?: { version?: string } } }).GM_info;

startApp({ registrations, version: info?.script?.version });
