import { execSync } from "node:child_process";

const commitTypePattern =
  /^(feat|fix|chore|docs|refactor|test|build|ci|perf|revert)(\([^)]+\))?!?: .+/;

function getHeadCommitSubject() {
  return execSync("git log -1 --pretty=%s", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function main() {
  const provided = process.argv.slice(2).join(" ").trim();
  const message = provided || getHeadCommitSubject();

  if (!message) {
    console.error(
      "No commit message found. Pass one explicitly: node scripts/verify-commit-msg.mjs \"feat: ...\""
    );
    process.exit(1);
  }

  if (!commitTypePattern.test(message)) {
    console.error("Invalid commit message format:");
    console.error(`  "${message}"`);
    console.error("");
    console.error("Use Conventional Commit style, e.g.:");
    console.error("  feat(auth): add password reset flow");
    console.error("  fix(sync): avoid duplicate message insert");
    console.error("  chore: update dependencies");
    process.exit(1);
  }

  console.log(`Commit message is valid: "${message}"`);
}

main();
