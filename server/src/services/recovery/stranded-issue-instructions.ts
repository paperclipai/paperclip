/**
 * Required-action blocks handed to the owner of a stranded-issue recovery task.
 *
 * The recovery owner is a manager/executive who did not do the source issue's work and
 * cannot attest to it. Treating "resolve the source issue" as part of the recovery task
 * lets the owner substitute a plausible completion report for the work itself.
 */

export const STRANDED_ISSUE_RECOVERY_REQUIRED_ACTION = [
  "- Inspect the latest run and source issue state.",
  "- Restore a live execution path: fix the runtime/adapter problem, or reassign the source issue to an executing agent.",
  "- You are the recovery owner, not the assignee. Never do the source issue's work yourself, and never mark the source issue `done` or `cancelled` — only its assignee may complete it, after actually doing the work.",
  "- If the source issue's assignee claims the work is already finished, never trust that self-report. Verify the claimed artifact exists at the location the source issue requires (file in the repo/vault, commit, document, URL). A completion comment is not evidence.",
  "- If no execution path can be restored, leave the source issue `blocked` and escalate to a human instead of resolving it.",
  "- When the source issue has a live execution path or a human has taken it over, mark this recovery issue done.",
];

export const SUCCESSFUL_RUN_MISSING_STATE_REQUIRED_ACTION = [
  "- Inspect the source issue and run metadata, not raw transcript excerpts.",
  "- Choose a valid issue disposition: `done`/`cancelled`, `in_review` with an owner, `blocked` with first-class blockers, delegated follow-up work, or an explicit continuation path.",
  "- Never do the source issue's work yourself. If the work is unfinished, hand it back to an executing agent — do not substitute your own output for it.",
  "- Before recording `done`, verify the artifact the source issue asked for actually exists where it was required (file in the repo/vault, commit, document, URL). Never rely on the assignee's self-report or on a completion comment; an artifact delivered to the wrong location is not `done`.",
  "- When the source issue has a clear owner and a verified disposition, mark this recovery issue done.",
];
