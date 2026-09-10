import { useMemo } from "react";
import type { Issue, IssueOverview, IssueOverviewPullRequest } from "@paperclipai/shared";
import { AlertTriangle, CheckCircle2, ExternalLink, GitPullRequest, Loader2, RefreshCw } from "lucide-react";
import { Link } from "@/lib/router";
import { formatDateTime, issueUrl, relativeTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IssueStatusBadge } from "./StatusBadge";
import { prDisplayRef, prStateLabel } from "./kanbanOverviewModel";
import {
  PROJECT_OPERATOR_BLOCKER_ROW_LIMIT,
  PROJECT_OPERATOR_COMPLETED_ROW_LIMIT,
  PROJECT_OPERATOR_LANE_ROW_LIMIT,
  PROJECT_OPERATOR_PR_PREVIEW_LIMIT,
  collectCompletedTasks,
  collectProjectBlockers,
  groupProjectTasks,
  resolveCompletionState,
  resolveDeliveryCoverage,
  summarizeProjectOutcomes,
  summarizePullRequests,
  type OperatorBlocker,
  type OperatorCompletedTask,
  type OperatorCompletionState,
  type OperatorRootOutcome,
  type OperatorSnapshotTask,
} from "./project-operator-overview";

export interface ProjectOperatorOverviewProps {
  /** Stable href of the project's Tasks tab, for overflow and empty states. */
  tasksHref: string;
  issues: Issue[] | undefined;
  issuesLoading: boolean;
  issuesError: Error | null;
  /** Inventory fetch observation time. 0 when never observed. */
  issuesObservedAt: number;
  issuesRefreshing: boolean;
  onRetryIssues: () => void;
  truncated: boolean;
  /** Board-scoped overviews keyed by issue id. Empty while unavailable. */
  overviewsById: ReadonlyMap<string, IssueOverview>;
  overviewsPending: boolean;
  overviewsError: Error | null;
  /** Overview fetch observation time. 0 when never observed. */
  overviewsObservedAt: number;
  onRetryOverviews: () => void;
  onRefreshAll: () => void;
  /** Task ids with a recorded plan document. Undefined while unknown — never "0 plans". */
  planTaskIds: ReadonlySet<string> | undefined;
}

function toIsoString(value: Date | string | null | undefined): string {
  const date = value instanceof Date ? value : new Date(value ?? 0);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatUnblockOwner(owner: { agentId?: string } | { userId?: string } | "board"): string | null {
  if (owner === "board") return "Board";
  if (typeof owner === "object" && owner !== null) {
    if ("agentId" in owner && owner.agentId) return "Assigned agent";
    if ("userId" in owner && owner.userId) return "Assigned user";
  }
  return null;
}

function formatInboxOwner(type: string): string | null {
  switch (type) {
    case "board":
      return "Board";
    case "agent":
      return "Assigned agent";
    case "user":
      return "Assigned user";
    case "external":
      return "External";
    default:
      return null;
  }
}

function toSnapshotTask(issue: Issue): OperatorSnapshotTask {
  const inbox = issue.blockedInboxAttention ?? null;
  return {
    id: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    parentId: issue.parentId,
    updatedAt: toIsoString(issue.updatedAt),
    completedAt: toIsoOrNull(issue.completedAt),
    deliveryKind: issue.deliveryKind ?? null,
    labelNames: (issue.labels ?? []).map((label) => label.name),
    unblockOwnerLabel: issue.unblockDescriptor ? formatUnblockOwner(issue.unblockDescriptor.owner) : null,
    unblockAction: issue.unblockDescriptor?.action ?? null,
    reviewStalled: issue.reviewAttention?.state === "stalled",
    reviewReason: issue.reviewAttention?.reason ?? null,
    blockedInbox: inbox
      ? {
          ownerLabel: inbox.owner.label ?? formatInboxOwner(inbox.owner.type),
          actionLabel: inbox.action.label,
          actionDetail: inbox.action.detail,
          needsDecision: inbox.state === "awaiting_decision",
        }
      : null,
    blockedByRefs: (issue.blockedBy ?? []).map((ref) => ({
      id: ref.id,
      identifier: ref.identifier ?? null,
      title: ref.title,
    })),
  };
}

function taskHref(issue: { id: string; identifier?: string | null }): string {
  return issueUrl({ id: issue.id, identifier: issue.identifier ?? null });
}

function TaskTitleLink({ href, identifier, title }: { href: string; identifier: string | null; title: string }) {
  return (
    <Link
      to={href}
      title={title}
      className="min-w-0 flex-1 break-words text-sm font-medium text-foreground hover:underline"
    >
      <span className="line-clamp-2">
        {identifier ? <span className="mr-1 font-mono text-xs font-normal text-muted-foreground">{identifier}</span> : null}
        {title}
      </span>
    </Link>
  );
}

/**
 * One PR chip: canonical display ref, canonical state label, stale flag, and a
 * direct link when one is recorded. A PR without a URL still shows its state —
 * the chip just has nothing to link to. Mirrors the board's PR chip vocabulary.
 */
function PullRequestChip({ pr }: { pr: IssueOverviewPullRequest }) {
  const label = `${prDisplayRef(pr)} · ${prStateLabel(pr.state)}${pr.stale ? " · stale" : ""}`;
  const title = pr.url ? `${label} — open pull request` : `${label} — link unavailable`;
  const chip = (
    <Badge
      variant="outline"
      data-pr-state={pr.state}
      data-pr-stale={pr.stale ? "true" : undefined}
      className="max-w-full gap-1 border-border px-1.5 text-(length:--text-nano) font-medium text-muted-foreground"
      title={title}
    >
      {pr.repository ? <span className="min-w-0 max-w-20 truncate">{pr.repository}</span> : null}
      <span className="shrink-0">{pr.number !== null ? `#${pr.number}` : "PR"}</span>
      <span className="shrink-0">{prStateLabel(pr.state)}</span>
      {pr.stale ? <span className="shrink-0">stale</span> : null}
    </Badge>
  );
  return pr.url ? (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      title={title}
      aria-label={`Pull request ${label}`}
      className="inline-flex min-w-0 max-w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {chip}
      <ExternalLink className="ml-0.5 h-3 w-3 shrink-0 self-center text-muted-foreground" aria-hidden="true" />
    </a>
  ) : (
    <span title={title} aria-label={`Pull request ${label}`}>
      {chip}
    </span>
  );
}

/**
 * Every recorded pull request with its canonical state. A bounded preview
 * stays inline; the rest sit behind a native disclosure so keyboard and touch
 * users reach each state and link without an opaque count.
 */
function PullRequestMarkers({ prs }: { prs: IssueOverviewPullRequest[] }) {
  if (prs.length === 0) return null;
  const preview = prs.slice(0, PROJECT_OPERATOR_PR_PREVIEW_LIMIT);
  const overflow = prs.slice(PROJECT_OPERATOR_PR_PREVIEW_LIMIT);
  return (
    <div
      data-testid="pull-request-markers"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
    >
      <GitPullRequest className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      {preview.map((pr, index) => (
        <PullRequestChip key={pr.url ?? `${pr.repository ?? "pr"}#${pr.number ?? index}`} pr={pr} />
      ))}
      {overflow.length > 0 ? (
        <details data-testid="pull-request-overflow" className="min-w-0">
          <summary className="cursor-pointer text-(length:--text-nano) text-muted-foreground underline decoration-dotted underline-offset-2">
            {overflow.length} more {overflow.length === 1 ? "pull request" : "pull requests"}
          </summary>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {overflow.map((pr, index) => (
              <PullRequestChip key={pr.url ?? `${pr.repository ?? "pr"}#${pr.number ?? index}`} pr={pr} />
            ))}
          </span>
        </details>
      ) : null}
    </div>
  );
}

function RootOutcomeRow({
  outcome,
  planTaskIds,
  overview,
}: {
  outcome: OperatorRootOutcome;
  planTaskIds: ReadonlySet<string> | undefined;
  overview: IssueOverview | undefined;
}) {
  const { task, children } = outcome;
  const prs = overview?.pullRequests ?? [];
  const blocked = overview?.blocked === true || task.status === "blocked";
  const doneChildren = children.filter((child) => child.status === "done").length;
  return (
    <li className="min-w-0 space-y-1">
      <div className="flex items-start gap-2">
        <TaskTitleLink href={taskHref(task)} identifier={task.identifier} title={task.title} />
        <IssueStatusBadge status={task.status} />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {blocked ? <span className="font-medium text-destructive">Blocked</span> : null}
        {task.reviewStalled ? <span>Stalled review</span> : null}
        {children.length > 0 ? (
          <span>
            Subtasks {doneChildren}/{children.length} done — parent outcome unchanged
          </span>
        ) : null}
        {planTaskIds?.has(task.id) ? <span>Plan</span> : null}
        <PullRequestMarkers prs={prs} />
      </div>
      {children.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-2">
            {children.length} {children.length === 1 ? "subtask" : "subtasks"}
          </summary>
          <ul className="mt-1 space-y-1 border-l border-border pl-3">
            {children.map((child) => (
              <li key={child.id} className="flex items-start gap-2">
                <TaskTitleLink
                  href={taskHref(child)}
                  identifier={child.identifier}
                  title={child.title}
                />
                <IssueStatusBadge status={child.status} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

function BlockerRow({ blocker }: { blocker: OperatorBlocker }) {
  return (
    <li className="min-w-0 space-y-1 border-b border-border pb-2 last:border-b-0 last:pb-0">
      <div className="flex items-start gap-2">
        <TaskTitleLink href={taskHref({ id: blocker.taskId, identifier: blocker.identifier })} identifier={blocker.identifier} title={blocker.title} />
        <IssueStatusBadge status={blocker.status} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {blocker.needsDecision ? (
          <Badge variant="destructive">Needs decision</Badge>
        ) : null}
        {blocker.ownerLabel ? (
          <span className="break-words">Owner: {blocker.ownerLabel}</span>
        ) : (
          <span>Owner not recorded</span>
        )}
      </div>
      {blocker.nextAction ? <p className="break-words text-xs">Next: {blocker.nextAction}</p> : null}
      {blocker.message ? (
        <p className="break-words text-xs text-muted-foreground">{blocker.message}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {blocker.stalledReview ? <span>Stalled review</span> : null}
        {blocker.blockingFindingCount > 0 ? (
          <span>{blocker.blockingFindingCount} blocking findings</span>
        ) : null}
      </div>
      {blocker.blockingRefs.length > 0 ? (
        <p className="break-words text-xs text-muted-foreground">
          Blocked by{" "}
          {blocker.blockingRefs.slice(0, 3).map((ref, index) => (
            <span key={ref.id}>
              {index > 0 ? ", " : null}
              <Link to={taskHref(ref)} className="underline decoration-dotted underline-offset-2">
                {ref.identifier ?? ref.title}
              </Link>
            </span>
          ))}
          {blocker.blockingRefs.length > 3 ? <span> +{blocker.blockingRefs.length - 3} more</span> : null}
        </p>
      ) : null}
    </li>
  );
}

const COMPLETION_COPY: Record<OperatorCompletionState, string> = {
  merged: "Merged",
  non_code: "Done",
  code_unverified: "Code completion · merge unverified",
  unclassified: "Marked done · delivery evidence not recorded",
};

function CompletedRow({ completed }: { completed: OperatorCompletedTask }) {
  const completion = resolveCompletionState(completed);
  return (
    <li
      className="min-w-0 space-y-1 border-b border-border pb-2 last:border-b-0 last:pb-0"
      data-completion-state={completion}
    >
      <div className="flex items-start gap-2">
        <TaskTitleLink
          href={taskHref({ id: completed.taskId, identifier: completed.identifier })}
          identifier={completed.identifier}
          title={completed.title}
        />
        <span
          data-testid="project-operator-overview-completion"
          className={
            completion === "merged"
              ? "inline-flex shrink-0 items-center gap-1 text-xs font-medium"
              : "shrink-0 text-xs text-muted-foreground"
          }
        >
          {completion === "merged" ? (
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          ) : null}
          {COMPLETION_COPY[completion]}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {completed.completedAt ? (
          <span title={formatDateTime(completed.completedAt)}>{relativeTime(completed.completedAt)}</span>
        ) : null}
        {completed.artifactReady ? <span>Artifact ready</span> : null}
        <PullRequestMarkers prs={completed.pullRequests} />
      </div>
    </li>
  );
}

/**
 * Live project snapshot for the overview tab, rendered above the description
 * prose and the generated project summary. Everything here derives from
 * current task records (plus batched delivery detail); the generated prose
 * below stays untouched and visually distinct.
 */
export function ProjectOperatorOverview(props: ProjectOperatorOverviewProps) {
  const {
    tasksHref,
    issues,
    issuesLoading,
    issuesError,
    issuesObservedAt,
    issuesRefreshing,
    onRetryIssues,
    truncated,
    overviewsById,
    overviewsPending,
    overviewsError,
    overviewsObservedAt,
    onRetryOverviews,
    onRefreshAll,
    planTaskIds,
  } = props;

  const snapshotTasks = useMemo(() => (issues ?? []).map(toSnapshotTask), [issues]);
  const outcome = useMemo(() => summarizeProjectOutcomes(snapshotTasks), [snapshotTasks]);
  const grouping = useMemo(() => groupProjectTasks(snapshotTasks), [snapshotTasks]);
  const blockers = useMemo(
    () => collectProjectBlockers(snapshotTasks, overviewsById),
    [snapshotTasks, overviewsById],
  );
  const completed = useMemo(
    () => collectCompletedTasks(snapshotTasks, overviewsById),
    [snapshotTasks, overviewsById],
  );
  const pullRequests = useMemo(
    () =>
      summarizePullRequests(
        [...overviewsById.entries()].flatMap(([issueId, overview]) =>
          overview.pullRequests.map((pr) => ({ issueId, pr })),
        ),
      ),
    [overviewsById],
  );
  const refreshing = issuesRefreshing || overviewsPending;
  const deliveryCoverage = resolveDeliveryCoverage({
    pending: overviewsPending,
    failed: overviewsError !== null,
    observedAt: overviewsObservedAt,
  });
  const donePercent = outcome.total === 0 ? 0 : Math.round((outcome.done / outcome.total) * 100);

  return (
    <section
      aria-labelledby="project-operator-snapshot-heading"
      data-testid="project-operator-overview"
      className="space-y-4 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="project-operator-snapshot-heading" className="text-sm font-semibold text-foreground">
          Current snapshot
        </h2>
        <span
          className="text-xs text-muted-foreground"
          title={
            issuesObservedAt > 0
              ? `Tasks observed ${formatDateTime(new Date(issuesObservedAt).toISOString())}`
              : undefined
          }
        >
          {issuesLoading
            ? "Loading tasks…"
            : issuesObservedAt > 0
              ? `Tasks observed ${relativeTime(new Date(issuesObservedAt).toISOString())}`
              : "Tasks not yet observed"}
          {" · "}
          {overviewsPending
            ? "Loading delivery detail…"
            : overviewsObservedAt > 0
              ? `Delivery detail observed ${relativeTime(new Date(overviewsObservedAt).toISOString())}`
              : "Delivery detail unavailable"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRefreshAll}
          disabled={issuesLoading || refreshing}
          aria-label="Refresh snapshot"
          title="Refresh snapshot"
          className="ml-auto"
        >
          {issuesLoading || refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Live from project task records — separate from the generated summary below, which keeps its own
        revision controls.
      </p>

      {issuesError ? (
        <div
          role="alert"
          data-testid="project-operator-overview-issues-error"
          className="flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <span className="inline-flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="break-words">Could not load project tasks: {issuesError.message}</span>
          </span>
          <Button type="button" variant="outline" size="sm" onClick={onRetryIssues}>
            Retry
          </Button>
        </div>
      ) : null}

      {issuesLoading && !issues ? (
        <div role="status" data-testid="project-operator-overview-loading" className="space-y-2">
          <span className="text-sm text-muted-foreground">Loading snapshot…</span>
          <div className="h-4 animate-pulse rounded bg-muted" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      ) : null}

      {!issuesLoading && !issuesError && (issues ?? []).length === 0 ? (
        <div data-testid="project-operator-overview-empty" className="space-y-1 text-sm">
          <p className="font-medium text-foreground">No tasks in this project yet.</p>
          <p className="text-muted-foreground">
            Tasks you create here will appear in this snapshot automatically — nothing to configure.{" "}
            <Link to={tasksHref} className="underline underline-offset-2">
              Open Tasks
            </Link>
          </p>
        </div>
      ) : null}

      {!issuesLoading && !issuesError && (issues ?? []).length > 0 ? (
        <div className="space-y-4">
          {truncated ? (
            <p data-testid="project-operator-overview-truncated" className="text-xs text-muted-foreground">
              Inventory capped at the first {snapshotTasks.length} tasks; figures below cover those tasks
              only.
            </p>
          ) : null}

          <div data-testid="project-operator-overview-outcome" className="space-y-1">
            <p className="text-sm text-foreground">
              <span className="font-semibold">
                {outcome.done} of {outcome.total} tasks done
              </span>
              {outcome.cancelled > 0 ? (
                <span className="text-muted-foreground"> · {outcome.cancelled} cancelled</span>
              ) : null}
            </p>
            <div
              role="progressbar"
              aria-label="Tasks done"
              aria-valuemin={0}
              aria-valuemax={outcome.total}
              aria-valuenow={outcome.done}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${donePercent}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {outcome.rootCount} {outcome.rootCount === 1 ? "root outcome" : "root outcomes"} in this
              snapshot.
            </p>
          </div>

          <div data-testid="project-operator-overview-lanes" className="grid gap-4 md:grid-cols-3">
            {grouping.lanes.map((lane) => (
              <div key={lane.key} className="min-w-0 space-y-2">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    {lane.title}{" "}
                    <span className="font-normal text-muted-foreground">({lane.roots.length})</span>
                  </h3>
                  <p className="text-xs text-muted-foreground">{lane.hint}</p>
                </div>
                {lane.roots.length === 0 ? (
                  <p className="text-xs text-muted-foreground">None</p>
                ) : (
                  <ul className="space-y-2">
                    {lane.roots.slice(0, PROJECT_OPERATOR_LANE_ROW_LIMIT).map((root) => (
                      <RootOutcomeRow
                        key={root.task.id}
                        outcome={root}
                        planTaskIds={planTaskIds}
                        overview={overviewsById.get(root.task.id)}
                      />
                    ))}
                  </ul>
                )}
                {lane.roots.length > PROJECT_OPERATOR_LANE_ROW_LIMIT ? (
                  <Link to={tasksHref} className="text-xs text-muted-foreground underline underline-offset-2">
                    +{lane.roots.length - PROJECT_OPERATOR_LANE_ROW_LIMIT} more in Tasks
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
          {grouping.mode === "roadmap" ? (
            <p className="text-xs text-muted-foreground">
              Lanes follow the root outcomes' explicit now / next / later labels.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              No explicit now / next / later labels on project tasks — lanes fall back to Active / Ready /
              Backlog by status.
            </p>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <div data-testid="project-operator-overview-blockers" className="min-w-0 space-y-2">
              <h3 className="text-sm font-semibold text-foreground">
                Needs attention <span className="font-normal text-muted-foreground">({blockers.length})</span>
              </h3>
              {blockers.length === 0 ? (
                <p
                  data-testid="project-operator-overview-blockers-empty"
                  data-delivery-coverage={deliveryCoverage}
                  className="text-xs text-muted-foreground"
                >
                  {deliveryCoverage === "loading"
                    ? "Checking for blockers…"
                    : deliveryCoverage === "complete"
                      ? "No recorded blockers."
                      : deliveryCoverage === "partial"
                        ? "Delivery detail is partial, so blockers recorded outside these task rows may be missing."
                        : "Blocker detail unavailable — this snapshot cannot confirm there are none."}
                </p>
              ) : (
                <>
                  <ul className="space-y-2">
                    {blockers.slice(0, PROJECT_OPERATOR_BLOCKER_ROW_LIMIT).map((blocker) => (
                      <BlockerRow key={blocker.taskId} blocker={blocker} />
                    ))}
                  </ul>
                  <Link to="/decisions" className="text-xs text-muted-foreground underline underline-offset-2">
                    Open Decisions queue
                  </Link>
                </>
              )}
            </div>

            <div data-testid="project-operator-overview-completed" className="min-w-0 space-y-2">
              <h3 className="text-sm font-semibold text-foreground">
                Completed tasks <span className="font-normal text-muted-foreground">({completed.length})</span>
              </h3>
              {completed.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing done yet.</p>
              ) : (
                <ul className="space-y-2">
                  {completed.slice(0, PROJECT_OPERATOR_COMPLETED_ROW_LIMIT).map((item) => (
                    <CompletedRow key={item.taskId} completed={item} />
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div
            data-testid="project-operator-overview-evidence"
            data-delivery-coverage={deliveryCoverage}
            className="space-y-1 text-xs text-muted-foreground"
          >
            <p>
              {planTaskIds !== undefined ? (
                <>
                  Plans recorded on {planTaskIds.size} {planTaskIds.size === 1 ? "task" : "tasks"}.{" "}
                </>
              ) : null}
              {deliveryCoverage === "complete" ? (
                <>
                  {pullRequests.total} pull {pullRequests.total === 1 ? "request" : "requests"}
                  {pullRequests.total > 0 ? (
                    <>
                      {" "}
                      ({pullRequests.merged} merged · {pullRequests.open} open
                      {pullRequests.closedUnmerged > 0 ? ` · ${pullRequests.closedUnmerged} closed unmerged` : null}
                      {pullRequests.unknown > 0 ? ` · ${pullRequests.unknown} unknown` : null})
                    </>
                  ) : null}
                  .{" "}
                </>
              ) : deliveryCoverage === "loading" ? (
                <>Delivery detail is still loading — pull request totals are not final.{" "}</>
              ) : deliveryCoverage === "partial" ? (
                <>
                  Pull request totals are partial: {pullRequests.total} recorded so far.{" "}
                </>
              ) : (
                <>Pull request totals unavailable — delivery detail could not be loaded.{" "}</>
              )}
              Specs and files live on each task.
            </p>
          </div>

          {overviewsError ? (
            <div
              role="status"
              data-testid="project-operator-overview-detail-error"
              className="flex flex-col items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <span className="break-words text-muted-foreground">
                {deliveryCoverage === "partial"
                  ? `Delivery detail is partial: ${overviewsError.message} The rows already loaded are real; pull requests, merges, and delivery-only blockers may be missing.`
                  : `Delivery detail unavailable: ${overviewsError.message} Lanes and counts above still reflect current task records; pull requests, merges, and delivery-only blockers may be missing.`}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={onRetryOverviews}>
                Retry
              </Button>
            </div>
          ) : null}

          <details data-testid="project-operator-overview-reading-guide" className="text-xs text-muted-foreground">
            <summary className="cursor-pointer underline decoration-dotted underline-offset-2">
              How to read this snapshot
            </summary>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>Completed means task status done — not business acceptance or operational readiness.</li>
              <li>
                Merged appears only with a recorded delivery merge on the current outcome; pull requests
                are listed per task with their recorded state for context.
              </li>
              <li>
                “Code completion · merge unverified” means the task is recorded as code work without a
                verified current merge. “Delivery evidence not recorded” is unclassified: it does not
                prove the work was non-code.
              </li>
              <li>Subtask counts describe children only; the parent's own status stands.</li>
            </ul>
          </details>
        </div>
      ) : null}
    </section>
  );
}
