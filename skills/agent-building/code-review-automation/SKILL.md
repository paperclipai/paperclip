---
name: code-review-automation
description: Use when running automated code reviews on PRs or diffs in Claude Code. Triggers on: "review my PR", "code review automation", "automated code review", "run a code review", "review this diff", "parallel code review", "security review before push", "pre-push review hook", "free alternative to Anthropic Code Review", "gh cli code review", "review PR #N", "set up automated PR reviews", "post review results to GitHub", "stack-specific code review". Also fires for: configuring review checklists, setting up PreToolUse auto-trigger, parallel sub-reviewer architecture. NOT for: general debugging, code explanation, writing unit tests (see tdd-workflow), or one-off file reading.
---

# Code Review Automation

Run parallel code reviews on any PR or diff using Claude Code's Agent tool and `gh` CLI — free on your existing subscription, customizable for your stack, no $15/PR product required.

## Phase Detection

| Signal | Jump To |
|--------|---------|
| "review PR #N" / "review this diff" / running a review now | → Running a Review |
| "set up auto-trigger" / "hook before push" / PreToolUse | → Auto-Triggering |
| "add my checklist" / "stack-specific checks" | → Custom Checklists |
| First time / "how does this work" | → Review Architecture first |

---

## Review Architecture

Four parallel sub-reviewers, each focused on one domain:

```python
# Run all four in parallel
security    = Agent(model="claude-sonnet-4-6", prompt=SECURITY_PROMPT + diff)
performance = Agent(model="claude-sonnet-4-6", prompt=PERF_PROMPT + diff)
correctness = Agent(model="claude-sonnet-4-6", prompt=CORRECTNESS_PROMPT + diff)
style       = Agent(model="claude-haiku-4-5-20251001", prompt=STYLE_PROMPT + diff)  # cheaper
```

Each returns findings as: `file:line | severity | finding | suggestion`

**Severity levels:** `critical` → `high` → `medium` → `low`
- `critical` — blocks push (injection, data loss, broken auth, exposed secrets)
- `high` — fix before merge
- `medium` — fix before merge if time allows
- `low` — consider fixing

→ See [01-review-architecture.md](references/01-review-architecture.md) for full prompts, merge/dedup logic, and model tier rationale.

---

## Running a Review

**Three diff sources:**
```bash
gh pr diff 47                  # open PR by number
git diff main...HEAD           # all commits on this branch
git diff HEAD~1                # last commit only
```

**The orchestrator flow:**
1. Fetch diff — exclude `*.lock`, `*generated*`, `vendor/`, `dist/`
2. Load `~/.claude/review-checklist.md` if it exists
3. Spawn 4 parallel Agent sub-reviewers
4. Merge findings, deduplicate, sort by severity
5. Output markdown table — optionally post to PR

**Output format:**
```
| File | Line | Severity | Finding | Suggestion |
|------|------|----------|---------|------------|
| auth.ts | 42 | CRITICAL | SQL injection via unsanitized input | Use parameterized query |
| api.ts | 118 | HIGH | N+1 query in loop | Batch with Promise.all |
```

→ See [02-fetching-diffs.md](references/02-fetching-diffs.md) for exclusion patterns and directory scoping.

---

## Posting to the PR

```bash
# Post review as PR comment
gh pr comment 47 --body "$(cat /tmp/review-output.md)"

# Update existing review comment
gh pr comment 47 --edit-last

# Line-level annotations via GitHub review API
gh api repos/{owner}/{repo}/pulls/47/reviews \
  -f body="Review findings" -f event="COMMENT"
```

When to use each: new comment on first review, `--edit-last` for iteration updates.

→ See [03-posting-to-pr.md](references/03-posting-to-pr.md) for threading, line-level annotation, and the full comment template.

---

## Custom Checklists

Create `~/.claude/review-checklist.md` with stack-specific rules. The orchestrator reads this and appends it to each sub-reviewer prompt at review time.

```markdown
## Next.js/Convex
- [ ] Convex validators on all mutations (prevents injection via schema)
- [ ] Missing "use client" on components using hooks or event handlers
- [ ] Server components fetching sensitive data without auth check

## iOS/Swift
- [ ] Force unwraps in production code paths (crash risk)
- [ ] Missing @MainActor on UI-touching async functions
```

→ See [04-custom-checklists.md](references/04-custom-checklists.md) for full Next.js, iOS, Python, and Go examples.

---

## Auto-Triggering

A PreToolUse hook fires a review before any `git push` to a feature branch. Blocks the push if critical findings exist.

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "node ~/.claude/hooks/pre-push-review.js"
      }]
    }]
  }
}
```

The hook script checks if the command is `git push` to a non-main branch, runs the review with `--check-only`, and exits 1 to block if criticals exist. Escape hatch: `git push --no-verify`.

→ See [05-auto-trigger-hook.md](references/05-auto-trigger-hook.md) for the full hook script, branch scope filter, and override mechanism.

---

## Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "Four agents is overkill, one reviewer is fine" | One generic reviewer misses 60% of domain-specific issues. Security needs OWASP patterns. Perf needs query analysis. They're cheap parallel Haiku/Sonnet calls — run them all. |
| "The diff is too big, I'll review just the key files" | The critical bug is always in the file you skipped. Scope by excluding generated/lock files, not by cherry-picking which logic to check. |
| "I'll post results manually, no need to automate" | You'll forget, or post a stripped summary. One `gh pr comment` command costs nothing. Automate it. |
| "The pre-push hook is annoying, I'll remove it" | The hook is the point. Manual review = skipped review under deadline. If it's blocking false positives, tighten the branch scope — don't remove it. |
| "My stack is too custom for a checklist" | Add 3 lines to `review-checklist.md`. It gets read on every future review. This is the cheapest customization here. |

---

## Full Walk-Through

→ See [06-walkthrough.md](references/06-walkthrough.md) for end-to-end: `gh pr diff 47` → 4 parallel reviewers → merged findings → PR comment posted with real example output.

---

## Reference Files

| File | Contents |
|------|----------|
| [01-review-architecture.md](references/01-review-architecture.md) | Sub-reviewer prompts, model tiers, merge and dedup logic |
| [02-fetching-diffs.md](references/02-fetching-diffs.md) | Diff sources, exclusion patterns, directory scoping |
| [03-posting-to-pr.md](references/03-posting-to-pr.md) | gh pr comment, GitHub review API, line-level threading |
| [04-custom-checklists.md](references/04-custom-checklists.md) | Stack-specific checklist examples (Next.js, iOS, Python, Go) |
| [05-auto-trigger-hook.md](references/05-auto-trigger-hook.md) | PreToolUse hook config, branch scoping, override mechanism |
| [06-walkthrough.md](references/06-walkthrough.md) | End-to-end example with real diff and output |
