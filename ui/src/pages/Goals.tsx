import { useEffect } from "react";
import { useT } from "../i18n";
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

export function Goals() {
  const { selectedCompanyId } = useCompany();
  const { openNewGoal } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useT();

  useEffect(() => {
    setBreadcrumbs([{ label: t("page.goals.title") }]);
  }, [setBreadcrumbs]);

  const { data: goals, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select a company to view goals." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("page.goals.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("page.goals.description")}
          </p>
        </div>
        <Button onClick={() => openNewGoal()}>
          <Plus className="mr-2 h-4 w-4" />
          {t("action.newGoal")}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {goals && goals.length === 0 && (
        <EmptyState
          icon={Target}
          message={t("empty.noGoals")}
          action={t("action.newGoal")}
          onAction={() => openNewGoal()}
        />
      )}

      {goals && goals.length > 0 && (
        <GoalTree goals={goals} goalLink={(goal) => `/goals/${goal.id}`} />
      )}
    </div>
  );
}
