// LET-467 — sticky-ish mission header for the EAOS Mission detail page.
//
// Read-only: shows identifier, title, status, owner, last activity, blocker
// summary, and a demoted Kernel/Admin escape hatch. No mutating controls.

import { Link } from "@/lib/router";
import type { Agent, Issue } from "@paperclipai/shared";
import { EaosStateChip } from "../EaosStateChip";
import type { EaosStateLabel } from "../state-labels";

interface MissionDetailHeaderProps {
  issue: Issue;
  owner: string;
  liveRunCount: number;
  hasActiveRun: boolean;
}

function statusChip(status: Issue["status"]): { label: EaosStateLabel; copy: string } {
  switch (status) {
    case "in_review":
      return { label: "APPROVAL REQUIRED", copy: "In review" };
    case "blocked":
      return { label: "FAILED", copy: "Blocked" };
    case "done":
      return { label: "APPLIED", copy: "Done" };
    case "cancelled":
      return { label: "PREVIEW", copy: "Cancelled" };
    case "in_progress":
      return { label: "BACKEND-BACKED", copy: "Active" };
    case "todo":
      return { label: "BACKEND-BACKED", copy: "Queued" };
    case "backlog":
    default:
      return { label: "PREVIEW", copy: "Backlog" };
  }
}

function describeBlockers(issue: Issue): string {
  const attn = issue.blockerAttention;
  if (!attn) {
    return "Blockers · unknown";
  }
  if (attn.state === "none" || attn.unresolvedBlockerCount === 0) {
    return "Blockers · none";
  }
  if (attn.state === "needs_attention") {
    return `Blockers · attention required (${attn.unresolvedBlockerCount})`;
  }
  if (attn.state === "stalled") {
    return `Blockers · stalled (${attn.stalledBlockerCount})`;
  }
  return `Blockers · ${attn.unresolvedBlockerCount} open`;
}

function describeLastActivity(issue: Issue): string {
  const ts = issue.lastActivityAt ?? issue.updatedAt ?? null;
  if (!ts) return "No recorded activity yet";
  const ms = ts instanceof Date ? ts.getTime() : new Date(ts as unknown as string).getTime();
  if (Number.isNaN(ms)) return "No recorded activity yet";
  const delta = Date.now() - ms;
  if (delta < 0) return "Activity recorded";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "Activity in the last minute";
  if (minutes < 60) return `Activity ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Activity ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Activity ${days}d ago`;
  return "Older than 30 days";
}

export function MissionDetailHeader({
  issue,
  owner,
  liveRunCount,
  hasActiveRun,
}: MissionDetailHeaderProps) {
  const chip = statusChip(issue.status);
  const kernelHref = `/issues/${issue.identifier ?? issue.id}`;
  const isLive = hasActiveRun || liveRunCount > 0;

  return (
    <header
      aria-labelledby="eaos-mission-title"
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
      data-testid="eaos-mission-detail-header"
    >
      <div className="flex flex-wrap items-center gap-2" data-testid="eaos-mission-detail-truth">
        <EaosStateChip label="BACKEND-BACKED" prefix="Shell" />
        <EaosStateChip
          label={chip.label}
          prefix="Mission"
          title={`Derived from issue.status=${issue.status}`}
        />
        {isLive ? (
          <EaosStateChip
            label="LIVE"
            prefix="Run"
            title={
              hasActiveRun
                ? "An active run is in progress for this mission."
                : `${liveRunCount} live run${liveRunCount === 1 ? "" : "s"}`
            }
          />
        ) : null}
        <EaosStateChip
          label="PREVIEW"
          prefix="Truth"
          title="Header summary aggregates issue + run state; gate/owner labels are derived from status and assignment."
        />
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            {issue.identifier ? (
              <span
                aria-label={`Mission identifier ${issue.identifier}`}
                className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                data-testid="eaos-mission-detail-identifier"
              >
                {issue.identifier}
              </span>
            ) : null}
            <span className="text-xs text-muted-foreground">{chip.copy}</span>
          </div>
          <h1
            id="eaos-mission-title"
            className="text-2xl font-semibold tracking-tight text-foreground"
            data-testid="eaos-mission-detail-title"
          >
            {issue.title}
          </h1>
        </div>
        <Link
          to={kernelHref}
          aria-label={`Open Kernel/Admin view for ${issue.identifier ?? issue.title}`}
          data-testid="eaos-mission-detail-kernel-link"
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span aria-hidden="true">⎈</span>
          <span>Kernel / Admin view</span>
        </Link>
      </div>

      <dl
        className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-4"
        data-testid="eaos-mission-detail-summary"
      >
        <div className="flex flex-col gap-0.5">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Owner</dt>
          <dd className="text-xs text-foreground">{owner}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Priority</dt>
          <dd className="text-xs text-foreground">{issue.priority}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Last activity</dt>
          <dd className="text-xs text-foreground">{describeLastActivity(issue)}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Blockers</dt>
          <dd className="text-xs text-foreground">{describeBlockers(issue)}</dd>
        </div>
      </dl>
    </header>
  );
}

export function describeOwner(issue: Issue, agents: ReadonlyArray<Agent>): string {
  if (issue.assigneeAgentId) {
    const match = agents.find((a) => a.id === issue.assigneeAgentId);
    return match?.name ?? "Assigned agent (lookup pending)";
  }
  if (issue.assigneeUserId) return "Assigned user";
  return "Unassigned";
}
