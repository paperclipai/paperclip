import { displayStatusLabel } from "./StatusBadge";
import { t, useTranslation, Trans } from "@/i18n";
import { useWorkspaceIsolationControls } from "@/hooks/useWorkspaceIsolationControls";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import type { Issue, ExecutionWorkspace } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { environmentsApi } from "../api/environments";
import { instanceSettingsApi } from "../api/instanceSettings";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { copyTextToClipboard } from "../lib/clipboard";
import {
  defaultExecutionWorkspaceModeForProject,
} from "../lib/project-workspace-defaults";
import {
  buildWorkspaceSelectionUpdate,
  currentWorkspaceSelection,
} from "../lib/issue-workspace-selection";
import { orderReusableExecutionWorkspaces } from "../lib/reusable-execution-workspaces";
import { cn, projectWorkspaceUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Check, Copy, FileSearch, FolderOpen, FolderSearch, GitBranch, Pencil, X } from "lucide-react";
import { ReusableExecutionWorkspaceSelect } from "./ReusableExecutionWorkspaceSelect";
import { Badge } from "@/components/ui/badge";

/* -------------------------------------------------------------------------- */
/*  Utility helpers (mirrored from IssueProperties for self-containment)      */
/* -------------------------------------------------------------------------- */

const EXECUTION_WORKSPACE_OPTIONS = [
  { value: "shared_workspace", get label() { return t("task-components:projectDefault_e8cb80e5"); } },
  { value: "isolated_workspace", get label() { return t("task-components:newIsolatedWorkspace_0c67029f"); } },
  { value: "reuse_existing", get label() { return t("task-components:reuseExistingWorkspace_c84ba2b6"); } },
] as const;

/* -------------------------------------------------------------------------- */
/*  Sub-components                                                             */
/* -------------------------------------------------------------------------- */

function BreakablePath({ text }: { text: string }) {
  useTranslation("task-components");
  const parts: React.ReactNode[] = [];
  const segments = text.split(/(?<=[\/-])/);
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) parts.push(<wbr key={i} />);
    parts.push(segments[i]);
  }
  return <>{parts}</>;
}

function CopyableInline({ value, label, mono }: { value: string; label?: string; mono?: boolean }) {
  useTranslation("task-components");
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(async () => {
    try {
      await copyTextToClipboard(value);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  }, [value]);

  return (
    <span className="inline-flex items-center gap-1 group/copy">
      {label && <span className="text-muted-foreground">{label}</span>}
      <span className={cn("min-w-0", mono && "font-mono")} style={{ overflowWrap: "anywhere" }}>
        <BreakablePath text={value} />
      </span>
      <button
        type="button"
        className="shrink-0 p-0.5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground opacity-0 group-hover/copy:opacity-100 focus:opacity-100"
        onClick={handleCopy}
        title={copied ? t("task-components:copied_ea61bc15") : t("task-components:copy_e21f935f")}
        aria-label={copied ? t("task-components:copiedToClipboard_d37078fe") : t("task-components:copy_9776bafb", { value1: label ?? "value" })}
      >
        {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}

function workspaceModeLabel(mode: string | null | undefined) {
  switch (mode) {
    case "isolated_workspace": return t("final-components-b:IssueWorkspaceCard.Isolated_workspace_291e49");
    case "operator_branch": return t("final-components-b:IssueWorkspaceCard.Operator_branch_ff9526");
    case "cloud_sandbox": return t("final-components-b:IssueWorkspaceCard.Cloud_environment_f6aabf");
    case "adapter_managed": return t("final-components-b:IssueWorkspaceCard.Adapter_managed_17348d");
    default: return t("task-components:workspace_87bb59ba");
  }
}

function configuredWorkspaceLabel(
  selection: string | null | undefined,
  reusableWorkspace: ExecutionWorkspace | null,
) {
  switch (selection) {
    case "isolated_workspace":
      return t("task-components:newIsolatedWorkspace_0c67029f");
    case "reuse_existing":
      return reusableWorkspace?.mode === "isolated_workspace"
        ? t("task-components:existingIsolatedWorkspace_cb171f74")
        : t("task-components:reuseExistingWorkspace_c84ba2b6");
    default:
      return t("task-components:projectDefault_e8cb80e5");
  }
}

function projectWorkspaceDetailLink(input: {
  projectId: string | null | undefined;
  projectWorkspaceId: string | null | undefined;
}) {
  if (!input.projectId || !input.projectWorkspaceId) return null;
  return projectWorkspaceUrl({ id: input.projectId, urlKey: input.projectId }, input.projectWorkspaceId);
}

function workspaceDetailLink(input: {
  projectId: string | null | undefined;
  issueProjectWorkspaceId: string | null | undefined;
  workspace: ExecutionWorkspace | null | undefined;
}) {
  const linkedProjectWorkspaceId = input.workspace?.projectWorkspaceId ?? input.issueProjectWorkspaceId ?? null;
  if (input.workspace?.mode === "shared_workspace") {
    return projectWorkspaceDetailLink({
      projectId: input.projectId,
      projectWorkspaceId: linkedProjectWorkspaceId,
    });
  }
  return input.workspace ? `/execution-workspaces/${input.workspace.id}` : null;
}

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    active: "bg-green-500/15 text-green-700 dark:text-green-400",
    idle: "bg-muted text-muted-foreground",
    in_review: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
    archived: "bg-muted text-muted-foreground",
  };
  return (
    <Badge variant="ghost" className={cn("text-(length:--text-nano) px-1.5", colors[status] ?? colors.idle)}>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

/* -------------------------------------------------------------------------- */
/*  Main component                                                             */
/* -------------------------------------------------------------------------- */

interface IssueWorkspaceCardProps {
  issue: Omit<
    Pick<
      Issue,
      | "companyId"
      | "projectId"
      | "projectWorkspaceId"
      | "executionWorkspaceId"
      | "executionWorkspacePreference"
      | "executionWorkspaceSettings"
    >,
    "companyId"
  > & {
    companyId: string | null;
    currentExecutionWorkspace?: ExecutionWorkspace | null;
  };
  project: {
    id: string;
    executionWorkspacePolicy?: {
      enabled?: boolean;
      defaultMode?: string | null;
      defaultProjectWorkspaceId?: string | null;
      environmentId?: string | null;
    } | null;
    workspaces?: Array<{ id: string; isPrimary: boolean }>;
  } | null;
  onUpdate: (data: Record<string, unknown>) => void;
  initialEditing?: boolean;
  livePreview?: boolean;
  onDraftChange?: (data: Record<string, unknown> | null, meta: { canSave: boolean; workspaceBranchName?: string | null }) => void;
  /** Opens the workspace file browser sheet. When omitted, the browse row is hidden. */
  onBrowseFiles?: () => void;
  /** Opens the same browser sheet focused for path entry. */
  onOpenFileByPath?: () => void;
}

export function IssueWorkspaceCard({
  issue,
  project,
  onUpdate,
  initialEditing = false,
  livePreview = false,
  onDraftChange,
  onBrowseFiles,
  onOpenFileByPath,
}: IssueWorkspaceCardProps) {
  useTranslation("task-components");
  const { visible: workspaceIsolationControlsVisible } = useWorkspaceIsolationControls();
  const { selectedCompanyId } = useCompany();
  const companyId = issue.companyId ?? selectedCompanyId;
  const [editing, setEditing] = useState(initialEditing);

  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  const environmentsEnabled = experimentalSettings?.enableEnvironments === true;
  // Managed-sandbox-only policy: the workspace path is a host filesystem path,
  // so the card omits it and keeps branch, repo, and environment. The gate fails
  // closed whenever the policy is unknown — in flight and also on a failed read
  // — because an unresolved policy reads as "not managed" and would show the
  // path the policy exists to hide.
  const hideHostPaths =
    experimentalSettings === undefined || experimentalSettings.enableManagedSandboxOnly === true;
  const policyEnabled = experimentalSettings?.enableIsolatedWorkspaces === true
    && Boolean(project?.executionWorkspacePolicy?.enabled);

  const workspace = issue.currentExecutionWorkspace as ExecutionWorkspace | null | undefined;
  const { data: environments } = useQuery({
    queryKey: queryKeys.environments.list(companyId!),
    queryFn: () => environmentsApi.list(companyId!),
    enabled: Boolean(companyId) && environmentsEnabled,
  });

  const {
    data: reusableExecutionWorkspaces,
    isLoading: reusableExecutionWorkspacesLoading,
    isError: reusableExecutionWorkspacesError,
  } = useQuery({
    queryKey: queryKeys.executionWorkspaces.list(companyId!, {
      projectId: issue.projectId ?? undefined,
      projectWorkspaceId: issue.projectWorkspaceId ?? undefined,
      reuseEligible: true,
    }),
    queryFn: () =>
      executionWorkspacesApi.list(companyId!, {
        projectId: issue.projectId ?? undefined,
        projectWorkspaceId: issue.projectWorkspaceId ?? undefined,
        reuseEligible: true,
      }),
    enabled: Boolean(companyId) && Boolean(issue.projectId) && editing && workspaceIsolationControlsVisible,
  });

  const selectableReusableWorkspaces = reusableExecutionWorkspaces ?? [];

  const selectedReusableExecutionWorkspace =
    selectableReusableWorkspaces.find((w) => w.id === issue.executionWorkspaceId)
    ?? workspace
    ?? null;

  const currentSelection = currentWorkspaceSelection(issue, project)
    ?? defaultExecutionWorkspaceModeForProject(project);

  const [draftSelection, setDraftSelection] = useState(currentSelection);
  const [draftExecutionWorkspaceId, setDraftExecutionWorkspaceId] = useState(issue.executionWorkspaceId ?? "");
  const projectEnvironmentId = environmentsEnabled
    ? project?.executionWorkspacePolicy?.environmentId ?? null
    : null;
  const currentReusableEnvironmentId = selectedReusableExecutionWorkspace?.config?.environmentId ?? null;
  const currentEnvironmentId = environmentsEnabled
    ? (
        (currentSelection === "reuse_existing" && currentReusableEnvironmentId)
        ?? workspace?.config?.environmentId
        ?? projectEnvironmentId
      )
    : null;
  const currentEnvironment =
    environments?.find((environment) => environment.id === currentEnvironmentId)
    ?? null;

  useEffect(() => {
    if (editing) return;
    setDraftSelection(currentSelection);
    setDraftExecutionWorkspaceId(issue.executionWorkspaceId ?? "");
  }, [currentSelection, editing, issue.executionWorkspaceId]);

  const activeNonDefaultWorkspace = Boolean(workspace && workspace.mode !== "shared_workspace");

  const configuredReusableWorkspace =
    selectableReusableWorkspaces.find((w) => w.id === draftExecutionWorkspaceId)
    ?? (draftExecutionWorkspaceId === issue.executionWorkspaceId ? selectedReusableExecutionWorkspace : null);

  const selectedReusableWorkspaceLink = workspaceDetailLink({
    projectId: project?.id,
    issueProjectWorkspaceId: issue.projectWorkspaceId,
    workspace: selectedReusableExecutionWorkspace,
  });
  const currentWorkspaceLink = workspaceDetailLink({
    projectId: project?.id,
    issueProjectWorkspaceId: issue.projectWorkspaceId,
    workspace,
  });

  const canSaveWorkspaceConfig = draftSelection !== "reuse_existing" || draftExecutionWorkspaceId.length > 0;
  const draftWorkspaceBranchName =
    draftSelection === "reuse_existing" && configuredReusableWorkspace?.mode !== "shared_workspace"
      ? configuredReusableWorkspace?.branchName ?? null
      : null;

  const buildWorkspaceDraftUpdate = useCallback(() => buildWorkspaceSelectionUpdate(
    draftSelection,
    draftExecutionWorkspaceId || null,
    configuredReusableWorkspace?.mode,
  ), [
    configuredReusableWorkspace?.mode,
    draftExecutionWorkspaceId,
    draftSelection,
  ]);

  useEffect(() => {
    if (!onDraftChange || !workspaceIsolationControlsVisible) return;
    onDraftChange(buildWorkspaceDraftUpdate(), {
      canSave: canSaveWorkspaceConfig,
      workspaceBranchName: draftWorkspaceBranchName,
    });
  }, [buildWorkspaceDraftUpdate, canSaveWorkspaceConfig, draftWorkspaceBranchName, onDraftChange, workspaceIsolationControlsVisible]);

  const handleSave = useCallback(() => {
    if (!canSaveWorkspaceConfig || !workspaceIsolationControlsVisible) return;
    const update = buildWorkspaceDraftUpdate();
    if (!update) return;
    onUpdate(update);
    setEditing(false);
  }, [
    buildWorkspaceDraftUpdate,
    canSaveWorkspaceConfig,
    workspaceIsolationControlsVisible,
    onUpdate,
  ]);

  const handleCancel = useCallback(() => {
    setDraftSelection(currentSelection);
    setDraftExecutionWorkspaceId(issue.executionWorkspaceId ?? "");
    setEditing(false);
  }, [currentSelection, issue.executionWorkspaceId]);

  if (!policyEnabled || !project) return null;

  const showEditingControls = workspaceIsolationControlsVisible && (livePreview || editing);

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
          {activeNonDefaultWorkspace && workspace
            ? workspaceModeLabel(workspace.mode)
            : configuredWorkspaceLabel(currentSelection, selectedReusableExecutionWorkspace)}
          {workspace ? statusBadge(workspace.status) : statusBadge("idle")}
        </div>
        {workspaceIsolationControlsVisible && (
          <div className="flex items-center gap-1">
            {showEditingControls ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground"
                  onClick={handleCancel}
                >
                  <X className="h-3 w-3 mr-1" />{t("task-components:cancel_19766ed6")}</Button>
                <Button
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={handleSave}
                  disabled={!canSaveWorkspaceConfig}
                >{t("task-components:save_1509f561")}</Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-muted-foreground"
                onClick={() => setEditing(true)}
              >
                <Pencil className="h-3 w-3 mr-1" />{t("task-components:edit_464c4ffd")}</Button>
            )}
          </div>
        )}
      </div>

      {/* Read-only info */}
      {!showEditingControls && (
        <div className="space-y-1.5 text-xs">
          {workspace?.branchName && (
            <div className="flex items-center gap-1.5">
              <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
              <CopyableInline value={workspace.branchName} mono />
            </div>
          )}
          {workspace?.cwd && !hideHostPaths && (
            <div className="flex items-center gap-1.5">
              <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
              <CopyableInline value={workspace.cwd} mono />
            </div>
          )}
          {workspace?.repoUrl && (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <span className="text-(length:--text-micro)">{t("task-components:repo_8d01a908")}</span>
              <CopyableInline value={workspace.repoUrl} mono />
            </div>
          )}
          {environmentsEnabled && currentEnvironmentId && (
            <div className="text-muted-foreground" style={{ overflowWrap: "anywhere" }}><Trans ns="task-components" i18nKey="sentence_2010bc7ba083" components={{ part1: <>{<span className="text-foreground">{currentEnvironment?.name ?? currentEnvironmentId}</span>}</>, part2: <>{currentSelection === "reuse_existing" && currentReusableEnvironmentId === currentEnvironmentId
                ? (" " + t("task-components:reusedWorkspace_cd5acd29"))
                : !issue.executionWorkspaceSettings?.environmentId && projectEnvironmentId === currentEnvironmentId
                ? (" " + t("task-components:projectDefault_2a001b78"))
                : null}</> }} /></div>
          )}
          {!workspace && (
            <div className="text-muted-foreground">
              {currentSelection === "isolated_workspace"
                ? t("task-components:aFreshIsolatedWorkspaceWillBeCreated_65c789bf")
                : currentSelection === "reuse_existing"
                  ? t("task-components:thisTaskWillReuseAnExistingWorkspace_6243271b")
                  : t("task-components:thisTaskWillUseTheProjectDefault_263f49e4")}
            </div>
          )}
          {currentSelection === "reuse_existing" && selectedReusableExecutionWorkspace && (
            <div className="text-muted-foreground" style={{ overflowWrap: "anywhere" }}>{t("task-components:reusing_cc296a09")}{" "}
              {selectedReusableWorkspaceLink ? (
                <Link
                  to={selectedReusableWorkspaceLink}
                  className="hover:text-foreground hover:underline"
                >
                  <BreakablePath text={selectedReusableExecutionWorkspace.name} />
                </Link>
              ) : (
                <BreakablePath text={selectedReusableExecutionWorkspace.name} />
              )}
            </div>
          )}
          {workspace && currentWorkspaceLink && (
            <div className="pt-0.5">
              <Link
                to={currentWorkspaceLink}
                className="text-(length:--text-micro) text-muted-foreground hover:text-foreground hover:underline"
              >{t("task-components:viewWorkspaceDetails_2e956143")}</Link>
            </div>
          )}
        </div>
      )}

      {/* Editing controls */}
      {editing && workspaceIsolationControlsVisible && (
        <div className="space-y-2 pt-1">
          <select
            className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-xs outline-none"
            value={draftSelection}
            onChange={(e) => {
              const nextMode = e.target.value as typeof draftSelection;
              setDraftSelection(nextMode);
              if (nextMode !== "reuse_existing") {
                setDraftExecutionWorkspaceId("");
              } else if (!draftExecutionWorkspaceId && issue.executionWorkspaceId) {
                setDraftExecutionWorkspaceId(issue.executionWorkspaceId);
              }
            }}
          >
            {EXECUTION_WORKSPACE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.value === "reuse_existing" && configuredReusableWorkspace?.mode === "isolated_workspace"
                  ? t("task-components:existingIsolatedWorkspace_cb171f74")
                  : option.label}
              </option>
            ))}
          </select>

          {draftSelection === "reuse_existing" && (
            <ReusableExecutionWorkspaceSelect
              value={draftExecutionWorkspaceId}
              workspaces={selectableReusableWorkspaces}
              onValueChange={(workspaceId) => setDraftExecutionWorkspaceId(workspaceId)}
              loading={reusableExecutionWorkspacesLoading}
              error={reusableExecutionWorkspacesError}
            />
          )}

          {/* Current workspace summary when editing */}
          {workspace && (
            <div className="text-(length:--text-micro) text-muted-foreground space-y-0.5 pt-1 border-t border-border/50">
              <div style={{ overflowWrap: "anywhere" }}>
                {t("final-components-b:IssueWorkspaceCard.Current_c09f63")}{" "}
                {currentWorkspaceLink ? (
                  <Link
                    to={currentWorkspaceLink}
                    className="hover:text-foreground hover:underline"
                  >
                    <BreakablePath text={workspace.name} />
                  </Link>
                ) : (
                  <BreakablePath text={workspace.name} />
                )}
                {" · "}
                {displayStatusLabel(workspace.status)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Workspace file discovery — calm row under the workspace identity. */}
      {!showEditingControls && onBrowseFiles && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/50 pt-2 text-xs">
          <button
            type="button"
            onClick={onBrowseFiles}
            className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <FolderSearch className="h-3.5 w-3.5 shrink-0" />{t("task-components:browseFiles_62f9b067")}</button>
          <button
            type="button"
            onClick={onOpenFileByPath ?? onBrowseFiles}
            className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <FileSearch className="h-3.5 w-3.5 shrink-0" />{t("task-components:openFileByPath_1f9a7fd5")}</button>
        </div>
      )}
    </div>
  );
}
