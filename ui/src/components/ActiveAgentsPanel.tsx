import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import type { TranscriptEntry } from "../adapters";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { ChevronRight, ExternalLink } from "lucide-react";
import { Identity } from "./Identity";
import { RunTranscriptView } from "./transcript/RunTranscriptView";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";

const MIN_DASHBOARD_RUNS = 4;

function isRunActive(run: LiveRunForIssue): boolean {
  return run.status === "queued" || run.status === "running";
}

interface ActiveAgentsPanelProps {
  companyId: string;
}

export function ActiveAgentsPanel({ companyId }: ActiveAgentsPanelProps) {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), "dashboard"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, MIN_DASHBOARD_RUNS),
  });

  const runs = liveRuns ?? [];
  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(companyId),
    queryFn: () => issuesApi.list(companyId),
    enabled: runs.length > 0,
  });

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues ?? []) {
      map.set(issue.id, issue);
    }
    return map;
  }, [issues]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs,
    companyId,
    maxChunksPerRun: 120,
  });

  return (
    <div>
      <h3 className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-muted-foreground/50 mb-3">
        Agent Runs
      </h3>
      {runs.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-mono text-muted-foreground/40">No recent agent runs.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden divide-y divide-border/50">
          {runs.map((run) => {
            const active = isRunActive(run);
            const issue = run.issueId ? issueById.get(run.issueId) : undefined;
            const transcript = transcriptByRun.get(run.id) ?? [];
            const hasOutput = hasOutputForRun(run.id);
            const isExpanded = expandedRunId === run.id;

            return (
              <AgentRunRow
                key={run.id}
                run={run}
                issue={issue}
                transcript={transcript}
                hasOutput={hasOutput}
                isActive={active}
                isExpanded={isExpanded}
                onToggle={() => setExpandedRunId(isExpanded ? null : run.id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function AgentRunRow({
  run,
  issue,
  transcript,
  hasOutput,
  isActive,
  isExpanded,
  onToggle,
}: {
  run: LiveRunForIssue;
  issue?: Issue;
  transcript: TranscriptEntry[];
  hasOutput: boolean;
  isActive: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const issueLabel = issue?.identifier ?? (run.issueId ? run.issueId.slice(0, 8) : null);
  const issueTitle = issue?.title;

  return (
    <div className={cn(
      isActive && "bg-brand-accent-muted/20",
    )}>
      <div
        className={cn(
          "flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-accent/40",
          isActive && "border-l-2 border-l-brand-accent",
        )}
        onClick={onToggle}
      >
        <ChevronRight className={cn(
          "h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-150",
          isExpanded && "rotate-90",
        )} />

        {isActive ? (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-accent opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-accent" />
          </span>
        ) : (
          <span className="inline-flex h-2 w-2 shrink-0 bg-muted-foreground/30" />
        )}

        <Identity name={run.agentName} size="sm" className="shrink-0" />

        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {issueLabel && (
            <>
              <span className="font-mono">{issueLabel}</span>
              {issueTitle && <span className="ml-1">— {issueTitle}</span>}
            </>
          )}
        </span>

        <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">
          {isActive ? "Live" : run.finishedAt ? relativeTime(run.finishedAt) : relativeTime(run.createdAt)}
        </span>

        <Link
          to={`/agents/${run.agentId}/runs/${run.id}`}
          className="shrink-0 rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>

      {isExpanded && (
        <div className="border-t border-border/50 bg-background/50 px-4 py-3 max-h-48 overflow-y-auto">
          <RunTranscriptView
            entries={transcript}
            density="compact"
            limit={5}
            streaming={isActive}
            collapseStdout
            thinkingClassName="!text-[10px] !leading-4"
            emptyMessage={hasOutput ? "Waiting for transcript parsing..." : isActive ? "Waiting for output..." : "No transcript captured."}
          />
        </div>
      )}
    </div>
  );
}
