---
name: release-changelog
description: >
  Generate user-facing release changelogs for Paperclip. Reads git history,
  merged PRs, and changeset files since the last release tag. Detects breaking
  changes, categorizes changes, and outputs structured markdown to
  releases/v{version}.md. Use when preparing a release or when asked to
  generate a changelog.
---

# Release Changelog Skill

Generate a user-facing changelog for a new Paperclip release. This skill reads
the commit history, changeset files, and merged PRs since the last release tag,
detects breaking changes, categorizes everything, and writes a structured
release notes file.

**Output:** `releases/v{version}.md` in the repo root.
**Review required:** Always present the draft for human sign-off before
finalizing. Never auto-publish.

---

## Step 0 — Idempotency Check

Before generating anything, check if a changelog already exists for this version:

```bash
ls releases/v{version}.md 2>/dev/null
```

**If the file already exists:**

1. Read the existing changelog and present it to the reviewer.
2. Ask: "A changelog for v{version} already exists. Do you want to (a) keep it
   as-is, (b) regenerate from scratch, or (c) update specific sections?"
3. If the reviewer says keep it → **stop here**. Do not overwrite. This skill is
   done.
4. If the reviewer says regenerate → back up the existing file to
   `releases/v{version}.md.prev`, then proceed from Step 1.
5. If the reviewer says update → read the existing file, proceed through Steps
   1-4 to gather fresh data, then merge changes into the existing file rather
   than replacing it wholesale. Preserve any manual edits the reviewer previously
   made.

**If the file does not exist:** Proceed normally from Step 1.

**Critical rule:** This skill NEVER triggers a version bump. It only reads git
history and writes a markdown file. The `release.sh` script is the only thing
that bumps versions, and it is called separately by the `release` coordination
skill. Running this skill multiple times is always safe — worst case it
overwrites a draft changelog (with reviewer permission).

---

## Step 1 — Determine the Release Range

Find the last release tag and the planned version:

```bash
# Last release tag (most recent semver tag)
git tag --sort=-version:refname | head -1
# e.g. v0.2.7

# All commits since that tag
git log v0.2.7..HEAD --oneline --no-merges
```

If no tag exists yet, use the initial commit as the base.

The new version number comes from one of:
- An explicit argument (e.g. "generate changelog for v0.3.0")
- The bump type (patch/minor/major) applied to the last tag
- The version already set in `cli/package.json` if `scripts/release.sh` has been run

---

## Step 2 — Gather Raw Change Data

Collect changes from three sources, in priority order:

### 2a. Git Commits

```bash
git log v{last}..HEAD --oneline --no-merges
git log v{last}..HEAD --format="%H %s" --no-merges   # full SHAs for file diffs
```

### 2b. Changeset Files

Look for unconsumed changesets in `.changeset/`:

```bash
ls .changeset/*.md | grep -v README.md
```

Each changeset file has YAML frontmatter with package names and bump types
(`patch`, `minor`, `major`), followed by a description. Parse these — the bump
type is a strong categorization signal, and the description may contain
user-facing summaries.

### 2c. Merged PRs (when available)

If GitHub access is available via `gh`:

```bash
gh pr list --state merged --search "merged:>={last-tag-date}" --json number,title,body,labels
```

PR titles and bodies are often the best source of user-facing descriptions.
Prefer PR descriptions over raw commit messages when both are available.

---

## Step 3 — Detect Breaking Changes

Scan for breaking changes using these signals. **Any match flags the release as
containing breaking changes**, which affects version bump requirements and
changelog structure.

### 3a. Migration Files

Check for new migration files since the last tag:

```bash
git diff --name-only v{last}..HEAD -- packages/db/src/migrations/
```

- **New migration files exist** = DB migration required in upgrade.
- Inspect migration content: look for `DROP`, `ALTER ... DROP`, `RENAME` to
  distinguish destructive vs. additive migrations.
- Additive-only migrations (new tables, new nullable columns, new indexes) are
  safe but should still be mentioned.
- Destructive migrations (column drops, type changes, table drops) = breaking.

### 3b. Schema Changes

```bash
git diff v{last}..HEAD -- packages/db/src/schema/
```

Look for:
- Removed or renamed columns/tables
- Changed column types
- Removed default values or nullable constraints
- These indicate breaking DB changes even if no explicit migration file exists

### 3c. API Route Changes

```bash
git diff v{last}..HEAD -- server/src/routes/ server/src/api/
```

Look for:
- Removed endpoints
- Changed request/response shapes (removed fields, type changes)
- Changed authentication requirements

### 3d. Config Changes

```bash
git diff v{last}..HEAD -- cli/src/config/ packages/*/src/*config*
```

Look for renamed, removed, or restructured configuration keys.

### 3e. Changeset Severity

Any `.changeset/*.md` file with a `major` bump = explicitly flagged breaking.

### 3f. Commit Conventions

Scan commit messages for:
- `BREAKING:` or `BREAKING CHANGE:` prefix
- `!` after the type in conventional commits (e.g. `feat!:`, `fix!:`)

### Version Bump Rules

| Condition | Minimum Bump |
|---|---|
| Destructive migration (DROP, RENAME) | `major` |
| Removed API endpoints or fields | `major` |
| Any `major` changeset or `BREAKING:` commit | `major` |
| New (additive) migration | `minor` |
| New features (`feat:` commits, `minor` changesets) | `minor` |
| Bug fixes only | `patch` |

If the planned bump is lower than the minimum required, **warn the reviewer**
and recommend the correct bump level.

---

## Step 4 — Categorize Changes

Assign every meaningful change to one of these categories:

| Category | What Goes Here | Shows in User Notes? |
|---|---|---|
| **Breaking Changes** | Anything requiring user action to upgrade | Yes (top, with warning) |
| **Highlights** | New user-visible features, major behavioral changes | Yes (with 1-2 sentence descriptions) |
| **Improvements** | Enhancements to existing features | Yes (bullet list) |
| **Fixes** | Bug fixes | Yes (bullet list) |
| **Internal** | Refactoring, deps, CI, tests, docs | No (dev changelog only) |

### Categorization Heuristics

Use these signals to auto-categorize. When signals conflict, prefer the
higher-visibility category and flag for human review.

| Signal | Category |
|---|---|
| Commit touches migration files, schema changes | Breaking Change (if destructive) |
| Changeset marked `major` | Breaking Change |
| Commit message has `BREAKING:` or `!:` | Breaking Change |
| New UI components, new routes, new API endpoints | Highlight |
| Commit message starts with `feat:` or `add:` | Highlight or Improvement |
| Changeset marked `minor` | Highlight |
| Commit message starts with `fix:` or `bug:` | Fix |
| Changeset marked `patch` | Fix or Improvement |
| Commit message starts with `chore:`, `refactor:`, `ci:`, `test:`, `docs:` | Internal |
| PR has detailed body with user-facing description | Use PR body as the description |

### Writing Good Descriptions

- **Highlights** get 1-2 sentence descriptions explaining the user benefit.
  Write from the user's perspective ("You can now..." not "Added a component that...").
- **Improvements and Fixes** are concise bullet points.
- **Breaking Changes** get detailed descriptions including what changed,
  why, and what the user needs to do.
- Group related commits into a single changelog entry. Five commits implementing
  one feature = one Highlight entry, not five bullets.
- Omit purely internal changes from user-facing notes entirely.

---

## Step 5 — Write the Changelog

Output the changelog to `releases/v{version}.md` using this template:

```markdown
# v{version}

> Released: {YYYY-MM-DD}

{If breaking changes detected, include this section:}

## Breaking Changes

> **Action required before upgrading.** Read the Upgrade Guide below.

- **{Breaking change title}** — {What changed and why. What the user needs to do.}

## Highlights

- **{Feature name}** — {1-2 sentence description of what it does and why it matters.}

## Improvements

- {Concise description of improvement}

## Fixes

- {Concise description of fix}

---

{If breaking changes detected, include this section:}

## Upgrade Guide

### Before You Update

1. **Back up your database.**
   - SQLite: `cp paperclip.db paperclip.db.backup`
   - Postgres: `pg_dump -Fc paperclip > paperclip-pre-{version}.dump`
2. **Note your current version:** `paperclip --version`

### After Updating

{Specific steps: run migrations, update configs, etc.}

### Rolling Back

If something goes wrong:
1. Restore your database backup
2. `npm install @paperclipai/server@{previous-version}`
```

### Template Rules

- Omit any empty section entirely (don't show "## Fixes" with no bullets).
- The Breaking Changes section always comes first when present.
- The Upgrade Guide always comes last when present.
- Use `**bold**` for feature/change names, regular text for descriptions.
- Keep the entire changelog scannable — a busy user should get the gist from
  headings and bold text alone.

---

## Step 6 — Present for Review

After generating the draft:

1. **Show the full changelog** to the reviewer (CTO or whoever triggered the release).
2. **Flag ambiguous items** — commits you weren't sure how to categorize, or
   items that might be breaking but aren't clearly signaled.
3. **Flag version bump mismatches** — if the planned bump is lower than what
   the changes warrant.
4. **Wait for approval** before considering the changelog final.

If the reviewer requests edits, update `releases/v{version}.md` accordingly.

Do not proceed to publishing, website updates, or social announcements. Those
are handled by the `release` coordination skill (separate from this one).

---

## Directory Convention

Release changelogs live in `releases/` at the repo root:

```
releases/
  v0.2.7.md
  v0.3.0.md
  ...
```

Each file is named `v{version}.md` matching the git tag. This directory is
committed to the repo and serves as the source of truth for release history.

The `releases/` directory should be created with a `.gitkeep` if it doesn't
exist yet.

---

## Quick Reference

```bash
# Full workflow summary:

# 1. Find last tag
LAST_TAG=$(git tag --sort=-version:refname | head -1)

# 2. Commits since last tag
git log $LAST_TAG..HEAD --oneline --no-merges

# 3. Files changed (for breaking change detection)
git diff --name-only $LAST_TAG..HEAD

# 4. Migration changes specifically
git diff --name-only $LAST_TAG..HEAD -- packages/db/src/migrations/

# 5. Schema changes
git diff $LAST_TAG..HEAD -- packages/db/src/schema/

# 6. Unconsumed changesets
ls .changeset/*.md | grep -v README.md

# 7. Merged PRs (if gh available)
gh pr list --state merged --search "merged:>=$(git log -1 --format=%aI $LAST_TAG)" \
  --json number,title,body,labels
```
