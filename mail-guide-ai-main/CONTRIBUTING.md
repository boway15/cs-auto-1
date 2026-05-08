# Contributing Guide

## Commit Message Convention

Use Conventional Commit format:

`<type>(<scope>): <description>`

Examples:

- `feat(auth): add login throttling`
- `fix(sync): avoid duplicate email insert`
- `chore: update supabase function env docs`

Supported types:

- `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`, `revert`

Local check:

- `npm run commit:check` (validates latest commit subject)
- `npm run commit:check -- "feat(api): add retry logic"` (validates an explicit message)

## Changelog

Generate/update changelog from conventional commits:

- `npm run changelog`

This command reads commits since the latest tag and appends a new section for the current `package.json` version.

## Release and Tag

Release commands (automatic version bump + changelog + commit + tag):

- `npm run release:patch`
- `npm run release:minor`
- `npm run release:major`

Each release command does:

1. Ensure git working tree is clean
2. Bump `package.json` version
3. Regenerate `CHANGELOG.md`
4. Commit as `chore(release): vX.Y.Z`
5. Create git tag `vX.Y.Z`

Publish release commit and tag:

- `git push origin HEAD --follow-tags`
