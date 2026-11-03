import { i18n, useTranslation } from "@/i18n";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity as ActivityIcon } from "lucide-react";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { routineDetailHref } from "../RoutineContextualSidebar";
import { createIssueDetailLocationState } from "@/lib/issueDetailBreadcrumb";
import { useToastActions } from "@/context/ToastContext";
import { IssuesList } from "../IssuesList";
import { EmptyState } from "../EmptyState";
import { RoutineHistoryTab } from "../RoutineHistoryTab";
import { RoutineActivityRow } from "../RoutineActivityRow";
import { useRoutineDetail } from "./context";

export function RunsSection() {
  const { t } = useTranslation();
  const { routine, companyId, agents, projects, hasLiveRun, activeIssueId } = useRoutineDetail();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const filters = { originKind: "routine_execution", originId: routine.id };
  const issueQueryKey = [...queryKeys.issues.list(companyId), "routine", routine.id];
  const { data: issues, isLoading, error } = useQuery({
    queryKey: issueQueryKey,
    queryFn: () => issuesApi.list(companyId, filters),
  });
  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => issuesApi.update(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routine.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.routines.runs(routine.id) });
    },
    onError: (updateError) => pushToast({ title: t("sep28Routines.updateTaskError"), body: updateError.message, tone: "error" }),
  });

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error}
      agents={agents}
      projects={projects}
      liveIssueIds={new Set(hasLiveRun && activeIssueId ? [activeIssueId] : [])}
      viewStateKey={`paperclip:routine-runs:${companyId}:${routine.id}`}
      searchFilters={filters}
      issueLinkState={createIssueDetailLocationState(t("localizationRoutines.runs"), routineDetailHref(routine.id, "runs"))}
      rowPresentation="task"
      toolbarPresentation="collection"
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}

export function ActivitySection({ isLoading = false, error }: { isLoading?: boolean; error?: Error | null } = {}) {
  const { t } = useTranslation();
  const ctx = useRoutineDetail();
  const { activity } = ctx;
  const events = activity ?? [];

  const groups = useMemo(() => {
    const byDay = new Map<string, typeof events>();
    for (const event of events) {
      let label = t("localizationRoutines.earlier");
      try {
        label = new Date(event.createdAt).toLocaleDateString(i18n.language, {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
      } catch {
        /* keep fallback label */
      }
      const bucket = byDay.get(label) ?? [];
      bucket.push(event);
      byDay.set(label, bucket);
    }
    return Array.from(byDay.entries());
  }, [events, t]);

  if (isLoading) return <p className="text-sm text-muted-foreground">{t("sep28Routines.loadingActivity")}</p>;
  if (error) return <p role="alert" className="text-sm text-destructive">{error.message}</p>;

  if (events.length === 0) {
    return <EmptyState icon={ActivityIcon} message={t("localizationRoutines.noActivity")} />;
  }

  return (
    <div className="space-y-4">
      {groups.map(([day, dayEvents]) => (
        <div key={day}>
          <div className="sticky top-0 bg-background py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {day}
          </div>
          <div>
            {dayEvents.map((event) => (
              <RoutineActivityRow key={event.id} event={event} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function HistorySection() {
  useTranslation();
  const ctx = useRoutineDetail();
  const {
    routine,
    isEditDirty,
    dirtyFields,
    routineDefaults,
    setEditDraft,
    saveRoutine,
    agentById,
    projectById,
    availableSecrets,
    onHistoryRestoreSecretMaterials,
    onHistoryRestored,
  } = ctx;

  return (
    <RoutineHistoryTab
      routine={routine}
      isEditDirty={isEditDirty}
      dirtyFields={dirtyFields}
      onDiscardEdits={() => setEditDraft(routineDefaults)}
      onSaveEdits={() => {
        if (!saveRoutine.isPending && routine.title.trim()) {
          saveRoutine.mutate();
        }
      }}
      agents={agentById}
      projects={projectById}
      secrets={availableSecrets}
      onRestoreSecretMaterials={onHistoryRestoreSecretMaterials}
      onRestored={onHistoryRestored}
    />
  );
}
