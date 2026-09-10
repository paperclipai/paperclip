import { useEffect, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitMerge, GitPullRequest, RefreshCw } from "lucide-react";
import type { DeliveryReconciliationItem, DeliverySummary } from "@paperclipai/shared";
import { deliveryApi } from "../api/delivery";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { Link, useSearchParams } from "@/lib/router";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { cn, formatDateTime, relativeTime } from "../lib/utils";
import {
  checkStatusTone,
  deliveryQueueLabel,
  deliveryToneBadge,
  dispositionDetail,
  dispositionLabel,
  groupDeliveryQueues,
  provenanceDetail,
  provenanceLabel,
  reconciliationClassificationLabel,
  reconciliationClassificationTone,
  reconciliationCounts,
  reconciliationOutcomeLabel,
  shortSha,
  type DeliveryTone,
} from "../lib/delivery-display";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { InlineBanner } from "../components/InlineBanner";
import { IssueStatusBadge } from "../components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ALL_PROJECTS = "__all_projects__";

function ToneChip({ tone, children }: { tone: DeliveryTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        deliveryToneBadge(tone),
      )}
    >
      {children}
    </span>
  );
}

function checkSummary(summary: DeliverySummary): { label: string; tone: DeliveryTone } {
  if (summary.checks.length === 0) return { label: "No checks", tone: "pending" };
  const passing = summary.checks.filter((check) => checkStatusTone(check.status) === "success").length;
  const failing = summary.checks.filter((check) => checkStatusTone(check.status) === "failure").length;
  if (failing > 0) return { label: `${passing}/${summary.checks.length} passing`, tone: "failure" };
  if (passing === summary.checks.length) return { label: `${passing}/${summary.checks.length} passing`, tone: "success" };
  return { label: `${passing}/${summary.checks.length} passing`, tone: "pending" };
}

interface IssueLookup {
  identifier: string | null;
  title: string | null;
}

function IssueLink({ summary, lookup }: { summary: DeliverySummary; lookup?: IssueLookup }) {
  const label = lookup?.identifier ?? summary.issueId.slice(0, 8);
  return (
    <Link
      to={createIssueDetailPath(lookup?.identifier ?? summary.issueId)}
      className="text-sm underline underline-offset-2 hover:text-foreground"
      title={lookup?.title ?? summary.issueId}
    >
      {label}
    </Link>
  );
}

function QueueTable({
  items,
  agentNameById,
  issueLookupById,
}: {
  items: DeliverySummary[];
  agentNameById: Map<string, string>;
  issueLookupById: Map<string, IssueLookup>;
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide bg-muted/30 text-muted-foreground">
            <th className="px-3 py-2 text-left">Task</th>
            <th className="px-3 py-2 text-left">Phase</th>
            <th className="px-3 py-2 text-left">Pull request</th>
            <th className="px-3 py-2 text-left">Head</th>
            <th className="px-3 py-2 text-left">Owner</th>
            <th className="px-3 py-2 text-left">Checks</th>
            <th className="px-3 py-2 text-left">Queue</th>
            <th className="px-3 py-2 text-left">Blocker / next action</th>
            <th className="px-3 py-2 text-left">Updated</th>
          </tr>
        </thead>
        <tbody>
          {items.map((summary) => {
            const checks = checkSummary(summary);
            const owner = summary.ownerAgentId;
            return (
              <tr key={summary.issueId} className="border-t border-border/60 align-top">
                <td className="px-3 py-2">
                  <IssueLink summary={summary} lookup={issueLookupById.get(summary.issueId)} />
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <IssueStatusBadge status={summary.phase} />
                    {summary.paused ? <ToneChip tone="warning">Paused</ToneChip> : null}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {summary.prUrl ? (
                    <a
                      href={summary.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      {summary.prNumber ? `#${summary.prNumber}` : "PR"}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {summary.headSha ? (
                    <span title={summary.headSha}>{shortSha(summary.headSha)}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {owner ? (
                    <span className="truncate" title={agentNameById.get(owner) ?? owner}>
                      {agentNameById.get(owner) ?? owner.slice(0, 8)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <ToneChip tone={checks.tone}>{checks.label}</ToneChip>
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {summary.queuePosition === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    `#${summary.queuePosition}`
                  )}
                </td>
                <td className="px-3 py-2 text-xs">
                  {summary.blocker ? (
                    <span className="text-destructive">
                      {summary.blocker.reasonCode}: {summary.blocker.message}
                    </span>
                  ) : summary.nextAction ? (
                    <span className="text-muted-foreground">{summary.nextAction}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {summary.lastEventAt ? (
                    <span title={formatDateTime(summary.lastEventAt)}>{relativeTime(summary.lastEventAt)}</span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReconciliationTable({ items }: { items: DeliveryReconciliationItem[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide bg-muted/30 text-muted-foreground">
            <th className="px-3 py-2 text-left">Task</th>
            <th className="px-3 py-2 text-left">Classification</th>
            <th className="px-3 py-2 text-left">Task status</th>
            <th className="px-3 py-2 text-left">Repository</th>
            <th className="px-3 py-2 text-left">Merged</th>
            <th className="px-3 py-2 text-left">Pull request</th>
            <th className="px-3 py-2 text-left">Provenance</th>
            <th className="px-3 py-2 text-left">Reconciled</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const provenance = provenanceLabel(item.provenance);
            const provenanceFull = provenanceDetail(item.provenance);
            const disposition = dispositionLabel(item.disposition);
            const outcome = reconciliationOutcomeLabel(item.outcome);
            return (
              <tr key={item.issueId} className="border-t border-border/60 align-top">
                <td className="px-3 py-2">
                  <Link
                    to={createIssueDetailPath(item.identifier ?? item.issueId)}
                    className="text-sm underline underline-offset-2 hover:text-foreground"
                    title={item.title}
                  >
                    {item.identifier ?? item.issueId}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <ToneChip tone={reconciliationClassificationTone(item.classification)}>
                    {reconciliationClassificationLabel(item.classification)}
                  </ToneChip>
                  {outcome ? <p className="mt-1 text-xs text-muted-foreground">{outcome}</p> : null}
                </td>
                <td className="px-3 py-2">
                  {item.issueStatus ? (
                    <IssueStatusBadge status={item.issueStatus} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {item.repository ? (
                    <>
                      {item.repository}
                      {item.targetBranch ? (
                        <span className="text-muted-foreground"> → {item.targetBranch}</span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {item.mergedSha ? (
                    <span title={item.mergedSha}>{shortSha(item.mergedSha)}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {item.prUrl ? (
                    <a
                      href={item.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      {item.prNumber ? `#${item.prNumber}` : "PR"}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="max-w-(--sz-18rem) px-3 py-2 text-xs text-muted-foreground">
                  {provenance ? (
                    <span className="block break-words" title={provenanceFull ?? provenance}>
                      {provenance}
                    </span>
                  ) : null}
                  {disposition ? (
                    <span className="mt-1 block break-words" title={dispositionDetail(item.disposition) ?? disposition}>
                      {disposition}
                    </span>
                  ) : null}
                  {!provenance && !disposition ? "—" : null}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {item.reconciledAt ? (
                    <span title={formatDateTime(item.reconciledAt)}>{relativeTime(item.reconciledAt)}</span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Company delivery queue + historical reconciliation.
 *
 * One queue per canonical repository + target branch, shared across the
 * company's projects, so cross-project serialization is visible in one place.
 * The reconciliation inventory lists every Done outcome and whether it closed
 * as code delivery, non-code closure, or unknown.
 */
export function Delivery() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectFilter = searchParams.get("project") ?? ALL_PROJECTS;
  const projectId = projectFilter === ALL_PROJECTS ? null : projectFilter;

  useEffect(() => {
    setBreadcrumbs([{ label: "Delivery" }]);
  }, [setBreadcrumbs]);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? "__none__"),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const deliveryQuery = useQuery({
    queryKey: queryKeys.delivery.company(selectedCompanyId ?? "__none__", projectId),
    queryFn: () => deliveryApi.getCompanyDelivery(selectedCompanyId!, projectId),
    enabled: Boolean(selectedCompanyId),
  });

  const reconciliationQuery = useQuery({
    queryKey: queryKeys.delivery.reconciliation(selectedCompanyId ?? "__none__"),
    queryFn: () => deliveryApi.getReconciliation(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  // DeliverySummary carries only issue ids; the queue reads identifiers and
  // titles from the company task list so rows stay linkable by name.
  const issuesQuery = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId ?? "__none__"), "delivery-lookup", "compact"],
    queryFn: () =>
      issuesApi.listCompact(selectedCompanyId!, { limit: 500, sortField: "updated", sortDir: "desc" }),
    enabled: Boolean(selectedCompanyId),
    staleTime: 30_000,
  });

  const issueLookupById = useMemo(() => {
    const map = new Map<string, IssueLookup>();
    for (const issue of issuesQuery.data ?? []) {
      map.set(issue.id, { identifier: issue.identifier ?? null, title: issue.title ?? null });
    }
    return map;
  }, [issuesQuery.data]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agentsQuery.data ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agentsQuery.data]);

  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const queueGroups = useMemo(
    () => groupDeliveryQueues(deliveryQuery.data?.items ?? []),
    [deliveryQuery.data],
  );
  const reconciliationItems = useMemo(
    () => reconciliationQuery.data?.items ?? [],
    [reconciliationQuery.data],
  );
  const counts = useMemo(
    () => reconciliationCounts(reconciliationQuery.data?.counts, reconciliationItems),
    [reconciliationQuery.data?.counts, reconciliationItems],
  );

  const setProjectFilter = (value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === ALL_PROJECTS) next.delete("project");
      else next.set("project", value);
      return next;
    }, { replace: true });
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={GitPullRequest} message="Select an organization to view delivery." />;
  }

  const refreshing = deliveryQuery.isFetching || reconciliationQuery.isFetching;

  return (
    <div className="w-full max-w-7xl space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Delivery</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            One queue per repository and target branch, shared across projects. GitHub is authoritative for
            head, checks, and merge state.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger className="w-56" aria-label="Filter by project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
              {(projects).map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={() => {
              void deliveryQuery.refetch();
              void reconciliationQuery.refetch();
            }}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      <section className="space-y-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <GitMerge className="h-4 w-4" aria-hidden />
          Merge queue
        </h2>
        {deliveryQuery.isLoading ? (
          <PageSkeleton variant="issues-list" />
        ) : deliveryQuery.error ? (
          <InlineBanner
            tone="danger"
            title="Delivery queue unavailable"
            actions={
              <Button variant="outline" size="sm" onClick={() => void deliveryQuery.refetch()}>
                Retry
              </Button>
            }
          >
            {deliveryQuery.error instanceof Error ? deliveryQuery.error.message : "The delivery service did not respond."}
          </InlineBanner>
        ) : queueGroups.length === 0 ? (
          <EmptyState
            icon={GitMerge}
            message="No delivery candidates in this scope."
            description="Tasks appear here once a worker registers a candidate with its head SHA."
          />
        ) : (
          queueGroups.map((group) => (
            <div key={group.key} className="space-y-2">
              <h3 className="font-mono text-xs text-muted-foreground">
                {deliveryQueueLabel({ repository: group.repository, targetBranch: group.targetBranch })}
                <span className="ml-2 text-muted-foreground/70">
                  {group.items.length} {group.items.length === 1 ? "candidate" : "candidates"}
                </span>
              </h3>
              <QueueTable
                items={group.items}
                agentNameById={agentNameById}
                issueLookupById={issueLookupById}
              />
            </div>
          ))
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold">Reconciliation</h2>
        {reconciliationQuery.isLoading ? (
          <PageSkeleton variant="issues-list" />
        ) : reconciliationQuery.error ? (
          <InlineBanner
            tone="danger"
            title="Reconciliation inventory unavailable"
            actions={
              <Button variant="outline" size="sm" onClick={() => void reconciliationQuery.refetch()}>
                Retry
              </Button>
            }
          >
            {reconciliationQuery.error instanceof Error
              ? reconciliationQuery.error.message
              : "The delivery service did not respond."}
          </InlineBanner>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {counts.map((entry) => (
                <ToneChip key={entry.classification} tone={entry.tone}>
                  {entry.label}: {entry.count}
                </ToneChip>
              ))}
            </div>
            {reconciliationItems.length === 0 ? (
              <EmptyState
                icon={GitPullRequest}
                message="No Done outcomes to reconcile."
                description="Completed tasks appear here with their recorded delivery provenance."
              />
            ) : (
              <ReconciliationTable items={reconciliationItems} />
            )}
          </>
        )}
      </section>
    </div>
  );
}
