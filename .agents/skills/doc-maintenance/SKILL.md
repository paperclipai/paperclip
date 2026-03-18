---
name: doc-maintenance
description: >
  Audit top-level documentation (README, SPEC, PRODUCT) against recent git
  history to find drift — shipped features missing from docs or features
  listed as upcoming that already landed. Proposes minimal edits, creates
  a branch, and opens a PR. Use when asked to review docs for accuracy,
  after major feature merges, or on a periodic schedule.
---

# Doc Maintenance Skill

Detect documentation drift and fix it via PR — no rewrites, no churn.

## When to Use

- Periodic doc review (e.g. weekly or after releases)
- After major feature merges
- When asked "are our docs up to date?"
- When asked to audit README / SPEC / PRODUCT accuracy

## Target Documents

| Document | Path | What matters |
|----------|------|-------------|
| README | `README.md` | Features table, roadmap, quickstart, "what is" accuracy, "works with" table |
| SPEC | `doc/SPEC.md` | No false "not supported" claims, major model/schema accuracy |
| PRODUCT | `doc/PRODUCT.md` | Core concepts, feature list, principles accuracy |

Out of scope: DEVELOPING.md, DATABASE.md, CLI.md, doc/plans/, skill files,
release notes. These are dev-facing or ephemeral — lower risk of user-facing
confusion.

## Workflow

### Step 1 — Detect what changed

Find the last review cursor:

```bash
# Read the last-reviewed commit SHA
CURSOR_FILE=".doc-review-cursor"
if [ -f "$CURSOR_FILE" ]; then
  LAST_SHA=$(cat "$CURSOR_FILE" | head -1)
else
  # First run: look back 60 days
  LAST_SHA=$(git log --format="%H" --after="60 days ago" --reverse | head -1)
fi
```

Then gather commits since the cursor:

```bash
git log "$LAST_SHA"..HEAD --oneline --no-merges
```

### Step 2 — Classify changes

Scan commit messages and changed files. Categorize into:

- **Feature** — new capabilities (keywords: `feat`, `add`, `implement`, `support`)
- **Breaking** — removed/renamed things (keywords: `remove`, `breaking`, `drop`, `rename`)
- **Structural** — new directories, config changes, new adapters, new CLI commands

**Ignore:** refactors, test-only changes, CI config, dependency bumps, doc-only
changes, style/formatting commits. These don't affect doc accuracy.

For borderline cases, check the actual diff — a commit titled "refactor: X"
that adds a new public API is a feature.

### Step 3 — Build a change summary

Produce a concise list like:

```
Since last review (<sha>, <date>):
- FEATURE: Plugin system merged (runtime, SDK, CLI, slots, event bridge)
- FEATURE: Project archiving added
- BREAKING: Removed legacy webhook adapter
- STRUCTURAL: New .agents/skills/ directory convention
```

If there are no notable changes, skip to Step 7 (update cursor and exit).

### Step 4 — Audit each target doc

For each target document, read it fully and cross-reference against the change
summary. Check for:

1. **False negatives** — major shipped features not mentioned at all
2. **False positives** — features listed as "coming soon" / "roadmap" / "planned"
   / "not supported" / "TBD" that already shipped
3. **Quickstart accuracy** — install commands, prereqs, and startup instructions
   still correct (README only)
4. **Feature table accuracy** — does the features section reflect current
   capabilities? (README only)
5. **Works-with accuracy** — are supported adapters/integrations listed correctly?

Use `references/audit-checklist.md` as the structured checklist.
Use `references/section-map.md` to know where to look for each feature area.

### Step 5 — Create branch and apply minimal edits

```bash
# Create a branch for the doc updates
BRANCH="docs/maintenance-$(date +%Y%m%d)"
git checkout -b "$BRANCH"
```

Apply **only** the edits needed to fix drift. Rules:

- **Minimal patches only.** Fix inaccuracies, don't rewrite sections.
- **Preserve voice and style.** Match the existing tone of each document.
- **No cosmetic changes.** Don't fix typos, reformat tables, or reorganize
  sections unless they're part of a factual fix.
- **No new sections.** If a feature needs a whole new section, note it in the
  PR description as a follow-up — don't add it in a maintenance pass.
- **Roadmap items:** Move shipped features out of Roadmap. Add a brief mention
  in the appropriate existing section if there isn't one already. Don't add
  long descriptions.

### Step 6 — Open a PR

Commit the changes and open a PR:

```bash
git add README.md doc/SPEC.md doc/PRODUCT.md .doc-review-cursor
git commit -m "docs: update documentation for accuracy

- [list each fix briefly]

Co-Authored-By: Paperclip <noreply@paperclip.ing>"

git push -u origin "$BRANCH"

gh pr create \
  --title "docs: periodic documentation accuracy update" \
  --body "$(cat <<'EOF'
## Summary
Automated doc maintenance pass. Fixes documentation drift detected since
last review.

### Changes
- [list each fix]

### Change summary (since last review)
- [list notable code changes that triggered doc updates]

## Review notes
- Only factual accuracy fixes — no style/cosmetic changes
- Preserves existing voice and structure
- Larger doc additions (new sections, tutorials) noted as follow-ups

🤖 Generated by doc-maintenance skill
EOF
)"
```

### Step 7 — Update the cursor

After a successful audit (whether or not edits were needed), update the cursor:

```bash
git rev-parse HEAD > .doc-review-cursor
```

If edits were made, this is already committed in the PR branch. If no edits
were needed, commit the cursor update to the current branch.

## Change Classification Rules

| Signal | Category | Doc update needed? |
|--------|----------|-------------------|
| `feat:`, `add`, `implement`, `support` in message | Feature | Yes if user-facing |
| `remove`, `drop`, `breaking`, `!:` in message | Breaking | Yes |
| New top-level directory or config file | Structural | Maybe |
| `fix:`, `bugfix` | Fix | No (unless it changes behavior described in docs) |
| `refactor:`, `chore:`, `ci:`, `test:` | Maintenance | No |
| `docs:` | Doc change | No (already handled) |
| Dependency bumps only | Maintenance | No |

## Patch Style Guide

- Fix the fact, not the prose
- If removing a roadmap item, don't leave a gap — remove the bullet cleanly
- If adding a feature mention, match the format of surrounding entries
  (e.g. if features are in a table, add a table row)
- Keep README changes especially minimal — it shouldn't churn often
- For SPEC/PRODUCT, prefer updating existing statements over adding new ones
  (e.g. change "not supported in V1" to "supported via X" rather than adding
  a new section)

## Output

When the skill completes, report:

- How many commits were scanned
- How many notable changes were found
- How many doc edits were made (and to which files)
- PR link (if edits were made)
- Any follow-up items that need larger doc work
