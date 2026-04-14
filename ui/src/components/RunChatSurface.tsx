import { useMemo } from "react";
import type { TranscriptEntry } from "../adapters";
import type { LiveRunForIssue } from "../api/heartbeats";
import { useLocale } from "../context/LocaleContext";
import { IssueChatThread } from "./IssueChatThread";
import type { IssueChatLinkedRun } from "../lib/issue-chat-messages";

function isRunActive(run: LiveRunForIssue) {
  return run.status === "queued" || run.status === "running";
}

interface RunChatSurfaceProps {
  run: LiveRunForIssue;
  transcript: TranscriptEntry[];
  hasOutput: boolean;
  companyId?: string | null;
}

export function RunChatSurface({
  run,
  transcript,
  hasOutput,
  companyId,
}: RunChatSurfaceProps) {
  const { t } = useLocale();
  const active = isRunActive(run);
  const liveRuns = active ? [run] : [];
  const linkedRuns = useMemo<IssueChatLinkedRun[]>(
    () =>
      active
        ? []
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
      comments={[]}
      linkedRuns={linkedRuns}
      timelineEvents={[]}
      liveRuns={liveRuns}
      companyId={companyId}
      onAdd={async () => {}}
      showComposer={false}
      showJumpToLatest={false}
      variant="embedded"
      emptyMessage={active ? t("runChatSurface.waitingForRunOutput") : t("runChatSurface.noRunOutputCaptured")}
      enableLiveTranscriptPolling={false}
      transcriptsByRunId={transcriptsByRunId}
      hasOutputForRun={(runId) => runId === run.id && hasOutput}
      includeSucceededRunsWithoutOutput
    />
  );
}
