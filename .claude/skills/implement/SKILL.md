---
name: implement
description: Complete GitHub issue implementation workflow from investigation through PR creation
---

# Implement a GitHub Issue

Pre-flight checks → understand issue → branch → implement → verify → PR.

## Pre-Flight (MANDATORY)

```bash
git branch --show-current   # Should be master or a dedicated feature branch
git status                  # Must be clean — if dirty, STOP and ask user
git stash list              # Warn if stashes exist
```

## Step 1 — Understand the Issue

```bash
gh issue view {issue_number}
```

Read the full description. Identify:
- All acceptance criteria (stated and implied)
- Files likely affected (search codebase first)
- Which contract layers must stay in sync: `packages/db` → `packages/shared` → `server` → `ui`

Check for existing work:

```bash
gh pr list | grep {issue_number}
git branch -a | grep {issue_number}
```

If a branch/PR already exists, STOP and ask user.

## Step 2 — Create Feature Branch

```bash
git fetch origin master
git checkout -b fix/{slug} origin/master   # for bug fixes
git checkout -b feat/{slug} origin/master  # for features
```

## Step 3 — Implement

Follow AGENTS.md rules:
- Keep changes company-scoped
- Keep contracts synchronized across db → shared → server → ui
- Preserve control-plane invariants (single-assignee, atomic checkout, budget hard-stop)
- No wholesale doc replacement — additive updates only

Run checks frequently:

```bash
pnpm -r typecheck   # After every TypeScript change
pnpm test           # After every logic change
```

## Step 4 — Verify (Full Gate)

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

All must pass. If anything cannot be run, explicitly report what was skipped and why.

## Step 5 — Commit

```bash
git add <specific files>
git commit -m "feat(scope): <description>"
git log -1 --stat
```

Use `/commit` for retry logic on hook failures. Never `--no-verify`.

## Step 6 — Create PR

Read `.github/PULL_REQUEST_TEMPLATE.md` and fill in EVERY section:

```bash
gh pr create \
  --base master \
  --title "<type>(scope): <description>" \
  --body "$(cat <<'EOF'
[Filled-in PR template — all sections required]
EOF
)"
```

Required sections (per template):
- **Thinking Path** — trace from project context to this change (5-8 steps)
- **What Changed** — bullet list of concrete changes
- **Verification** — how reviewer confirms it works
- **Risks** — what could go wrong
- **Model Used** — AI model that assisted (provider, exact model ID)
- **Checklist** — all items checked

## Definition of Done

All of these must be true:
1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts synced across db/shared/server/ui
4. Docs updated if behavior or commands changed
5. PR description follows template with all sections filled
