import { beforeAll, describe, expect, it } from "vitest";
import { compileStyles, rawStyles } from "./compile-css";
import { shadowSafe } from "./css";

let css = "";
beforeAll(async () => {
  css = await compileStyles(["dark:bg-fur", "text-xs", "rounded-xl", "max-w-sm", "sm:flex-row", "p-4", "shadow-lift"]);
});

/** Declarations of every rule whose selector list is exactly `selector`. */
function block(source: string, selector: string) {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(source); m; m = re.exec(source)) if (m[1]!.trim() === selector) out.push(m[2]!);
  return out.join(";");
}

describe("styles.css (R1.2, R1.7)", () => {
  it("compiles to px only: no rem anywhere, so html { font-size } on the page cannot resize the UI", () => {
    expect(css.length).toBeGreaterThan(1000);
    const rems = css.match(/[\d.]+rem\b/g) ?? [];
    expect(rems).toEqual([]);
  });

  it("keeps the v5 cat-fur tokens on :host, dark ones on :host(.dark), none on :root or .dark", () => {
    expect(rawStyles()).not.toMatch(/(^|[\s,}]):root\b/);
    const light = block(css, ":host");
    expect(light).toContain("--paper: #f3f2ef");
    expect(light).toContain("--fur: #ffffff");
    expect(light).toContain("--ginger: #f39a2e");
    expect(light).toContain("--ginger-ink: #a5540a");
    expect(light).toContain("--ink: #2a2421");
    expect(light).toContain("--leaf: #2d8655");
    expect(light).toContain("--berry: #c23849");
    expect(light).toContain("--nose: #f2a3ab");
    const dark = block(css, ":host(.dark)");
    expect(dark).toContain("--paper: #1a1715");
    expect(dark).toContain("--ink: #f1ece7");
    expect(block(css, ".dark")).toBe("");
  });

  it("stops page styles from inheriting into the shadow tree (:host all: initial, important wins inside)", () => {
    expect(css).toMatch(/:host\s*\{[^}]*all:\s*initial\s*!important/);
  });

  it("dark: utilities key off the shadow host's class", () => {
    expect(css).toMatch(/:host\(\.dark\)\s+\.dark\\:bg-fur/);
  });

  it("wraps the product root base styles in @layer base, with px font size and ui-rounded font", () => {
    expect(rawStyles()).toMatch(/@layer base\s*\{[\s\S]*\.cc\s*\{[\s\S]*font-size:\s*14px/);
    expect(css).toMatch(/--font-ui:\s*ui-rounded/);
  });

  it("pads a line of text sitting directly in a card body, so the rounded corner does not clip it (R5.5 footer)", () => {
    expect(css).toMatch(/\[data-part="body"\]\s*>\s*\[data-part="text"\]\s*\{[^}]*padding:\s*8px 16px 14px/);
  });

  it("stops the breathing and pop animations under prefers-reduced-motion (R1.3, R13.3)", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.cc-breathe[^}]*animation:\s*none !important/);
  });

  it("also stops transitions (hover lift, switch thumb, paw scale) under prefers-reduced-motion (R13.3)", () => {
    const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/transition:\s*none !important/);
  });

  it("defines the sticker utility (outline + lift shadow)", () => {
    expect(css).toMatch(/\.sticker\s*\{[^}]*border:\s*1\.5px solid var\(--outline\)[^}]*box-shadow:\s*var\(--lift\)/);
  });
});

describe("shadowSafe", () => {
  it("adds unconditional fallbacks for @property registrations, which shadow roots ignore", () => {
    const input = `@property --tw-shadow { syntax: "*"; inherits: false; initial-value: 0 0 #0000; }
@property --tw-ring-inset { syntax: "*"; inherits: false; }
.a { color: red; }`;
    const out = shadowSafe(input);
    expect(out.endsWith(input)).toBe(true);
    expect(out.startsWith("@layer properties")).toBe(true);
    expect(out).toMatch(/\*,\s*::before,\s*::after,\s*::backdrop\s*\{[^}]*--tw-shadow:\s*0 0 #0000;[^}]*--tw-ring-inset:\s*initial;/);
  });

  it("leaves CSS without @property untouched", () => {
    expect(shadowSafe(".a{color:red}")).toBe(".a{color:red}");
  });

  it("covers every @property the compiled stylesheet registers", () => {
    const props = [...css.matchAll(/@property\s+(--[\w-]+)/g)].map((m) => m[1]!);
    expect(props.length).toBeGreaterThan(0);
    const out = shadowSafe(css);
    const fallback = out.slice(0, out.length - css.length);
    for (const p of props) expect(fallback).toContain(`${p}:`);
  });

  it("floating surfaces are opaque in light and dark: plain token fills, and the pop animation never fades them (R13.4, R1.7)", () => {
    for (const bg of ["bg-fur", "bg-paper"]) {
      expect(block(css, `.${bg}`)).toMatch(new RegExp(`^\\s*background-color:\\s*var\\(--${bg.slice(3)}\\);?\\s*$`));
    }
    // tokens behind those fills are solid hex in both themes
    for (const scope of [":host", ":host(.dark)"]) {
      const b = block(css, scope);
      expect(b).toMatch(/--paper: #[0-9a-f]{6};/);
      expect(b).toMatch(/--fur: #[0-9a-f]{6};/);
    }
    // a frame caught mid-animation would show the page through the window and card
    const pop = /@keyframes cc-pop\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(pop).toContain("transform");
    expect(pop).not.toContain("opacity");
  });
});
