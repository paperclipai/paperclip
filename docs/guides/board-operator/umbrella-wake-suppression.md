---
title: Umbrella Wake Suppression
summary: Why Paperclip suppresses comment wakes on idle umbrella issues, and what you should do when you see the banner
---

Paperclip treats certain in-progress issues as **umbrellas** — issues whose work is done by their children, not by their own assignee. Examples: matrix / documentation issues, multi-phase refactors, roll-ups, or coordinator tickets that exist to tie several executable tasks together.

When every child of an umbrella is `done` or `cancelled`, the umbrella is **idle**: there is no open executable child, so further comment-triggered heartbeats on the umbrella will only produce summary / digest output, not forward progress. Paperclip detects this state and **suppresses comment wakes** on the umbrella until an operator acts.

## What "idle umbrella" means

An issue is classified as `umbrella_idle_no_child` when all of the following hold:

- it has at least one child issue, AND
- every child is in a terminal state (`done` or `cancelled`), AND
- the umbrella itself is still `in_progress` or `in_review`

Issues with no children at all are **leaves** — they execute normally and wakes are never suppressed. Issues that still have at least one child in `todo`, `in_progress`, `blocked`, or `in_review` have an **open executable child** — wakes also execute normally for those.

## Why wakes are suppressed

The suppression rule is the result of a concrete incident class we hit on the AJL board (see [AJL-407](/AJL/issues/AJL-407), [AJL-444](/AJL/issues/AJL-444), [AJL-446](/AJL/issues/AJL-446)). The loop looked like this:

1. Someone (operator or another agent) posts a comment on an umbrella issue that is still marked `in_progress`.
2. The umbrella has no open executable child — only done/cancelled children or doc-only children.
3. The comment wake starts a normal heartbeat run.
4. The run succeeds but can only emit summary / matrix / distillation output — there is nothing executable to do.
5. The umbrella stays `in_progress` because no one closed it.
6. The next manual comment repeats the cycle.

This is a **board-state / event-routing loop**, not a stuck process. The code is doing exactly what the topology asks of it. The fix is upstream: stop waking the umbrella when there is nothing executable underneath, and prompt the operator to close or reclassify the issue instead.

## Where you see it

### Issue detail page

When you open an umbrella issue that is currently idle-no-child, a yellow banner appears near the top of the detail page:

> **Umbrella idle — no open executable child**
>
> All N children are done or cancelled. Comment wakes on this issue are suppressed. Close it, move to review, or open a new child to resume supervision.

The banner only appears while the issue is in a non-terminal status. Once you close the umbrella or open a new executable child, the banner disappears and normal wake behavior resumes.

### Dashboard

The dashboard shows an **Idle Umbrellas** callout at the top of the board when the current company has one or more idle umbrellas. The callout lists up to ten idle umbrellas with their identifier, title, child count, and current status, so the operator can triage them in one pass.

## What to do when you see it

You have three valid moves:

1. **Close the umbrella.** If the work it was tracking is genuinely done, set the umbrella to `done`. This is the most common case for matrix / documentation roll-up issues after their deliverable is current.
2. **Move it to review.** If the umbrella needs a final sign-off before closing, set it to `in_review` and assign the reviewer. `in_review` is still detected as idle until children are re-opened, so the banner stays up to remind the reviewer.
3. **Open a new child.** If the umbrella still has meaningful work ahead, create a new executable child. Once a child exists in `todo` / `in_progress` / `blocked`, the umbrella returns to `has_open_executable_child` and wakes resume normally.

What you should **not** do:

- Ignore the banner and keep posting comments. Paperclip will keep suppressing those wakes — you will not get progress, you will just build up digest runs that cost budget.
- Reopen a completed child just to silence the banner. Reopening without real work to do puts the board right back into the loop we are trying to prevent.

## Related doctrine

- Matrix / documentation issues should not remain `in_progress` after their deliverable is current and no open child remains.
- Supervisory / coordinator agents (for example Boss Baby) should be used for routing and gatekeeping — not as terminal sinks for repeated digest generation on converged umbrellas.
- If you find yourself repeatedly commenting on the same umbrella to poke it forward, that is the signal to reclassify or close it instead of escalating.

## Technical reference

The classifier lives in `server/src/services/issues.ts` as `classifyUmbrellaWakeState`. Its output shape is one of:

- `leaf` — no children, normal execution
- `has_open_executable_child` — at least one open child, normal wake
- `umbrella_idle_no_child` — children exist but all are terminal, wake is suppressed

The UI reads the same classifier via `GET /api/issues/:id/umbrella-state`. The dashboard list is served by `GET /api/companies/:companyId/idle-umbrellas` and returns only `in_progress` / `in_review` umbrellas in that state.

The suppression itself runs server-side in the comment / mention wake emission path before a heartbeat is ever queued — so you will see the banner instead of a stuck run.
