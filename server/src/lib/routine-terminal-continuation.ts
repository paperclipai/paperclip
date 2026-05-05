/**
 * Central definitions for guarding routine_execution issues in terminal statuses
 * against synthetic continuation wakes (children completed, comment-driven reopen envelopes,
 * recovery continuation) without structured resume intent.
 */

/** Wake envelope reasons tied to automation/continuation paths that must never reopen routine terminal output casually. */
export const ROUTINE_TERMINAL_SYNTHETIC_CONTINUATION_WAKE_REASONS: ReadonlySet<string> = new Set([
  "issue_children_completed",
  "issue_reopened_via_comment",
  "issue_continuation_needed",
]);

function readTrimmedString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function classifyWakeReasonFromContext(context: Record<string, unknown>): string | null {
  return readTrimmedString(context, "wakeReason") ?? readTrimmedString(context, "reason") ?? null;
}

/** Matches PATCH/POST semantics: structured `resume: true` stamps resumeIntent/followUpRequested on snapshots. */
export function resumeIntentFromIssueWakeContext(context: Record<string, unknown>): boolean {
  return (
    context.resume === true || context.resumeIntent === true || context.followUpRequested === true
  );
}

export function isRoutineTerminalSyntheticContinuationWake(wakeReason: string | null | undefined): boolean {
  return typeof wakeReason === "string" && ROUTINE_TERMINAL_SYNTHETIC_CONTINUATION_WAKE_REASONS.has(wakeReason);
}
