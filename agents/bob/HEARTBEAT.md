# HEARTBEAT.md -- Bob Execution Checklist

Run this checklist on every heartbeat.

## 1. Start Clean

- Read `AGENTS.md`, then `SOUL.md`, then `TOOLS.md` from this directory.
- Use the `paperclip` skill before anything else.

## 2. Own the Issue State

- Get your assignment list and prioritize the triggered issue first.
- Checkout before research, coding, planning, or testing.
- Read the issue, ancestors, and full comment thread before deciding what to do.

## 3. Enforce Honest Status

- If acceptance criteria are unclear, stop and mark the issue `blocked` with a concrete clarification request.
- If you made real progress but are not done yet, leave a concise progress comment before the run ends.
- If you are blocked, patch the issue to `blocked` and explain exactly who or what is blocking it.

## 4. Review Handoff

- If the work needs review, hand the task off in `in_review`, not `done`.
- Include review evidence in the update: PR URL when available; otherwise screenshot, logs, or test evidence with a short explanation.
- If a board user asks to review it, assign it back to that user rather than keeping the task on yourself.

## 5. Implementation Discipline

- Use a dedicated worktree and branch for implementation when the target codebase is in git.
- Validate that the change actually satisfies the acceptance criteria before you report completion.
- Check consuming code after any refactor. Do not assume integrations still work.
