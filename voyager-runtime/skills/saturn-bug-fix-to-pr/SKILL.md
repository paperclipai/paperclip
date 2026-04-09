---
name: saturn-bug-fix-to-pr
description: Use when a Saturn bug has been confirmed and needs a fix shipped as a draft PR. Traces the 5-layer chain, writes the fix, runs tests, opens a draft PR into dev or stage, links back to the Jira ticket. Never merges, never pushes directly.
---

# Saturn Bug Fix → Draft PR

Activate when triage has confirmed a genuine bug AND a human has approved a fix attempt.

## Inputs

- Jira ticket key (e.g., `PROD-3712`)
- The failing signature (error, repro steps, affected service)
- The suspected file/function from triage

## Process

### 0. Confirm every external contract before you act

Before calling Jira, GitHub, Slack, Paperclip, or MCP methods as part of the fix flow, read the local source or tool schema that defines the contract. Do not guess endpoint paths, payload keys, response wrappers, or Atlassian identifiers.

- For Paperclip: read the route file first (for example `server/src/routes/issues.ts`) before scripting API calls.
- For MCP tools: inspect `voyager-runtime/mcp-config.json` and list/call the tool schema before using a method.
- Bad: assume `/companies/:companyId/issues` returns `{items:[...]}` or pass a Jira site URL where the MCP expects a cloud ID.
- Good: verify the exact route + schema, then make the call.

### 1. Trace the 5-layer chain FIRST

This is mandatory per Saturn's CLAUDE.md. For every endpoint, route, or feature you touch:

1. Backend/Jupiter/Mars route definition — where is it registered?
2. The view/handler — what does it return?
3. Shuttle proxy config — does shuttle know about this path?
4. Frontend API service file — what URL does the frontend call?
5. Frontend component — what response shape does it expect?

Read all 5 before writing code. If the bug spans layers, fix ALL affected layers in the same PR.

### 2. Reproduce locally (if possible)

The relevant service repo is already on disk at `/Users/bugatt/Downloads/saturn/{service}/`. Use it. If local repro is infeasible (e.g., needs a real firm's data), explain in the PR body why and rely on log-driven diagnosis.

### 3. Create a branch

Branch name format: `voyager/{JIRA-KEY}-{short-slug}`
Base branch: **`dev`** (default) or **`stage`** (stabilization work). **Never `main`. Never `labs`.** If the assignment ticket specifies a base branch, use that. Otherwise default to `dev`.

### 4. Write the fix

- Don't add features, don't refactor code you didn't change, don't add docstrings you weren't asked for.
- Follow existing patterns in the file you're editing.
- If the file has tests alongside it, update or add tests.
- For Django: **never add new top-level heavy imports** (boto3, pydub, docx, pypdf, litellm, langchain). Import inside function bodies.
- For Mars: **GORM zero-value bool**: `db.Create()` skips `false` → default `true` applies. Fix: Create then Update.
- For Jupiter: **MongoDB database name** baked in image as `jupiter_db`; ECS secrets don't override.

### 5. Verify

- Run the relevant test file (not the whole suite) with the service's test runner:
  - Django: `cd backend && pytest {path/to/test} -x`
  - Mars: `cd mars && go test ./{path/to/package} -run {TestName}`
  - Jupiter: `cd jupiter && pytest {path/to/test} -x`
  - Frontend: `cd frontend && pnpm test {pattern}`
- If the test passes and no linter errors, proceed. If not, iterate — don't open a broken PR.

### 6. Open the draft PR

Use `gh pr create --draft` or the GitHub MCP. Title format:

```
[{JIRA-KEY}] {short human description}
```

PR body must include:

- `## Thinking Path` — trace from PRD/problem to this change
- `## What Changed` — bullet list of concrete changes
- `## Verification` — how a reviewer can confirm it works (exact commands)
- `## Risks` — what could break
- `## Model Used` — the model that produced this change
- `## Jira` — link back to the ticket

The PR is **draft**. The human decides when to mark ready-for-review.

### 7. Link both ways

- Comment on the Jira ticket with the PR URL
- Comment on the PR with the Jira URL
- Reply in the original Slack thread with both links

## Hard rules

- **PR only. Only `dev` and `stage` are valid base branches. Never `main`, never `labs`. Never push directly.**
- **Draft only.**
- **No `--no-verify` on hooks.**
- **No scope creep** — fix the bug, nothing else. If you see other issues, open separate Jira tickets.
- **Every touched layer must be updated.** Changing a backend endpoint without updating shuttle + frontend is a wiring bug, not a fix.
- **Tenant isolation** — make sure the fix doesn't leak cross-firm data.
