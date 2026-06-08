import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { GoalTree } from "../components/GoalTree";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Target, Plus } from "lucide-react";

export function Goals() {
  const { selectedCompanyId } = useCompany();
  const { openNewGoal } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
  }, [setBreadcrumbs]);

  const { data: goals, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Progress-at-a-glance summary (goal statuses: planned/active/achieved/cancelled).
  const summary = useMemo(() => {
    let achieved = 0, active = 0, planned = 0;
    for (const g of goals ?? []) {
      if (g.status === "achieved") achieved++;
      else if (g.status === "active") active++;
      else if (g.status === "planned") planned++;
    }
    return { achieved, active, planned };
  }, [goals]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select a company to view goals." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-2xl font-medium tracking-tight">Goals</h1>
        {goals && goals.length > 0 && (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
            <span>
              <span className="font-mono text-foreground">{goals.length}</span>{" "}
              {goals.length === 1 ? "goal" : "goals"}
            </span>
            {[
              { n: summary.achieved, label: "achieved", dot: "bg-status-success" },
              { n: summary.active, label: "in progress", dot: "bg-status-running" },
              { n: summary.planned, label: "planned", dot: "bg-muted-foreground/50" },
            ]
              .filter((s) => s.n > 0)
              .map((s) => (
                <span key={s.label} className="inline-flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
                  <span className="font-mono font-medium text-foreground">{s.n}</span> {s.label}
                </span>
              ))}
          </p>
        )}
      </div>

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
          <div className="flex items-center justify-start">
            <Button size="sm" onClick={() => openNewGoal()}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Goal
            </Button>
          </div>
          <GoalTree goals={goals} goalLink={(goal) => `/goals/${goal.id}`} />
        </>
      )}
    </div>
  );
}
