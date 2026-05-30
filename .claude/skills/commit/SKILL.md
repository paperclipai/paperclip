---
name: commit
description: Standardized commit workflow with pre-flight checks and retry logic for pre-commit hooks
---

# Commit Workflow

Self-healing commit sequence: pre-flight → stage → commit with retry → verify.

## Step 1 — Pre-flight

```bash
git branch --show-current        # Must NOT be master/main directly
git status                       # Identify all modified/untracked files
git diff --staged --name-only    # What's already staged?
```

If on `master` or `main`: **STOP** and ask user.

## Step 2 — Stage files

Stage only files relevant to the current change. Never `git add .` blindly.

```bash
git add <file1> <file2>    # Preferred: explicit files
# OR
git add -u                  # All tracked modifications (safe if worktree is clean)

# Verify:
git diff --staged --name-only
```

If unrecognized files appear: `git restore --staged <file>`

## Step 3 — Commit with retry loop

Attempt up to **3 times**, fixing hook failures between attempts:

```bash
for ATTEMPT in 1 2 3; do
    git commit -m "$(cat <<'MSG'
<type>(scope): <description>
MSG
)" && echo "Committed on attempt $ATTEMPT" && break
    echo "Hook failed. Re-staging modified files..."
    git add -u
done
```

**NEVER use `--no-verify`.** Fix the underlying issue.

## Step 4 — Post-commit verification

```bash
git log -1 --stat
git diff           # Must be empty
git diff --staged  # Must be empty
```

## Commit Message Format

```
<type>(scope): <description>
```

Types: `feat` · `fix` · `refactor` · `test` · `docs` · `chore` · `perf`

## Common Hook Failures

| Hook | Symptom | Fix |
|------|---------|-----|
| eslint | lint errors | `pnpm lint --fix` then `git add -u` |
| tsc | type errors | Fix types then `git add <file>` |
| prettier | formatting | `pnpm format` then `git add -u` |
