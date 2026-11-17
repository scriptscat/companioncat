import { Environment } from "@marcbachmann/cel-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { position, renderTemplate } from "./index";

// The 50 ms budget is the expression's own evaluation work (R8.4): time spent waiting on
// awaited functions, event-loop stalls caused by other code, and compile / warm-up do not count.
const POS = position("budget", ["input"]);

const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // burn CPU outside the expression
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("time budget counts only the expression's own work", () => {
  it("does not count awaited WebCrypto latency", async () => {
    const subtle = globalThis.crypto.subtle;
    const digest = subtle.digest.bind(subtle);
    vi.spyOn(subtle, "digest").mockImplementation(async (alg, data) => {
      await new Promise((r) => setTimeout(r, 120));
      return digest(alg, data);
    });
    await expect(renderTemplate("{{ sha256('a') }}", {}, POS)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not count an event-loop stall caused by other code while it awaits", async () => {
    setTimeout(() => busy(120), 0);
    await expect(renderTemplate("{{ hmacSha256('k', 'd') }}", {}, POS)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not time out a small expression when the clock jumps mid-evaluation (deschedule / GC pause)", async () => {
    const real = performance.now.bind(performance);
    let calls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => real() + (++calls > 3 ? 100 : 0));
    const input = { a: Array.from({ length: 1000 }, (_, i) => i) };
    await expect(renderTemplate("{{ input.a.map(x, x * 2).size() }}", { input }, POS)).resolves.toBe(1000);
    expect(calls).toBeGreaterThan(3); // the jump really happened during evaluation
  });

  it("does not count parse / type-check / first-call warm-up", async () => {
    const parse = Environment.prototype.parse;
    vi.spyOn(Environment.prototype, "parse").mockImplementation(function (this: Environment, src: string) {
      busy(120);
      return parse.call(this, src);
    });
    await expect(renderTemplate("{{ input.n + 1 }}", { input: { n: 41 } }, position("cold", ["input"]))).resolves.toBe(42);
  });

  it("charges one slow native call in full, so a single heavy function call cannot exceed the budget", async () => {
    const replaceAll = String.prototype.replaceAll as (this: string, a: string, b: string) => string;
    vi.spyOn(String.prototype, "replaceAll").mockImplementation(function (this: string, a: unknown, b: unknown) {
      busy(120);
      return replaceAll.call(this, a as string, b as string);
    } as never);
    await expect(renderTemplate("{{ replace('ab', 'a', 'c') }}", {}, POS)).rejects.toMatchObject({ code: "timeout" });
  });

  it("errors thrown while evaluating are runtime errors, not syntax errors", async () => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(new TypeError("digest broke"));
    await expect(renderTemplate("{{ sha256('a') }}", {}, POS)).rejects.toMatchObject({ code: "runtime", message: expect.stringContaining("digest broke") });
  });
});

