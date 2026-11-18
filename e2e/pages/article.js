// External on purpose: the strict-CSP variant allows script-src 'self' only.
// CSP violations are counted on <html> (not <body>, so a page snapshot is unaffected): data-csp-violations.
const violations = [];
document.addEventListener("securitypolicyviolation", (e) => {
  violations.push(`${e.violatedDirective} ${e.blockedURI}`);
  document.documentElement.dataset.cspViolations = String(violations.length);
  document.documentElement.dataset.cspLast = violations.at(-1);
});
document.documentElement.dataset.cspViolations = "0";

// The button adds a paragraph right below it, inside the first screen, as a page that loads content late would.
document.addEventListener("DOMContentLoaded", () => {
  let n = 0;
  document.getElementById("append").addEventListener("click", () => {
    const p = document.createElement("p");
    p.className = "appended";
    p.textContent = `Appended paragraph ${++n} arrived after the page had loaded.`;
    document.getElementById("appended").append(p);
  });
});
