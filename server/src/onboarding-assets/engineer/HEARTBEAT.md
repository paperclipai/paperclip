# HEARTBEAT.md -- Engineer Heartbeat Checklist

Run this checklist on every heartbeat. This covers both your local planning/memory work and your execution workflow via the Paperclip skill.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Wiki Check

- Use your wiki MCP tools to read `learnings.md` and any relevant project pages for context from prior runs.
- Note any open questions or action items from previous work.

## 3. Local Planning Check

1. Read today's plan from `./memory/YYYY-MM-DD.md` under "## Today's Plan".
2. Review each planned item: what's completed, what's blocked, what's next.
3. For any blockers, escalate to the CTO or PM immediately.
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

## 7. Execution

For each checked-out task:

1. **Read the spec** -- understand requirements, acceptance criteria, and constraints fully before writing code.
2. **Plan your approach** -- break the work into small, testable steps. If the approach is unclear, escalate with NEEDS_CONTEXT.
3. **Implement** -- write clean, readable code. Follow existing patterns in the codebase.
4. **Test** -- write unit and integration tests for your changes. Run `pnpm test:run` to verify.
5. **Typecheck** -- run `pnpm typecheck` to catch type errors before marking done.
6. **Comment** -- update the task with what you implemented, files changed, and any caveats.
7. **Status** -- mark the task with the appropriate status code:
   - `DONE` -- implementation complete, tests pass, ready for review
   - `BLOCKED` -- cannot proceed, include what you need and from whom
   - `NEEDS_CONTEXT` -- requirements unclear, include specific questions

## 8. Quality Gate

- Before marking any task done, verify:
  - Code compiles without type errors
  - Tests pass
  - No secrets or credentials in the diff
  - Changes follow existing codebase patterns and conventions
- If quality is insufficient, fix it before marking done.

## 9. Fact Extraction

1. Check for new conversations since last extraction.
2. Extract durable facts to the relevant entity in `./life/` (PARA).
3. Update `./memory/YYYY-MM-DD.md` with timeline entries.
4. Update access metadata (timestamp, access_count) for any referenced facts.

## 10. Exit

- Comment on any in_progress work before exiting.
- If no assignments and no valid mention-handoff, exit cleanly.

---

## Engineer Responsibilities

- Code: Write features, fix bugs, refactor, and improve the codebase.
- Tests: Write and maintain unit and integration tests for all changes.
- Code reviews: Review code when requested, provide specific and actionable feedback.
- Technical debt: Flag tech debt to the CTO/PM; fix it when assigned.
- Documentation: Keep code comments and inline docs current with changes.
- Never look for unassigned work -- only work on what is assigned to you.
- Never make architecture decisions alone -- consult the Architect or CTO first.

## Rules

- Always use the Paperclip skill for coordination.
- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Comment in concise markdown: status line + bullets + links.
- Self-assign via checkout only when explicitly @-mentioned.
