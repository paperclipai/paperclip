import { useEffect, useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { GoalTree } from "../components/GoalTree";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Target, Plus } from "lucide-react";
import type { GoalStatus } from "@paperclipai/shared";

type GoalFilter = "all" | GoalStatus;

const FILTER_OPTIONS: { value: GoalFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "planned", label: "Planned" },
  { value: "achieved", label: "Achieved" },
];

export function Goals() {
  const { selectedCompanyId } = useCompany();
  const { openNewGoal } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [statusFilter, setStatusFilter] = useState<GoalFilter>(() => {
    try {
      const saved = localStorage.getItem("goals:statusFilter");
      return (saved === "all" || saved === "active" || saved === "planned" || saved === "achieved" || saved === "cancelled")
        ? (saved as GoalFilter)
        : "active";
    } catch {
      return "active";
    }
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
  }, [setBreadcrumbs]);

  const { data: goals, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const statusCounts = useMemo(() => {
    const all = goals ?? [];
    return {
      all: all.length,
      active: all.filter((g) => g.status === "active").length,
      planned: all.filter((g) => g.status === "planned").length,
      achieved: all.filter((g) => g.status === "achieved").length,
    };
  }, [goals]);

  const filteredGoals = useMemo(() => {
    if (!goals) return [];
    if (statusFilter === "all") return goals;
    return goals.filter((g) => g.status === statusFilter);
  }, [goals, statusFilter]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select a company to view goals." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const handleFilter = (filter: GoalFilter) => {
    setStatusFilter(filter);
    try {
      localStorage.setItem("goals:statusFilter", filter);
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {goals && goals.length === 0 && (
        <EmptyState
          icon={Target}
          message="No goals yet."
          action="Add Goal"
          onAction={() => openNewGoal()}
        />
      )}

      {goals && goals.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <div className="flex flex-wrap gap-1">
              {FILTER_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => handleFilter(value)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    statusFilter === value
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  {label}
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                    statusFilter === value
                      ? "bg-background/20 text-background"
                      : "bg-muted text-muted-foreground"
                  }`}>
                    {statusCounts[value as keyof typeof statusCounts] ?? statusCounts.all}
                  </span>
                </button>
              ))}
            </div>
            <Button size="sm" variant="outline" onClick={() => openNewGoal()}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Goal
            </Button>
          </div>

          {filteredGoals.length === 0 ? (
            <EmptyState
              icon={Target}
              message={`No ${statusFilter === "all" ? "" : statusFilter} goals.`}
            />
          ) : (
            <GoalTree goals={filteredGoals} goalLink={(goal) => `/goals/${goal.id}`} />
          )}
        </>
      )}
    </div>
  );
}
