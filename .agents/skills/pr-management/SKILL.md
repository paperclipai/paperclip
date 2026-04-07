---
name: pr-management
description: >
  End-to-end pull request lifecycle management for fork-based contributions.
  Covers branch creation, code changes, commit hygiene, pushing to forks,
  creating upstream PRs with the project template, and managing the review
  cycle. Use when creating PRs, managing branches, pushing to remotes, or
  coordinating fork-to-upstream workflows.
  Trigger phrases: "create a PR", "push to fork", "open pull request",
  "manage PR lifecycle", "submit upstream PR".
---

# PR Management Skill

Manage the full lifecycle of pull requests in a fork-based contribution model.

## When to Use

- Creating a new feature or fix branch
- Pushing changes to a fork remote
- Opening a PR against the upstream repository
- Managing the review-fix-push cycle
- Coordinating multiple related PRs

## Principles

1. **Branch-story alignment** — branch names must match the feature/fix being
   worked on (e.g. `feat/hermes-list-models`, `fix/hermes-toolsets-filter`)
2. **Template compliance** — every PR description must follow the repo's
   PR template (`.github/PULL_REQUEST_TEMPLATE.md`)
3. **Atomic PRs** — one logical change per PR, keep diffs reviewable
4. **Fork-first** — push to fork remote, PR against upstream

## Workflow

### Step 1 — Branch Setup

```bash
# Create feature branch from latest main
git checkout main
git pull origin main
git checkout -b <type>/<descriptive-slug>

# Types: feat/, fix/, refactor/, docs/, test/, chore/
```

**Branch naming rules:**
- Lowercase, hyphen-separated
- Prefix with change type
- Match the Jira/Dart story being worked on
- Verify branch name before first commit

### Step 2 — Develop and Commit

Follow conventional commit messages:

```
<type>: <concise description>

<optional body explaining what and why>
```

Types: `feat`, `fix`, `test`, `refactor`, `docs`, `chore`

**Pre-commit checklist:**
```bash
pnpm -r typecheck    # Types must pass
pnpm test:run        # Tests must pass
pnpm build           # Build must succeed
```

### Step 3 — Push to Fork

```bash
# Ensure fork remote exists
git remote -v
# If not: git remote add fork git@github.com:<user>/<repo>.git

# Push branch to fork
git push fork <branch-name>

# Or force-push after amend (with caution)
git push fork <branch-name> --force-with-lease
```

### Step 4 — Create Upstream PR

Read and fill in EVERY section of `.github/PULL_REQUEST_TEMPLATE.md`:

| Section | Content |
|---------|---------|
| **Thinking Path** | Trace reasoning from project context to this change |
| **What Changed** | Bullet list of concrete changes |
| **Verification** | How a reviewer can confirm it works |
| **Risks** | What could go wrong |
| **Model Used** | AI model that produced or assisted the change |
| **Checklist** | All items checked |

Use MCP GitHub tools to create the PR:
```
mcp_github_create_pull_request(
  owner, repo, title, body, head: "fork-user:branch", base: "main"
)
```

### Step 5 — Review Cycle

When reviews come in:

1. Use the **pr-review-responder** skill to triage and respond
2. Fix valid issues, commit, push
3. Reply to each thread with commit references
4. Request re-review when all threads are addressed

### Step 6 — Post-Merge Cleanup

```bash
# After PR is merged upstream
git checkout main
git pull origin main
git branch -d <branch-name>
git push fork --delete <branch-name>
```

## Multi-PR Coordination

When a feature spans multiple PRs:

- Create PRs in dependency order (base changes first)
- Reference related PRs in descriptions ("Depends on #XXXX")
- Use separate branches for each PR
- Cross-link in review replies when comments span PRs

## Git Remote Conventions

| Remote | Points To | Purpose |
|--------|-----------|---------|
| `origin` | `paperclipai/paperclip` | Upstream source of truth |
| `fork` | `<user>/paperclip` | Personal fork for PRs |

## Tool Usage

- `mcp_github_create_pull_request` — open PRs
- `mcp_github_update_pull_request` — update PR title/body
- `mcp_github_push_files` — push file changes
- `mcp_github_list_pull_requests` — check existing PRs
- `run_in_terminal` — git operations (branch, commit, push)
- `read_file` — read PR template before creating PR

## Common Issues

- **Auth mismatch**: `gh` CLI may not have a token but MCP GitHub tools do.
  Prefer MCP tools for GitHub API operations.
- **Branch not on fork**: Always verify `git push fork <branch>` succeeded
  before creating a PR.
- **Stale branch**: If upstream main has advanced, rebase before PR:
  ```bash
  git fetch origin main
  git rebase origin/main
  ```
