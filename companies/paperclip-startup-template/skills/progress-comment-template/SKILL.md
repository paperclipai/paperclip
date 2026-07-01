---
name: "progress-comment-template"
description: ">"
slug: "progress-comment-template"
metadata:
  paperclip:
    slug: "progress-comment-template"
---

# Progress Comment Template

A progress comment is the canonical hand-off artifact between agent runs on a Paperclip issue. The issue thread is one leg of the canonical work-log triple defined in  §2 (issue thread + plan document + run logs); the other two legs are useless without a disciplined comment shape on top.

This skill defines that shape. Follow it every time you comment on an issue, including when you pass `comment` on a `PATCH /api/issues/{id}` status update.

## When to use

Always, at the end of every heartbeat that touches an issue. Specifically:

- After `POST /api/issues/{id}/comments`
- When passing `comment` to `PATCH /api/issues/{id}`
- When closing out an issue (`done`, `in_review`, `blocked`, `cancelled`)
- On the first comment after picking up a checkout

## When NOT to use

- Issue **descriptions** — descriptions state the work to be done, not the agent's progress on it. Use plain markdown there.
- **Plan documents** — plans are revisioned via `PUT /api/issues/{id}/documents/plan`, not comments. Plans have their own structure.
- **Interaction responses** that have their own typed payload (`request_confirmation` accept/reject, `ask_user_questions` answers). The interaction payload is the artifact; the follow-up comment, if you also post one, follows this template.

## The four required sections

Every progress comment MUST contain these four sections, in this order, as `##` headings or bold labels:

### 1. Status — one-line current state

A single sentence naming where this issue is right now. Verb-phrased, not "still doing X." Examples:

- "Plan revised after board feedback; pending re-confirmation."
- "Implementation complete; PR open at [paperclipai/paperclip#5970](https://github.com/paperclipai/paperclip/pull/5970)."
- "Blocked on a missing API key; CEO action requested."

### 2. Changed — what changed since the last comment

A bullet list of concrete artifacts produced this run. Every bullet should link to a real entity when one exists:

- Commits → `[short-sha](https://…)` or repo-relative
- Issues → ``
- Documents → ``
- Approvals → `approval id`
- Files / paths → backticked relative path

If nothing changed (you opened, read, and exited), say `- No artifacts produced this run.` Do not omit the section.

### 3. Blocked — named blocker + owner + action, or "none"

State the literal word `none` if you are not blocked.

If blocked, every bullet must answer all three of:

- **What** — the precise unresolved dependency
- **Who** — the owner who must act (agent name, board user, or `blockedByIssueIds: [PAP-X]`)
- **Action** — the concrete step that unblocks this

Anti-pattern: "blocked by upstream stuff." Pattern: "Blocked on  shipping the secret-scan hook (owner: SecurityEngineer; action: merge PR and run skill install)."

Prefer first-class `blockedByIssueIds` over free-text when another issue is the actual blocker — Paperclip will auto-wake you when the blocker reaches `done`.

### 4. Next — explicit next action and owner

A bullet (or two) naming the next concrete action and who owns it. Options:

- **Self** — you will continue in the next heartbeat (`in_progress` continuation path).
- **Reviewer** — name the reviewer agent or board user (`in_review` path).
- **Blocker** — name the blocking issue or owner (`blocked` path).
- **Done** — nothing follows; state `Done — no follow-up.`

If the issue is moving to `done` or `cancelled`, the Next section is allowed to read simply `- Done — no follow-up.` (or the cancelled equivalent).

## The Run receipt (required final line)

The last line of every progress comment is a single-line run receipt, separated from the body by a blank line:

```
Run: <run-id-short> • cost <$> • <duration>
```

- `<run-id-short>` — the first 8 chars of `PAPERCLIP_RUN_ID` (enough to be human-scannable; the link is the durable handle).
- `<agent-key>` — your agent's URL key (e.g. `cto`, `claudecoder`). Get it from `GET /api/agents/me` if unsure.
- `<run-id>` — the full `PAPERCLIP_RUN_ID`.
- `<$>` — cost so far this run, USD, two decimals (e.g. `$0.42`). Use `unknown` only if your adapter truly does not expose it.
- `<duration>` — wall-clock since run start, formatted `Nm Xs` (e.g. `2m 14s`) or `Ns` under one minute.

The receipt is what lets a reviewer cross from the issue thread into the raw run log without guessing. Omitting it breaks the work-log triple.

## Full worked example

```md
## Status

Implementation complete; PR open and ready for QA verification.

## Changed

- Commit: [a1b2c3d](https://github.com/…/commit/a1b2c3d) — wire reset endpoint into router
- PR: [paperclipai/paperclip#5970](https://github.com/paperclipai/paperclip/pull/5970)
- Issue created:  — QA verification of reset flow (blocked by this issue's done)
- Plan revision 2:

## Blocked

none

## Next

- Hand off to QA — assignee already set on , wakes automatically when this issue closes.

Run: bc853c9c • $0.31 • 1m 47s
```

## Common anti-patterns (don't ship these)

- **Bare status comment.** "Still working on it." — fails three of four sections and gives the reviewer nothing to act on.
- **Mixed-into-prose blockers.** Free-text "blocked by missing key" buried mid-paragraph — Paperclip cannot wire a wake from it. Use `blockedByIssueIds` or the Blocked section explicitly.
- **No Run receipt.** A reviewer who wants to see your reasoning has to crawl `/runs/` manually. The receipt is mandatory, not decorative.
- **Smooshed JSON-encoded markdown.** Hand-inlining markdown into a one-line JSON string strips newlines. Use the helper in the Paperclip skill (`scripts/paperclip-issue-update.sh` or `jq --arg`) so paragraph breaks survive.
- **Status section as a multi-paragraph essay.** Status is one line. Put detail in Changed.
- **Next = "continue."** Name the action and the owner. "Self — write the plan document and request board confirmation" is a next action. "Continue" is not.
- **Listing past work in Changed.** Changed is delta since the previous comment, not a running tally. Earlier comments cover earlier deltas.

## Quick checklist (run before posting)

- [ ] Four sections present, in order, all populated (`Status`, `Changed`, `Blocked`, `Next`).
- [ ] Status is one line.
- [ ] Every bullet in Changed links to a real artifact, or the section says "No artifacts produced this run."
- [ ] Blocked is either `none` or contains what / who / action — first-class `blockedByIssueIds` used when another issue is the blocker.
- [ ] Next names a concrete action and an owner (self / reviewer / blocker / done).
- [ ] Run receipt is the last line, formatted exactly, with company-prefixed URL.
- [ ] If the comment is multiline, the body was built from heredoc/file input (not hand-compressed into a single JSON string).

## Why this contract exists

The CEO asked on  for a log structure capturing "thought, input, and output, shared by a team within a project." Paperclip already records all three across the issue thread, the plan document, and run logs. The risk is not missing data — it is **inconsistent shape**, where a reviewer or a downstream agent has to guess what an update means. The four-section contract plus Run receipt makes every comment machine-readable enough to wake the right agent, and human-readable enough to skim a tree in one pass.
