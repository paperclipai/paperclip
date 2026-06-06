---
name: parallel
description: Safely dispatch parallel agents to work on multiple issues simultaneously with worktree isolation
---

# Parallel Agent Dispatch

Orchestrate multiple Claude agents on separate issues using isolated git worktrees.

## When to Use

**Good:** 3-6 independent issues that don't touch overlapping files.
**Bad:** Issues with file conflicts or dependencies on each other.

## Pre-Flight (run ALL before spawning agents)

```bash
# 1. Main session must stay on master — never on a feature branch
git branch --show-current   # Must be: master

# 2. Must be clean
git status --porcelain       # Must be empty

# 3. No stale worktrees
ls .worktrees/ 2>/dev/null

# 4. Bash permission is approved (agents inherit from parent session)
echo "Bash approved"
```

## Create Worktrees

```bash
git worktree add .worktrees/issue-XXXX -b fix/issue-XXXX origin/master
cd .worktrees/issue-XXXX && git branch --unset-upstream
```

Each agent works ONLY in its own `.worktrees/issue-XXXX/` directory.

## Agent Rules

- **Max 3 agents per batch** to avoid API rate limiting
- Agents commit locally only — they do NOT push
- Main session handles all `git push` and `gh pr create`
- If an agent loses Bash permissions: STOP, report — do not retry

## Every Agent Prompt Must Include

1. Exact worktree path: `.worktrees/issue-XXXX/`
2. Issue number and description
3. Verification commands: `pnpm -r typecheck && pnpm test:run && pnpm build`
4. "You have Bash, Read, Edit, Write, Grep, and Glob permissions. If you lose Bash permissions, STOP immediately and report."

## After Agents Complete

```bash
# Review diff for each completed agent
cd .worktrees/issue-XXXX
git diff master..HEAD

# Verify
pnpm -r typecheck && pnpm test:run && pnpm build

# Push (from main session — agents don't push)
git push -u origin fix/issue-XXXX

# Create PR
gh pr create --base master --title "..." --body "..."

# Clean up
git worktree remove .worktrees/issue-XXXX
git branch -d fix/issue-XXXX
```
