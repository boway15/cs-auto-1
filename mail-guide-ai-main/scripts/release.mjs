import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const RELEASE_TYPES = new Set(["patch", "minor", "major"]);

function run(command) {
  execSync(command, { stdio: "inherit" });
}

function runSilent(command) {
  return execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parseVersion(version) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid semver version in package.json: ${version}`);
  }
  return parts;
}

function bumpVersion(current, releaseType) {
  const [major, minor, patch] = parseVersion(current);
  if (releaseType === "major") return `${major + 1}.0.0`;
  if (releaseType === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function ensureCleanWorkingTree() {
  const status = runSilent("git status --porcelain");
  if (status) {
    throw new Error(
      "Working tree is not clean. Commit or stash changes before running release."
    );
  }
}

function main() {
  const releaseType = process.argv[2];
  if (!RELEASE_TYPES.has(releaseType)) {
    console.error("Usage: node scripts/release.mjs <patch|minor|major>");
    process.exit(1);
  }

  ensureCleanWorkingTree();

  const pkgPath = resolve(process.cwd(), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const current = pkg.version;
  const next = bumpVersion(current, releaseType);

  pkg.version = next;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  run("node scripts/generate-changelog.mjs");
  run("git add package.json CHANGELOG.md");
  run(`git commit -m "chore(release): v${next}"`);
  run(`git tag v${next}`);

  console.log("");
  console.log(`Release created: v${next}`);
  console.log("Next step:");
  console.log("  git push origin HEAD --follow-tags");
}

main();
