import { useCallback, useEffect, useMemo, useState } from "react";
import type { IssueExecutionWorkspaceSettings, Project, RoutineVariable } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { IssueWorkspaceCard } from "./IssueWorkspaceCard";
import { Button, Modal, Input, Select, ListBox } from "@heroui/react";

function buildInitialValues(variables: RoutineVariable[]) {
  return Object.fromEntries(variables.map((variable) => [variable.name, variable.defaultValue ?? ""]));
}

function defaultProjectWorkspaceIdForProject(project: Project | null | undefined) {
  if (!project) return null;
  return project.executionWorkspacePolicy?.defaultProjectWorkspaceId
    ?? project.workspaces?.find((workspace) => workspace.isPrimary)?.id
    ?? project.workspaces?.[0]?.id
    ?? null;
}

function defaultExecutionWorkspaceModeForProject(project: Project | null | undefined) {
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

function buildInitialWorkspaceConfig(project: Project | null | undefined) {
  const defaultMode = defaultExecutionWorkspaceModeForProject(project);
  return {
    executionWorkspaceId: null as string | null,
    executionWorkspacePreference: defaultMode,
    executionWorkspaceSettings: { mode: defaultMode } as IssueExecutionWorkspaceSettings,
    projectWorkspaceId: defaultProjectWorkspaceIdForProject(project),
  };
}

function workspaceConfigEquals(
  a: ReturnType<typeof buildInitialWorkspaceConfig>,
  b: ReturnType<typeof buildInitialWorkspaceConfig>,
) {
  return a.executionWorkspaceId === b.executionWorkspaceId
    && a.executionWorkspacePreference === b.executionWorkspacePreference
    && a.projectWorkspaceId === b.projectWorkspaceId
    && JSON.stringify(a.executionWorkspaceSettings ?? null) === JSON.stringify(b.executionWorkspaceSettings ?? null);
}

function applyWorkspaceDraft(
  current: ReturnType<typeof buildInitialWorkspaceConfig>,
  data: Record<string, unknown>,
) {
  const next = {
    ...current,
    executionWorkspaceId: (data.executionWorkspaceId as string | null | undefined) ?? null,
    executionWorkspacePreference:
      (data.executionWorkspacePreference as string | null | undefined)
      ?? current.executionWorkspacePreference,
    executionWorkspaceSettings:
      (data.executionWorkspaceSettings as IssueExecutionWorkspaceSettings | null | undefined)
      ?? current.executionWorkspaceSettings,
  };
  return workspaceConfigEquals(current, next) ? current : next;
}

function isMissingRequiredValue(value: unknown) {
  return value == null || (typeof value === "string" && value.trim().length === 0);
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
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: IssueExecutionWorkspaceSettings | null;
}

export function RoutineRunVariablesDialog({
  open,
  onOpenChange,
  companyId,
  project,
  variables,
  isPending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string | null | undefined;
  project: Project | null | undefined;
  variables: RoutineVariable[];
  isPending: boolean;
  onSubmit: (data: RoutineRunDialogSubmitData) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [workspaceConfig, setWorkspaceConfig] = useState(() => buildInitialWorkspaceConfig(project));
  const [workspaceConfigValid, setWorkspaceConfigValid] = useState(true);

  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });

  const workspaceSelectionEnabled = supportsRoutineRunWorkspaceSelection(
    project,
    experimentalSettings?.enableIsolatedWorkspaces === true,
  );

  useEffect(() => {
    if (!open) return;
    setValues(buildInitialValues(variables));
    setWorkspaceConfig(buildInitialWorkspaceConfig(project));
    setWorkspaceConfigValid(true);
  }, [open, project, variables]);

  const missingRequired = useMemo(
    () =>
      variables
        .filter((variable) => variable.required)
        .filter((variable) => isMissingRequiredValue(values[variable.name]))
        .map((variable) => variable.label || variable.name),
    [values, variables],
  );

  const workspaceIssue = useMemo(() => ({
    companyId: companyId ?? null,
    projectId: project?.id ?? null,
    projectWorkspaceId: workspaceConfig.projectWorkspaceId,
    executionWorkspaceId: workspaceConfig.executionWorkspaceId,
    executionWorkspacePreference: workspaceConfig.executionWorkspacePreference,
    executionWorkspaceSettings: workspaceConfig.executionWorkspaceSettings,
    currentExecutionWorkspace: null,
  }), [
    companyId,
    project?.id,
    workspaceConfig.executionWorkspaceId,
    workspaceConfig.executionWorkspacePreference,
    workspaceConfig.executionWorkspaceSettings,
    workspaceConfig.projectWorkspaceId,
  ]);

  const canSubmit = missingRequired.length === 0 && (!workspaceSelectionEnabled || workspaceConfigValid);

  const handleWorkspaceUpdate = useCallback((data: Record<string, unknown>) => {
    setWorkspaceConfig((current) => applyWorkspaceDraft(current, data));
  }, []);

  const handleWorkspaceDraftChange = useCallback((
    data: Record<string, unknown>,
    meta: { canSave: boolean },
  ) => {
    setWorkspaceConfig((current) => applyWorkspaceDraft(current, data));
    setWorkspaceConfigValid((current) => (current === meta.canSave ? current : meta.canSave));
  }, []);

  return (
    <Modal.Backdrop isOpen={open} onOpenChange={(next: boolean) => !isPending && onOpenChange(next)}>
      <Modal.Container size="md">
        <Modal.Dialog>
          <div className="px-6 pt-6 pb-2">
            <h2 className="text-base font-semibold">Run routine</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Fill in the routine variables before starting the execution issue.
            </p>
          </div>

          <div className="px-6 pb-2 space-y-4">
          {variables.map((variable) => (
            <div key={variable.name} className="space-y-1.5">
              <label className="text-xs text-muted-foreground">
                {variable.label || variable.name}
                {variable.required ? " *" : ""}
              </label>
              {variable.type === "textarea" ? (
                <textarea
                  rows={4}
                  className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm resize-none"
                  value={typeof values[variable.name] === "string" ? values[variable.name] as string : ""}
                  onChange={(event) => setValues((current) => ({ ...current, [variable.name]: event.target.value }))}
                />
              ) : variable.type === "boolean" ? (
                <Select
                  selectedKey={values[variable.name] === true ? "true" : values[variable.name] === false ? "false" : "__unset__"}
                  onSelectionChange={(next) => setValues((current) => ({
                    ...current,
                    [variable.name]: next === "__unset__" ? "" : next === "true",
                  }))}
                >
                  <Select.Trigger />
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="__unset__">No value</ListBox.Item>
                      <ListBox.Item id="true">True</ListBox.Item>
                      <ListBox.Item id="false">False</ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
              ) : variable.type === "select" ? (
                <Select
                  selectedKey={typeof values[variable.name] === "string" && values[variable.name] ? values[variable.name] as string : "__unset__"}
                  onSelectionChange={(next) => setValues((current) => ({
                    ...current,
                    [variable.name]: next === "__unset__" ? "" : next,
                  }))}
                >
                  <Select.Trigger />
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="__unset__">No value</ListBox.Item>
                      {variable.options.map((option) => (
                        <ListBox.Item key={option} id={option}>{option}</ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              ) : (
                <Input
                  type={variable.type === "number" ? "number" : "text"}
                  value={values[variable.name] == null ? "" : String(values[variable.name])}
                  onChange={(event) => setValues((current) => ({ ...current, [variable.name]: event.target.value }))}
                />
              )}
            </div>
          ))}

          {workspaceSelectionEnabled && project && companyId ? (
            <IssueWorkspaceCard
              key={`${open ? "open" : "closed"}:${project.id}`}
              issue={workspaceIssue}
              project={project}
              initialEditing
              livePreview
              onUpdate={handleWorkspaceUpdate}
              onDraftChange={handleWorkspaceDraftChange}
            />
          ) : null}
        </div>

        <div className="flex items-center gap-2 px-6 py-4 border-t border-border">
          {missingRequired.length > 0 ? (
            <p className="mr-auto text-xs text-amber-600">
              Missing: {missingRequired.join(", ")}
            </p>
          ) : workspaceSelectionEnabled && !workspaceConfigValid ? (
            <p className="mr-auto text-xs text-amber-600">
              Choose an existing workspace before running.
            </p>
          ) : (
            <span className="mr-auto" />
          )}
          <Button variant="ghost" onPress={() => onOpenChange(false)} isDisabled={isPending}>
            Cancel
          </Button>
          <Button
            onPress={() => {
              const nextVariables: Record<string, string | number | boolean> = {};
              for (const variable of variables) {
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
                ...(workspaceSelectionEnabled
                  ? {
                    executionWorkspaceId: workspaceConfig.executionWorkspaceId,
                    executionWorkspacePreference: workspaceConfig.executionWorkspacePreference,
                    executionWorkspaceSettings: workspaceConfig.executionWorkspaceSettings,
                  }
                  : {}),
              });
            }}
            isDisabled={isPending || !canSubmit}
          >
            {isPending ? "Running..." : "Run routine"}
          </Button>
          </div>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
