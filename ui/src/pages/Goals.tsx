import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  const queryClient = useQueryClient();
  const [deleteErrorMessage, setDeleteErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
  }, [setBreadcrumbs]);

  const { data: goals, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const deleteGoal = useMutation({
    mutationFn: (id: string) => goalsApi.remove(id),
    onSuccess: () => {
      setDeleteErrorMessage(null);
      if (selectedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.list(selectedCompanyId),
        });
      }
    },
    onError: (err) => {
      setDeleteErrorMessage(err instanceof Error ? err.message : "Failed to delete goal");
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select a company to view goals." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {deleteErrorMessage && (
        <p className="text-sm text-destructive" role="alert">
          {deleteErrorMessage}
        </p>
      )}

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
            <Button size="sm" variant="outline" onClick={() => openNewGoal()}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Goal
            </Button>
          </div>
          <GoalTree
            goals={goals}
            goalLink={(goal) => `/goals/${goal.id}`}
            onDelete={(goal) => {
              if (window.confirm(`Delete goal "${goal.title}"?`)) {
                deleteGoal.mutate(goal.id);
              }
            }}
          />
        </>
      )}
    </div>
  );
}

