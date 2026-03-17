---
name: git-workflow-automation
category: dev-workflow
description: Automate the full git workflow in Claude Code — worktrees for parallel agent isolation, gh CLI for PRs, hooks for auto-commits, and the complete branch-to-merge loop. Use when hitting git lock errors with parallel agents, creating PRs from within Claude Code, setting up automated git workflows, or running multi-agent sessions safely. Triggers on: "git worktrees", "parallel agents git", "gh cli claude code", "git lock fix", "automated PR", "git lock error", "branch to PR", "full git loop", "multi-agent git isolation". NOT for: basic git tutorials, GitHub Actions CI setup, GitLab/Bitbucket workflows.
---

# Git Workflow Automation

Git + multi-agent Claude Code = a race condition waiting to happen. Two agents, one working tree, shared refs — someone hits `fatal: unable to lock ref` and everything stops.

The fix is two commands: `git worktree add` and `gh pr create`. The pattern is a loop: branch → implement → commit → PR → merge → cleanup. No human touching a terminal.

## Quick Entry

| Goal | Reference |
|---|---|
| Fix git lock errors right now | [01-why-it-breaks.md](references/01-why-it-breaks.md) |
| Isolate parallel agents with worktrees | [02-worktrees.md](references/02-worktrees.md) |
| Create and merge PRs from Claude Code | [03-gh-cli-loop.md](references/03-gh-cli-loop.md) |
| Branch naming and lifecycle strategy | [04-branch-strategy.md](references/04-branch-strategy.md) |
| Auto-commit hooks (PreToolUse, Stop) | [05-hooks.md](references/05-hooks.md) |
| Complete end-to-end loop walkthrough | [07-full-loop.md](references/07-full-loop.md) |

## The Core Pattern (30-Second Version)

```bash
# 1. Each agent gets its own worktree
git worktree add /tmp/worktree-agent-a feat/task-a
git worktree add /tmp/worktree-agent-b feat/task-b

# 2. Each agent works in its own directory — zero contention
# 3. Both create PRs with gh CLI
gh pr create --title "feat: task-a" --body "..." --base main

# 4. Cleanup
git worktree remove /tmp/worktree-agent-a
```
