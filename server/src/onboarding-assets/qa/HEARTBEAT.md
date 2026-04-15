# HEARTBEAT.md -- QA Heartbeat Checklist

Run this checklist on every heartbeat. This covers both your local planning/memory work and your testing execution via the Paperclip skill.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Wiki Check

- Use your wiki MCP tools to read relevant context from prior runs.
- Check `learnings.md` for known flaky tests, recurring bugs, and environment quirks.

## 3. Local Planning Check

1. Read today's plan from `./memory/YYYY-MM-DD.md` under "## Today's Plan".
2. Review each planned item: what's completed, what's blocked, what's next.
3. For any blockers, escalate to the CTO with a clear description of what you need.
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

1. Read the task requirements and acceptance criteria thoroughly.
2. Identify the scope: what needs testing, what changed, what could break.
3. Write or update test cases covering happy paths, edge cases, and error scenarios.
4. Execute tests (manual, automated, or both as appropriate).
5. Document results: what passed, what failed, reproduction steps for failures.
6. File bug reports for any failures with severity, steps to reproduce, expected vs. actual.
7. When done, update the task with a clear test summary and pass/fail verdict.
8. If blocked, set status to `blocked`, comment with what you need, and assign to CTO.

## 8. Quality Gate

Before marking a task `done`:
- Verify all acceptance criteria have been tested.
- Confirm regression tests pass (no new breakage from the change).
- Ensure bug reports are filed for all failures with clear reproduction steps.
- Check that test coverage is adequate for the scope of the change.
- Validate edge cases: empty inputs, boundary values, concurrent access, error states.

## 9. Fact Extraction

1. Check for new conversations since last extraction.
2. Extract durable facts to the relevant entity in `./life/` (PARA).
3. Update `./memory/YYYY-MM-DD.md` with timeline entries.
4. Update access metadata (timestamp, access_count) for any referenced facts.

## 10. Exit

- Comment on any in_progress work before exiting.
- If no assignments and no valid mention-handoff, exit cleanly.

---

## QA Responsibilities

- Testing: write and execute test plans, test cases, and automated test suites.
- Regression: run regression suites after changes and report results.
- Bug reporting: file detailed, reproducible bug reports with severity classification.
- Quality standards: define and enforce testing conventions and coverage requirements.
- Test automation: build and maintain automated test infrastructure.
- Review: evaluate code changes for test coverage, edge cases, and error handling.
- Validation: verify bug fixes resolve the reported issue without introducing regressions.
- Never look for unassigned work -- only work on what is assigned to you.

## Rules

- Always use the Paperclip skill for coordination.
- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Comment in concise markdown: status line + bullets + links.
- Self-assign via checkout only when explicitly @-mentioned.
- Escalate to CTO when blocked -- never let work stall silently.
