/**
 * Other extensions and userscripts in the user's real browser mark up the test pages too (Immersive
 * Translate adds data-imt-* attributes and its own popup, and now and then leaves an empty style=""
 * on a paragraph it inspected). Before comparing a page's DOM, drop those marks so only the page's
 * own markup and 陪伴猫's changes count. An empty style attribute is inert, so dropping it hides no
 * visible leftover. Runs in the page: inject with `${stripForeign}` (it must stay self-contained).
 */
export function stripForeign(root) {
  const foreign = /^immersive-translate/;
  for (const el of [...root.querySelectorAll("*")]) {
    if (!root.contains(el)) continue; // inside an element already removed
    const cls = typeof el.className === "string" ? el.className.split(/\s+/) : [];
    if (foreign.test(el.localName) || foreign.test(el.id) || cls.some((c) => foreign.test(c))) {
      el.remove();
      continue;
    }
    for (const a of [...el.attributes]) if (/^data-(imt|immersive-translate)/.test(a.name)) el.removeAttribute(a.name);
    if (el.getAttribute("style") === "") el.removeAttribute("style");
  }
  return root;
}
