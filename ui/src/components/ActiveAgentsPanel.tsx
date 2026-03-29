import { useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import type { TranscriptEntry } from "../adapters";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { ExternalLink } from "lucide-react";
import { Identity } from "./Identity";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";

const MIN_DASHBOARD_RUNS = 4;

function isRunActive(run: LiveRunForIssue): boolean {
  return run.status === "queued" || run.status === "running";
}

function ragForRun(run: LiveRunForIssue): { label: "green" | "amber" | "red"; dot: string } {
  if (run.status === "failed" || run.status === "error" || run.status === "cancelled") {
    return { label: "red", dot: "bg-rose-500" };
  }
  if (run.status === "queued" || run.status === "running") {
    return { label: "green", dot: "bg-emerald-500" };
  }
  return { label: "amber", dot: "bg-amber-500" };
}

function transcriptSummary(entries: TranscriptEntry[]): string | null {
  if (!entries || entries.length === 0) return null;
  const latest = [...entries].reverse().find((entry) => {
    if (!("text" in entry)) return false;
    return typeof entry.text === "string" && entry.text.trim().length > 0;
  });
  if (!latest || !("text" in latest) || typeof latest.text !== "string") return null;
  return latest.text.trim() || null;
}

interface ActiveAgentsPanelProps {
  companyId: string;
}

export function ActiveAgentsPanel({ companyId }: ActiveAgentsPanelProps) {
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

  const { transcriptByRun } = useLiveRunTranscripts({
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
        <div className="h-[320px] overflow-y-auto rounded-xl border border-border bg-background/70 divide-y">
          {runs.map((run) => {
            const rag = ragForRun(run);
            const isActive = isRunActive(run);
            const issue = run.issueId ? issueById.get(run.issueId) : undefined;
            const transcript = transcriptByRun.get(run.id) ?? [];
            const lastAction = transcriptSummary(transcript)
              ?? run.triggerDetail
              ?? (isActive ? "Run active" : "No recent output");
            const timeLabel = isActive
              ? `Started ${relativeTime(run.createdAt)}`
              : run.finishedAt
                ? `Finished ${relativeTime(run.finishedAt)}`
                : `Started ${relativeTime(run.createdAt)}`;

            return (
              <div key={run.id} className="px-3 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cn("inline-flex h-2.5 w-2.5 rounded-full shrink-0", rag.dot)} title={rag.label} />
                      <Identity name={run.agentName} size="sm" className="[&>span:last-child]:!text-[11px]" />
                    </div>
                    <p className="text-xs text-muted-foreground truncate" title={lastAction}>
                      {lastAction}
                    </p>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{timeLabel}</span>
                      {issue && (
                        <span className="truncate">• {issue.identifier}</span>
                      )}
                    </div>
                  </div>
                  <Link
                    to={`/agents/${run.agentId}/runs/${run.id}`}
                    className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
