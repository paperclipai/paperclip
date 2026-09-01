import { useCallback, useEffect, useMemo, useState } from "react";
import {
  WORKSPACE_BRANCH_ROUTINE_VARIABLE,
  type Agent,
  type ExecutionWorktree,
  type ExecutionWorktreeMode,
  type IssueExecutionWorktreeSettings,
  type Project,
  type RoutineVariable,
} from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { IssueWorktreeCard } from "./IssueWorktreeCard";
import { AgentIcon } from "./AgentIconPicker";
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

function defaultProjectWorktreeIdForProject(project: Project | null | undefined) {
  if (!project) return null;
  return project.executionWorkspacePolicy?.defaultProjectWorkspaceId
    ?? project.workspaces?.find((worktree) => worktree.isPrimary)?.id
    ?? project.workspaces?.[0]?.id
    ?? null;
}

function defaultExecutionWorktreeModeForProject(project: Project | null | undefined): ExecutionWorktreeMode {
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

function issueModeForExistingWorktree(mode: string | null | undefined): ExecutionWorktreeMode {
  if (mode === "isolated_workspace" || mode === "operator_branch" || mode === "shared_workspace") return mode;
  if (mode === "adapter_managed" || mode === "cloud_sandbox") return "agent_default";
  return "shared_workspace";
}

function issueWorktreePreferenceFromDraft(value: unknown, fallback: ExecutionWorktreeMode): ExecutionWorktreeMode {
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

type RoutineRunWorktreeConfig = {
  executionWorkspaceId: string | null;
  executionWorkspacePreference: ExecutionWorktreeMode;
  executionWorkspaceSettings: IssueExecutionWorktreeSettings;
  projectWorkspaceId: string | null;
};

function buildInitialWorktreeConfig(
  project: Project | null | undefined,
  defaultExecutionWorkspace?: ExecutionWorktree | null,
): RoutineRunWorktreeConfig {
  if (defaultExecutionWorkspace && defaultExecutionWorkspace.projectId === project?.id) {
    return {
      executionWorkspaceId: defaultExecutionWorkspace.id,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: issueModeForExistingWorktree(defaultExecutionWorkspace.mode),
      },
      projectWorkspaceId: defaultExecutionWorkspace.projectWorkspaceId ?? defaultProjectWorktreeIdForProject(project),
    };
  }

  const defaultMode = defaultExecutionWorktreeModeForProject(project);
  return {
    executionWorkspaceId: null as string | null,
    executionWorkspacePreference: defaultMode,
    executionWorkspaceSettings: { mode: defaultMode },
    projectWorkspaceId: defaultProjectWorktreeIdForProject(project),
  };
}

function worktreeConfigEquals(
  a: RoutineRunWorktreeConfig,
  b: RoutineRunWorktreeConfig,
) {
  return a.executionWorkspaceId === b.executionWorkspaceId
    && a.executionWorkspacePreference === b.executionWorkspacePreference
    && a.projectWorkspaceId === b.projectWorkspaceId
    && JSON.stringify(a.executionWorkspaceSettings ?? null) === JSON.stringify(b.executionWorkspaceSettings ?? null);
}

function applyWorktreeDraft(
  current: RoutineRunWorktreeConfig,
  data: Record<string, unknown>,
) {
  const next = {
    ...current,
    executionWorkspaceId: (data.executionWorkspaceId as string | null | undefined) ?? null,
    executionWorkspacePreference: issueWorktreePreferenceFromDraft(
      data.executionWorkspacePreference,
      current.executionWorkspacePreference,
    ),
    executionWorkspaceSettings:
      (data.executionWorkspaceSettings as IssueExecutionWorktreeSettings | null | undefined)
      ?? current.executionWorkspaceSettings,
  };
  return worktreeConfigEquals(current, next) ? current : next;
}

function isMissingRequiredValue(value: unknown) {
  return value == null || (typeof value === "string" && value.trim().length === 0);
}

function shouldUseDateInput(variable: RoutineVariable) {
  return variable.type === "date";
}

function supportsRoutineRunWorktreeSelection(
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
    || supportsRoutineRunWorktreeSelection(input.project, input.isolatedWorkspacesEnabled);
}

export interface RoutineRunDialogSubmitData {
  variables?: Record<string, string | number | boolean>;
  assigneeAgentId?: string | null;
  projectId?: string | null;
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: IssueExecutionWorktreeSettings | null;
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
  defaultExecutionWorkspace?: ExecutionWorktree | null;
  variables: RoutineVariable[];
  isPending: boolean;
  onSubmit: (data: RoutineRunDialogSubmitData) => void;
}) {
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
  const [worktreeConfig, setWorktreeConfig] = useState(() =>
    buildInitialWorktreeConfig(selectedProject, defaultExecutionWorkspace));
  const [worktreeConfigValid, setWorktreeConfigValid] = useState(true);
  const [worktreeBranchName, setWorktreeBranchName] = useState<string | null>(null);

  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });

  const worktreeSelectionEnabled = supportsRoutineRunWorktreeSelection(
    selectedProject,
    experimentalSettings?.enableIsolatedWorkspaces === true,
  );

  useEffect(() => {
    if (!open) return;
    setValues(buildInitialValues(variables));
    const nextSelection = buildInitialRunSelection({ defaultAssigneeAgentId, defaultProjectId });
    setSelection(nextSelection);
    setWorktreeConfig(buildInitialWorktreeConfig(
      projects.find((project) => project.id === nextSelection.projectId) ?? null,
      defaultExecutionWorkspace,
    ));
    setWorktreeConfigValid(true);
    setWorktreeBranchName(defaultExecutionWorkspace?.branchName ?? null);
  }, [defaultAssigneeAgentId, defaultExecutionWorkspace, defaultProjectId, open, projects, variables]);

  const worktreeBranchAutoValue = worktreeSelectionEnabled && worktreeBranchName
    ? worktreeBranchName
    : null;

  const isAutoWorktreeBranchVariable = useCallback(
    (variable: RoutineVariable) =>
      variable.name === WORKSPACE_BRANCH_ROUTINE_VARIABLE && Boolean(worktreeBranchAutoValue),
    [worktreeBranchAutoValue],
  );

  const missingRequired = useMemo(
    () =>
      variables
        .filter((variable) => variable.required)
        .filter((variable) => !isAutoWorktreeBranchVariable(variable))
        .filter((variable) => isMissingRequiredValue(values[variable.name]))
        .map((variable) => variable.label || variable.name),
    [isAutoWorktreeBranchVariable, values, variables],
  );

  const worktreeIssue = useMemo(() => ({
    companyId: companyId ?? null,
    projectId: selectedProject?.id ?? null,
    projectWorkspaceId: worktreeConfig.projectWorkspaceId,
    executionWorkspaceId: worktreeConfig.executionWorkspaceId,
    executionWorkspacePreference: worktreeConfig.executionWorkspacePreference,
    executionWorkspaceSettings: worktreeConfig.executionWorkspaceSettings,
    currentExecutionWorkspace:
      worktreeConfig.executionWorkspaceId && worktreeConfig.executionWorkspaceId === defaultExecutionWorkspace?.id
        ? defaultExecutionWorkspace
        : null,
  }), [
    companyId,
    defaultExecutionWorkspace,
    selectedProject?.id,
    worktreeConfig.executionWorkspaceId,
    worktreeConfig.executionWorkspacePreference,
    worktreeConfig.executionWorkspaceSettings,
    worktreeConfig.projectWorkspaceId,
  ]);

  const canSubmit =
    selection.assigneeAgentId.trim().length > 0 &&
    missingRequired.length === 0 &&
    (!worktreeSelectionEnabled || worktreeConfigValid);

  const handleWorktreeUpdate = useCallback((data: Record<string, unknown>) => {
    setWorktreeConfig((current) => applyWorktreeDraft(current, data));
  }, []);

  const handleWorktreeDraftChange = useCallback((
    data: Record<string, unknown>,
    meta: { canSave: boolean; workspaceBranchName?: string | null },
  ) => {
    setWorktreeConfig((current) => applyWorktreeDraft(current, data));
    setWorktreeConfigValid((current) => (current === meta.canSave ? current : meta.canSave));
    setWorktreeBranchName((current) => {
      const defaultWorktreeBranchName = defaultExecutionWorkspace?.branchName ?? null;
      const next = meta.workspaceBranchName
        ?? (data.executionWorkspaceId === defaultExecutionWorkspace?.id ? defaultWorktreeBranchName : null)
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
          <DialogTitle>Run routine</DialogTitle>
          <DialogDescription>
            Choose the agent and optional project for this one run. Routine defaults are prefilled and won&apos;t be changed.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 py-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Agent *</Label>
              <InlineEntitySelector
                value={selection.assigneeAgentId}
                options={assigneeOptions}
                recentOptionIds={recentAssigneeIds}
                placeholder="Agent"
                noneLabel="Select an agent"
                searchPlaceholder="Search agents..."
                emptyMessage="No agents found."
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
                        <AgentIcon icon={currentAssignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{option.label}</span>
                      </>
                    ) : (
                      <span className="truncate">{option.label}</span>
                    )
                  ) : (
                    <span className="text-muted-foreground">Select an agent</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const assignee = agents.find((agent) => agent.id === option.id);
                  return (
                    <>
                      {assignee ? <AgentIcon icon={assignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Project</Label>
              <InlineEntitySelector
                value={selection.projectId}
                options={projectOptions}
                recentOptionIds={recentProjectIds}
                placeholder="Project"
                noneLabel="No project"
                searchPlaceholder="Search projects..."
                emptyMessage="No projects found."
                disablePortal
                openOnFocus={false}
                onChange={(projectId) => {
                  const project = projects.find((entry) => entry.id === projectId) ?? null;
                  if (projectId) trackRecentProject(projectId);
                  setSelection((current) => ({ ...current, projectId }));
                  setWorktreeConfig(buildInitialWorktreeConfig(project, defaultExecutionWorkspace));
                  setWorktreeConfigValid(true);
                  setWorktreeBranchName(
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
                    <span className="text-muted-foreground">No project</span>
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
              {isAutoWorktreeBranchVariable(variable) ? (
                <Input
                  readOnly
                  disabled
                  value={worktreeBranchAutoValue ?? ""}
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
                    <SelectItem value="__unset__">No value</SelectItem>
                    <SelectItem value="true">True</SelectItem>
                    <SelectItem value="false">False</SelectItem>
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
                    <SelectValue placeholder="Choose a value" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__unset__">No value</SelectItem>
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

          {worktreeSelectionEnabled && selectedProject && companyId ? (
            <IssueWorktreeCard
              key={`${open ? "open" : "closed"}:${selectedProject.id}`}
              issue={worktreeIssue}
              project={selectedProject}
              initialEditing
              livePreview
              onUpdate={handleWorktreeUpdate}
              onDraftChange={handleWorktreeDraftChange}
            />
          ) : null}
        </div>

        <DialogFooter
          showCloseButton={false}
          className="shrink-0 border-t border-border/60 bg-background px-6 pb-(--sz-calc-19) pt-4"
        >
          {!selection.assigneeAgentId ? (
            <p className="mr-auto text-xs text-amber-600">Default agent required for this run.</p>
          ) : missingRequired.length > 0 ? (
            <p className="mr-auto text-xs text-amber-600">
              Missing: {missingRequired.join(", ")}
            </p>
          ) : worktreeSelectionEnabled && !worktreeConfigValid ? (
            <p className="mr-auto text-xs text-amber-600">
              Choose an existing worktree before running.
            </p>
          ) : (
            <span className="mr-auto" />
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const nextVariables: Record<string, string | number | boolean> = {};
              for (const variable of variables) {
                if (isAutoWorktreeBranchVariable(variable)) {
                  nextVariables[variable.name] = worktreeBranchAutoValue!;
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
                ...(worktreeSelectionEnabled
                  ? {
                    executionWorkspaceId: worktreeConfig.executionWorkspaceId,
                    executionWorkspacePreference: worktreeConfig.executionWorkspacePreference,
                    executionWorkspaceSettings: worktreeConfig.executionWorkspaceSettings,
                  }
                  : {}),
              });
            }}
            disabled={isPending || !canSubmit}
          >
            {isPending ? "Running..." : "Run routine"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
