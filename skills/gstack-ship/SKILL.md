---
name: gstack-ship
description: >
  Ship workflow: detect + merge base branch, run tests, review diff, bump VERSION,
  update CHANGELOG, commit, push, create PR. Use when asked to "ship", "deploy",
  "push to main", "create a PR", or "merge and push".
  Proactively suggest when the user says code is ready or asks about deploying.
---

# /gstack-ship: Ship Workflow

Ship code with confidence: merge base branch, run tests, review diff, bump version, update changelog, and create a PR.

## Step 0: Detect base branch

Determine which branch this PR targets:

1. Check if a PR already exists:
   ```bash
   gh pr view --json baseRefName -q .baseRefName
   ```

2. If no PR exists, detect the repo's default branch:
   ```bash
   gh repo view --json defaultBranchRef -q .defaultBranchRef.name
   ```

3. If both fail, fall back to `main`.

---

## Step 1: Merge base branch

```bash
git fetch origin <base>
git merge origin/<base> --no-edit
```

If conflicts occur, use AskUserQuestion:
- A) Help me resolve conflicts
- B) Abort — I'll handle this manually

---

## Step 2: Run tests

```bash
npm test
```

If tests fail, use AskUserQuestion:
- A) Fix the failing tests
- B) Skip tests for now (not recommended)
- C) Abort — I'll fix tests manually

---

## Step 3: Review diff

Show the full diff against base:
```bash
git diff origin/<base> --stat
git diff origin/<base>
```

Ask the user: "Does this diff look correct? Ready to ship?"

---

## Step 4: VERSION bump

Check if VERSION file exists:
```bash
cat VERSION 2>/dev/null || echo "NO_VERSION_FILE"
```

If VERSION exists and wasn't already bumped:
```bash
git diff origin/<base> -- VERSION
```

If VERSION was NOT modified, use AskUserQuestion:
- A) Bump PATCH (X.Y.Z+1)
- B) Bump MINOR (X.Y+1.0)
- C) Skip — no version bump needed

---

## Step 5: CHANGELOG update

If CHANGELOG.md exists, update it with the changes from this branch.

Format:
```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- [new features]

### Changed
- [changes to existing functionality]

### Fixed
- [bug fixes]
```

---

## Step 6: Commit documentation changes

If VERSION or CHANGELOG were modified:
```bash
git add VERSION CHANGELOG.md
git commit -m "chore: bump version to X.Y.Z and update changelog"
```

---

## Step 7: Push

```bash
git push origin HEAD
```

---

## Step 8: Create PR

Check if PR already exists:
```bash
gh pr view --json number 2>/dev/null
```

If no PR exists:
```bash
gh pr create --title "[PR title]" --body "[PR description]"
```

PR body should include:
- Summary of changes
- Test plan
- Screenshots (if applicable)

---

## Step 9: Review readiness check

Suggest running reviews before merging:
- `/gstack-review` — code review
- `/gstack-plan-eng-review` — engineering review (if significant changes)
- `/gstack-plan-design-review` — design review (if UI changes)

---

## Important Rules

- Always merge base branch before shipping
- Never skip failing tests without user approval
- Always update CHANGELOG for user-facing changes
- One logical change per commit
- Always create a PR (don't push directly to main)
