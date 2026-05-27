import { memo, useMemo } from "react";
import type { TranscriptEntry } from "../adapters";
import type { LiveRunForIssue } from "../api/heartbeats";
import { IssueChatThread } from "./IssueChatThread";
import type { IssueChatLinkedRun } from "../lib/issue-chat-messages";
import { useCurrentLocale, useLocalizedCopy } from "@/i18n/ui-copy";

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
  locale?: string | null;
}

export const RunChatSurface = memo(function RunChatSurface({
  run,
  transcript,
  hasOutput,
  companyId,
  locale: localeProp,
}: RunChatSurfaceProps) {
  const currentLocale = useCurrentLocale();
  const copy = useLocalizedCopy();
  const locale = localeProp ?? currentLocale;
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
      emptyMessage={active
        ? copy("runChat.waitingForOutput", "Waiting for run output...", "실행 출력을 기다리는 중...")
        : copy("runChat.noOutputCaptured", "No run output captured.", "저장된 실행 출력이 없습니다.")}
      enableLiveTranscriptPolling={false}
      transcriptsByRunId={transcriptsByRunId}
      hasOutputForRun={(runId) => runId === run.id && hasOutput}
      includeSucceededRunsWithoutOutput
      locale={locale}
    />
  );
});
