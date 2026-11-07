import { useTranslation } from "@/i18n";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { GoalTree } from "../components/GoalTree";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { QueryErrorState, useQueryView } from "../components/QueryView";
import { Button } from "@/components/ui/button";
import { Target, Plus } from "lucide-react";

export function Goals() {
  const { t } = useTranslation("work");
  const { selectedCompanyId } = useCompany();
  const { openNewGoal } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: t("work:copy.goals_116cd3") }]);
  }, [setBreadcrumbs, t]);

  const goalsQuery = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: goals, isLoading } = goalsQuery;
  const goalsView = useQueryView(goalsQuery);

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message={t("work:copy.selectAnOrganizationToViewGoals_bdca2f")} />;
  }

  // Keep a loaded list on screen through a failed refetch; only a real
  // failure, or an outage before the first load, replaces the page.
  if (isLoading || goalsView.kind === "reconnecting") {
    return <PageSkeleton variant="list" />;
  }
  if (goalsView.kind === "error") {
    return (
      <QueryErrorState
        size="page"
        error={goalsView.error}
        action={t("work:copy.loadGoals_44eeef")}
        onRetry={goalsView.retry}
        retrying={goalsView.isFetching}
      />
    );
  }

  return (
    <div className="space-y-4">
      {goals && goals.length === 0 && (
        <EmptyState
          icon={Target}
          message={t("work:copy.noGoalsYet_347e65")}
          action={t("work:copy.addGoal_e1f033")}
          onAction={() => openNewGoal()}
        />
      )}

      {goals && goals.length > 0 && (
        <>
          <div className="flex items-center justify-start">
            <Button size="sm" variant="outline" onClick={() => openNewGoal()}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />{t("work:copy.newGoal_9d2b5d")}</Button>
          </div>
          <GoalTree goals={goals} goalLink={(goal) => `/goals/${goal.id}`} />
        </>
      )}
    </div>
  );
}
