import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpDown,
  CheckCircle2,
  Circle,
  Clock,
  Filter,
  Loader2,
  Plus,
  Search,
  ShieldAlert,
  Target,
  Users,
} from "lucide-react";
import type { Goal } from "@ironworksai/shared";
import { goalsApi } from "../api/goals";
import { goalProgressApi, type GoalProgressItem } from "../api/goalProgress";
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
    <div className={cn("w-full bg-muted rounded-full overflow-hidden", size === "sm" ? "h-1.5" : "h-2")}>
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300",
          clamped === 100
            ? "bg-emerald-500"
            : clamped > 50
              ? "bg-blue-500"
              : clamped > 0
                ? "bg-amber-500"
                : "bg-muted",
        )}
        style={{ width: `${clamped}%` }}
      />
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

  return (
    <Link
      to={`/goals/${goal.id}`}
      className="block border border-border rounded-lg p-4 hover:bg-accent/30 transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold truncate">{goal.title}</h3>
            <StatusBadge status={goal.status} />
            {(goal as Goal & { targetDate?: string | null }).targetDate && (
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full shrink-0",
                new Date((goal as Goal & { targetDate?: string | null }).targetDate!) < new Date()
                  ? "bg-red-500/10 text-red-600 dark:text-red-400"
                  : "bg-muted text-muted-foreground",
              )}>
                {new Date((goal as Goal & { targetDate?: string | null }).targetDate!).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            )}
          </div>
          {goal.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{goal.description}</p>
          )}
        </div>
        {totalIssues > 0 && (
          <div className="text-right shrink-0">
            <span className="text-lg font-semibold tabular-nums">{Math.round(percent)}%</span>
            <div className="text-[10px] text-muted-foreground">{completed}/{totalIssues} done</div>
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
          No tasks yet — click to add issues or run a playbook
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
/*  Main Goals Page                                                    */
/* ------------------------------------------------------------------ */

type GoalSortField = "title" | "progress" | "updated";
type GoalStatusFilter = "all" | "planned" | "active" | "achieved" | "cancelled";

export function Goals() {
  const { selectedCompanyId } = useCompany();
  const { openNewGoal } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<GoalStatusFilter>("all");
  const [sortField, setSortField] = useState<GoalSortField>("updated");

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
          <h1 className="text-2xl font-semibold tracking-tight">Goals</h1>
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
          </div>
        </div>
      )}

      {/* Empty state */}
      {totalGoals === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="bg-muted/50 p-4 mb-4 rounded-full">
            <Target className="h-10 w-10 text-muted-foreground/50" />
          </div>
          <h3 className="text-sm font-medium mb-1">No goals yet</h3>
          <p className="text-xs text-muted-foreground max-w-sm mb-4">
            Goals track what your agents are working toward. Create a goal, then add issues or run a playbook to break it into tasks.
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => openNewGoal()}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Create Goal
            </Button>
          </div>
        </div>
      )}

      {/* Goal cards */}
      {rootGoals.length > 0 && (
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
    </div>
  );
}
