import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { issuesApi } from "@/api/issues";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import type { Agent, Issue } from "@paperclipai/shared";
import { EaosStateChip } from "./EaosStateChip";
import {
  NOT_CONNECTED_DATA_LABEL,
  NOT_CONNECTED_DATA_NOTE,
  NOT_CONNECTED_DATA_PREFIX,
  SHELL_POSTURE_LABEL,
  SHELL_POSTURE_PREFIX,
  type EaosStateLabel,
} from "./state-labels";

// LET-460 Missions thin slice — replaces the `/eaos/missions` placeholder
// with a read-only, backend-informed mission list. Mission rows derive
// from the existing issue list API. Fields that are not strictly
// backend-backed for the row layer (next action, gate) carry a "Derived"
// truth label per LET-459 §"Mission object model".
//
// No live mutating controls — only navigation and filter toggles. Release,
// deploy, spend, secret, live-vendor, and workflow holds are shown as
// state via chips and short text, never as actionable buttons.

export interface MissionsLandingProps {
  // Cap how many issues this slice pulls from the list endpoint. Mission
  // rows are coarse summaries — we stop well before the IssueDetail page's
  // 500/page bulk fetch. Override is exposed mainly for tests.
  pageLimit?: number;
}

type MissionFilter = "active" | "needs-attention" | "done";

interface MissionFilterOption {
  readonly id: MissionFilter;
  readonly label: string;
  readonly description: string;
}

const MISSION_FILTERS: readonly MissionFilterOption[] = [
  {
    id: "active",
    label: "Active",
    description: "In progress, in review, or queued work.",
  },
  {
    id: "needs-attention",
    label: "Needs attention",
    description: "Blocked, review-stuck, or attention-flagged work.",
  },
  {
    id: "done",
    label: "Done",
    description: "Recently completed missions.",
  },
];

const ACTIVE_STATUSES = new Set<Issue["status"]>(["todo", "in_progress", "in_review"]);
const NEEDS_ATTENTION_STATUSES = new Set<Issue["status"]>(["blocked"]);
const DONE_STATUSES = new Set<Issue["status"]>(["done"]);

function statusToMissionState(
  status: Issue["status"],
): { label: string; chip: EaosStateLabel; prefix: string } {
  switch (status) {
    case "in_review":
      return { label: "In review", chip: "APPROVAL REQUIRED", prefix: "Mission" };
    case "blocked":
      return { label: "Blocked", chip: "FAILED", prefix: "Mission" };
    case "done":
      return { label: "Done", chip: "APPLIED", prefix: "Mission" };
    case "cancelled":
      return { label: "Cancelled", chip: "PREVIEW", prefix: "Mission" };
    case "in_progress":
      return { label: "Active", chip: "BACKEND-BACKED", prefix: "Mission" };
    case "todo":
      return { label: "Queued", chip: "BACKEND-BACKED", prefix: "Mission" };
    case "backlog":
    default:
      return { label: "Backlog", chip: "PREVIEW", prefix: "Mission" };
  }
}

function deriveNextAction(issue: Issue): string {
  switch (issue.status) {
    case "in_review":
      return "Waiting on reviewer decision.";
    case "blocked":
      return issue.blockedBy && issue.blockedBy.length > 0
        ? `Blocked by ${issue.blockedBy.length} item${issue.blockedBy.length === 1 ? "" : "s"}.`
        : "Blocker assigned. Owner action required.";
    case "in_progress":
      return "Work in progress. No human action required.";
    case "todo":
      return "Queued for the next assignee pickup.";
    case "done":
      return "Mission closed. Review evidence as needed.";
    case "cancelled":
      return "Mission cancelled. No further action.";
    case "backlog":
    default:
      return "In backlog. Not yet scheduled.";
  }
}

function deriveGate(issue: Issue): { label: string; tone: EaosStateLabel } | null {
  if (issue.status === "in_review") {
    return { label: "Reviewer decision", tone: "APPROVAL REQUIRED" };
  }
  if (issue.status === "blocked") {
    return { label: "Unblock required", tone: "FAILED" };
  }
  return null;
}

function describeOwner(issue: Issue, agents: Agent[]): string {
  if (issue.assigneeAgentId) {
    const match = agents.find((agent) => agent.id === issue.assigneeAgentId);
    return match?.name ?? "Assigned agent (lookup pending)";
  }
  if (issue.assigneeUserId) {
    return "Assigned user";
  }
  return "Unassigned";
}

function describeEvidence(issue: Issue): string {
  const activity = issue.lastActivityAt ?? issue.updatedAt;
  if (!activity) return "No recorded activity yet.";
  const ms = activity instanceof Date ? activity.getTime() : new Date(activity).getTime();
  if (Number.isNaN(ms)) return "No recorded activity yet.";
  const delta = Date.now() - ms;
  if (delta < 0) return "Activity recorded.";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "Activity in the last minute.";
  if (minutes < 60) return `Activity ${minutes}m ago.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Activity ${hours}h ago.`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Activity ${days}d ago.`;
  return "Older than 30 days.";
}

function filterMissions(issues: Issue[], filter: MissionFilter): Issue[] {
  return issues.filter((issue) => {
    if (filter === "active") return ACTIVE_STATUSES.has(issue.status);
    if (filter === "needs-attention") return NEEDS_ATTENTION_STATUSES.has(issue.status);
    return DONE_STATUSES.has(issue.status);
  });
}

function sortMissions(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const aMs = (a.lastActivityAt instanceof Date ? a.lastActivityAt : a.updatedAt instanceof Date ? a.updatedAt : new Date(a.updatedAt as unknown as string)).getTime();
    const bMs = (b.lastActivityAt instanceof Date ? b.lastActivityAt : b.updatedAt instanceof Date ? b.updatedAt : new Date(b.updatedAt as unknown as string)).getTime();
    return bMs - aMs;
  });
}

export function MissionsLanding({ pageLimit = 50 }: MissionsLandingProps = {}) {
  const { selectedCompanyId } = useCompany();
  const [filter, setFilter] = useState<MissionFilter>("active");

  const issuesQuery = useQuery({
    queryKey: [...(selectedCompanyId ? queryKeys.issues.list(selectedCompanyId) : ["issues", "__no-company__"]), "missions-landing", pageLimit],
    queryFn: () => issuesApi.list(selectedCompanyId!, { limit: pageLimit }),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "__no-company__"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const visibleMissions = useMemo(() => {
    const data = issuesQuery.data ?? [];
    return sortMissions(filterMissions(data, filter));
  }, [issuesQuery.data, filter]);

  const totalIssues = issuesQuery.data?.length ?? 0;
  const isLoading = issuesQuery.isLoading;
  const hasError = issuesQuery.isError;
  const agents = agentsQuery.data ?? [];

  return (
    <section
      aria-labelledby="eaos-missions-title"
      className="flex flex-col gap-5"
      data-testid="eaos-missions-landing"
      data-eaos-data-connected={selectedCompanyId ? "true" : "false"}
    >
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2" data-testid="eaos-missions-posture">
          <EaosStateChip label={SHELL_POSTURE_LABEL} prefix={SHELL_POSTURE_PREFIX} />
          {selectedCompanyId ? (
            <EaosStateChip
              label="BACKEND-BACKED"
              prefix="Data"
              title="Mission rows are derived from the live issues read API for the current company scope."
            />
          ) : (
            <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
          )}
          <EaosStateChip
            label="PREVIEW"
            prefix="Row fields"
            title="Owner / next action / gate are derived from issue status and assignment; not all fields are individually backend-backed yet."
          />
        </div>
        <h1 id="eaos-missions-title" className="text-2xl font-semibold tracking-tight">
          Missions
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Active enterprise missions across the current company scope. Rows are read-only —
          release, deploy, spend, secret, and live-vendor states appear as status only.
        </p>
      </header>

      <div
        role="toolbar"
        aria-label="Mission filters"
        className="flex flex-wrap items-center gap-2"
        data-testid="eaos-missions-toolbar"
      >
        {MISSION_FILTERS.map((option) => {
          const isActive = filter === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setFilter(option.id)}
              aria-pressed={isActive}
              title={option.description}
              data-testid={`eaos-missions-filter-${option.id}`}
              className={
                "inline-flex items-center rounded-md border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
                (isActive
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground")
              }
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {!selectedCompanyId ? (
        <MissionsEmpty
          testId="eaos-missions-no-company"
          title="No company scope selected"
          body="Select a company in the workspace switcher to load missions. Missions list reads from the active company scope."
        />
      ) : isLoading ? (
        <MissionsLoading />
      ) : hasError ? (
        <MissionsError onRetry={() => issuesQuery.refetch()} />
      ) : totalIssues === 0 ? (
        <MissionsEmpty
          testId="eaos-missions-empty-all"
          title="No missions in this scope yet"
          body="When new work is created for this company it will appear here as a mission. Until then, the operator path has nothing to track."
        />
      ) : visibleMissions.length === 0 ? (
        <MissionsEmpty
          testId="eaos-missions-empty-filtered"
          title="No missions match this view"
          body="Switch the filter above to widen the view. Missions are not deleted from the system; they may be hidden by the active filter."
        />
      ) : (
        <ul
          aria-label="Mission list"
          className="flex flex-col gap-2"
          data-testid="eaos-missions-list"
        >
          {visibleMissions.map((issue) => (
            <MissionRow key={issue.id} issue={issue} agents={agents} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MissionsLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="eaos-missions-loading"
      className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
    >
      Loading missions for this scope…
    </div>
  );
}

function MissionsError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      data-testid="eaos-missions-error"
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-4 text-sm"
    >
      <p className="font-medium text-foreground">Could not load missions for this scope</p>
      <p className="text-muted-foreground">
        The mission list is temporarily unavailable. This does not stop in-flight work — agents
        continue from their own context. Retry when the connection settles.
      </p>
      <div>
        <button
          type="button"
          onClick={onRetry}
          data-testid="eaos-missions-error-retry"
          className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function MissionsEmpty({ title, body, testId }: { title: string; body: string; testId: string }) {
  return (
    <div
      data-testid={testId}
      className="rounded-md border border-dashed border-border bg-card p-4"
    >
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
      <p className="mt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        {NOT_CONNECTED_DATA_NOTE} controls. Read-only view.
      </p>
    </div>
  );
}

function MissionRow({ issue, agents }: { issue: Issue; agents: Agent[] }) {
  const state = statusToMissionState(issue.status);
  const owner = describeOwner(issue, agents);
  const nextAction = deriveNextAction(issue);
  const gate = deriveGate(issue);
  const evidence = describeEvidence(issue);
  const detailHref = `/issues/${issue.identifier ?? issue.id}`;

  return (
    <li
      data-testid={`eaos-missions-row-${issue.id}`}
      data-eaos-mission-status={issue.status}
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <EaosStateChip
              label={state.chip}
              prefix={state.prefix}
              title={`Derived from issue.status=${issue.status}`}
            />
            {gate ? (
              <EaosStateChip
                label={gate.tone}
                prefix="Gate"
                title={`Gate state derived from issue.status=${issue.status}`}
              />
            ) : null}
            <EaosStateChip
              label="PREVIEW"
              prefix="Truth"
              title="Row fields aggregate live issue data with derived summaries."
            />
            {issue.identifier ? (
              <span
                aria-label={`Kernel identifier ${issue.identifier}`}
                title="Kernel/Admin identifier — links into the legacy issue detail surface."
                className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {issue.identifier}
              </span>
            ) : null}
          </div>
          <p className="truncate text-sm font-medium text-foreground" title={issue.title}>
            {issue.title}
          </p>
        </div>
        <Link
          to={detailHref}
          aria-label={`Open Kernel/Admin view for ${issue.identifier ?? issue.title}`}
          data-testid={`eaos-missions-row-link-${issue.id}`}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span aria-hidden="true">⎈</span>
          <span>Kernel / Admin view</span>
        </Link>
      </div>
      <dl
        className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4"
        data-testid={`eaos-missions-row-meta-${issue.id}`}
      >
        <div className="flex flex-col gap-0.5">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Owner</dt>
          <dd className="text-xs text-foreground">{owner}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Next action</dt>
          <dd className="text-xs text-foreground">{nextAction}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Gate</dt>
          <dd className="text-xs text-foreground">{gate?.label ?? "None"}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Evidence</dt>
          <dd className="text-xs text-foreground">{evidence}</dd>
        </div>
      </dl>
    </li>
  );
}
