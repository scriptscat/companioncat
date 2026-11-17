/**
 * Shadow roots ignore `@property` (it only registers at document level), and Tailwind's own
 * fallback for that is gated to Safari/Firefox. Restate each registered property's initial value
 * on every element so utilities such as shadow/ring/translate work inside the shadow root.
 */
export function shadowSafe(css: string): string {
  const decls: string[] = [];
  for (const m of css.matchAll(/@property\s+(--[\w-]+)\s*\{([^}]*)\}/g)) {
    const initial = /initial-value\s*:\s*([^;]+?)\s*(;|$)/.exec(m[2]!)?.[1];
    decls.push(`${m[1]}: ${initial ?? "initial"};`);
  }
  if (!decls.length) return css;
  // first, so the layer sorts lowest even if the stylesheet never declared the layer order
  return `@layer properties {\n  *, ::before, ::after, ::backdrop { ${decls.join(" ")} }\n}\n${css}`;
}

/** Puts the stylesheet into the shadow root: a constructed sheet when possible (not subject to page CSP), else a <style>. */
export function adoptStyles(root: ShadowRoot, css: string) {
  const win = root.ownerDocument.defaultView;
  try {
    if (win && "adoptedStyleSheets" in root) {
      const sheet = new win.CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      return;
    }
  } catch {
    // fall through to a <style> element
  }
  const style = root.ownerDocument.createElement("style");
  style.textContent = css;
  root.prepend(style);
}
