---
name: release-changelog
description: >
  Generate the stable Paperclip release changelog at releases/vYYYY.MDD.P.md by
  reading commits, changesets, and merged PR context since the last stable tag.
---

# Release Changelog Skill

Generate the user-facing changelog for the **stable** Paperclip release.

## Versioning Model

Paperclip uses **calendar versioning (calver)**:

- Stable releases: `YYYY.MDD.P` (e.g. `2026.318.0`)
- Canary releases: `YYYY.MDD.P-canary.N` (e.g. `2026.318.1-canary.0`)
- Git tags: `vYYYY.MDD.P` for stable, `canary/vYYYY.MDD.P-canary.N` for canary

There are no major/minor/patch bumps. The stable version is derived from the
intended release date (UTC) plus the next same-day stable patch slot.

Output:

- `releases/vYYYY.MDD.P.md`

Important rules:

- even if there are canary releases such as `2026.318.1-canary.0`, the changelog file stays `releases/v2026.318.1.md`
- do not derive versions from semver bump types
- do not create canary changelog files

## Step 0 — Idempotency Check

Before generating anything, check whether the file already exists:

```bash
ls releases/vYYYY.MDD.P.md 2>/dev/null
```

If it exists:

1. read it first
2. present it to the reviewer
3. ask whether to keep it, regenerate it, or update specific sections
4. never overwrite it silently

## Step 1 — Determine the Stable Range

Find the last stable tag:

```bash
git tag --list 'v*' --sort=-version:refname | head -1
git log v{last}..HEAD --oneline --no-merges
```

The stable version comes from one of:

- an explicit maintainer request
- `./scripts/release.sh stable --date YYYY-MM-DD --print-version`
- the release plan already agreed in `doc/RELEASING.md`

Do not derive the changelog version from a canary tag or prerelease suffix.
Do not derive major/minor/patch bumps from API intent — calver uses the date and same-day stable slot.

## Step 2 — Gather the Raw Inputs

Collect release data from:

1. git commits since the last stable tag
2. `.changeset/*.md` files
3. merged PRs via `gh` when available

Useful commands:

```bash
git log v{last}..HEAD --oneline --no-merges
git log v{last}..HEAD --format="%H %s" --no-merges
ls .changeset/*.md | grep -v README.md
gh pr list --state merged --search "merged:>={last-tag-date}" --json number,title,body,labels
```

## Step 3 — Detect Breaking Changes

Look for:

- destructive migrations
- removed or changed API fields/endpoints
- renamed or removed config keys
- `BREAKING:` or `BREAKING CHANGE:` commit signals

Key commands:

```bash
git diff --name-only v{last}..HEAD -- packages/db/src/migrations/
git diff v{last}..HEAD -- packages/db/src/schema/
git diff v{last}..HEAD -- server/src/routes/ server/src/api/
git log v{last}..HEAD --format="%s" | rg -n 'BREAKING CHANGE|BREAKING:|^[a-z]+!:' || true
```

If breaking changes are detected, flag them prominently — they must appear in the
Breaking Changes section with an upgrade path.

## Step 4 — Categorize for Users

Use these stable changelog sections:

- `Breaking Changes`
- `Highlights`
- `Improvements`
- `Fixes`
- `Upgrade Guide` when needed

Exclude purely internal refactors, CI changes, and docs-only work unless they materially affect users.

Guidelines:

- group related commits into one user-facing entry
- write from the user perspective
- keep highlights short and concrete
- spell out upgrade actions for breaking changes

### Inline PR and contributor attribution

When a bullet item clearly maps to a merged pull request, add inline attribution at the
end of the entry in this format:

```
- **Feature name** — Description. ([#123](https://github.com/paperclipai/paperclip/pull/123), @contributor1, @contributor2)
```

Rules:

- Only add a PR link when you can confidently trace the bullet to a specific merged PR.
  Use merge commit messages (`Merge pull request #N from user/branch`) to map PRs.
- List the contributor(s) who authored the PR. Use GitHub usernames, not real names or emails.
- If multiple PRs contributed to a single bullet, list them all: `([#10](url), [#12](url), @user1, @user2)`.
- If you cannot determine the PR number or contributor with confidence, omit the attribution
  parenthetical — do not guess.
- Core maintainer commits that don't have an external PR can omit the parenthetical.

## Step 5 — Write the File

Template:

```markdown
# vYYYY.MDD.P

> Released: YYYY-MM-DD

## Breaking Changes

## Highlights

## Improvements

## Fixes

## Upgrade Guide

## Contributors

Thank you to everyone who contributed to this release!

@username1, @username2, @username3
```

Omit empty sections except `Highlights`, `Improvements`, and `Fixes`, which should usually exist.

The `Contributors` section should always be included. List every person who authored
commits in the release range, @-mentioning them by their **GitHub username** (not their
real name or email). To find GitHub usernames:

1. Extract usernames from merge commit messages: `git log v{last}..HEAD --oneline --merges` — the branch prefix (e.g. `from username/branch`) gives the GitHub username.
2. For noreply emails like `user@users.noreply.github.com`, the username is the part before `@`.
3. For contributors whose username is ambiguous, check `gh api users/{guess}` or the PR page.

**Never expose contributor email addresses.** Use `@username` only.

Exclude bot accounts (e.g. `lockfile-bot`, `dependabot`) from the list. List contributors
in alphabetical order by GitHub username (case-insensitive).

## Step 6 — Review Before Release

Before handing it off:

1. confirm the heading is the stable version only
2. confirm there is no `-canary` language in the title or filename
3. confirm any breaking changes have an upgrade path
4. present the draft for human sign-off

This skill never publishes anything. It only prepares the stable changelog artifact.
