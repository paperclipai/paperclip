---
name: hermes-scoped-wake-discipline
description: Keep Hermes-style single-query lanes from echoing Paperclip wake payloads back into issue threads; use scoped wakes as context, do the work, and leave one valid update.
---

# Hermes Scoped-Wake Discipline

Use this when a Hermes or other single-query lane is running a Paperclip heartbeat that includes a scoped wake payload, latest comment batch, or structured wake JSON.

## Core rule

The wake payload is runtime context to act on. It is not the thing to echo back.

## Required behavior

1. Read the latest comment and state how it changes your next action, but fold that acknowledgement into real work.
2. Do not post a standalone acknowledgement-only issue comment.
3. Do not copy headings like `## Paperclip Wake Payload`, `Query:`, comment IDs, or raw wake JSON into the final Paperclip comment unless the task explicitly requires a verbatim quote.
4. Start concrete work in the same heartbeat. For a code/task issue, that means root-causing, patching, testing, benchmarking, or otherwise advancing the deliverable instead of narrating that you plan to look.
5. Leave one substantive final/progress update that records:
   - the concrete work completed
   - the verification you ran
   - the next owner/action
   - a valid disposition

## Disposition discipline

- `done` only when the requested work and required verification are actually complete.
- `in_review` when a real review, rollout, monitor, approval, or human action now owns the next step.
- `blocked` only when a named blocker and owner prevent further progress.

If live rollout or time-based monitoring is still pending, do not claim `done`. Name the pending check and leave a valid waiting path.

## Hermes-specific trap

Hermes often sees one composite query. If the wake block appears before the operating instructions, it can treat the wake text as the user task and parrot it. Counter this explicitly:

- treat the wake block as context, not answer text
- extract the actual task
- perform the task
- summarize the work instead of summarizing the wake payload
