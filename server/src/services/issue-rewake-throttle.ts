/**
 * PAP-13775 / HIV-2654: terminate no-information issue re-wakes.
 *
 * External drivers — assignment pollers, the stranded-issue reconciler, the
 * successful-run handoff, on-demand invokes — re-wake the same agent for the
 * same issue for as long as it stays `in_progress`. When each of those runs
 * ends without changing any issue-visible state, every wake pays a full adapter
 * session for zero new information: 42 runs and 281k input tokens over three
 * hours against one execution issue, plus 156 throttled skips, on 2026-08-29.
 *
 * Founder direction, same day: a stalled issue is disclosed once and then left
 * alone. It is NOT retried on a longer and longer timer. Deterministic code
 * cannot resolve a blocker like an unusable workspace or a missing credential;
 * only the agent can, and only if it is told.
 *
 * The unit of judgment is the STALL EPISODE, not a time window. An episode
 * opens at the newest new issue input and holds every terminal run since. The
 * streak of consecutive succeeded-but-no-progress runs in it drives three
 * outcomes:
 *
 *   proceed  — below the disclosure streak; wake normally.
 *   disclose — exactly one more wake, stating the streak and when the newest
 *              stalled run finished, so the agent can reach a disposition:
 *              finish it, block it, record a finding, or escalate.
 *   stop     — the disclosed wake also produced nothing. Wake no further, and
 *              hand the issue back to the board as `blocked`. The streak is the
 *              only evidence; when every run in it came from a direct insert
 *              that bypassed this gate, no wake was ever admitted to disclose
 *              on. Tracking that would cost a marker on every run to save one
 *              message, and the board comment explains the stall either way.
 *
 * Episode, not window, because every clock-bounded variant of this decision
 * reopens itself. The first design used an escalating cooldown; a six-hour
 * lookback on the run sample would have done the same more slowly — once the
 * stalled runs age out the streak restarts at zero and "this is your only
 * further wake" becomes a lie told four times a day. Only real new input
 * reopens an episode, and the runs before it stop counting, so new work gets
 * its own full cycle rather than inheriting a spent one.
 *
 * `stop` blocks the issue rather than falling silent. Leaving it `in_progress`
 * with no wake and no owner is worse than the loop it replaces — the loop was
 * at least visible. Not a second terminator competing with the successful-run
 * handoff: both converge on `blocked`, and whichever arrives first makes the
 * other a no-op. It reuses the board's existing blocked contract — a
 * board-owned `unblockDescriptor` and a blocked transition — which is what
 * keeps the stale-hold reconciler from repairing the block straight back to
 * `todo`, and what puts the issue in a human's attention queue.
 *
 * Bypasses: fresh issue activity, `forceFreshSession`, a human actor, a human
 * comment wake, and any event-carrying reason. Agent-authored comment wakes
 * deliberately stay throttled so a cross-issue write cannot smuggle human wake
 * privileges. Process-loss retries insert runs directly and never reach this
 * gate, so crash recovery stays immediate; the stranded-issue reconciler and
 * the successful-run handoff do reach it, which is exactly why `stop` has to
 * block — it is removing their own escape.
 */

/** Consecutive no-progress runs after which the stall is disclosed to the agent. */
export const ISSUE_REWAKE_NO_PROGRESS_THRESHOLD = 2;

/**
 * Consecutive no-progress runs after which no further wake is issued. Exactly
 * one greater than the disclosure threshold, so a stall costs one disclosed
 * session and no more.
 */
export const ISSUE_REWAKE_STOP_THRESHOLD = ISSUE_REWAKE_NO_PROGRESS_THRESHOLD + 1;

/**
 * How many recent terminal runs to sample when computing the streak. The only
 * bound on the sample — deliberately a count, not an age.
 */
export const ISSUE_REWAKE_RUN_SAMPLE_LIMIT = 8;

/**
 * Wake reasons that assert issue state rather than deliver a new event.
 * These (plus reason-less on-demand invokes) are the only wakes the throttle
 * applies to; every event-shaped reason (comments, mentions, blockers
 * resolved, interactions, approvals, monitors, reviews, …) passes through.
 *
 * Membership also revokes the server-attached resume escape below, so an entry
 * that matches no real producer is not merely inert — keep this list to reasons
 * something actually enqueues. `issue_graph_liveness_backstop` was here and was
 * never one: that backstop enqueues `issue_blockers_resolved`, and the literal
 * appears only as an actor id.
 */
export const THROTTLED_ISSUE_REWAKE_REASONS: ReadonlySet<string> = new Set([
  "issue_assigned",
  "issue_continuation_needed",
  "issue_assignment_recovery",
  // The successful-run handoff asks the agent for a disposition — exactly what
  // the disclosed wake already asked for, in the same words. Left unthrottled
  // it starts one more full session after `stop`, which makes "this is the only
  // further wake you get" false. Below the disclosure threshold it is
  // unaffected, so ordinary handoffs still run.
  "finish_successful_run_handoff",
]);

/**
 * Activity actions that count as issue-visible progress when attributed to a
 * run. Deliberately narrower than run-liveness "concrete action evidence":
 * tool calls inside the workspace do not move the issue, so they do not reset
 * the streak — a run must leave a comment, mutation, document, work product,
 * interaction, or scheduled continuation behind.
 */
export const ISSUE_PROGRESS_ACTIVITY_ACTIONS: string[] = [
  "issue.updated",
  "issue.comment_added",
  "issue.created",
  "issue.child_created",
  "issue.assigned",
  "issue.released",
  "issue.blockers_updated",
  "issue.document_upserted",
  "issue.document_updated",
  "issue.document_deleted",
  "issue.document_restored",
  "issue.document_annotation_comment_added",
  "issue.document_annotation_thread_created",
  "issue.document_annotation_thread_resolved",
  "issue.work_product_created",
  "issue.work_product_updated",
  "issue.work_product_deleted",
  "issue.attachment_added",
  "issue.attachment_removed",
  "issue.thread_interaction_created",
  "issue.monitor_scheduled",
  "issue.approval_linked",
];

/**
 * Activity on the issue that counts as new external input — anything a waiting
 * agent should be woken for, including board responses to interactions. The
 * newest of these opens the current stall episode.
 */
export const ISSUE_NEW_INPUT_ACTIVITY_ACTIONS: string[] = [
  ...ISSUE_PROGRESS_ACTIVITY_ACTIONS,
  "issue.thread_interaction_accepted",
  "issue.thread_interaction_answered",
  "issue.thread_interaction_item_verdicts_submitted",
  "issue.blockers_resolved_wake_emitted",
];

export interface IssueRewakeCandidateInput {
  reason: string | null;
  wakeCommentId: string | null;
  requestedByActorType?: "user" | "agent" | "system" | null;
  forceFreshSession: boolean;
  hasExplicitResume: boolean;
}

/**
 * Whether a wake is even a candidate for throttling. Wakes that carry new
 * information or an explicit operator escalation always pass.
 */
export function isThrottleCandidateIssueRewake(input: IssueRewakeCandidateInput): boolean {
  if (input.forceFreshSession) return false;
  // Explicit resume is an operator privilege, not an actor-class escape hatch.
  // Agent-authored resume comments remain subject to the normal rewake throttle.
  //
  // A throttled reason overrides it, because the server attaches a resume to
  // its own wakes: `finish_successful_run_handoff` always carries
  // `resumeFromRunId`, so without this clause it took the operator door on
  // every real dispatch and the reason set below was never consulted — a
  // fourth full session started right after a stop that had just told the
  // agent it was getting none. The stranded-issue reconciler is unaffected: it
  // passes `retryOfRunId`, not a resume.
  if (
    input.hasExplicitResume &&
    input.requestedByActorType !== "agent" &&
    !(input.reason !== null && THROTTLED_ISSUE_REWAKE_REASONS.has(input.reason))
  ) {
    return false;
  }
  // A person pressing "invoke" is the operator door that survives a stop. The
  // on-demand invoke route sends no reason, which lands in the throttled class
  // below, so without this clause it would answer 202/skipped forever.
  if (input.requestedByActorType === "user") return false;
  if (input.wakeCommentId) return input.requestedByActorType === "agent";
  if (input.reason === null) return true;
  return THROTTLED_ISSUE_REWAKE_REASONS.has(input.reason);
}

export interface RecentIssueRunSample {
  id: string;
  status: string;
  finishedAt: Date | null;
}

export interface IssueRewakeThrottleInput {
  /** Terminal runs for the same (agent, issue), newest finish first. */
  recentTerminalRuns: RecentIssueRunSample[];
  /** Runs among the sample that produced issue-visible progress. */
  runIdsWithIssueProgress: ReadonlySet<string>;
  /**
   * When the newest new issue input landed, or null if there is none. Opens the
   * current stall episode: runs that finished before it belong to a previous
   * one and do not count.
   */
  newIssueInputAt: Date | null;
}

export type IssueRewakeThrottleDecision =
  | { action: "proceed"; noProgressStreak: number }
  | { action: "disclose"; noProgressStreak: number; lastRunFinishedAt: Date }
  | { action: "stop"; noProgressStreak: number; lastRunFinishedAt: Date };

/**
 * The evidence, with no instruction attached. Used on its own in the board
 * comment written when the issue is stopped: telling a run that is not
 * happening to "reach a disposition in this run" reads as noise to the person
 * who picks the issue up.
 */
export function buildIssueRewakeStallEvidence(input: {
  noProgressStreak: number;
  lastRunFinishedAt: Date;
  /** "The" for the board comment, "Your" when the agent is being addressed. */
  subject?: "The" | "Your";
}): string {
  return `${input.subject ?? "The"} last ${input.noProgressStreak} runs on this issue finished successfully but left no issue-visible progress \u2014 no comment, mutation, document, work product, interaction or scheduled continuation. The newest of them finished at ${input.lastRunFinishedAt.toISOString()}.`;
}

/**
 * The message handed to the agent on the single disclosed wake. It states the
 * evidence and the choice; it does not prescribe an outcome, because which
 * disposition is right depends on why the runs stalled — something only the
 * agent, looking at the workspace, can tell.
 */
export function buildIssueRewakeStallDisclosure(input: {
  noProgressStreak: number;
  lastRunFinishedAt: Date;
}): string {
  return [
    buildIssueRewakeStallEvidence({ ...input, subject: "Your" }),
    "This is the only further wake you get for this issue while nothing changes; after it the issue is blocked and handed back to the board. Reach a disposition in this run: finish it, block it on what it actually needs, record a finding, or escalate. If something in the environment is preventing progress \u2014 an unusable workspace, a missing credential, a permission you do not have \u2014 say so explicitly rather than repeating the attempt; nothing will retry this for you.",
  ].join("\n\n");
}

export function evaluateIssueRewakeThrottle(input: IssueRewakeThrottleInput): IssueRewakeThrottleDecision {
  const episodeStart = input.newIssueInputAt;
  const runs = episodeStart
    ? input.recentTerminalRuns.filter((run) => run.finishedAt !== null && run.finishedAt > episodeStart)
    : input.recentTerminalRuns;
  if (runs.length === 0) return { action: "proceed", noProgressStreak: 0 };

  let noProgressStreak = 0;
  for (const run of runs) {
    // A failed/cancelled/interrupted run breaks the streak: its follow-up is
    // recovery, not a redundant re-poll, and must not be delayed. A run with no
    // finish time has no place in the ordering either.
    if (run.status !== "succeeded" || run.finishedAt === null) break;
    if (input.runIdsWithIssueProgress.has(run.id)) break;
    noProgressStreak += 1;
  }

  if (noProgressStreak < ISSUE_REWAKE_NO_PROGRESS_THRESHOLD) {
    return { action: "proceed", noProgressStreak };
  }

  // Non-null by construction: the loop above counted at least one run, and it
  // only counts runs that have a finish time.
  const lastRunFinishedAt = runs[0].finishedAt as Date;
  if (noProgressStreak >= ISSUE_REWAKE_STOP_THRESHOLD) {
    return { action: "stop", noProgressStreak, lastRunFinishedAt };
  }
  return { action: "disclose", noProgressStreak, lastRunFinishedAt };
}
