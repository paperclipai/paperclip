import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, AcceptedPlanDecompositionSummary } from "@paperclipai/shared";
import { ChevronRight, GitBranch, Repeat, CheckCircle2, Loader2 } from "lucide-react";
import { Link } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, relativeTime } from "../lib/utils";

interface IssuePlanDecompositionsSectionProps {
  issueId: string;
  issueIdentifier: string | null;
  agentMap?: Map<string, Agent>;
}

function StatusBadge({ status }: { status: AcceptedPlanDecompositionSummary["status"] }) {
  if (status === "completed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-sm border border-emerald-500/50 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-900 dark:text-emerald-100">
        <CheckCircle2 className="h-3 w-3" />
        Completed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:text-amber-100">
      <Loader2 className="h-3 w-3 animate-spin" />
      In flight
    </span>
  );
}

export function IssuePlanDecompositionsSection({
  issueId,
  issueIdentifier,
  agentMap,
}: IssuePlanDecompositionsSectionProps) {
  const { data: decompositions } = useQuery({
    queryKey: queryKeys.issues.acceptedPlanDecompositions(issueId),
    queryFn: () => issuesApi.listAcceptedPlanDecompositions(issueId),
  });

  const items = useMemo(() => decompositions ?? [], [decompositions]);
  if (items.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">Plan decomposition</h3>
        <span className="text-[11px] text-muted-foreground/80">
          {items.length === 1 ? "1 accepted plan revision" : `${items.length} accepted plan revisions`}
        </span>
      </div>

      <ul className="space-y-3">
        {items.map((record) => {
          const requested = record.requestedChildCount ?? 0;
          const created = record.childIssueIds?.length ?? 0;
          const ownerName = record.ownerAgentId
            ? agentMap?.get(record.ownerAgentId)?.name ?? "agent"
            : null;
          const revisionLabel =
            record.acceptedPlanRevisionNumber != null
              ? `revision ${record.acceptedPlanRevisionNumber}`
              : `revision ${record.acceptedPlanRevisionId.slice(0, 8)}`;
          const completedAt =
            record.completedAt && typeof record.completedAt === "string"
              ? record.completedAt
              : record.completedAt instanceof Date
                ? record.completedAt.toISOString()
                : null;
          const updatedAt =
            typeof record.updatedAt === "string"
              ? record.updatedAt
              : record.updatedAt instanceof Date
                ? record.updatedAt.toISOString()
                : null;
          const startedAt =
            typeof record.createdAt === "string"
              ? record.createdAt
              : record.createdAt instanceof Date
                ? record.createdAt.toISOString()
                : null;

          return (
            <li
              key={record.id}
              className="rounded-md border border-border bg-card/50 p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={record.status} />
                <span className="text-xs text-muted-foreground">
                  Plan {revisionLabel}
                </span>
                <span className="text-xs text-muted-foreground/70">·</span>
                <span className="inline-flex items-center gap-1 text-xs text-foreground">
                  <GitBranch className="h-3 w-3 text-muted-foreground" />
                  {created} of {requested} child {requested === 1 ? "task" : "tasks"} created
                </span>
                {record.status === "completed" && requested > 0 ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-sm border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-900 dark:text-sky-100"
                    title="Repeat attempts with this fingerprint reuse this record instead of creating new children"
                  >
                    <Repeat className="h-3 w-3" />
                    Idempotent claim
                  </span>
                ) : null}
              </div>

              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                {ownerName ? <span>Owner: {ownerName}</span> : null}
                {startedAt ? (
                  <span title={formatDateTime(startedAt)}>Started {relativeTime(startedAt)}</span>
                ) : null}
                {completedAt ? (
                  <span title={formatDateTime(completedAt)}>Completed {relativeTime(completedAt)}</span>
                ) : updatedAt ? (
                  <span title={formatDateTime(updatedAt)}>Updated {relativeTime(updatedAt)}</span>
                ) : null}
                {issueIdentifier ? (
                  <Link
                    to={`/issues/${issueIdentifier}#document-plan`}
                    className="underline-offset-2 hover:underline"
                  >
                    Plan document
                  </Link>
                ) : null}
              </div>

              {record.childIssues && record.childIssues.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {record.childIssues.map((child) => (
                    <li key={child.id}>
                      <Link
                        to={`/issues/${child.identifier ?? child.id}`}
                        className={cn(
                          "inline-flex max-w-full items-center gap-1 rounded-sm border border-border bg-background px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent/40",
                        )}
                        title={child.title}
                      >
                        <span className="font-medium">
                          {child.identifier ?? child.id.slice(0, 8)}
                        </span>
                        <span className="truncate max-w-[24ch] text-muted-foreground">
                          {child.title}
                        </span>
                        <ChevronRight className="h-3 w-3 text-muted-foreground" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
