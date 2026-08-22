---
name: cycle-report
description: At the end of every cycle, write a structured outcome report to the issue's `cycle-report` document — what happened, what you did, what the Board should know, and whether anything is waiting on review. This is how Paperclip's own success/quality trend gets measured over time; skipping it leaves this cycle invisible to that record.
key: paperclipai/bundled/paperclip-operations/cycle-report
recommendedForRoles:
  - manager
  - engineer
  - product
  - general
tags:
  - paperclip
  - reporting
  - operations
  - observability
---

# Cycle Report

Every other skill in this catalog produces work. This one produces the **record of the work** — a short, structured, honest account of what a single cycle did, written back to the issue as a durable document. Without it, the only trace a cycle leaves is scattered comments and a status field; there is no queryable answer to "is Paperclip actually getting better over time." This skill is that answer, one cycle at a time.

## When to use

**Every cycle, as the last thing you do before the run ends** — regardless of whether the cycle succeeded, failed, got blocked, or was cancelled. This is not conditional on the work being interesting or complete. A cycle that failed and a cycle that shipped cleanly are equally worth recording; the failure is often the more valuable data point.

## When not to use

- You are not concluding a cycle — this is not a status update mid-work (see `summarize-status` for that) and not a plan (see `task-planning`).
- A sub-step of a larger cycle just finished but the overall cycle continues. Report once, at the true end.

## Report structure

Required fields, written as JSON to the `cycle-report` document (not markdown — this document is read by other agents and by aggregation tooling, not primarily by humans on the board):

```json
{
  "version": 1,
  "cycleId": "<this issue's id>",
  "runId": "<your run id, from the environment>",
  "timestamp": "<ISO 8601, now>",
  "outcome": "done" | "cancelled" | "blocked" | "in_review" | "delegated" | "error",
  "summary": "<1-3 sentences, plain language, what actually happened>",
  "actions_taken": ["<short imperative phrase>", "..."],
  "proposals_for_board": ["<anything you think a human should decide, or empty>"],
  "critical_findings": ["<anything a human should know even if no decision is needed, or empty>"],
  "review_pending": {
    "interactionId": "<id, if you opened a request_confirmation this cycle>",
    "reason": "<why, in one clause>"
  } | null
}
```

Field notes:

- **`outcome`** — must match the disposition you are actually recording for this issue (see the successful-run-handoff disposition types). Do not report `done` if you are about to leave the issue `blocked`.
- **`summary`** — write it the way you'd tell a colleague what happened in one breath. Not a status-jargon dump.
- **`actions_taken`** — concrete, verifiable things you did (files changed, comments posted, tests run) — not intentions. If you did nothing because the cycle was a no-op check, say so: `["confirmed nothing needed action"]`, not an empty list pretending work happened.
- **`proposals_for_board`** and **`critical_findings`** — empty arrays are a normal, honest result. Never invent a proposal or finding to avoid an empty array — a cycle that surfaced nothing noteworthy should say exactly that.
- **`review_pending`** — only set this if you actually opened a `request_confirmation` interaction this cycle (per `task-planning` or your own skill's approval step). Reference its real `interactionId`. Never set this to a vague "someone should look at this eventually" — that belongs in `proposals_for_board` instead. `null` is the common case.

## Filing the report

1. Gather the fields above from what you actually did this cycle — do not reconstruct after the fact from memory once the run is ending; keep a running note as you work if the cycle is long.
2. `PUT /api/issues/{issueId}/documents/cycle-report` with the JSON body above. If a `cycle-report` document already exists on this issue from an earlier cycle (issues can span multiple cycles), include the latest `baseRevisionId` — do not overwrite silently.
3. No confirmation, comment, or interaction is required for this write itself — it is a report, not a mutation the Board needs to approve. It should be your last write of the cycle.

## Anti-patterns

- **Skipping it because the cycle "didn't do much."** A no-op cycle is exactly the kind of signal this record exists to capture — silence here is what made recursive improvement unmeasurable before this skill existed.
- **Padding `proposals_for_board` or `critical_findings` to look thorough.** Empty is honest more often than not. A report that always has 3 findings is not being read carefully by whoever consumes it later.
- **Writing the report from memory after losing track of what you did.** If you can't reconstruct `actions_taken` accurately, that itself is worth noting in `summary` rather than guessing.
- **Setting `review_pending` without a real `interactionId`.** If nothing is actually gating on human review, it's `null`.
- **Treating this as a markdown status card.** That's `summarize-status`'s job, for a different audience (the board UI) and a different scope (project/workspace, not one cycle). This document is structured data for the aggregate record.

## Verification (self-check before ending the cycle)

- [ ] `outcome` matches the issue's actual disposition, not an aspirational one
- [ ] `actions_taken` lists things that actually happened, not intentions
- [ ] `proposals_for_board` / `critical_findings` are empty if there is genuinely nothing — not padded
- [ ] `review_pending` is `null` unless it references a real, currently-open interaction
- [ ] This is the last write before the cycle ends
