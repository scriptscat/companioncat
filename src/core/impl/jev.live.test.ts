/**
 * Live smoke test against the real Jev API. The key is read from ~/.env (JEV_SECRET_KEY, not
 * exported to the shell) and never printed: assertions only look at the masked trace and output.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installFetchGm } from "../../../test/fakes/gm-http";
import { executeImpl } from "./index";
import { ctxFor, official, providerOf } from "./testkit";

function jevKey(): string | undefined {
  try {
    const env = readFileSync(join(homedir(), ".env"), "utf8");
    const m = /^\s*(?:export\s+)?JEV_SECRET_KEY\s*=\s*(.*)$/m.exec(env);
    const v = m?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
    return v || undefined;
  } catch {
    return undefined;
  }
}

const key = jevKey();

describe.skipIf(!key)("Jev live smoke", () => {
  const gm = installFetchGm();
  afterAll(() => gm.restore());

  it("answers the choose sample through the official engine", { timeout: 30_000 }, async () => {
    const r = official();
    const contract = r.contracts.find((c) => c.id === "choose")!;
    const ctx = ctxFor(r, { secrets: { apiKey: key! } });
    let failure: unknown;
    const out = await executeImpl(providerOf(r, "official-llm/jev"), "choose", contract.def.sample, ctx).catch((e: unknown) => {
      failure = e;
    });
    // Never let the key reach the assertion output.
    expect(JSON.stringify(ctx.trace).includes(key!)).toBe(false);
    expect(failure && { type: (failure as { type?: string }).type, message: (failure as Error).message }).toBeUndefined();
    expect(Object.keys((contract.def.sample as { options: object }).options)).toContain((out as { choice: string }).choice);
    expect((out as { confidence: number }).confidence).toBeGreaterThanOrEqual(0);
  });
});
