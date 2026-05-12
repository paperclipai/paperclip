import { memo, useMemo } from "react";
import type { TranscriptEntry } from "../adapters";
import type { LiveRunForIssue } from "../api/heartbeats";
import { IssueChatThread } from "./IssueChatThread";
import type { IssueChatLinkedRun } from "../lib/issue-chat-messages";

const EMPTY_COMMENTS: [] = [];
const EMPTY_TIMELINE_EVENTS: [] = [];
const EMPTY_LIVE_RUNS: [] = [];
const EMPTY_LINKED_RUNS: [] = [];
const handleEmbeddedAdd = async () => {};

function isRunActive(run: LiveRunForIssue) {
  return run.status === "queued" || run.status === "running";
}

interface RunChatSurfaceProps {
  run: LiveRunForIssue;
  transcript: TranscriptEntry[];
  hasOutput: boolean;
  companyId?: string | null;
}

export const RunChatSurface = memo(function RunChatSurface({
  run,
  transcript,
  hasOutput,
  companyId,
}: RunChatSurfaceProps) {
  const active = isRunActive(run);
  const liveRuns = useMemo(() => (active ? [run] : EMPTY_LIVE_RUNS), [active, run]);
  const linkedRuns = useMemo<IssueChatLinkedRun[]>(
    () =>
      active
        ? EMPTY_LINKED_RUNS
        : [{
            runId: run.id,
            status: run.status,
            agentId: run.agentId,
            agentName: run.agentName,
            createdAt: run.createdAt,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          }],
    [active, run],
  );
  const transcriptsByRunId = useMemo(
    () => new Map([[run.id, transcript as readonly TranscriptEntry[]]]),
    [run.id, transcript],
  );

  return (
    <IssueChatThread
      comments={EMPTY_COMMENTS}
      linkedRuns={linkedRuns}
      timelineEvents={EMPTY_TIMELINE_EVENTS}
      liveRuns={liveRuns}
      companyId={companyId}
      onAdd={handleEmbeddedAdd}
      showComposer={false}
      showJumpToLatest={false}
      variant="embedded"
      emptyMessage={active ? "Waiting for run output..." : "No run output captured."}
      enableLiveTranscriptPolling={false}
      transcriptsByRunId={transcriptsByRunId}
      hasOutputForRun={(runId) => runId === run.id && hasOutput}
      includeSucceededRunsWithoutOutput
    />
  );
});
