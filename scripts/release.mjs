#!/usr/bin/env node
/**
 * Release: node scripts/release.mjs <x.y.z|patch|minor> [--dry-run]
 * Gates (real run only): on main, clean tree, up to date with origin/main. Then bump package.json,
 * run test/typecheck/build, write the CHANGELOG.md section from conventional commits since the last
 * tag (whole history for the first release), commit by explicit paths, tag v<version>, push, and
 * `gh release create` with dist/companioncat.user.js + .meta.js.
 * --dry-run works from any branch: it skips the gates, the checks and every write, and only prints the plan.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECTIONS = [
  ["feat", "新功能"],
  ["fix", "修复"],
  ["docs", "文档"],
  ["test", "测试"],
];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const parse = (v) => SEMVER.exec(v)?.slice(1).map(Number);

export function bumpVersion(current, arg) {
  const cur = parse(current);
  if (!cur) throw new Error(`current version ${current} is not x.y.z`);
  let next;
  if (arg === "patch") next = [cur[0], cur[1], cur[2] + 1];
  else if (arg === "minor") next = [cur[0], cur[1] + 1, 0];
  else {
    next = parse(arg ?? "");
    if (!next) throw new Error(`version must be x.y.z, patch or minor, got ${arg}`);
  }
  const gt = next[0] - cur[0] || next[1] - cur[1] || next[2] - cur[2];
  if (gt <= 0) throw new Error(`new version ${next.join(".")} must be greater than ${current}`);
  return next.join(".");
}

export function groupCommits(subjects) {
  const groups = Object.fromEntries(SECTIONS.map(([k]) => [k, []]));
  for (const s of subjects) {
    const m = /^(feat|fix|docs|test)(?:\([^)]*\))?!?:\s*(.+)$/.exec(s.trim());
    if (m) groups[m[1]].push(m[2]);
  }
  return groups;
}

export function renderChangelog(version, date, groups) {
  let out = `## ${version} (${date})\n`;
  let any = false;
  for (const [k, title] of SECTIONS) {
    if (!groups[k]?.length) continue;
    any = true;
    out += `\n### ${title}\n\n${groups[k].map((l) => `- ${l}`).join("\n")}\n`;
  }
  if (!any) out += "\n- 无用户可见变更\n";
  return out;
}

export function prependChangelog(existing, section) {
  const title = "# 更新日志";
  const body = existing.startsWith(title) ? existing.slice(title.length).replace(/^\n+/, "") : existing;
  return `${title}\n\n${section}${body ? `\n${body}` : ""}`;
}

const defaultRun = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"] })?.trim() ?? "";
const defaultIo = {
  read: (p) => {
    try {
      return readFileSync(path.join(ROOT, p), "utf8");
    } catch {
      return "";
    }
  },
  write: (p, c) => writeFileSync(path.join(ROOT, p), c),
  log: (m) => console.log(m),
};

/** `run` and `io` are injected so tests never touch git, gh or the disk. */
export function release(argv, { run = defaultRun, io = defaultIo } = {}) {
  const dry = argv.includes("--dry-run");
  const arg = argv.find((a) => !a.startsWith("--"));
  const pkgText = io.read("package.json");
  const pkg = JSON.parse(pkgText);
  const version = bumpVersion(pkg.version, arg);
  const tag = `v${version}`;
  const git = (...a) => run("git", a);

  if (dry) io.log("[dry-run] skipping the main / clean tree / up-to-date gates, the checks and all writes");
  else {
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== "main") throw new Error(`must run on main, on ${branch}`);
    if (git("status", "--porcelain")) throw new Error("working tree must be clean");
    git("fetch", "origin", "main");
    const [ahead, behind] = git("rev-list", "--left-right", "--count", "HEAD...origin/main").split(/\s+/).map(Number);
    if (behind || ahead) throw new Error("main must be up to date with origin/main (not ahead or behind)");
  }

  let last = "";
  try {
    last = git("describe", "--tags", "--abbrev=0");
  } catch {}
  const subjects = git("log", "--format=%s", ...(last ? [`${last}..HEAD`] : [])).split("\n").filter(Boolean);
  const section = renderChangelog(version, new Date().toISOString().slice(0, 10), groupCommits(subjects));
  io.log(`release ${pkg.version} -> ${version} (${tag}), commits since ${last || "the beginning"}: ${subjects.length}\n\n${section}`);

  const checks = [["test"], ["typecheck"], ["build"]];
  const paths = ["package.json", "CHANGELOG.md"];
  const npm = (c) => run("corepack", ["pnpm", ...c], { inherit: true });
  if (dry) {
    io.log(
      [
        `[dry-run] would write package.json version ${version} and prepend the section to CHANGELOG.md`,
        `[dry-run] would run: ${checks.map((c) => `corepack pnpm ${c[0]}`).join(", ")}`,
        `[dry-run] would run: git add -- ${paths.join(" ")}; git commit -m "chore: release ${tag}" -- ${paths.join(" ")}`,
        `[dry-run] would run: git tag ${tag}; git push origin main; git push origin ${tag}`,
        `[dry-run] would run: gh release create ${tag} dist/companioncat.user.js dist/companioncat.meta.js --notes <section above>`,
      ].join("\n"),
    );
    return { version, tag, section };
  }

  io.write("package.json", pkgText.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
  io.write("CHANGELOG.md", prependChangelog(io.read("CHANGELOG.md"), section));
  for (const c of checks) npm(c);
  run("git", ["add", "--", ...paths]);
  run("git", ["commit", "-m", `chore: release ${tag}`, "--", ...paths]);
  run("git", ["tag", tag]);
  run("git", ["push", "origin", "main"]);
  run("git", ["push", "origin", tag]);
  run("gh", ["release", "create", tag, "dist/companioncat.user.js", "dist/companioncat.meta.js", "--notes", section]);
  io.log(`released ${tag}`);
  return { version, tag, section };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    release(process.argv.slice(2));
  } catch (e) {
    console.error(`release: ${e.message}`);
    process.exit(1);
  }
}
