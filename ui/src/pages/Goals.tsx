import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { goalsApi } from "../api/goals";
import { brabrixApi } from "../api/brabrix";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { GoalTree } from "../components/GoalTree";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Target, Plus, Loader2, Link2 } from "lucide-react";

export function Goals() {
  const { selectedCompanyId } = useCompany();
  const { openNewGoal } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
  }, [setBreadcrumbs]);

  const { data: goals, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const syncBrabrixTask = useMutation({
    mutationKey: selectedCompanyId ? queryKeys.brabrix.nextTaskSync(selectedCompanyId) : undefined,
    mutationFn: async () => {
      if (!selectedCompanyId) {
        throw new Error("Select a company before importing Brabrix tasks.");
      }

      const syncResult = await brabrixApi.syncNextTask(selectedCompanyId);
      if (!syncResult.goal) {
        return { syncResult, createdGoal: null };
      }

      const createdGoal = await goalsApi.create(selectedCompanyId, {
        title: syncResult.goal.title,
        description: syncResult.goal.description,
        level: syncResult.goal.level,
        status: syncResult.goal.status,
      });

      return { syncResult, createdGoal };
    },
    onSuccess: async ({ syncResult, createdGoal }) => {
      if (!selectedCompanyId) return;

      if (!syncResult.task || !syncResult.goal) {
        pushToast({
          title: "No Brabrix task available",
          body: "The integration is connected, but there is no pending task to import.",
          tone: "info",
        });
        return;
      }

      await queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(selectedCompanyId) });
      pushToast({
        title: "Brabrix task imported",
        body: createdGoal
          ? `Goal "${createdGoal.title}" was created from task "${syncResult.task.title}".`
          : `Task "${syncResult.task.title}" was fetched from Brabrix.`,
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to import from Brabrix",
        body: err instanceof Error ? err.message : "Unexpected integration error.",
        tone: "error",
      });
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

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => syncBrabrixTask.mutate()}
          disabled={syncBrabrixTask.isPending}
        >
          {syncBrabrixTask.isPending
            ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            : <Link2 className="h-3.5 w-3.5 mr-1.5" />}
          {syncBrabrixTask.isPending ? "Importing..." : "Import from Brabrix"}
        </Button>

        {goals && goals.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => openNewGoal()}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Goal
          </Button>
        )}
      </div>

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
          <GoalTree goals={goals} goalLink={(goal) => `/goals/${goal.id}`} />
        </>
      )}
    </div>
  );
}
