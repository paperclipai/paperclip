---
name: gstack-document-release
description: >
  Post-ship documentation update. Reads all project docs, cross-references the
  diff, updates README/ARCHITECTURE/CONTRIBUTING/CLAUDE.md to match what shipped,
  polishes CHANGELOG voice, cleans up TODOS, and optionally bumps VERSION. Use when
  asked to "update the docs", "sync documentation", or "post-ship docs".
  Proactively suggest after a PR is merged or code is shipped.
---

# Document Release: Post-Ship Documentation Update

You are running the `/gstack-document-release` workflow. This runs **after shipping** (code committed, PR exists or about to exist) but **before the PR merges**. Your job: ensure every documentation file in the project is accurate, up to date, and written in a friendly, user-forward voice.

You are mostly automated. Make obvious factual updates directly. Stop and ask only for risky or subjective decisions.

**Only stop for:**
- Risky/questionable doc changes (narrative, philosophy, security, removals, large rewrites)
- VERSION bump decision (if not already bumped)
- New TODOS items to add
- Cross-doc contradictions that are narrative (not factual)

**Never stop for:**
- Factual corrections clearly from the diff
- Adding items to tables/lists
- Updating paths, counts, version numbers
- Fixing stale cross-references
- CHANGELOG voice polish (minor wording adjustments)
- Marking TODOS complete
- Cross-doc factual inconsistencies (e.g., version number mismatch)

**NEVER do:**
- Overwrite, replace, or regenerate CHANGELOG entries — polish wording only
- Bump VERSION without asking — always use AskUserQuestion for version changes
- Use `Write` tool on CHANGELOG.md — always use `Edit` with exact matches

---

## Step 0: Detect base branch

Determine which branch this PR targets:

1. Check if a PR already exists:
   ```bash
   gh pr view --json baseRefName -q .baseRefName
   ```

2. If no PR exists, detect default branch:
   ```bash
   gh repo view --json defaultBranchRef -q .defaultBranchRef.name
   ```

3. If both fail, fall back to `main`.

---

## Step 1: Pre-flight & Diff Analysis

1. Check the current branch. If on the base branch, **abort**: "You're on the base branch. Run from a feature branch."

2. Gather context about what changed:
   ```bash
   git diff <base>...HEAD --stat
   git log <base>..HEAD --oneline
   git diff <base>...HEAD --name-only
   ```

3. Discover all documentation files:
   ```bash
   find . -maxdepth 2 -name "*.md" -not -path "./.git/*" -not -path "./node_modules/*" -not -path "./.gstack/*" -not -path "./.context/*" | sort
   ```

4. Classify the changes:
   - **New features** — new files, new commands, new capabilities
   - **Changed behavior** — modified services, updated APIs, config changes
   - **Removed functionality** — deleted files, removed commands
   - **Infrastructure** — build system, test infrastructure, CI

---

## Step 2: Per-File Documentation Audit

Read each documentation file and cross-reference against the diff.

**README.md:**
- Does it describe all features visible in the diff?
- Are install/setup instructions consistent?
- Are examples still valid?
- Are troubleshooting steps accurate?

**ARCHITECTURE.md:**
- Do ASCII diagrams match current code?
- Are design decisions still accurate?
- Be conservative — only update things clearly contradicted by the diff

**CONTRIBUTING.md:**
- Are listed commands accurate?
- Do test tier descriptions match current infrastructure?
- Are workflow descriptions current?

**CLAUDE.md:**
- Does project structure section match actual file tree?
- Are listed commands accurate?
- Do build/test instructions match package.json?

For each file, classify needed updates:
- **Auto-update** — Factual corrections clearly warranted
- **Ask user** — Narrative changes, section removal, large rewrites

---

## Step 3: Apply Auto-Updates

Make all clear, factual updates directly using the Edit tool.

For each file modified, output a one-line summary: "README.md: added /new-skill to skills table, updated skill count from 9 to 10."

**Never auto-update:**
- README introduction or project positioning
- ARCHITECTURE philosophy or design rationale
- Security model descriptions
- Do not remove entire sections from any document

---

## Step 4: Ask About Risky/Questionable Changes

For each risky update, use AskUserQuestion with:
- Context: project name, branch, which doc file
- The specific documentation decision
- Options including C) Skip — leave as-is

Apply approved changes immediately.

---

## Step 5: CHANGELOG Voice Polish

**CRITICAL — NEVER CLOBBER CHANGELOG ENTRIES.**

Rules:
1. Read the entire CHANGELOG.md first
2. Only modify wording within existing entries
3. Never delete, reorder, or replace entries
4. Never regenerate from scratch
5. If entry looks wrong, use AskUserQuestion — do NOT silently fix
6. Use Edit tool with exact matches — never Write

**If CHANGELOG was not modified:** skip this step.

**If CHANGELOG was modified:** review the entry for voice:
- Lead with what the user can now **do** — not implementation details
- "You can now..." not "Refactored the..."
- Flag and rewrite any entry that reads like a commit message
- Auto-fix minor voice adjustments

---

## Step 6: Cross-Doc Consistency Check

1. Does README's feature list match CLAUDE.md?
2. Does ARCHITECTURE's component list match CONTRIBUTING's structure description?
3. Does CHANGELOG's latest version match VERSION file?
4. **Discoverability:** Is every doc file reachable from README.md or CLAUDE.md?
5. Flag any contradictions between documents

---

## Step 7: TODOS.md Cleanup

If TODOS.md exists:

1. **Completed items not yet marked:** Cross-reference diff against open TODOs. Mark items clearly completed by the changes.

2. **Items needing description updates:** If a TODO references files that changed significantly, ask whether to update.

3. **New deferred work:** Check diff for `TODO`, `FIXME`, `HACK` comments. Ask whether to capture in TODOS.md.

---

## Step 8: VERSION Bump Question

**CRITICAL — NEVER BUMP VERSION WITHOUT ASKING.**

1. If VERSION does not exist: Skip silently.

2. Check if VERSION was already modified:
   ```bash
   git diff <base>...HEAD -- VERSION
   ```

3. **If VERSION was NOT bumped:** Use AskUserQuestion:
   - A) Bump PATCH (X.Y.Z+1)
   - B) Bump MINOR (X.Y+1.0)
   - C) Skip — no version bump needed

4. **If VERSION was already bumped:** Check whether the bump covers full scope of changes. If not, ask about additional bump.

---

## Step 9: Commit & Output

**Empty check first:** Run `git status`. If no documentation files were modified, output "All documentation is up to date." and exit without committing.

**Commit:**

1. Stage modified documentation files by name (never `git add -A`).
2. Create a single commit:
   ```bash
   git commit -m "docs: update project documentation for vX.Y.Z.W"
   ```

3. Push to current branch.

**PR body update:**

1. Read existing PR body
2. If it contains a `## Documentation` section, replace it
3. Otherwise, append a `## Documentation` section
4. Include doc diff preview for each file modified

**Structured doc health summary:**
```
Documentation health:
  README.md       [status] ([details])
  ARCHITECTURE.md [status] ([details])
  CONTRIBUTING.md [status] ([details])
  CHANGELOG.md    [status] ([details])
  TODOS.md        [status] ([details])
  VERSION         [status] ([details])
```

---

## Important Rules

- **Read before editing.** Always read the full content of a file before modifying.
- **Never clobber CHANGELOG.** Polish wording only.
- **Never bump VERSION silently.** Always ask.
- **Be explicit about what changed.** Every edit gets a one-line summary.
- **Generic heuristics.** The audit checks work on any repo.
- **Discoverability matters.** Every doc should be reachable from README or CLAUDE.md.
