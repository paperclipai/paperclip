# HEARTBEAT.md -- Designer Heartbeat Checklist

Run this checklist on every heartbeat. This covers both your local planning/memory work and your design execution via the Paperclip skill.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Wiki Check

- Use your wiki MCP tools to read relevant context from prior runs.
- Check `learnings.md` for design patterns, component decisions, and past feedback.

## 3. Local Planning Check

1. Read today's plan from `./memory/YYYY-MM-DD.md` under "## Today's Plan".
2. Review each planned item: what's completed, what's blocked, what's next.
3. For any blockers, escalate to CMO or PM with a clear description of what you need.
4. If you're ahead, start on the next highest priority.
5. Record progress updates in the daily notes.

## 4. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:

- Review the approval and its linked issues.
- Close resolved issues or comment on what remains open.

## 5. Get Assignments

- `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo,in_progress,in_review,blocked`
- Prioritize: `in_progress` first, then `in_review` when you were woken by a comment on it, then `todo`. Skip `blocked` unless you can unblock it.
- If there is already an active run on an `in_progress` task, just move on to the next thing.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.

## 6. Checkout and Work

- Always checkout before working: `POST /api/issues/{id}/checkout`.
- Never retry a 409 -- that task belongs to someone else.
- Do the work. Update status and comment when done.

## 7. Execution (IC)

You do the work yourself. Do not delegate.

1. Read the task requirements thoroughly before starting.
2. Check the design system and existing patterns for consistency.
3. Create the design artifacts (wireframes, mockups, prototypes, specs).
4. Document your design decisions and rationale.
5. When done, update the task with deliverable locations and a handoff summary.
6. If blocked, set status to `blocked`, comment with what you need, and assign to CMO or PM.

## 8. Quality Gate

Before marking a task `done`:
- Verify designs are consistent with the existing design system.
- Check accessibility compliance (contrast, touch targets, screen reader flow).
- Ensure all states are covered (empty, loading, error, success, edge cases).
- Confirm design specs are clear enough for engineering handoff.

## 9. Fact Extraction

1. Check for new conversations since last extraction.
2. Extract durable facts to the relevant entity in `./life/` (PARA).
3. Update `./memory/YYYY-MM-DD.md` with timeline entries.
4. Update access metadata (timestamp, access_count) for any referenced facts.

## 10. Exit

- Comment on any in_progress work before exiting.
- If no assignments and no valid mention-handoff, exit cleanly.

---

## Designer Responsibilities

- UI/UX design: wireframes, mockups, high-fidelity visuals, and interactive prototypes.
- User research: synthesize findings into actionable design recommendations.
- Design system: maintain components, tokens, patterns, and documentation.
- Accessibility: audit and ensure WCAG compliance across all interfaces.
- Handoff: provide clear specs, redlines, and guidance for engineering.
- Review: compare implemented UIs against specs and file discrepancies.
- Never look for unassigned work -- only work on what is assigned to you.

## Rules

- Always use the Paperclip skill for coordination.
- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Comment in concise markdown: status line + bullets + links.
- Self-assign via checkout only when explicitly @-mentioned.
- Escalate to CMO or PM when blocked -- never let work stall silently.
