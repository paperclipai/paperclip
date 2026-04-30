---
name: code-review-pr
description: >
  Code Reviewer's primary skill — independent G_code review of a PR opened by
  Executor. Run on Codex CLI (GPT-5) for diversity vs Planner+Executor (Opus
  4.7). Use when ticket lands assigned to @code-reviewer with status
  awaiting-code-review.
---

# Code Review PR

You evaluate adherence-to-plan + correctness + tests. You APPROVE or REQUEST CHANGES.

## Scope

- One PR review per ticket
- Plan adherence (binary: matches or doesn't)
- Bug detection
- Test gap detection
- Convention check
- Local test run (verify Executor's claim)

## Inputs

- Paperclip ticket with `status: awaiting-code-review`
- PR URL
- Plan in vault/decisions/

## Workflow

### 1. Read the plan + ticket + PR diff

```bash
gh pr view <PR> --json number,title,body,headRefOid,files,reviews
gh pr diff <PR>
```

### 2. Check plan adherence (per step)

Walk every plan step. For each:
- Was it implemented? (Y/N)
- Does the implementation match the step's intent? (Y/N)

If ANY step is missing or implemented wrong → REQUEST CHANGES with line refs.

### 3. Run tests locally

```bash
gh pr checkout <PR>
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

If tests fail → REQUEST CHANGES with the specific failures.

### 4. Bug + security scan

Read the diff with attention to:
- Null/undefined dereferences
- Off-by-one in loops
- SQL injection / XSS / secret leaks
- Async/await mistakes
- Type narrowing gaps
- Dead branches

For each finding, line-anchor the comment.

### 5. Test coverage check

For new code: are there test cases for happy path + 2 edge cases?
For bug fixes: is there a test that would have caught the bug?

If gaps → REQUEST CHANGES.

### 6. Convention check

- Naming follows repo norms?
- File placement matches existing patterns?
- Imports clean?
- No unused code?

### 7. Decide

**APPROVE:**

```bash
gh pr review <PR> --approve --body "$(cat <<EOF
✅ G_code APPROVE

Plan adherence: 5/5 (all 5 steps implemented as specified)
Bugs: 0 found
Test coverage: passes; +<N> new test cases for the new code
Conventions: clean

Local test run: pnpm test → <N>/<N> ✓ | typecheck ✓ | lint ✓

Routing → @qa-verifier for G2
EOF
)"
```

**REQUEST CHANGES:**

```bash
gh pr review <PR> --request-changes --body "$(cat <<EOF
❌ G_code REQUEST CHANGES

PLAN ADHERENCE
- Plan step 3 says X; PR does Y instead. Either move it or update the plan.

BUGS
- file.tsx:84 — null deref on empty input. Add guard.

TEST GAPS
- No test for empty-string input. Add it.

→ @executor: revise + re-route through @code-reviewer
EOF
)"
```

### 8. Flip Paperclip ticket status

- APPROVE → `awaiting-qa` → @qa-verifier
- REQUEST CHANGES → `awaiting-execution-fix` → @executor

## Output

A `gh pr review` comment + Paperclip ticket flip.

## Notes

- Don't push commits. You comment; Executor pushes.
- Don't approve a PR that diverges from its plan. Plan adherence is binary.
- Don't request changes on subjective taste alone.
- Always run tests yourself.
- Approve or request changes — no third option.
- Same revision twice without new findings? Escalate to Chief Engineering.

## Escalation

- 3+ revisions on same ticket → Chief Engineering (plan may be wrong)
- Security issue → request changes immediately + Chief Engineering same heartbeat
- Tests pass for Executor but fail for you → environment drift; ping Chief Engineering before next ticket
