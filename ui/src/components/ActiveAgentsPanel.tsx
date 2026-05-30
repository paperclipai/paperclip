import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { IssueSummary } from "@paperclipai/shared";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import type { TranscriptEntry } from "../adapters";
import { isOpenLiveRun, isRunningLiveRun } from "../lib/live-runs";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { ExternalLink } from "lucide-react";
import { Identity } from "./Identity";
import { RunTranscriptView } from "./transcript/RunTranscriptView";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";

const MIN_DASHBOARD_RUNS = 4;

interface ActiveAgentsPanelProps {
  companyId: string;
  issueById: Map<string, IssueSummary>;
}

export function ActiveAgentsPanel({ companyId, issueById }: ActiveAgentsPanelProps) {
  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), "dashboard"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, MIN_DASHBOARD_RUNS),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const runs = liveRuns ?? [];

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs,
    companyId,
    maxChunksPerRun: 120,
  });

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Agents
      </h3>
      {runs.length === 0 ? (
        <div className="rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">No recent agent runs.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
          {runs.map((run) => (
            <AgentRunCard
              key={run.id}
              run={run}
              issue={run.issueId ? issueById.get(run.issueId) : undefined}
              transcript={transcriptByRun.get(run.id) ?? []}
              hasOutput={hasOutputForRun(run.id)}
              isOpen={isOpenLiveRun(run.status)}
              isRunning={isRunningLiveRun(run.status)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRunCard({
  run,
  issue,
  transcript,
  hasOutput,
  isOpen,
  isRunning,
}: {
  run: LiveRunForIssue;
  issue?: IssueSummary;
  transcript: TranscriptEntry[];
  hasOutput: boolean;
  isOpen: boolean;
  isRunning: boolean;
}) {
  const statusLabel = isRunning
    ? "Live now"
    : run.status === "queued"
      ? "Queued"
      : run.finishedAt
        ? `Finished ${relativeTime(run.finishedAt)}`
        : `Started ${relativeTime(run.createdAt)}`;
  const emptyMessage = hasOutput
    ? "Waiting for transcript parsing..."
    : run.status === "queued"
      ? "Queued to start..."
      : run.logRef
        ? "Waiting for output..."
        : "No persisted transcript for this run.";

  return (
    <div className={cn(
      "flex h-[320px] flex-col overflow-hidden rounded-xl border shadow-sm",
      isOpen
        ? "border-cyan-500/25 bg-cyan-500/[0.04] shadow-[0_16px_40px_rgba(6,182,212,0.08)]"
        : "border-border bg-background/70",
    )}>
      <div className="border-b border-border/60 px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {isOpen ? (
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span
                    className={cn(
                      "absolute inline-flex h-full w-full rounded-full opacity-70",
                      isRunning ? "animate-ping bg-cyan-400" : "bg-amber-300",
                    )}
                  />
                  <span
                    className={cn(
                      "relative inline-flex h-2.5 w-2.5 rounded-full",
                      isRunning ? "bg-cyan-500" : "bg-amber-500",
                    )}
                  />
                </span>
              ) : (
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/35" />
              )}
              <Identity name={run.agentName} size="sm" className="[&>span:last-child]:!text-[11px]" />
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>{statusLabel}</span>
            </div>
          </div>

          <Link
            to={`/agents/${run.agentId}/runs/${run.id}`}
            className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-2.5 w-2.5" />
          </Link>
        </div>

        {run.issueId && (
          <div className="mt-3 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 text-xs">
            <Link
              to={`/issues/${issue?.identifier ?? run.issueId}`}
              className={cn(
                "line-clamp-2 hover:underline",
                isOpen ? "text-cyan-700 dark:text-cyan-300" : "text-muted-foreground hover:text-foreground",
              )}
              title={issue?.title ? `${issue?.identifier ?? run.issueId.slice(0, 8)} - ${issue.title}` : issue?.identifier ?? run.issueId.slice(0, 8)}
            >
              {issue?.identifier ?? run.issueId.slice(0, 8)}
              {issue?.title ? ` - ${issue.title}` : ""}
            </Link>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <RunTranscriptView
          entries={transcript}
          density="compact"
          limit={5}
          streaming={isRunning}
          collapseStdout
          thinkingClassName="!text-[10px] !leading-4"
          emptyMessage={emptyMessage}
        />
      </div>
    </div>
  );
}
