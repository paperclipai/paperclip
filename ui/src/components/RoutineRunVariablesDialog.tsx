import { t, useTranslation, Trans } from "@/i18n";
import { useWorkspaceIsolationControls } from "@/hooks/useWorkspaceIsolationControls";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  WORKSPACE_BRANCH_ROUTINE_VARIABLE,
  type Agent,
  type ExecutionWorkspace,
  type ExecutionWorkspaceMode,
  type IssueExecutionWorkspaceSettings,
  type Project,
  type RoutineVariable,
} from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { IssueWorkspaceCard } from "./IssueWorkspaceCard";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "../lib/recent-projects";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

function buildInitialValues(variables: RoutineVariable[]) {
  return Object.fromEntries(variables.map((variable) => [variable.name, variable.defaultValue ?? ""]));
}

function buildInitialRunSelection(input: {
  defaultAssigneeAgentId?: string | null;
  defaultProjectId?: string | null;
}) {
  return {
    assigneeAgentId: input.defaultAssigneeAgentId ?? "",
    projectId: input.defaultProjectId ?? "",
  };
}

function defaultProjectWorkspaceIdForProject(project: Project | null | undefined) {
  if (!project) return null;
  return project.executionWorkspacePolicy?.defaultProjectWorkspaceId
    ?? project.workspaces?.find((workspace) => workspace.isPrimary)?.id
    ?? project.workspaces?.[0]?.id
    ?? null;
}

function defaultExecutionWorkspaceModeForProject(project: Project | null | undefined): ExecutionWorkspaceMode {
  const defaultMode = project?.executionWorkspacePolicy?.enabled ? project.executionWorkspacePolicy.defaultMode : null;
  if (
    defaultMode === "isolated_workspace" ||
    defaultMode === "operator_branch" ||
    defaultMode === "adapter_default"
  ) {
    return defaultMode === "adapter_default" ? "agent_default" : defaultMode;
  }
  return "shared_workspace";
}

function issueModeForExistingWorkspace(mode: string | null | undefined): ExecutionWorkspaceMode {
  if (mode === "isolated_workspace" || mode === "operator_branch" || mode === "shared_workspace") return mode;
  if (mode === "adapter_managed" || mode === "cloud_sandbox") return "agent_default";
  return "shared_workspace";
}

function issueWorkspacePreferenceFromDraft(value: unknown, fallback: ExecutionWorkspaceMode): ExecutionWorkspaceMode {
  if (
    value === "inherit" ||
    value === "shared_workspace" ||
    value === "isolated_workspace" ||
    value === "operator_branch" ||
    value === "reuse_existing" ||
    value === "agent_default"
  ) {
    return value;
  }
  return fallback;
}

type RoutineRunWorkspaceConfig = {
  executionWorkspaceId: string | null;
  executionWorkspacePreference: ExecutionWorkspaceMode;
  executionWorkspaceSettings: IssueExecutionWorkspaceSettings;
  projectWorkspaceId: string | null;
};

function buildInitialWorkspaceConfig(
  project: Project | null | undefined,
  defaultExecutionWorkspace?: ExecutionWorkspace | null,
): RoutineRunWorkspaceConfig {
  if (defaultExecutionWorkspace && defaultExecutionWorkspace.projectId === project?.id) {
    return {
      executionWorkspaceId: defaultExecutionWorkspace.id,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: issueModeForExistingWorkspace(defaultExecutionWorkspace.mode),
      },
      projectWorkspaceId: defaultExecutionWorkspace.projectWorkspaceId ?? defaultProjectWorkspaceIdForProject(project),
    };
  }

  const defaultMode = defaultExecutionWorkspaceModeForProject(project);
  return {
    executionWorkspaceId: null as string | null,
    executionWorkspacePreference: defaultMode,
    executionWorkspaceSettings: { mode: defaultMode },
    projectWorkspaceId: defaultProjectWorkspaceIdForProject(project),
  };
}

function workspaceConfigEquals(
  a: RoutineRunWorkspaceConfig,
  b: RoutineRunWorkspaceConfig,
) {
  return a.executionWorkspaceId === b.executionWorkspaceId
    && a.executionWorkspacePreference === b.executionWorkspacePreference
    && a.projectWorkspaceId === b.projectWorkspaceId
    && JSON.stringify(a.executionWorkspaceSettings ?? null) === JSON.stringify(b.executionWorkspaceSettings ?? null);
}

function applyWorkspaceDraft(
  current: RoutineRunWorkspaceConfig,
  data: Record<string, unknown>,
) {
  const next = {
    ...current,
    executionWorkspaceId: (data.executionWorkspaceId as string | null | undefined) ?? null,
    executionWorkspacePreference: issueWorkspacePreferenceFromDraft(
      data.executionWorkspacePreference,
      current.executionWorkspacePreference,
    ),
    executionWorkspaceSettings:
      (data.executionWorkspaceSettings as IssueExecutionWorkspaceSettings | null | undefined)
      ?? current.executionWorkspaceSettings,
  };
  return workspaceConfigEquals(current, next) ? current : next;
}

function isMissingRequiredValue(value: unknown) {
  return value == null || (typeof value === "string" && value.trim().length === 0);
}

function shouldUseDateInput(variable: RoutineVariable) {
  return variable.type === "date";
}

function supportsRoutineRunWorkspaceSelection(
  project: Project | null | undefined,
  isolatedWorkspacesEnabled: boolean,
) {
  return isolatedWorkspacesEnabled && Boolean(project?.executionWorkspacePolicy?.enabled);
}

export function routineRunNeedsConfiguration(input: {
  variables: RoutineVariable[];
  project: Project | null | undefined;
  isolatedWorkspacesEnabled: boolean;
}) {
  return input.variables.length > 0
    || supportsRoutineRunWorkspaceSelection(input.project, input.isolatedWorkspacesEnabled);
}

export interface RoutineRunDialogSubmitData {
  variables?: Record<string, string | number | boolean>;
  assigneeAgentId?: string | null;
  projectId?: string | null;
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: IssueExecutionWorkspaceSettings | null;
}

export function RoutineRunVariablesDialog({
  open,
  onOpenChange,
  companyId,
  routineName,
  projects,
  agents,
  defaultProjectId,
  defaultAssigneeAgentId,
  defaultExecutionWorkspace,
  variables,
  isPending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string | null | undefined;
  routineName?: string | null;
  projects: Project[];
  agents: Agent[];
  defaultProjectId?: string | null;
  defaultAssigneeAgentId?: string | null;
  defaultExecutionWorkspace?: ExecutionWorkspace | null;
  variables: RoutineVariable[];
  isPending: boolean;
  onSubmit: (data: RoutineRunDialogSubmitData) => void;
}) {
  useTranslation("task-components");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [selection, setSelection] = useState(() => buildInitialRunSelection({
    defaultAssigneeAgentId,
    defaultProjectId,
  }));
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selection.projectId) ?? null,
    [projects, selection.projectId],
  );
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [open]);
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [open]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () =>
      sortAgentsByRecency(
        agents.filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: agent.id,
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    [agents, recentAssigneeIds],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () => projects.map((project) => ({
      id: project.id,
      label: project.name,
      searchText: project.description ?? "",
    })),
    [projects],
  );
  const currentAssignee = selection.assigneeAgentId
    ? agents.find((agent) => agent.id === selection.assigneeAgentId) ?? null
    : null;
  const [workspaceConfig, setWorkspaceConfig] = useState(() =>
    buildInitialWorkspaceConfig(selectedProject, defaultExecutionWorkspace));
  const [workspaceConfigValid, setWorkspaceConfigValid] = useState(true);
  const [workspaceBranchName, setWorkspaceBranchName] = useState<string | null>(null);

  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  const { visible: workspaceIsolationControlsVisible } = useWorkspaceIsolationControls();
  const workspaceSelectionEnabled = workspaceIsolationControlsVisible && supportsRoutineRunWorkspaceSelection(
    selectedProject,
    experimentalSettings?.enableIsolatedWorkspaces === true,
  );

  useEffect(() => {
    if (!open) return;
    setValues(buildInitialValues(variables));
    const nextSelection = buildInitialRunSelection({ defaultAssigneeAgentId, defaultProjectId });
    setSelection(nextSelection);
    setWorkspaceConfig(buildInitialWorkspaceConfig(
      projects.find((project) => project.id === nextSelection.projectId) ?? null,
      defaultExecutionWorkspace,
    ));
    setWorkspaceConfigValid(true);
    setWorkspaceBranchName(defaultExecutionWorkspace?.branchName ?? null);
  }, [defaultAssigneeAgentId, defaultExecutionWorkspace, defaultProjectId, open, projects, variables]);

  const workspaceBranchAutoValue = workspaceSelectionEnabled
    ? workspaceBranchName
    : defaultExecutionWorkspace?.projectId === selection.projectId
      ? defaultExecutionWorkspace?.branchName ?? null
      : null;

  const isAutoWorkspaceBranchVariable = useCallback(
    (variable: RoutineVariable) =>
      variable.name === WORKSPACE_BRANCH_ROUTINE_VARIABLE && Boolean(workspaceBranchAutoValue),
    [workspaceBranchAutoValue],
  );

  const missingRequired = useMemo(
    () =>
      variables
        .filter((variable) => variable.required)
        .filter((variable) => !isAutoWorkspaceBranchVariable(variable))
        .filter((variable) => isMissingRequiredValue(values[variable.name]))
        .map((variable) => variable.label || variable.name),
    [isAutoWorkspaceBranchVariable, values, variables],
  );

  const workspaceIssue = useMemo(() => ({
    companyId: companyId ?? null,
    projectId: selectedProject?.id ?? null,
    projectWorkspaceId: workspaceConfig.projectWorkspaceId,
    executionWorkspaceId: workspaceConfig.executionWorkspaceId,
    executionWorkspacePreference: workspaceConfig.executionWorkspacePreference,
    executionWorkspaceSettings: workspaceConfig.executionWorkspaceSettings,
    currentExecutionWorkspace:
      workspaceConfig.executionWorkspaceId && workspaceConfig.executionWorkspaceId === defaultExecutionWorkspace?.id
        ? defaultExecutionWorkspace
        : null,
  }), [
    companyId,
    defaultExecutionWorkspace,
    selectedProject?.id,
    workspaceConfig.executionWorkspaceId,
    workspaceConfig.executionWorkspacePreference,
    workspaceConfig.executionWorkspaceSettings,
    workspaceConfig.projectWorkspaceId,
  ]);

  const canSubmit =
    selection.assigneeAgentId.trim().length > 0 &&
    missingRequired.length === 0 &&
    (!workspaceSelectionEnabled || workspaceConfigValid);

  const handleWorkspaceUpdate = useCallback((data: Record<string, unknown>) => {
    setWorkspaceConfig((current) => applyWorkspaceDraft(current, data));
  }, []);

  const handleWorkspaceDraftChange = useCallback((
    data: Record<string, unknown> | null,
    meta: { canSave: boolean; workspaceBranchName?: string | null },
  ) => {
    if (data) {
      setWorkspaceConfig((current) => applyWorkspaceDraft(current, data));
    }
    setWorkspaceConfigValid((current) => (current === meta.canSave ? current : meta.canSave));
    setWorkspaceBranchName((current) => {
      const defaultWorkspaceBranchName = defaultExecutionWorkspace?.branchName ?? null;
      const next = meta.workspaceBranchName
        ?? (data?.executionWorkspaceId === defaultExecutionWorkspace?.id ? defaultWorkspaceBranchName : null)
        ?? null;
      return current === next ? current : next;
    });
  }, [defaultExecutionWorkspace]);

  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent className="flex h-(--sz-calc-18) max-h-(--sz-calc-18) max-w-xl flex-col gap-0 overflow-hidden p-0 sm:h-auto sm:max-h-(--sz-calc-20)">
        <DialogHeader className="shrink-0 border-b border-border/60 px-6 pb-4 pr-12 pt-6">
          {routineName && (
            <p className="text-muted-foreground text-sm">{routineName}</p>
          )}
          <DialogTitle>{t("task-components:runRoutine_1f1580e1")}</DialogTitle>
          <DialogDescription>{t("task-components:chooseTheAgentAndOptionalProjectFor_244cc10d")}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 py-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("task-components:agent_1193d8da")}</Label>
              <InlineEntitySelector
                value={selection.assigneeAgentId}
                options={assigneeOptions}
                recentOptionIds={recentAssigneeIds}
                placeholder={t("task-components:agent_11b39c93")}
                noneLabel={t("final-components-b:RoutineRunVariablesDialog.Select_an_agent_7d4cf0")}
                searchPlaceholder={t("final-components-b:RoutineRunVariablesDialog.Search_agents_32f446")}
                emptyMessage={t("task-components:noAgentsFound_61666542")}
                disablePortal
                openOnFocus={false}
                onChange={(assigneeAgentId) => {
                  if (assigneeAgentId) trackRecentAssignee(assigneeAgentId);
                  setSelection((current) => ({ ...current, assigneeAgentId }));
                }}
                renderTriggerValue={(option) =>
                  option ? (
                    currentAssignee ? (
                      <>
                        <AgentAvatar agent={currentAssignee} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
                        <span className="truncate">{option.label}</span>
                      </>
                    ) : (
                      <span className="truncate">{option.label}</span>
                    )
                  ) : (
                    <span className="text-muted-foreground">{t("task-components:selectAnAgent_7d4cf068")}</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const assignee = agents.find((agent) => agent.id === option.id);
                  return (
                    <>
                      {assignee ? <AgentAvatar agent={assignee} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/> : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("task-components:project_98595978")}</Label>
              <InlineEntitySelector
                value={selection.projectId}
                options={projectOptions}
                recentOptionIds={recentProjectIds}
                placeholder={t("task-components:project_98595978")}
                noneLabel={t("final-components-b:RoutineRunVariablesDialog.No_project_f34c2b")}
                searchPlaceholder={t("task-components:searchProjects_c59dd5a3")}
                emptyMessage={t("task-components:noProjectsFound_26e92309")}
                disablePortal
                openOnFocus={false}
                onChange={(projectId) => {
                  const project = projects.find((entry) => entry.id === projectId) ?? null;
                  if (projectId) trackRecentProject(projectId);
                  setSelection((current) => ({ ...current, projectId }));
                  setWorkspaceConfig(buildInitialWorkspaceConfig(project, defaultExecutionWorkspace));
                  setWorkspaceConfigValid(true);
                  setWorkspaceBranchName(
                    defaultExecutionWorkspace && defaultExecutionWorkspace.projectId === project?.id
                      ? defaultExecutionWorkspace.branchName
                      : null,
                  );
                }}
                renderTriggerValue={(option) =>
                  option && selectedProject ? (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: selectedProject.color ?? "var(--project-none)" }}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">{t("task-components:noProject_f34c2be0")}</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const project = projects.find((entry) => entry.id === option.id);
                  return (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: project?.color ?? "var(--project-none)" }}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
            </div>
          </div>

          {variables.map((variable) => (
            <div key={variable.name} className="space-y-1.5">
              <Label className="text-xs">
                {variable.label || variable.name}
                {variable.required ? " *" : ""}
              </Label>
              {isAutoWorkspaceBranchVariable(variable) ? (
                <Input
                  readOnly
                  disabled
                  value={workspaceBranchAutoValue ?? ""}
                />
              ) : variable.type === "textarea" ? (
                <Textarea
                  rows={4}
                  value={typeof values[variable.name] === "string" ? values[variable.name] as string : ""}
                  onChange={(event) => setValues((current) => ({ ...current, [variable.name]: event.target.value }))}
                />
              ) : variable.type === "boolean" ? (
                <Select
                  value={values[variable.name] === true ? "true" : values[variable.name] === false ? "false" : "__unset__"}
                  onValueChange={(next) => setValues((current) => ({
                    ...current,
                    [variable.name]: next === "__unset__" ? "" : next === "true",
                  }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__unset__">{t("task-components:noValue_4fd0272a")}</SelectItem>
                    <SelectItem value="true">{t("task-components:true_3cbc87c7")}</SelectItem>
                    <SelectItem value="false">{t("task-components:false_60a33e6c")}</SelectItem>
                  </SelectContent>
                </Select>
              ) : variable.type === "select" ? (
                <Select
                  value={typeof values[variable.name] === "string" && values[variable.name] ? values[variable.name] as string : "__unset__"}
                  onValueChange={(next) => setValues((current) => ({
                    ...current,
                    [variable.name]: next === "__unset__" ? "" : next,
                  }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("task-components:chooseAValue_c039634c")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__unset__">{t("task-components:noValue_4fd0272a")}</SelectItem>
                    {variable.options.map((option) => (
                      <SelectItem key={option} value={option}>{option}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : shouldUseDateInput(variable) ? (
                <Input
                  type="date"
                  value={values[variable.name] == null ? "" : String(values[variable.name])}
                  onChange={(event) => setValues((current) => ({ ...current, [variable.name]: event.target.value }))}
                />
              ) : (
                <Input
                  type={variable.type === "number" ? "number" : "text"}
                  value={values[variable.name] == null ? "" : String(values[variable.name])}
                  onChange={(event) => setValues((current) => ({ ...current, [variable.name]: event.target.value }))}
                />
              )}
            </div>
          ))}

          {workspaceSelectionEnabled && selectedProject && companyId ? (
            <IssueWorkspaceCard
              key={`${open ? "open" : "closed"}:${selectedProject.id}`}
              issue={workspaceIssue}
              project={selectedProject}
              initialEditing
              livePreview
              onUpdate={handleWorkspaceUpdate}
              onDraftChange={handleWorkspaceDraftChange}
            />
          ) : null}
        </div>

        <DialogFooter
          showCloseButton={false}
          className="shrink-0 border-t border-border/60 bg-background px-6 pb-(--sz-calc-19) pt-4"
        >
          {!selection.assigneeAgentId ? (
            <p className="mr-auto text-xs text-amber-600">{t("task-components:defaultAgentRequiredForThisRun_b0d7683f")}</p>
          ) : missingRequired.length > 0 ? (
            <p className="mr-auto text-xs text-amber-600"><Trans ns="task-components" i18nKey="sentence_eef095d4629c" components={{ part1: <>{missingRequired.join(", ")}</> }} /></p>
          ) : workspaceSelectionEnabled && !workspaceConfigValid ? (
            <p className="mr-auto text-xs text-amber-600">{t("task-components:chooseAnExistingWorkspaceBeforeRunning_ecc98732")}</p>
          ) : (
            <span className="mr-auto" />
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>{t("task-components:cancel_19766ed6")}</Button>
          <Button
            onClick={() => {
              const nextVariables: Record<string, string | number | boolean> = {};
              for (const variable of variables) {
                if (isAutoWorkspaceBranchVariable(variable)) {
                  nextVariables[variable.name] = workspaceBranchAutoValue!;
                  continue;
                }
                const rawValue = values[variable.name];
                if (isMissingRequiredValue(rawValue)) continue;
                if (variable.type === "number") {
                  nextVariables[variable.name] = Number(rawValue);
                } else if (variable.type === "boolean") {
                  nextVariables[variable.name] = rawValue === true;
                } else {
                  nextVariables[variable.name] = String(rawValue);
                }
              }
              onSubmit({
                variables: nextVariables,
                assigneeAgentId: selection.assigneeAgentId,
                projectId: selection.projectId || null,
                ...(workspaceSelectionEnabled
                  ? {
                    executionWorkspaceId: workspaceConfig.executionWorkspaceId,
                    executionWorkspacePreference: workspaceConfig.executionWorkspacePreference,
                    executionWorkspaceSettings: workspaceConfig.executionWorkspaceSettings,
                  }
                  : {}),
              });
            }}
            disabled={isPending || !canSubmit}
          >
            {isPending ? t("task-components:running_4977a7e5") : t("task-components:runRoutine_1f1580e1")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
