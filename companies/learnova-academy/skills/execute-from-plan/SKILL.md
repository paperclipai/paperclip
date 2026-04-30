---
name: execute-from-plan
description: >
  Executor's primary skill — implement a Planner-authored plan exactly,
  step-by-step, in a feature branch, then open a PR. Use when ticket lands
  assigned to @executor with status ready-to-execute.
---

# Execute from Plan

You implement what the plan says. You don't re-plan.

## Scope

- Read plan in `vault/decisions/<ticket>-plan.md`
- Execute every step in order
- Commit per step
- Open PR
- Hand off to G_code via Paperclip status flip

## Inputs

- Paperclip ticket assigned to you with `status: ready-to-execute`
- Plan markdown in vault

## Workflow

### 1. Read the plan in full

If anything is unclear → STOP and route back to Planner with a re-plan request comment. Do NOT improvise.

### 2. Create or check out a feature branch

```bash
cd <repo>
git checkout main
git pull
git checkout -b koe-<ticket-id>/<plan-slug>
```

Never push to main directly.

### 3. Execute step 1

Implement the change. Commit:

```bash
git add <files-from-plan-step-1>
git commit -m "<conventional-commit-msg matching plan step 1>"
```

Run any local verification specified in the plan step.

### 4. Execute step N

Repeat for every plan step. One commit per step (or logical group).

### 5. Run full local tests

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Address any failures. If failures are in code you didn't touch and pre-existed → comment on the ticket; flag the flake; don't paper over.

### 6. Push and open PR

```bash
git push -u origin koe-<ticket-id>/<plan-slug>
gh pr create --title "[KOE-<id>] <plan title>" --body "$(cat <<EOF
## Plan
- Vault: vault/decisions/<ticket-id>-plan.md
- Steps completed: 1 ✓ 2 ✓ 3 ✓ 4 ✓ 5 ✓

## Verification
- Local tests: <N>/<N> ✓
- Typecheck: ✓
- Lint: ✓

## Risks
<from plan>

## How to verify
<from plan's Verification section>
EOF
)"
```

### 7. Hand off to G_code

```
status: awaiting-code-review
assignee: @code-reviewer
PR: <url>
```

Comment on Paperclip ticket:
```
✅ PR <#> opened · <url>
- Branch: <branch>
- Commits: <N> matching plan steps
- Local tests: <N>/<N> ✓
- Status: awaiting-code-review → @code-reviewer
```

## On block

If a plan step is wrong (e.g., file structure changed since plan, dependency missing) → STOP. Comment:

```
🚧 BLOCKED at step 3 · vault/decisions/<id>-plan.md says modify lib/format.ts but file no longer exists at that path. Need re-plan.

→ @planner: re-plan request
```

Flip status to `awaiting-replan`.

## Output

Open PR + ticket status flip + comment.

## Notes

- Plan adherence is binary. Either you implemented every step or you didn't.
- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`
- Never `--no-verify` unless plan explicitly calls it out
- Never modify files outside the plan's "files touched" list
- Run tests before opening PR — never punt verification to G_code

## Escalation

- Plan step impossible (deps missing, repo state diverged) → @planner re-plan
- Tests fail and root cause is in the plan → @planner re-plan
- Tests fail and root cause is in your implementation → fix it, continue
- Repo dirty (uncommitted from prior run) → escalate to chief-engineering; don't stomp work
