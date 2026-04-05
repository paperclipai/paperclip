import { useEffect, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { fleetosApi, type FleetContainer } from "../api/fleetos";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  CheckCircle2,
  Circle,
  AlertTriangle,
  Clock,
  ArrowUpRight,
} from "lucide-react";

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
  // Container names are often slugged; try to humanize
  return container.labels?.["agent_name"]
    ?? container.name
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Extract initials from a display name for the avatar circle. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
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
      // stopped, frozen, provisioning → idle
      idle++;
    }
  }

  return { active, idle, needsAttention };
}

// ---------------------------------------------------------------------------
// Mock data (TODO: replace with real backend data when available)
// ---------------------------------------------------------------------------

const MOCK_RECENT_TASKS = [
  { id: "1", title: "Update CRM contact records from CSV", status: "done" as const, assignee: "Sales Assistant", timestamp: "2h ago" },
  { id: "2", title: "Generate weekly analytics report", status: "in_progress" as const, assignee: "Data Analyst", timestamp: "4h ago" },
  { id: "3", title: "Draft follow-up emails for demo attendees", status: "done" as const, assignee: "Sales Assistant", timestamp: "6h ago" },
  { id: "4", title: "Triage incoming support tickets", status: "todo" as const, assignee: "Support Agent", timestamp: "1d ago" },
  { id: "5", title: "Reconcile invoice discrepancies", status: "in_progress" as const, assignee: "Ops Coordinator", timestamp: "1d ago" },
];

type TaskStatus = "done" | "in_progress" | "todo";

const STATUS_BADGE: Record<TaskStatus, { label: string; className: string }> = {
  done: { label: "Done", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" },
  in_progress: { label: "In Progress", className: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
  todo: { label: "To Do", className: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
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
      className="flex-1 rounded-xl border border-border bg-card p-4 shadow-sm hover:bg-accent/50 transition-colors no-underline text-inherit"
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={cn("h-2.5 w-2.5 rounded-full", dotColor)} />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </span>
      </div>
      <p
        className="text-3xl font-bold tracking-tight tabular-nums"
        style={{ fontFamily: "Syne, system-ui, sans-serif" }}
      >
        {count}
      </p>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function RaavaHome() {
  const { setBreadcrumbs } = useBreadcrumbs();

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

  const counts = useMemo(
    () => countByStatus(containers ?? []),
    [containers],
  );

  const activeContainers = useMemo(
    () => (containers ?? []).filter((c) => c.status === "running"),
    [containers],
  );

  // TODO: Pull user name from company context or auth session when available
  const userName = "Carlos";

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  if (isError) {
    return (
      <div className="rounded-xl border border-destructive/50 bg-destructive/5 p-6 text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-destructive mb-2" />
        <p className="text-sm font-medium text-destructive">
          Failed to load team data
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {error instanceof Error ? error.message : "An unexpected error occurred. Please try again."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ----------------------------------------------------------------- */}
      {/* 1. Welcome Banner                                                  */}
      {/* ----------------------------------------------------------------- */}
      <div
        className="relative overflow-hidden rounded-xl border border-border bg-card p-6 shadow-sm"
        style={{
          background:
            "linear-gradient(135deg, rgba(34,74,232,0.05) 0%, rgba(0,189,183,0.03) 100%)",
        }}
      >
        {/* Left accent border (brand gradient) */}
        <div
          className="absolute left-0 top-0 bottom-0 w-[3px]"
          style={{
            background: "linear-gradient(180deg, #224AE8, #00BDB7)",
          }}
        />
        <h1
          className="text-xl font-bold text-foreground"
          style={{ fontFamily: "Syne, system-ui, sans-serif" }}
        >
          {getGreeting()}, {userName}.
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Here&apos;s your team&apos;s status.
        </p>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* 2. Team Status Strip                                               */}
      {/* ----------------------------------------------------------------- */}
      <div className="grid grid-cols-3 gap-3">
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

      {/* ----------------------------------------------------------------- */}
      {/* 3. Active Work + Spend This Week (side-by-side on md+)            */}
      {/* ----------------------------------------------------------------- */}
      <div className="grid gap-4 md:grid-cols-3">
        {/* Active Work — 2/3 width on md+ */}
        <div className="md:col-span-2 rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Active Work
            </h2>
            <Link
              to="/agents/all"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors no-underline inline-flex items-center gap-1"
            >
              View team <ArrowUpRight className="h-3 w-3" />
            </Link>
          </div>

          {activeContainers.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-sm text-muted-foreground">
                Your team is idle. Assign a task to get started.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {activeContainers.map((c) => {
                const name = displayName(c);
                return (
                  <div
                    key={c.id}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-accent/30 transition-colors"
                  >
                    {/* Avatar initial circle */}
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {initials(name)}
                    </div>
                    {/* Name + current task */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {/* Use container name as task proxy — real task data requires backend integration */}
                        Working on: {c.name}
                      </p>
                    </div>
                    {/* Time elapsed */}
                    {c.health?.uptime_seconds != null && (
                      <span className="text-xs text-muted-foreground shrink-0 inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatElapsed(c.health.uptime_seconds)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Spend This Week — 1/3 width on md+ */}
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm flex flex-col justify-between">
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              Spend This Week
            </h2>
            {/* TODO: Replace with real billing data from backend billing API */}
            <p
              className="text-4xl font-bold tracking-tight"
              style={{ fontFamily: "Syne, system-ui, sans-serif" }}
            >
              $127.40
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              <span className="text-amber-600 dark:text-amber-400">+12%</span>{" "}
              vs last week
            </p>
          </div>
          <Link
            to="/costs"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors no-underline inline-flex items-center gap-1 mt-4"
          >
            View billing <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* 4. Recent Tasks                                                    */}
      {/* ----------------------------------------------------------------- */}
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Recent Tasks
          </h2>
          <Link
            to="/issues"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors no-underline inline-flex items-center gap-1"
          >
            View all <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
        {/* TODO: Replace mock data with real task data from issues API when backend supports fleetos task queries */}
        <div className="divide-y divide-border">
          {MOCK_RECENT_TASKS.map((task) => {
            const badge = STATUS_BADGE[task.status];
            return (
              <div
                key={task.id}
                className="flex items-center gap-3 px-4 py-3 hover:bg-accent/30 transition-colors"
              >
                {/* Status icon */}
                {task.status === "done" && (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                )}
                {task.status === "in_progress" && (
                  <Circle className="h-4 w-4 shrink-0 text-blue-500" />
                )}
                {task.status === "todo" && (
                  <Circle className="h-4 w-4 shrink-0 text-gray-400" />
                )}

                {/* Title + assignee */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{task.title}</p>
                  <p className="text-xs text-muted-foreground">{task.assignee}</p>
                </div>

                {/* Badge */}
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                    badge.className,
                  )}
                >
                  {badge.label}
                </span>

                {/* Timestamp */}
                <span className="text-xs text-muted-foreground shrink-0">
                  {task.timestamp}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
