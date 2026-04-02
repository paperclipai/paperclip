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

1. **Tab 0 — Navigate to the Paperclip issue URL:**
   Open (or reuse) Tab 0 and navigate to `{PAPERCLIP_API_URL}/{company-prefix}/issues/{issue-identifier}` (e.g., `http://127.0.0.1:3100/DSPA/issues/DSPA-42`). This anchors the session to the active task.
2. **Proceed with task work** in subsequent tabs. Tab 0 stays on the issue page as a persistent reference for the current task context.

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

## Waiting for User Input

When you need the user to take an action (login, MFA, confirm something), use the `wait-for-user` skill. **Never exit your process** if you can poll and wait instead — this keeps browser state alive.
