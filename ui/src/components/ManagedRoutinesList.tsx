import { Button } from "@/components/ui/button";
import {
  RoutineListRow,
  type RoutineListAgentSummary,
  type RoutineListProjectSummary,
  type RoutineListRowItem,
} from "@/components/RoutineList";
import { useTranslation } from "@/i18n";

export type ManagedRoutinesListAgent = {
  id: string;
  name: string;
  icon?: string | null;
};

export type ManagedRoutinesListProject = {
  id: string;
  name: string;
  color?: string | null;
};

export type ManagedRoutineMissingRef = {
  resourceKind: string;
  resourceKey: string;
};

export type ManagedRoutineDefaultDrift = {
  changedFields: string[];
  defaultTitle?: string | null;
  defaultDescription?: string | null;
};

export type ManagedRoutinesListItem = {
  key: string;
  title: string;
  status: string;
  routineId?: string | null;
  href?: string | null;
  resourceKey?: string | null;
  projectId?: string | null;
  assigneeAgentId?: string | null;
  cronExpression?: string | null;
  lastRunAt?: Date | string | null;
  lastRunStatus?: string | null;
  managedByPluginDisplayName?: string | null;
  missingRefs?: ManagedRoutineMissingRef[];
  defaultDrift?: ManagedRoutineDefaultDrift | null;
};

export type ManagedRoutinesListProps = {
  routines: ManagedRoutinesListItem[];
  agents?: ManagedRoutinesListAgent[];
  projects?: ManagedRoutinesListProject[];
  pluginDisplayName?: string | null;
  emptyMessage?: string;
  runningRoutineKey?: string | null;
  statusMutationRoutineKey?: string | null;
  reconcilingRoutineKey?: string | null;
  resettingRoutineKey?: string | null;
  onRunNow?: (routine: ManagedRoutinesListItem) => void;
  onToggleEnabled?: (routine: ManagedRoutinesListItem, enabled: boolean) => void;
  onReconcile?: (routine: ManagedRoutinesListItem) => void;
  onReset?: (routine: ManagedRoutinesListItem) => void;
};

function managedRoutineToRow(routine: ManagedRoutinesListItem): RoutineListRowItem {
  return {
    id: routine.key,
    title: routine.title,
    status: routine.status,
    projectId: routine.projectId ?? null,
    assigneeAgentId: routine.assigneeAgentId ?? null,
    lastRun: routine.lastRunAt || routine.lastRunStatus
      ? {
          triggeredAt: routine.lastRunAt ?? null,
          status: routine.lastRunStatus ?? null,
        }
      : null,
  };
}

export function ManagedRoutinesList({
  routines,
  agents = [],
  projects = [],
  pluginDisplayName = null,
  emptyMessage,
  runningRoutineKey = null,
  statusMutationRoutineKey = null,
  reconcilingRoutineKey = null,
  resettingRoutineKey = null,
  onRunNow,
  onToggleEnabled,
  onReconcile,
  onReset,
}: ManagedRoutinesListProps) {
  const { t } = useTranslation();
  const resolvedEmptyMessage =
    emptyMessage ??
    t("components.managedRoutinesList.emptyMessage", { defaultValue: "No managed routines." });
  const agentById = new Map<string, RoutineListAgentSummary>(
    agents.map((agent) => [agent.id, { name: agent.name, icon: agent.icon }]),
  );
  const projectById = new Map<string, RoutineListProjectSummary>(
    projects.map((project) => [project.id, { name: project.name, color: project.color }]),
  );

  if (routines.length === 0) {
    return (
      <div className="rounded-lg border border-border px-3 py-8 text-center text-sm text-muted-foreground">
        {resolvedEmptyMessage}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      {routines.map((routine) => {
        const row = managedRoutineToRow(routine);
        const href = routine.href ?? (routine.routineId ? `/routines/${routine.routineId}` : "/routines");
        const missingRefs = routine.missingRefs ?? [];
        const canUseRoutine = Boolean(routine.routineId && routine.resourceKey && missingRefs.length === 0);
        const managedBy = routine.managedByPluginDisplayName ?? pluginDisplayName;
        const hasRepairActions = Boolean(onReconcile || onReset);

        return (
          <div key={routine.key} className="last:[&_a]:border-b-0">
            <RoutineListRow
              routine={row}
              projectById={projectById}
              agentById={agentById}
              runningRoutineId={runningRoutineKey}
              statusMutationRoutineId={statusMutationRoutineKey}
              href={href}
              configureLabel={t("components.managedRoutinesList.configure", {
                defaultValue: "Configure",
              })}
              managedByLabel={
                managedBy
                  ? t("components.managedRoutinesList.managedBy", {
                      name: managedBy,
                      defaultValue: "Managed by {{name}}",
                    })
                  : null
              }
              runNowButton
              hideArchiveAction
              disableRunNow={!canUseRoutine}
              disableToggle={!canUseRoutine}
              secondaryDetails={
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {routine.resourceKey ? <span>{routine.resourceKey}</span> : null}
                  {routine.cronExpression ? (
                    <span>
                      {t("components.managedRoutinesList.schedule", {
                        expression: routine.cronExpression,
                        defaultValue: "Schedule {{expression}}",
                      })}
                    </span>
                  ) : null}
                </span>
              }
              onRunNow={() => onRunNow?.(routine)}
              onToggleEnabled={() => onToggleEnabled?.(routine, row.status === "active")}
            />
            {hasRepairActions ? (
              <div
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 pb-3 text-xs text-muted-foreground last:border-b-0"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                <span>
                  {missingRefs.length
                    ? t("components.managedRoutinesList.missingRefs", {
                        refs: missingRefs
                          .map((ref) => `${ref.resourceKind}:${ref.resourceKey}`)
                          .join(", "),
                        defaultValue: "Missing {{refs}}",
                      })
                    : t("components.managedRoutinesList.defaultsRepairable", {
                        defaultValue: "Routine defaults can be repaired.",
                      })}
                </span>
                <span className="flex items-center gap-2">
                  {onReconcile ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={reconcilingRoutineKey === routine.key}
                      onClick={() => onReconcile(routine)}
                    >
                      {reconcilingRoutineKey === routine.key
                        ? t("components.managedRoutinesList.reconciling", {
                            defaultValue: "Reconciling...",
                          })
                        : t("components.managedRoutinesList.reconcile", {
                            defaultValue: "Reconcile",
                          })}
                    </Button>
                  ) : null}
                  {onReset ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={resettingRoutineKey === routine.key}
                      onClick={() => onReset(routine)}
                    >
                      {resettingRoutineKey === routine.key
                        ? t("components.managedRoutinesList.resetting", {
                            defaultValue: "Resetting...",
                          })
                        : t("components.managedRoutinesList.reset", {
                            defaultValue: "Reset",
                          })}
                    </Button>
                  ) : null}
                </span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
