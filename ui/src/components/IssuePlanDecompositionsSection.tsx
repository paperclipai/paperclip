import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, AcceptedPlanDecompositionSummary } from "@paperclipai/shared";
import { ChevronRight, GitBranch, Repeat, CheckCircle2, Loader2 } from "lucide-react";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, relativeTime } from "../lib/utils";

interface IssuePlanDecompositionsSectionProps {
  issueId: string;
  issueIdentifier: string | null;
  agentMap?: Map<string, Agent>;
}

function StatusBadge({ status }: { status: AcceptedPlanDecompositionSummary["status"] }) {
  const { t } = useTranslation();
  if (status === "completed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-sm border border-emerald-500/50 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-900 dark:text-emerald-100">
        <CheckCircle2 className="h-3 w-3" />
        {t("components.issuePlanDecompositionsSection.statusCompleted", { defaultValue: "Completed" })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:text-amber-100">
      <Loader2 className="h-3 w-3 animate-spin" />
      {t("components.issuePlanDecompositionsSection.statusInFlight", { defaultValue: "In flight" })}
    </span>
  );
}

export function IssuePlanDecompositionsSection({
  issueId,
  issueIdentifier,
  agentMap,
}: IssuePlanDecompositionsSectionProps) {
  const { t } = useTranslation();
  const { data: decompositions } = useQuery({
    queryKey: queryKeys.issues.acceptedPlanDecompositions(issueId),
    queryFn: () => issuesApi.listAcceptedPlanDecompositions(issueId),
  });

  const items = useMemo(() => decompositions ?? [], [decompositions]);
  if (items.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">
          {t("components.issuePlanDecompositionsSection.heading", { defaultValue: "Plan decomposition" })}
        </h3>
        <span className="text-[11px] text-muted-foreground/80">
          {t("components.issuePlanDecompositionsSection.acceptedPlanRevisions", {
            count: items.length,
            defaultValue: "{{count}} accepted plan revision",
            defaultValue_other: "{{count}} accepted plan revisions",
          })}
        </span>
      </div>

      <ul className="space-y-3">
        {items.map((record) => {
          const requested = record.requestedChildCount ?? 0;
          const created = record.childIssueIds?.length ?? 0;
          const ownerName = record.ownerAgentId
            ? agentMap?.get(record.ownerAgentId)?.name ??
              t("components.issuePlanDecompositionsSection.ownerFallback", { defaultValue: "agent" })
            : null;
          const revisionLabel =
            record.acceptedPlanRevisionNumber != null
              ? t("components.issuePlanDecompositionsSection.revisionNumber", {
                  number: record.acceptedPlanRevisionNumber,
                  defaultValue: "revision {{number}}",
                })
              : t("components.issuePlanDecompositionsSection.revisionId", {
                  id: record.acceptedPlanRevisionId.slice(0, 8),
                  defaultValue: "revision {{id}}",
                });
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
                  {t("components.issuePlanDecompositionsSection.planRevisionLabel", {
                    revisionLabel,
                    defaultValue: "Plan {{revisionLabel}}",
                  })}
                </span>
                <span className="text-xs text-muted-foreground/70">·</span>
                <span className="inline-flex items-center gap-1 text-xs text-foreground">
                  <GitBranch className="h-3 w-3 text-muted-foreground" />
                  {t("components.issuePlanDecompositionsSection.childTasksCreated", {
                    count: requested,
                    created,
                    defaultValue: "{{created}} of {{count}} child task created",
                    defaultValue_other: "{{created}} of {{count}} child tasks created",
                  })}
                </span>
                {record.status === "completed" && requested > 0 ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-sm border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-900 dark:text-sky-100"
                    title={t("components.issuePlanDecompositionsSection.idempotentClaimTooltip", {
                      defaultValue:
                        "Repeat attempts with this fingerprint reuse this record instead of creating new children",
                    })}
                  >
                    <Repeat className="h-3 w-3" />
                    {t("components.issuePlanDecompositionsSection.idempotentClaim", {
                      defaultValue: "Idempotent claim",
                    })}
                  </span>
                ) : null}
              </div>

              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                {ownerName ? (
                  <span>
                    {t("components.issuePlanDecompositionsSection.owner", {
                      ownerName,
                      defaultValue: "Owner: {{ownerName}}",
                    })}
                  </span>
                ) : null}
                {startedAt ? (
                  <span title={formatDateTime(startedAt)}>
                    {t("components.issuePlanDecompositionsSection.started", {
                      time: relativeTime(startedAt),
                      defaultValue: "Started {{time}}",
                    })}
                  </span>
                ) : null}
                {completedAt ? (
                  <span title={formatDateTime(completedAt)}>
                    {t("components.issuePlanDecompositionsSection.completed", {
                      time: relativeTime(completedAt),
                      defaultValue: "Completed {{time}}",
                    })}
                  </span>
                ) : updatedAt ? (
                  <span title={formatDateTime(updatedAt)}>
                    {t("components.issuePlanDecompositionsSection.updated", {
                      time: relativeTime(updatedAt),
                      defaultValue: "Updated {{time}}",
                    })}
                  </span>
                ) : null}
                {issueIdentifier ? (
                  <Link
                    to={`/issues/${issueIdentifier}#document-plan`}
                    className="underline-offset-2 hover:underline"
                  >
                    {t("components.issuePlanDecompositionsSection.planDocument", {
                      defaultValue: "Plan document",
                    })}
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
