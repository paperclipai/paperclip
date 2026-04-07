---
name: pr-review-responder
description: >
  Triage and respond to PR review comments. Validates each comment against the
  PR's stated goal, fixes valid issues in code, commits with references, and
  posts concise replies. Use when asked to handle review feedback, resolve PR
  threads, address reviewer comments, or when a PR has outstanding reviews.
  Trigger phrases: "handle review comments", "respond to PR feedback",
  "fix PR review issues", "resolve review threads".
---

# PR Review Responder Skill

Systematically triage, fix, and reply to every review comment on a pull request.

## When to Use

- A PR has new review comments that need responses
- User asks to "handle the PR comments" or "resolve review threads"
- After pushing a feature PR and receiving automated or human reviews
- When Copilot, Greptile, or human reviewers leave feedback

## Principles

1. **Goal-anchored** — evaluate every comment against the PR's stated purpose
2. **Fix or explain** — valid comments get code fixes; out-of-scope or incorrect
   comments get a respectful explanation of why no change is made
3. **Atomic commits** — each fix gets its own commit with a message referencing
   the review comment
4. **Reply with evidence** — replies cite the specific commit SHA or code change

## Workflow

### Step 1 — Gather Context

1. Identify the PR number and repository
2. Read the PR description to understand the stated goal and scope
3. Fetch all review comments (use MCP GitHub tools or `gh` CLI)
4. Read the current state of all files touched by the PR

```
Information needed:
- PR number, repo owner/name, base branch, head branch
- PR description / body text
- All review comment threads (commentId, author, body, file, line)
- Current file contents for referenced files
```

### Step 2 — Classify Each Comment

For each review comment, determine:

| Classification | Criteria | Action |
|---------------|----------|--------|
| **Valid & in-scope** | Points to a real bug, missing test, or code quality issue within the PR's scope | Fix it |
| **Valid but out-of-scope** | Real issue but belongs in a separate PR | Acknowledge, suggest follow-up |
| **Incorrect** | Reviewer misread the code or the suggestion would introduce a bug | Explain with code references |
| **Style/preference** | Subjective preference with no correctness impact | Adopt if cheap, explain if not |
| **Duplicate** | Same issue raised in another thread | Reference the other thread |

### Step 3 — Fix Valid Issues

For each valid in-scope comment:

1. Make the code change in the relevant file
2. Run typecheck (`pnpm -r typecheck`) to verify
3. Run tests (`pnpm test:run`) if test files were changed
4. Commit with message format:
   ```
   fix: <concise description>

   Addresses review comment on <file>:<line>
   PR #<number>
   ```
5. Note the commit SHA for the reply

### Step 4 — Post Replies

For each comment thread, post a reply:

- **Fixed**: "Fixed in `<sha>` — <brief description of what changed and why>"
- **Out-of-scope**: "Valid observation. This is outside the scope of this PR
  (which focuses on <goal>). I'll track it as a follow-up."
- **Incorrect**: "This is actually handled by <explanation with code reference>.
  <Cite specific lines or logic that address the concern.>"
- **Style**: "Adopted — updated in `<sha>`" or "Keeping current approach because
  <reason>."

### Step 5 — Push and Summarize

1. Push all fix commits to the PR branch
2. Provide a summary table:

```markdown
| # | Comment | Classification | Action | Commit |
|---|---------|---------------|--------|--------|
| 1 | Missing null check | Valid | Fixed | abc1234 |
| 2 | Wrong variable name | Incorrect | Explained | — |
| 3 | Add tests | Valid | Fixed | def5678 |
```

## Reply Style Guide

- **Concise but complete** — 2-4 sentences max per reply
- **Technical** — cite file paths, line numbers, function names
- **Professional** — no defensiveness, acknowledge good catches
- **Cross-reference** — link related comments or PRs when relevant
- Do NOT use emojis or casual language in review replies

## Tool Usage

Preferred tools for this workflow:

- `mcp_github_pull_request_read` — fetch PR details and review comments
- `mcp_github_add_reply_to_pull_request_comment` — reply to review threads
- `grep_search` / `read_file` — understand current code state
- `replace_string_in_file` — make code fixes
- `run_in_terminal` — run typecheck and tests
- `mcp_github_push_files` or `run_in_terminal` (git push) — push fixes

## Edge Cases

- **Bot comments** (Greptile, Copilot): Treat the same as human reviews —
  bots can surface real issues
- **Conflicting comments**: If two reviewers disagree, note both perspectives
  and choose the approach that best serves the PR's goal
- **Stale comments**: If code was already fixed in a subsequent commit,
  reply with the existing commit SHA
