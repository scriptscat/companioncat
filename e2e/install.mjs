#!/usr/bin/env node
/** Installs dist/companioncat.user.js into the user's ScriptCat; blocks until approved in the browser. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/companioncat.user.js");
console.log("WAITING: approve the 陪伴猫 install in the ScriptCat tab");
try {
  console.log(execFileSync("sctl", ["install", file, "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
} catch (e) {
  console.error(`install not completed (exit ${e.status}: 1 = rejected, 2 = timed out or cancelled)`);
  process.exit(e.status ?? 1);
}
