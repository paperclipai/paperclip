import { isTerminalRunStatus } from "./transcript-adapter";

export interface TranscriptBudgetRun {
  id: string;
  status: string;
}

export interface BudgetedTranscriptRun {
  runId: string;
  settled: boolean;
}

/**
 * Select the pending transcript runs that may stop holding the first reveal
 * when the transcript budget expires. The work is one pass over the runs, with
 * one anchor lookup for each live run.
 *
 * - A live run streams into the tail, so it may stop holding the reveal,
 *   unless it has steering or timeline anchors. Its pre-anchor segments enter
 *   the main chronology above the anchored messages.
 * - A settled run may stop holding the reveal only when compact history can
 *   show it behind the fixed "More run output" control.
 */
export function selectBudgetedTranscriptRuns<Run extends TranscriptBudgetRun>(
  pendingRuns: readonly Run[],
  options: {
    compactDeferral: boolean;
    hasTimelineAnchors: (run: Run) => boolean;
  },
): BudgetedTranscriptRun[] {
  const budgeted: BudgetedTranscriptRun[] = [];
  for (const run of pendingRuns) {
    const settled = isTerminalRunStatus(run.status);
    if (settled ? !options.compactDeferral : options.hasTimelineAnchors(run)) continue;
    budgeted.push({ runId: run.id, settled });
  }
  return budgeted;
}
