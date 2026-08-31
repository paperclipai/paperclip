import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";
import type { RunTranscriptSource } from "../components/transcript/useLiveRunTranscripts";
import type { IssueChatLinkedRun } from "./issue-chat-messages";

/**
 * Upper bound on how many runs an issue thread streams live transcripts for.
 *
 * Live/active runs are always included (they are the ones actually streaming);
 * older linked runs are historical and only fill the remaining slots, most
 * recent first. Without this cap a long-lived issue with a large run history
 * would open a live-transcript poll/subscription for every run it ever had —
 * multiplying the steady-state polling and re-render churn (and off-heap
 * growth) that this change set is fixing.
 */
export const MAX_ISSUE_CHAT_TRANSCRIPT_RUNS = 20;

function toTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function resolveIssueChatTranscriptRuns(args: {
  linkedRuns?: readonly IssueChatLinkedRun[];
  liveRuns?: readonly LiveRunForIssue[];
  activeRun?: ActiveRunForIssue | null;
  limit?: number;
}): RunTranscriptSource[] {
  const { linkedRuns = [], liveRuns = [], activeRun = null, limit = MAX_ISSUE_CHAT_TRANSCRIPT_RUNS } = args;
  const combined = new Map<string, RunTranscriptSource>();

  for (const run of liveRuns) {
    combined.set(run.id, {
      id: run.id,
      status: run.status,
      adapterType: run.adapterType,
      logBytes: run.logBytes,
      lastOutputBytes: run.lastOutputBytes,
    });
  }

  if (activeRun) {
    combined.set(activeRun.id, {
      id: activeRun.id,
      status: activeRun.status,
      adapterType: activeRun.adapterType,
      logBytes: activeRun.logBytes,
      lastOutputBytes: activeRun.lastOutputBytes,
    });
  }

  // Live/active runs above are always retained; fill the remaining slots with
  // the most recently created linked runs so the retained set is bounded.
  const remainingLinked = [...linkedRuns]
    .filter((run) => !combined.has(run.runId) && run.adapterType)
    .sort((a, b) => toTimestamp(b.createdAt) - toTimestamp(a.createdAt));

  for (const run of remainingLinked) {
    if (combined.size >= limit) break;
    const adapterType = run.adapterType;
    if (!adapterType) continue;
    combined.set(run.runId, {
      id: run.runId,
      status: run.status,
      adapterType,
      hasStoredOutput: run.hasStoredOutput,
      logBytes: run.logBytes,
    });
  }

  return [...combined.values()];
}
