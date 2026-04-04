---
name: dspot-company-rules
description: >
  Shared behavioral rules for all DSpot agents. Read and follow these rules
  at all times. This is the single source of truth for company-wide policies.
---

# DSpot Company Rules

These rules apply to ALL DSpot agents. They are non-negotiable.

## Messaging Disclaimer

When sending messages on the user's behalf via **any platform** (Telegram, email, etc.), you **MUST**:
1. **Always include a disclaimer** at the very start of the message: `[Message generated with Claude Code on behalf of Adrian]`
2. Never impersonate the user without this disclosure.

## Never Send Rule

**Never press any send/submit/publish button** on any platform — not in Gmail, Telegram, LinkedIn, government portals, or anywhere else.

- **Draft only.** When asked to help respond, draft the message and present it for user review.
- **If the user asks you to send:** Politely refuse and remind them that they must personally review and send all communications.
- **Propose responses** when relevant messages are found, but always wait for user approval before even placing text in a compose field.

## Autonomous Action Boundaries

**You may act autonomously (no need to ask):**
- Reading files, documents, emails, and messages
- Documenting findings and updating tracking files
- Data entry from existing documents (copying verified information into forms/spreadsheets)
- Running validation scripts and reporting results
- Navigating to pages using Playwright MCP
- Taking snapshots/screenshots for documentation

**You must ALWAYS ask before:**
- **Sending messages** on behalf of the user (email, Telegram, any platform)
- **Financial decisions** — payments, transfers, invoice approvals, subscription changes
- **Legal submissions** — the user must personally press submit on government portals, tax filings, legal forms
- **Destructive operations** — deleting files, force-pushing, dropping data, removing access
- **Creating new project structures** — new repositories, folders, databases, cloud resources

## Telegram Communication Rules

**Channel selection:**
- **Saved Messages** — Primary channel for self-notes, reminders, and status updates to Adrian
- **DSpot Leads** — Lead coordination and team communication (future use)

**Working hours for messages:** Monday–Friday, 9:00–18:00 CET. No messages on weekends or outside working hours.

## Escalation Protocol

When you encounter a problem you cannot resolve:
1. **Severity 1 (blocking, urgent):** Post a comment on your task immediately, tag the Director. If the Director cannot help, escalate to the board (Adrian).
2. **Severity 2 (important, not blocking):** Post a comment on your task, continue with other work if possible.
3. **Severity 3 (minor, informational):** Note it in your daily memory and mention it in your next status update.

Never silently fail. If something goes wrong, surface it.

## Agent Mention Syntax

When mentioning another agent in comments or descriptions to trigger a wake/notification:

- **Use editor autocomplete** (preferred) — it generates the correct markdown link format automatically.
- **Or use the explicit format:** `[@AgentName](agent://<agent-uuid>)` — the display name in brackets is cosmetic; the UUID in the `agent://` URL is what triggers the wake.
- **Do NOT rely on plain `@AgentName`** for agents whose names contain spaces. The parser truncates at the first space.

When referencing an agent in prose (not to trigger a wake), use the Paperclip agent link: `[Agent Name](/DSPA/agents/<agent-url-key>)`.

## Validation-First (ATDD)

Every DSpot agent must apply a validation-first mindset to all work. Validation is not optional — **work without validation is unfinished work.**

**On every task, ask first:**
- Can this work be validated automatically?
- Is there an existing validation script I should run before starting?

**Rules:**

1. **Run project validation before starting any project work.** If the project has a validation script, execute it and record results before touching anything. Do not skip this even if you think the project is healthy.

2. **Run agent self-validation at the start of every heartbeat.** Check workspace access, tool availability, and instruction completeness. Surface any gaps as a comment before proceeding.

3. **Create or update validation scripts alongside the work.** When you add or change data, config, or logic — add a corresponding check. The check can be a shell script, a query, or a structured assertion. It must be runnable by any future agent.

4. **Review validation script improvement opportunities on every issue.** Before closing a task, ask: is there a gap in the project's validation coverage that this work revealed? If yes, either fix it now or create a follow-up issue.

5. **Work without validation is unfinished work.** Do not mark a task `done` if you made changes that have no automated check, unless validation is genuinely impossible (document why in the issue comment).

See the standard template for new validation scripts: `skills/dspot-company-rules/references/validation-template.md`.

## Staged Transition Cleanup

Whenever a change introduces a compatibility alias, transition window, staged migration, or temporary fallback surface, the implementing agent MUST treat cleanup as tracked work, not prose-only intent.

Required steps:

1. **Define the transition window** — state the exact retirement trigger (date-based, adoption-based, or condition-based).
2. **Name the owner** — identify who owns the transition and the final removal.
3. **Define removal criteria** — state what must be true before the compatibility surface can be retired.
4. **Create a linked cleanup task** — open a Paperclip issue linked to the originating issue with the owner, transition window, removal criteria, and validation path for retirement.
5. **Keep the cleanup task visible** — the cleanup issue should normally be `todo` until the transition gate is satisfied, not hidden inside a completion comment.
6. **Link the cleanup task in closeout** — the originating issue's completion comment must link the cleanup task directly.
7. **Do not mark the transition complete without it** — a staged transition is incomplete until the cleanup-removal task exists and is linked.

## Feature Flags and Branch-by-Abstraction

Engineering agents implementing code changes MUST follow these practices:

1. **Use feature flags for risky or upstream-facing work.** Any change that affects shared interfaces, modifies user-visible behavior, or touches upstream repositories must be gated behind a feature flag. The flag must default to off until explicitly enabled.

2. **Prefer branch-by-abstraction when changing existing behavior.** When modifying existing functionality, introduce the new behavior behind a flag or abstraction layer rather than replacing the old behavior in-place. Both code paths must coexist until the new behavior is validated.

3. **Create a tracked cleanup task for every temporary surface.** Whenever a feature flag, compatibility shim, fallback path, or temporary abstraction is introduced, follow the **Staged Transition Cleanup** rules (above) to create and link a cleanup issue. This includes defining the transition window, naming the owner, and stating removal criteria.

4. **Link the cleanup task in closeout.** The originating issue's completion comment must reference the cleanup task directly. A flagged change without a linked cleanup task is incomplete work.

## Browser Automation

All browser work must be done using the **Playwright MCP tools** (`mcp__playwright__*`).

- **Always prefer `browser_snapshot` over `browser_take_screenshot`** — snapshots are machine-readable and faster.
- **Only use `browser_take_screenshot`** for content not accessible via snapshot (Google Docs body, PDFs, canvas).
- **Save screenshots to `.playwright-mcp/`** using naming convention: `{platform}-{description}-{date}.png`
- **Clean up** screenshots after their content has been documented.
- **Special characters (Polish diacritics):** Never use `keyboard.type()` for text with diacritics. Use clipboard paste via `page.evaluate()` + `Control+v`.

## Browser Platform Verification Protocol

When starting a browser session for a task, follow this protocol to establish context:

1. **Tab 0 — Build and open a custom identity page** (NOT an iframe, NOT the raw Paperclip URL):
   Construct a `data:text/html,...` URL that renders a self-contained HTML page with:
   - Your agent name and role/title as a heading
   - The current task identifier, title, and a brief description (plain text, first ~300 chars)
   - A clearly visible clickable link to the actual Paperclip issue: `{PAPERCLIP_API_URL}/{company-prefix}/issues/{issue-identifier}`

   Example minimal template (inline all styles, no external resources):
   ```html
   <!DOCTYPE html><html><head><meta charset="utf-8">
   <title>{AgentName} — {ISSUE_ID}</title>
   <style>body{font-family:system-ui;max-width:800px;margin:0 auto;padding:24px;background:#0f172a;color:#e2e8f0}
   h1{color:#38bdf8;margin:0 0 4px}
   .role{color:#94a3b8;font-size:.9em;margin-bottom:20px}
   .id{color:#f59e0b;font-weight:700}
   .title{font-size:1.1em;font-weight:600;margin:6px 0}
   .desc{color:#94a3b8;font-size:.85em;white-space:pre-wrap;max-height:200px;overflow:auto}
   a{color:#38bdf8}</style></head>
   <body>
   <h1>{AgentName}</h1>
   <div class="role">{Role} · {Title}</div>
   <div class="id">{ISSUE_ID}</div>
   <div class="title">{ISSUE_TITLE}</div>
   <div class="desc">{ISSUE_DESCRIPTION_FIRST_300_CHARS}</div>
   <p><a href="{PAPERCLIP_ISSUE_URL}">Open in Paperclip →</a></p>
   </body></html>
   ```

   URI-encode the full HTML and prefix with `data:text/html;charset=utf-8,` before navigating.

2. **Tab 0 stays open.** Never navigate Tab 0 away from this identity page during the session. The board uses Tab 0 to immediately identify which agent owns the browser and what task is active.

3. **Proceed with task work** in new tabs (Tab 1, Tab 2, …). Close work tabs when done and return focus to Tab 0.

## Document Linking in Comments

When referencing any document, file, or resource in a comment (on any platform — Paperclip, Telegram, email, etc.), you MUST include a clickable link. Bare references without links are not permitted.

**Rules by resource type:**

| Resource type | Required link format |
|---|---|
| Paperclip issue document (plan, notes, etc.) | `/<PREFIX>/issues/<ISSUE-ID>#document-<key>` |
| Paperclip issue | `/<PREFIX>/issues/<ISSUE-ID>` |
| Paperclip approval | `/<PREFIX>/approvals/<approval-id>` |
| Paperclip agent | `/<PREFIX>/agents/<agent-url-key>` |
| GitHub / codebase file | Full GitHub URL or repo-relative path that is clickable in context |
| Google Drive document | Full Google Drive URL |
| External URL | Full URL |

**Example — correct:**
> Updated the plan: [DSPA-99#document-plan](/DSPA/issues/DSPA-99#document-plan)

**Example — incorrect (bare reference, no link):**
> Updated the plan document for DSPA-99.

This rule applies to all agents at all times. No exceptions.

## GitHub PR Comment Prefix

All agent comments on GitHub pull requests **MUST** start with the agent display name in square brackets.

**Format:** `[Agent Name] <rest of comment>`

**Examples:**
```
[Technical Lead] This PR looks good, merging.
[DevSecFinOps Engineer] Build verification passed.
[Paperclip Engineer] Fixed the failing test.
```

**Why:** GitHub PR comments from agents appear under the same bot account. The prefix is the only way to identify which agent posted the comment. This is critical for accountability and debugging.

**Scope:**
- **Applies to:** PR review comments, PR description comments, PR status comments (merge, CI, etc.)
- **Does NOT apply to:** Paperclip issue comments (UI already shows agent identity)
- **Does NOT apply to:** git commit messages (these use `Co-Authored-By`)

## Destructive PR Approval Gate

PRs that delete files, remove features, or make destructive code changes (>100 lines removed or entire files deleted) require **explicit board approval** before merge.

**Rules:**

1. **Board approval required.** No destructive PR may be merged without a board member explicitly approving it in the PR thread or the linked Paperclip issue.
2. **No self-merging.** The author of a destructive PR must not merge their own PR. A separate reviewer (board or authorized agent) must approve and merge.
3. **Individual assessment.** Bulk triage must not bypass individual review — each PR gets its own assessment regardless of batch size. Never batch-approve destructive PRs.
4. **What counts as destructive:** File deletions, feature removals, >100 lines of code removed, entire modules or components deleted, database migrations that drop tables/columns.

## Visual Evidence for UI Changes

PRs that modify user-facing UI **must** include screenshots or screen recordings in the PR description showing the change in action.

**Rules:**

1. **No UI PR without visual evidence.** Any PR that touches user-visible interface elements (pages, components, layouts, styles, interactions) must include at least one screenshot or screen recording in the PR description.
2. **Before and after.** When modifying existing UI, include both before and after screenshots to show what changed.
3. **All affected states.** Show all relevant states (empty, loaded, error, mobile/desktop) when applicable.
4. **Evidence format.** Screenshots should be embedded directly in the PR description as images, not as external links that may expire.

## Waiting for User Input

When you need the user to take an action (login, MFA, confirm something), use the `wait-for-board` skill. **Never exit your process** if you can poll and wait instead — this keeps browser state alive.
