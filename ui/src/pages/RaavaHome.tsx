import { useEffect, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { fleetosApi, type FleetContainer } from "../api/fleetos";
import { costsApi } from "../api/costs";
import { issuesApi } from "../api/issues";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatCents } from "../lib/utils";
import { PageSkeleton } from "../components/PageSkeleton";
import { Skeleton } from "../components/ui/skeleton";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import type { Issue } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Derive a human-friendly display name from a container name. */
function displayName(container: FleetContainer): string {
  const raw = container.labels?.["agent_name"] ?? container.name ?? container.id ?? "Unknown";
  return raw
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Status counts
// ---------------------------------------------------------------------------

interface StatusCounts {
  active: number;
  idle: number;
  needsAttention: number;
}

function countByStatus(containers: FleetContainer[]): StatusCounts {
  let active = 0;
  let idle = 0;
  let needsAttention = 0;

  for (const c of containers) {
    if (c.status === "error") {
      needsAttention++;
    } else if (c.status === "running") {
      active++;
    } else {
      idle++;
    }
  }

  return { active, idle, needsAttention };
}

// ---------------------------------------------------------------------------
// Helpers — current week date range
// ---------------------------------------------------------------------------

function currentWeekRange(): { from: string; to: string } {
  const now = new Date();
  const day = now.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMon, 0, 0, 0, 0);
  return { from: mon.toISOString(), to: now.toISOString() };
}

/** Map an Issue status to the badge key used by the Recent Tasks UI. */
function issueStatusToBadge(status: string): TaskStatus {
  if (status === "done" || status === "cancelled") return "done";
  if (status === "in_progress") return "in_progress";
  if (status === "blocked" || status === "in_review") return "stuck";
  return "in_progress";
}

/** Derive a short assignee label from an Issue. */
function issueAssigneeLabel(issue: Issue): string {
  return issue.executionAgentNameKey ?? issue.assigneeAgentId ?? "Unassigned";
}

type TaskStatus = "done" | "in_progress" | "stuck";

const STATUS_BADGE: Record<
  TaskStatus,
  { label: string; bgClass: string; textClass: string }
> = {
  done: {
    label: "Done",
    bgClass: "bg-emerald-500/10",
    textClass: "text-emerald-500",
  },
  in_progress: {
    label: "In Progress",
    bgClass: "bg-[rgba(34,74,232,0.1)]",
    textClass: "text-[#224ae8]",
  },
  stuck: {
    label: "Stuck",
    bgClass: "bg-red-500/10",
    textClass: "text-red-500",
  },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusCard({
  label,
  count,
  color,
  to,
}: {
  label: string;
  count: number;
  color: "green" | "gray" | "red";
  to: string;
}) {
  const dotColor = {
    green: "bg-emerald-500",
    gray: "bg-gray-400",
    red: "bg-red-500",
  }[color];

  return (
    <Link
      to={to}
      className="raava-card flex flex-1 items-center gap-3 bg-white px-5 py-4 transition-colors hover:bg-accent/30 no-underline text-inherit dark:bg-card"
    >
      <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", dotColor)} />
      <span className="font-display text-2xl text-foreground">{count}</span>
      <span className="text-[13px] font-medium text-muted-foreground">
        {label}
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function RaavaHome() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, selectedCompany } = useCompany();

  useEffect(() => {
    setBreadcrumbs([{ label: "Home" }]);
  }, [setBreadcrumbs]);

  const {
    data: containers,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: queryKeys.fleet.containers,
    queryFn: () => fleetosApi.listContainers(),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  // Weekly spend from costs API
  const weekRange = useMemo(() => currentWeekRange(), []);
  const {
    data: costSummary,
    isLoading: isCostLoading,
  } = useQuery({
    queryKey: queryKeys.costs(selectedCompanyId!, weekRange.from, weekRange.to),
    queryFn: () => costsApi.summary(selectedCompanyId!, weekRange.from, weekRange.to),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  // Recent tasks from issues API — most recently updated, limit 5
  const {
    data: recentIssues,
    isLoading: isRecentTasksLoading,
  } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "recent-home"],
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
    select: (issues: Issue[]) =>
      [...issues]
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 5),
  });

  // Active work = in_progress issues (cross-referenced with running containers below)
  const {
    data: activeIssues,
    isLoading: isActiveIssuesLoading,
  } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "active-home"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { status: "in_progress" }),
    enabled: !!selectedCompanyId,
    staleTime: 15_000,
  });

  const counts = useMemo(
    () => countByStatus(containers ?? []),
    [containers],
  );

  const activeContainers = useMemo(
    () => (containers ?? []).filter((c) => c.status === "running"),
    [containers],
  );

  // Build active work items by cross-referencing in_progress issues with running containers
  // NOTE: This useMemo MUST be above the early returns to satisfy the Rules of Hooks.
  const activeWorkItems = useMemo(() => {
    // Build a lookup from agent name key to running container for uptime info
    const containerByAgent = new Map<string, FleetContainer>();
    for (const c of activeContainers) {
      const agentName = c.labels?.["agent_name"] ?? c.name;
      containerByAgent.set(agentName, c);
    }

    if (activeIssues && activeIssues.length > 0) {
      return activeIssues.map((issue) => {
        const agentKey = issue.executionAgentNameKey ?? issue.assigneeAgentId ?? "";
        const container = containerByAgent.get(agentKey);
        return {
          name: agentKey || "Agent",
          task: issue.title,
          time:
            container?.health?.uptime_seconds != null
              ? formatElapsed(container.health.uptime_seconds)
              : "--",
        };
      });
    }

    // Fallback to container-only data when no active issues available
    return activeContainers.map((c) => ({
      name: displayName(c),
      task: `Working on: ${c.name}`,
      time:
        c.health?.uptime_seconds != null
          ? formatElapsed(c.health.uptime_seconds)
          : "--",
    }));
  }, [activeIssues, activeContainers]);

  // Company name for greeting
  const userName = selectedCompany?.name ?? "there";

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  if (isError) {
    return (
      <div className="raava-card bg-destructive/5 p-6 text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-destructive mb-2" />
        <p className="text-sm font-medium text-destructive">
          Failed to load team data
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {error instanceof Error
            ? error.message
            : "An unexpected error occurred. Please try again."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* --------------------------------------------------------------- */}
      {/* 1. Welcome Banner                                                */}
      {/* --------------------------------------------------------------- */}
      <div
        className="relative overflow-hidden rounded-2xl border border-border/50 px-8 py-7"
        style={{
          background:
            "linear-gradient(135deg, rgba(34,74,232,0.06) 0%, rgba(113,110,255,0.04) 50%, rgba(0,189,183,0.06) 100%)",
        }}
      >
        <h1 className="font-display text-[22px] text-foreground">
          {getGreeting()}, {userName}.
        </h1>
        <p className="text-[15px] text-muted-foreground mt-2">
          Here&apos;s your team&apos;s status.
        </p>
      </div>

      {/* --------------------------------------------------------------- */}
      {/* 2. Team Status Strip                                             */}
      {/* --------------------------------------------------------------- */}
      <div className="grid grid-cols-3 gap-4">
        <StatusCard
          label="Active"
          count={counts.active}
          color="green"
          to="/agents/active"
        />
        <StatusCard
          label="Idle"
          count={counts.idle}
          color="gray"
          to="/agents/paused"
        />
        <StatusCard
          label="Needs Attention"
          count={counts.needsAttention}
          color="red"
          to="/agents/error"
        />
      </div>

      {/* --------------------------------------------------------------- */}
      {/* 3. Active Work + Spend This Week                                 */}
      {/* --------------------------------------------------------------- */}
      <div className="flex gap-5">
        {/* Active Work */}
        <div className="raava-card flex-1 bg-white px-6 py-5 dark:bg-card">
          <h2 className="text-[15px] font-semibold text-foreground mb-4">
            Active Work
          </h2>

          {activeWorkItems.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              Your team is idle. Assign a task to get started.
            </p>
          ) : (
            <div className="space-y-0">
              {activeWorkItems.map((item) => (
                <div
                  key={item.name}
                  className="flex items-center justify-between py-2"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                    <span className="text-[13px] font-semibold text-foreground">
                      {item.name}
                    </span>
                    <span className="text-[13px] text-muted-foreground">
                      {item.task}
                    </span>
                  </div>
                  <span className="text-xs font-medium text-muted-foreground shrink-0 ml-4">
                    {item.time}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Spend This Week */}
        <div className="raava-card w-[280px] shrink-0 bg-white px-6 py-5 dark:bg-card flex flex-col justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-foreground mb-2">
              Spend This Week
            </h2>
            {isCostLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-9 w-28 animate-pulse" />
                <Skeleton className="h-4 w-36 animate-pulse" />
              </div>
            ) : costSummary ? (
              <>
                <div className="flex items-baseline gap-2.5">
                  <p className="font-display text-[32px] text-foreground">
                    {formatCents(costSummary.spendCents)}
                  </p>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {costSummary.budgetCents > 0
                    ? `${costSummary.utilizationPercent}% of ${formatCents(costSummary.budgetCents)} budget`
                    : "No budget set"}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground py-2">
                Unable to load spend data.
              </p>
            )}
          </div>
          <Link
            to="/costs"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors no-underline inline-flex items-center gap-1 mt-4"
          >
            View billing <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {/* --------------------------------------------------------------- */}
      {/* 4. Recent Tasks                                                  */}
      {/* --------------------------------------------------------------- */}
      <div className="raava-card bg-white pt-5 pb-2 px-6 dark:bg-card">
        <h2 className="text-[15px] font-semibold text-foreground mb-3">
          Recent Tasks
        </h2>
        <div>
          {isRecentTasksLoading ? (
            <div className="space-y-3 py-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-4 w-48 animate-pulse" />
                    <Skeleton className="h-3 w-16 animate-pulse" />
                  </div>
                  <Skeleton className="h-5 w-16 rounded-xl animate-pulse" />
                </div>
              ))}
            </div>
          ) : recentIssues && recentIssues.length > 0 ? (
            recentIssues.map((issue, idx) => {
              const badgeKey = issueStatusToBadge(issue.status);
              const badge = STATUS_BADGE[badgeKey];
              const isLast = idx === recentIssues.length - 1;
              return (
                <div
                  key={issue.id}
                  className={cn(
                    "flex items-center justify-between py-3",
                    !isLast && "border-b border-border",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-foreground">
                      {issue.title}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {issueAssigneeLabel(issue)}
                    </span>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-xl px-2.5 py-1 text-[11px] font-medium",
                      badge.bgClass,
                      badge.textClass,
                    )}
                  >
                    {badge.label}
                  </span>
                </div>
              );
            })
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No recent tasks found.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
