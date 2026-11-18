import assert from "node:assert/strict";
import test from "node:test";
import { bumpVersion, groupCommits, renderChangelog, prependChangelog, release } from "./release.mjs";

test("bumpVersion: explicit, patch, minor", () => {
  assert.equal(bumpVersion("0.2.0", "patch"), "0.2.1");
  assert.equal(bumpVersion("0.2.5", "minor"), "0.3.0");
  assert.equal(bumpVersion("0.2.0", "1.0.0"), "1.0.0");
  assert.throws(() => bumpVersion("0.2.0", "banana"), /version/);
  assert.throws(() => bumpVersion("0.2.0", "0.2.0"), /greater/);
  assert.throws(() => bumpVersion("0.2.0", "0.1.9"), /greater/);
});

test("groupCommits groups by feat, fix, docs, test and drops the rest", () => {
  const g = groupCommits(["feat(ui): a", "fix: b", "docs: c", "test: d", "feat!: e", "chore: f", "random words"]);
  assert.deepEqual(g, { feat: ["a", "e"], fix: ["b"], docs: ["c"], test: ["d"] });
});

test("renderChangelog orders sections and is stable for empty input", () => {
  const md = renderChangelog("0.3.0", "2026-11-18", { feat: ["a"], fix: ["b"], docs: [], test: ["d"] });
  assert.equal(md, "## 0.3.0 (2026-11-18)\n\n### 新功能\n\n- a\n\n### 修复\n\n- b\n\n### 测试\n\n- d\n");
  assert.match(renderChangelog("0.3.0", "2026-11-18", {}), /无用户可见变更/);
});

test("prependChangelog keeps the title and puts the newest section first", () => {
  const out = prependChangelog("# 更新日志\n\n## 0.2.0 (x)\n\n- old\n", "## 0.3.0 (y)\n\n- new\n");
  assert.ok(out.startsWith("# 更新日志\n\n## 0.3.0"));
  assert.ok(out.indexOf("0.3.0") < out.indexOf("0.2.0"));
  assert.ok(prependChangelog("", "## 0.1.0 (y)\n").startsWith("# 更新日志\n\n## 0.1.0"));
});

function harness({ branch = "main", status = "", tag = "", behind = "0\t0", files = {} } = {}) {
  const calls = [];
  const fs = { ...files };
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    const j = args.join(" ");
    if (j === "rev-parse --abbrev-ref HEAD") return branch;
    if (j === "status --porcelain") return status;
    if (j === "fetch origin main") return "";
    if (j.startsWith("rev-list --left-right --count")) return behind;
    if (j.startsWith("describe --tags --abbrev=0")) {
      if (!tag) throw new Error("no tags");
      return tag;
    }
    if (j.startsWith("log ")) return "feat: one\nfix: two\nchore: x";
    return "";
  };
  const io = { read: (p) => fs[p] ?? "", write: (p, c) => void (fs[p] = c), log: (m) => calls.push(`LOG ${m}`) };
  return { calls, fs, run, io };
}
const PKG = JSON.stringify({ name: "x", version: "0.2.0" });

test("refuses off main, dirty tree, or behind origin; dry-run skips these gates", () => {
  let h = harness({ branch: "feat/x", files: { "package.json": PKG } });
  assert.throws(() => release(["minor"], h), /main/);
  h = harness({ status: " M a", files: { "package.json": PKG } });
  assert.throws(() => release(["minor"], h), /clean/);
  h = harness({ behind: "0\t2", files: { "package.json": PKG } });
  assert.throws(() => release(["minor"], h), /up to date/);
  h = harness({ branch: "feat/x", status: " M a", files: { "package.json": PKG } });
  assert.doesNotThrow(() => release(["minor", "--dry-run"], h));
});

test("first release (no tag) logs the whole history", () => {
  const h = harness({ files: { "package.json": PKG } });
  release(["patch", "--dry-run"], h);
  assert.ok(h.calls.some((c) => c === "git log --format=%s"), h.calls.join("\n"));
});

test("with a tag, logs only since it", () => {
  const h = harness({ tag: "v0.2.0", files: { "package.json": PKG } });
  release(["patch", "--dry-run"], h);
  assert.ok(h.calls.some((c) => c === "git log --format=%s v0.2.0..HEAD"));
});

test("dry-run never writes, commits, tags, pushes or calls gh", () => {
  const h = harness({ files: { "package.json": PKG } });
  release(["minor", "--dry-run"], h);
  assert.equal(h.fs["package.json"], PKG);
  assert.equal(h.fs["CHANGELOG.md"], undefined);
  assert.ok(!h.calls.some((c) => /^(git (commit|tag|push|add)|gh)/.test(c)), h.calls.join("\n"));
  assert.ok(h.calls.some((c) => c.startsWith("LOG") && c.includes("v0.3.0")));
});

test("a real release bumps, checks, commits explicit paths, tags, pushes, creates the gh release", () => {
  const h = harness({ files: { "package.json": PKG } });
  release(["minor"], h);
  assert.equal(JSON.parse(h.fs["package.json"]).version, "0.3.0");
  assert.match(h.fs["CHANGELOG.md"], /## 0\.3\.0/);
  const c = h.calls.filter((x) => !x.startsWith("LOG"));
  const at = (re) => c.findIndex((x) => re.test(x));
  const order = [/corepack pnpm test/, /corepack pnpm typecheck/, /corepack pnpm build/, /^git add -- package\.json CHANGELOG\.md$/, /^git commit -m chore: release v0\.3\.0 -- package\.json CHANGELOG\.md/, /^git tag v0\.3\.0/, /^git push origin main/, /^git push origin v0\.3\.0/, /^gh release create v0\.3\.0 dist\/companioncat\.user\.js dist\/companioncat\.meta\.js --notes /];
  const idx = order.map(at);
  assert.ok(idx.every((i) => i >= 0), `${idx} in\n${c.join("\n")}`);
  assert.deepEqual([...idx].sort((a, b) => a - b), idx);
});
