import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CHANGELOG_PATH = resolve(process.cwd(), "CHANGELOG.md");

const TYPE_TITLES = {
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance",
  refactor: "Refactoring",
  docs: "Documentation",
  test: "Tests",
  build: "Build System",
  ci: "CI",
  chore: "Chores",
  revert: "Reverts",
};

function run(command) {
  return execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function getLatestTag() {
  try {
    return run("git describe --tags --abbrev=0");
  } catch {
    return "";
  }
}

function getCommitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const raw = run(`git log ${range} --pretty=format:%s`);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseConventionalCommit(subject) {
  const match = subject.match(
    /^(?<type>[a-z]+)(\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<desc>.+)$/
  );
  if (!match?.groups) return null;
  return {
    type: match.groups.type,
    scope: match.groups.scope || "",
    breaking: Boolean(match.groups.breaking),
    desc: match.groups.desc,
  };
}

function getCurrentVersion() {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
  return pkg.version;
}

function renderSection(title, items) {
  if (!items.length) return "";
  const lines = items.map((it) =>
    it.scope ? `- **${it.scope}**: ${it.desc}` : `- ${it.desc}`
  );
  return `### ${title}\n${lines.join("\n")}\n\n`;
}

function main() {
  const latestTag = getLatestTag();
  const subjects = getCommitsSince(latestTag);
  const parsed = subjects.map(parseConventionalCommit).filter(Boolean);

  if (!parsed.length) {
    console.log("No conventional commits found since last tag. Changelog unchanged.");
    return;
  }

  const version = getCurrentVersion();
  const date = new Date().toISOString().slice(0, 10);
  const header = `## v${version} - ${date}\n\n`;

  const grouped = new Map();
  for (const item of parsed) {
    if (!grouped.has(item.type)) grouped.set(item.type, []);
    grouped.get(item.type).push(item);
  }

  let body = "";
  for (const type of Object.keys(TYPE_TITLES)) {
    body += renderSection(TYPE_TITLES[type], grouped.get(type) || []);
  }

  const breaking = parsed.filter((p) => p.breaking);
  if (breaking.length) {
    body += renderSection("Breaking Changes", breaking);
  }

  if (!body) {
    console.log("No mapped changelog entries found. Changelog unchanged.");
    return;
  }

  const intro = "# Changelog\n\n";
  const existing = existsSync(CHANGELOG_PATH)
    ? readFileSync(CHANGELOG_PATH, "utf8")
    : intro;
  const normalized = existing.startsWith("# Changelog") ? existing : `${intro}${existing}`;
  const withoutHeader = normalized.replace(/^# Changelog\s*\n\s*/m, "");
  const next = `${intro}${header}${body}${withoutHeader.trim()}\n`;

  writeFileSync(CHANGELOG_PATH, next, "utf8");
  console.log(`Changelog updated at ${CHANGELOG_PATH}`);
}

main();
