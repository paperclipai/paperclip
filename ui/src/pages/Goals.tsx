import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePageTitle } from "../hooks/usePageTitle";
import {
  AlertTriangle,
  ArrowUpDown,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Filter,
  LayoutList,
  Loader2,
  Network,
  Plus,
  Search,
  ShieldAlert,
  Target,
  TrendingUp,
  Users,
} from "lucide-react";
import type { Goal } from "@ironworksai/shared";
import { goalsApi } from "../api/goals";
import { goalProgressApi, type GoalProgressItem } from "../api/goalProgress";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from "@/lib/router";

/* ------------------------------------------------------------------ */
/*  Progress Bar                                                       */
/* ------------------------------------------------------------------ */

function ProgressBar({ percent, size = "md" }: { percent: number; size?: "sm" | "md" }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className={cn("w-full bg-muted rounded-full overflow-hidden", size === "sm" ? "h-1.5" : "h-2.5")}>
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500 ease-out",
          clamped === 100
            ? "bg-gradient-to-r from-emerald-500 to-emerald-400"
            : clamped > 50
              ? "bg-gradient-to-r from-blue-600 to-blue-400"
              : clamped > 0
                ? "bg-gradient-to-r from-amber-500 to-amber-400"
                : "bg-muted",
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Goal Health Scoring                                                */
/* ------------------------------------------------------------------ */

type GoalHealth = "on_track" | "at_risk" | "off_track" | "no_data";

/** Prefer the backend-computed healthStatus; fall back to local heuristic. */
function resolveGoalHealth(
  goal: Goal,
  progress?: GoalProgressItem | null,
): GoalHealth {
  // Use server-computed healthStatus when present
  if (goal.healthStatus && goal.healthStatus !== "no_data" && goal.healthStatus !== "achieved") {
    return goal.healthStatus as GoalHealth;
  }
  return computeGoalHealth(goal, progress);
}

function computeGoalHealth(
  goal: Goal,
  progress?: GoalProgressItem | null,
): GoalHealth {
  if (!progress || progress.totalIssues === 0) return "no_data";
  if (!goal.targetDate) {
    // No deadline - use completion percent heuristics
    if (progress.progressPercent >= 70) return "on_track";
    if (progress.blockedIssues > 0) return "at_risk";
    return "on_track";
  }

  const now = new Date();
  const created = new Date(goal.createdAt);
  const target = new Date(goal.targetDate);
  const totalDuration = target.getTime() - created.getTime();
  const elapsed = now.getTime() - created.getTime();

  // Past deadline and not done
  if (now > target && progress.progressPercent < 100) return "off_track";

  // No meaningful duration to measure against
  if (totalDuration <= 0) return progress.progressPercent >= 50 ? "on_track" : "at_risk";

  const timePercent = Math.min(100, (elapsed / totalDuration) * 100);
  const progressPercent = progress.progressPercent;
  const pace = progressPercent - timePercent;

  // Blocked issues are a risk signal
  if (progress.blockedIssues > 0 && pace < 10) return "at_risk";

  if (pace >= -10) return "on_track";
  if (pace >= -30) return "at_risk";
  return "off_track";
}

function forecastCompletion(
  goal: Goal,
  progress?: GoalProgressItem | null,
): string | null {
  if (!progress || progress.totalIssues === 0 || progress.completedIssues === 0) return null;

  const created = new Date(goal.createdAt);
  const now = new Date();
  const elapsed = now.getTime() - created.getTime();
  if (elapsed <= 0) return null;

  // Velocity: completed issues per ms
  const velocity = progress.completedIssues / elapsed;
  if (velocity <= 0) return null;

  const remaining = progress.totalIssues - progress.completedIssues;
  const msToComplete = remaining / velocity;
  const forecast = new Date(now.getTime() + msToComplete);

  return forecast.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const HEALTH_CONFIG: Record<GoalHealth, { label: string; className: string }> = {
  on_track: { label: "On Track", className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  at_risk: { label: "At Risk", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  off_track: { label: "Off Track", className: "bg-red-500/10 text-red-600 dark:text-red-400" },
  no_data: { label: "", className: "" },
};

function HealthBadge({ health }: { health: GoalHealth }) {
  if (health === "no_data") return null;
  const cfg = HEALTH_CONFIG[health];
  return (
    <span className={cn("text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0", cfg.className)}>
      {cfg.label}
    </span>
  );
}

function ConfidenceIndicator({ confidence }: { confidence: number | null | undefined }) {
  if (confidence == null) return null;
  const color =
    confidence > 66
      ? "bg-emerald-500"
      : confidence > 33
        ? "bg-amber-500"
        : "bg-red-500";
  return (
    <span className="flex items-center gap-1 shrink-0" title={`Confidence: ${confidence}%`}>
      <span className={cn("h-2 w-2 rounded-full", color)} />
      <span className="text-[10px] text-muted-foreground tabular-nums">{confidence}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Cascade Summary Banner                                             */
/* ------------------------------------------------------------------ */

function CascadeSummaryBanner({
  goals,
  progressMap,
}: {
  goals: Goal[];
  progressMap: Map<string, GoalProgressItem>;
}) {
  const counts = useMemo(() => {
    let onTrack = 0;
    let atRisk = 0;
    let offTrack = 0;
    let total = 0;

    for (const goal of goals) {
      const progress = progressMap.get(goal.id);
      const health = resolveGoalHealth(goal, progress);
      if (health === "no_data") continue;
      total++;
      if (health === "on_track") onTrack++;
      else if (health === "at_risk") atRisk++;
      else if (health === "off_track") offTrack++;
    }

    if (total === 0) return null;
    return {
      onTrack: Math.round((onTrack / total) * 100),
      atRisk: Math.round((atRisk / total) * 100),
      offTrack: Math.round((offTrack / total) * 100),
      total,
    };
  }, [goals, progressMap]);

  if (!counts) return null;

  return (
    <div className="flex items-center gap-4 px-4 py-2.5 rounded-lg border border-border bg-muted/30">
      <div className="flex items-center gap-1.5 text-xs">
        <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground font-medium">Goal Health</span>
      </div>
      <div className="flex items-center gap-3 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <span className="font-medium text-emerald-600 dark:text-emerald-400">{counts.onTrack}%</span>
          <span className="text-muted-foreground">on track</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          <span className="font-medium text-amber-600 dark:text-amber-400">{counts.atRisk}%</span>
          <span className="text-muted-foreground">at risk</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-red-500" />
          <span className="font-medium text-red-600 dark:text-red-400">{counts.offTrack}%</span>
          <span className="text-muted-foreground">off track</span>
        </span>
      </div>
      <span className="text-[11px] text-muted-foreground ml-auto">{counts.total} goals scored</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Goal Card                                                          */
/* ------------------------------------------------------------------ */

function GoalCard({
  goal,
  progress,
  children,
}: {
  goal: Goal;
  progress?: GoalProgressItem | null;
  children?: Goal[];
}) {
  const totalIssues = progress?.totalIssues ?? 0;
  const completed = progress?.completedIssues ?? 0;
  const inProgress = progress?.inProgressIssues ?? 0;
  const blocked = progress?.blockedIssues ?? 0;
  const percent = progress?.progressPercent ?? 0;
  const health = resolveGoalHealth(goal, progress);
  const forecast = forecastCompletion(goal, progress);

  return (
    <Link
      to={`/goals/${goal.id}`}
      className="block border border-border rounded-lg p-4 transition-all duration-150 hover:bg-accent/30 hover:border-border/80 hover:shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <HealthBadge health={health} />
            <h3 className="text-sm font-semibold truncate">{goal.title}</h3>
            <StatusBadge status={goal.status} />
            <ConfidenceIndicator confidence={goal.confidence} />
            {goal.targetDate && (
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full shrink-0",
                new Date(goal.targetDate) < new Date()
                  ? "bg-red-500/10 text-red-600 dark:text-red-400"
                  : "bg-muted text-muted-foreground",
              )}>
                {new Date(goal.targetDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            )}
          </div>
          {goal.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{goal.description}</p>
          )}
          {forecast && (
            <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Forecasted completion: {forecast}
            </p>
          )}
        </div>
        {totalIssues > 0 && (
          <div className="text-right shrink-0">
            <span className="text-xl font-bold tabular-nums">{Math.round(percent)}%</span>
            <div className="text-[10px] text-muted-foreground tabular-nums">{completed}/{totalIssues} done</div>
          </div>
        )}
      </div>

      {/* Progress bar */}
      {totalIssues > 0 && (
        <div className="mt-3">
          <ProgressBar percent={percent} />
          <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
            {completed > 0 && (
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                {completed} done
              </span>
            )}
            {inProgress > 0 && (
              <span className="flex items-center gap-1">
                <Loader2 className="h-3 w-3 text-blue-500" />
                {inProgress} active
              </span>
            )}
            {blocked > 0 && (
              <span className="flex items-center gap-1">
                <ShieldAlert className="h-3 w-3 text-red-500" />
                {blocked} blocked
              </span>
            )}
            {totalIssues - completed - inProgress - blocked > 0 && (
              <span className="flex items-center gap-1">
                <Circle className="h-3 w-3" />
                {totalIssues - completed - inProgress - blocked} pending
              </span>
            )}
          </div>
        </div>
      )}

      {totalIssues === 0 && (
        <div className="mt-2 text-xs text-muted-foreground italic">
          No tasks yet - click to add issues or run a playbook
        </div>
      )}

      {/* Sub-goals indicator */}
      {children && children.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border/50 text-[11px] text-muted-foreground">
          {children.length} sub-goal{children.length !== 1 ? "s" : ""}
        </div>
      )}
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/*  Goal Tree View Components                                          */
/* ------------------------------------------------------------------ */

function progressColor(percent: number): string {
  if (percent >= 70) return "text-emerald-600 dark:text-emerald-400";
  if (percent >= 30) return "text-amber-600 dark:text-amber-400";
  return "text-red-500 dark:text-red-400";
}

function progressBarColor(percent: number): string {
  if (percent >= 70) return "bg-emerald-500";
  if (percent >= 30) return "bg-amber-500";
  return "bg-red-500";
}

interface GoalTreeNodeProps {
  goal: Goal;
  progress?: GoalProgressItem;
  childGoals: Goal[];
  allGoals: Goal[];
  progressMap: Map<string, GoalProgressItem>;
  issuesByGoal: Map<string, Array<{ id: string; title: string; status: string; identifier: string | null }>>;
  depth?: number;
}

function GoalTreeNode({ goal, progress, childGoals, allGoals, progressMap, issuesByGoal, depth = 0 }: GoalTreeNodeProps) {
  const [expanded, setExpanded] = useState(depth === 0);
  const percent = progress?.progressPercent ?? 0;
  const issues = issuesByGoal.get(goal.id) ?? [];
  const hasChildren = childGoals.length > 0 || issues.length > 0;
  const health = resolveGoalHealth(goal, progress);

  const issueStatusIcon = (status: string) => {
    if (status === "done") return <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />;
    if (status === "in_progress") return <Loader2 className="h-3 w-3 text-blue-500 shrink-0" />;
    if (status === "blocked") return <ShieldAlert className="h-3 w-3 text-red-500 shrink-0" />;
    return <Circle className="h-3 w-3 text-muted-foreground shrink-0" />;
  };

  return (
    <div className={cn("border border-border rounded-lg", depth > 0 && "ml-6 mt-2")}>
      <div
        className={cn(
          "flex items-center gap-2 p-3 rounded-t-lg",
          hasChildren && "cursor-pointer hover:bg-accent/30",
          !expanded && "rounded-b-lg",
        )}
        onClick={() => hasChildren && setExpanded((e) => !e)}
      >
        {hasChildren ? (
          expanded
            ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Link
              to={`/goals/${goal.id}`}
              className="text-sm font-semibold hover:underline truncate"
              onClick={(e) => e.stopPropagation()}
            >
              {goal.title}
            </Link>
            <StatusBadge status={goal.status} />
            <HealthBadge health={health} />
            <span className="text-xs text-muted-foreground shrink-0">{goal.level}</span>
          </div>
          {progress && progress.totalIssues > 0 && (
            <div className="mt-1.5 flex items-center gap-2">
              <div className="flex-1 max-w-[200px] bg-muted rounded-full h-2 overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-[width] duration-500 ease-out", progressBarColor(percent))}
                  style={{ width: `${Math.min(100, percent)}%` }}
                />
              </div>
              <span className={cn("text-xs font-medium tabular-nums", progressColor(percent))}>
                {Math.round(percent)}%
              </span>
              <span className="text-[11px] text-muted-foreground">
                {progress.completedIssues}/{progress.totalIssues}
              </span>
            </div>
          )}
        </div>
      </div>

      {expanded && hasChildren && (
        <div className="border-t border-border px-3 py-2 space-y-1 rounded-b-lg bg-muted/20">
          {/* Issues linked to this goal */}
          {issues.map((issue) => (
            <div key={issue.id} className="flex items-center gap-2 py-1 pl-6">
              {issueStatusIcon(issue.status)}
              <Link
                to={`/issues/${issue.id}`}
                className="text-xs hover:underline text-muted-foreground hover:text-foreground truncate"
              >
                {issue.identifier ? (
                  <span className="font-mono mr-1 text-[10px]">{issue.identifier}</span>
                ) : null}
                {issue.title}
              </Link>
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full shrink-0",
                issue.status === "done" && "bg-emerald-500/10 text-emerald-600",
                issue.status === "in_progress" && "bg-blue-500/10 text-blue-600",
                issue.status === "blocked" && "bg-red-500/10 text-red-600",
                !["done", "in_progress", "blocked"].includes(issue.status) && "bg-muted text-muted-foreground",
              )}>
                {issue.status.replace("_", " ")}
              </span>
            </div>
          ))}
          {/* Child goals */}
          {childGoals.map((child) => (
            <GoalTreeNode
              key={child.id}
              goal={child}
              progress={progressMap.get(child.id)}
              childGoals={allGoals.filter((g) => g.parentId === child.id)}
              allGoals={allGoals}
              progressMap={progressMap}
              issuesByGoal={issuesByGoal}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Goals Page                                                    */
/* ------------------------------------------------------------------ */

/* ── Timeline / Gantt View ── */

function GoalGanttView({
  goals,
  progressMap,
  childrenMap,
}: {
  goals: Goal[];
  progressMap: Map<string, GoalProgressItem>;
  childrenMap: Map<string, Goal[]>;
}) {
  // Determine date range across all goals
  const allDates = goals.flatMap((g) => {
    const dates: number[] = [new Date(g.createdAt).getTime()];
    if (g.targetDate) dates.push(new Date(g.targetDate).getTime());
    return dates;
  });
  if (allDates.length === 0) return <p className="text-sm text-muted-foreground">No goals with dates for timeline.</p>;

  const minDate = Math.min(...allDates);
  const maxDate = Math.max(...allDates, Date.now() + 30 * 24 * 60 * 60 * 1000);
  const range = maxDate - minDate || 1;
  const nowPct = ((Date.now() - minDate) / range) * 100;

  // Build month markers
  const startMonth = new Date(minDate);
  startMonth.setDate(1);
  const months: Array<{ label: string; pct: number }> = [];
  const d = new Date(startMonth);
  while (d.getTime() <= maxDate) {
    const pct = ((d.getTime() - minDate) / range) * 100;
    if (pct >= 0 && pct <= 100) {
      months.push({ label: d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }), pct });
    }
    d.setMonth(d.getMonth() + 1);
  }

  return (
    <div className="space-y-1">
      {/* Month header */}
      <div className="relative h-6 border-b border-border mb-2">
        {months.map((m, i) => (
          <span
            key={i}
            className="absolute text-[9px] text-muted-foreground/60 -translate-x-1/2"
            style={{ left: `${m.pct}%`, top: 0 }}
          >
            {m.label}
          </span>
        ))}
        {/* Today marker */}
        <div
          className="absolute top-0 bottom-0 w-px bg-blue-500/50"
          style={{ left: `${nowPct}%` }}
          title="Today"
        />
      </div>

      {/* Goal bars */}
      {goals.map((goal) => {
        const startPct = ((new Date(goal.createdAt).getTime() - minDate) / range) * 100;
        const endPct = goal.targetDate
          ? ((new Date(goal.targetDate).getTime() - minDate) / range) * 100
          : Math.min(100, startPct + 15);
        const width = Math.max(2, endPct - startPct);
        const progress = progressMap.get(goal.id);
        const percent = progress?.progressPercent ?? 0;
        const health = resolveGoalHealth(goal, progress);
        const barColor = health === "on_track" ? "bg-emerald-500" : health === "at_risk" ? "bg-amber-500" : health === "off_track" ? "bg-red-500" : "bg-muted-foreground/30";
        const children = childrenMap.get(goal.id);

        return (
          <div key={goal.id} className="group">
            <div className="flex items-center gap-2 h-8">
              <Link
                to={`/goals/${goal.id}`}
                className="w-[160px] shrink-0 text-xs font-medium truncate hover:underline no-underline text-inherit"
                title={goal.title}
              >
                {goal.title}
              </Link>
              <div className="flex-1 relative h-5">
                {/* Background track */}
                <div className="absolute inset-y-0 left-0 right-0 bg-muted/20 rounded" />
                {/* Goal bar */}
                <div
                  className={cn("absolute top-0.5 bottom-0.5 rounded", barColor, "opacity-40")}
                  style={{ left: `${startPct}%`, width: `${width}%` }}
                />
                {/* Progress fill */}
                <div
                  className={cn("absolute top-0.5 bottom-0.5 rounded", barColor)}
                  style={{ left: `${startPct}%`, width: `${width * (percent / 100)}%` }}
                />
                {/* Dependency lines to children */}
                {children && children.length > 0 && (
                  <div
                    className="absolute bottom-0 w-px bg-muted-foreground/20 h-2"
                    style={{ left: `${startPct + width / 2}%` }}
                  />
                )}
              </div>
              <span className="w-10 text-right text-[10px] text-muted-foreground tabular-nums shrink-0">{Math.round(percent)}%</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Quarterly OKR Cycle Banner ── */

function getQuarterInfo(): { quarter: number; daysRemaining: number; endDate: Date } | null {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based

  // Quarter boundaries: Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec
  const quarterEnd = month < 3
    ? new Date(year, 3, 1) // Apr 1
    : month < 6
      ? new Date(year, 6, 1) // Jul 1
      : month < 9
        ? new Date(year, 9, 1) // Oct 1
        : new Date(year + 1, 0, 1); // Jan 1 next year

  const quarter = Math.floor(month / 3) + 1;
  const msRemaining = quarterEnd.getTime() - now.getTime();
  const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));

  if (daysRemaining > 14) return null; // Only show in last 2 weeks

  return { quarter, daysRemaining, endDate: quarterEnd };
}

function QuarterEndBanner({ inProgressCount }: { inProgressCount: number }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      const val = localStorage.getItem("ironworks:quarter-banner-dismissed");
      if (!val) return false;
      // Auto-reset dismissal if it was for a previous quarter
      const parsed = JSON.parse(val);
      const now = new Date();
      const currentQ = `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
      return parsed === currentQ;
    } catch {
      return false;
    }
  });

  const info = getQuarterInfo();
  if (!info || dismissed) return null;

  const dismiss = () => {
    const now = new Date();
    const currentQ = `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
    try { localStorage.setItem("ironworks:quarter-banner-dismissed", JSON.stringify(currentQ)); } catch {}
    setDismissed(true);
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5">
      <CalendarRange className="h-4 w-4 text-amber-500 shrink-0" />
      <p className="text-xs text-amber-700 dark:text-amber-300 flex-1">
        Q{info.quarter} ends in {info.daysRemaining} day{info.daysRemaining !== 1 ? "s" : ""}.
        {inProgressCount > 0 && <> {inProgressCount} goal{inProgressCount !== 1 ? "s are" : " is"} still in progress. Consider reviewing and closing out the quarter.</>}
      </p>
      <button
        onClick={dismiss}
        className="text-xs text-amber-600 dark:text-amber-400 hover:underline shrink-0"
      >
        Dismiss
      </button>
    </div>
  );
}

type GoalSortField = "title" | "progress" | "updated";
type GoalStatusFilter = "all" | "planned" | "active" | "achieved" | "cancelled";
type ViewMode = "list" | "tree" | "timeline";

export function Goals() {
  usePageTitle("Goals");
  const { selectedCompanyId } = useCompany();
  const { openNewGoal } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<GoalStatusFilter>("all");
  const [sortField, setSortField] = useState<GoalSortField>("updated");
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
  }, [setBreadcrumbs]);

  const { data: goals, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Fetch progress for all goals
  const { data: progressData } = useQuery({
    queryKey: ["goals", "progress", selectedCompanyId],
    queryFn: () => goalProgressApi.batch(selectedCompanyId!),
    enabled: !!selectedCompanyId && goals !== undefined,
  });

  const progressMap = useMemo(() => {
    const map = new Map<string, GoalProgressItem>();
    for (const p of progressData ?? []) {
      map.set(p.goalId, p);
    }
    return map;
  }, [progressData]);

  // Filter, search, sort root goals
  const rootGoals = useMemo(() => {
    let filtered = (goals ?? []).filter((g) => !g.parentId);
    if (statusFilter !== "all") filtered = filtered.filter((g) => g.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter((g) => g.title.toLowerCase().includes(q) || g.description?.toLowerCase().includes(q));
    }
    filtered.sort((a, b) => {
      if (sortField === "title") return a.title.localeCompare(b.title);
      if (sortField === "progress") {
        const pa = progressMap.get(a.id)?.progressPercent ?? 0;
        const pb = progressMap.get(b.id)?.progressPercent ?? 0;
        return pb - pa;
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    return filtered;
  }, [goals, statusFilter, search, sortField, progressMap]);

  const childrenMap = useMemo(() => {
    const map = new Map<string, Goal[]>();
    for (const g of goals ?? []) {
      if (g.parentId) {
        const children = map.get(g.parentId) ?? [];
        children.push(g);
        map.set(g.parentId, children);
      }
    }
    return map;
  }, [goals]);

  // For tree view: fetch issues linked to goals
  const { data: allIssues } = useQuery({
    queryKey: ["goals", "issues-for-tree", selectedCompanyId],
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && viewMode === "tree",
    staleTime: 30_000,
  });

  const issuesByGoal = useMemo(() => {
    const map = new Map<string, Array<{ id: string; title: string; status: string; identifier: string | null }>>();
    for (const issue of allIssues ?? []) {
      if (issue.goalId) {
        const arr = map.get(issue.goalId) ?? [];
        arr.push({ id: issue.id, title: issue.title, status: issue.status, identifier: issue.identifier ?? null });
        map.set(issue.goalId, arr);
      }
    }
    return map;
  }, [allIssues]);

  // Summary stats
  const totalGoals = goals?.length ?? 0;
  const activeGoals = (goals ?? []).filter((g) => g.status === "active").length;
  const achievedGoals = (goals ?? []).filter((g) => g.status === "achieved").length;

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select a company to view goals." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (error) {
    return (
      <EmptyState
        icon={Target}
        message={`Failed to load goals: ${error instanceof Error ? error.message : "Unknown error"}`}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Goals</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Set objectives and track progress as your agents deliver results.
          </p>
          {totalGoals > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {activeGoals} active · {achievedGoals} achieved · {totalGoals} total
            </p>
          )}
        </div>
        <Button size="sm" onClick={() => openNewGoal()}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Create Goal
        </Button>
      </div>

      {/* Quarterly OKR cycle hint */}
      {totalGoals > 0 && (
        <QuarterEndBanner inProgressCount={activeGoals} />
      )}

      {/* Cascade summary banner */}
      {totalGoals > 0 && progressData && (
        <CascadeSummaryBanner goals={goals ?? []} progressMap={progressMap} />
      )}

      {/* Toolbar */}
      {totalGoals > 0 && (
        <div className="flex items-center justify-between gap-2">
          <div className="relative w-48 sm:w-64 md:w-80">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search goals..."
              className="pl-7 text-xs sm:text-sm"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as GoalStatusFilter)}>
              <SelectTrigger className="h-8 w-auto min-w-[120px] text-xs">
                <Filter className="h-3 w-3 mr-1" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="planned">Planned</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="achieved">Achieved</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortField} onValueChange={(v) => setSortField(v as GoalSortField)}>
              <SelectTrigger className="h-8 w-auto min-w-[120px] text-xs">
                <ArrowUpDown className="h-3 w-3 mr-1" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updated">Last updated</SelectItem>
                <SelectItem value="progress">Progress</SelectItem>
                <SelectItem value="title">Title</SelectItem>
              </SelectContent>
            </Select>
            {/* View mode toggle */}
            <div className="flex items-center rounded-md border border-border overflow-hidden">
              <button
                className={cn(
                  "flex items-center justify-center h-8 w-8 transition-colors",
                  viewMode === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
                )}
                onClick={() => setViewMode("list")}
                title="List view"
              >
                <LayoutList className="h-3.5 w-3.5" />
              </button>
              <button
                className={cn(
                  "flex items-center justify-center h-8 w-8 transition-colors",
                  viewMode === "tree" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
                )}
                onClick={() => setViewMode("tree")}
                title="Tree view"
              >
                <Network className="h-3.5 w-3.5" />
              </button>
              <button
                className={cn(
                  "flex items-center justify-center h-8 w-8 transition-colors",
                  viewMode === "timeline" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
                )}
                onClick={() => setViewMode("timeline")}
                title="Timeline view"
              >
                <CalendarRange className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {totalGoals === 0 && (
        <EmptyState
          icon={Target}
          message="Goals track what your agents are working toward. Create a goal, then add issues or run a playbook to break it into tasks."
          action="Create Goal"
          onAction={() => openNewGoal()}
        />
      )}

      {/* Goal cards / tree */}
      {rootGoals.length > 0 && viewMode === "list" && (
        <div className="space-y-3">
          {rootGoals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              progress={progressMap.get(goal.id)}
              children={childrenMap.get(goal.id)}
            />
          ))}
        </div>
      )}

      {rootGoals.length > 0 && viewMode === "tree" && (
        <div className="space-y-3">
          {rootGoals.map((goal) => (
            <GoalTreeNode
              key={goal.id}
              goal={goal}
              progress={progressMap.get(goal.id)}
              childGoals={childrenMap.get(goal.id) ?? []}
              allGoals={goals ?? []}
              progressMap={progressMap}
              issuesByGoal={issuesByGoal}
              depth={0}
            />
          ))}
        </div>
      )}

      {rootGoals.length > 0 && viewMode === "timeline" && (
        <div className="rounded-lg border border-border p-4 overflow-x-auto">
          <GoalGanttView
            goals={rootGoals}
            progressMap={progressMap}
            childrenMap={childrenMap}
          />
        </div>
      )}
    </div>
  );
}
