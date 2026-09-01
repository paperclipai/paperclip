import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import type { Issue, ExecutionWorktree } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { executionWorktreesApi } from "../api/execution-worktrees";
import { environmentsApi } from "../api/environments";
import { instanceSettingsApi } from "../api/instanceSettings";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { copyTextToClipboard } from "../lib/clipboard";
import {
  defaultExecutionWorktreeModeForProject,
  issueExecutionWorktreeModeForExistingWorktree,
} from "../lib/project-worktree-defaults";
import { orderReusableExecutionWorktrees } from "../lib/reusable-execution-worktrees";
import { cn, projectWorktreeUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Check, Copy, FileSearch, FolderOpen, FolderSearch, GitBranch, Pencil, X } from "lucide-react";
import { ReusableExecutionWorktreeSelect } from "./ReusableExecutionWorktreeSelect";
import { Badge } from "@/components/ui/badge";

/* -------------------------------------------------------------------------- */
/*  Utility helpers (mirrored from IssueProperties for self-containment)      */
/* -------------------------------------------------------------------------- */

const EXECUTION_WORKSPACE_OPTIONS = [
  { value: "shared_workspace", label: "Project default" },
  { value: "isolated_workspace", label: "New isolated worktree" },
  { value: "reuse_existing", label: "Reuse existing worktree" },
] as const;

function shouldPresentExistingWorktreeSelection(
  issue: Pick<
    Issue,
    "executionWorkspaceId" | "executionWorkspacePreference" | "executionWorkspaceSettings" | "currentExecutionWorkspace"
  >,
) {
  const persistedMode =
    issue.currentExecutionWorkspace?.mode
    ?? issue.executionWorkspaceSettings?.mode
    ?? issue.executionWorkspacePreference;
  return Boolean(
    issue.executionWorkspaceId &&
    (persistedMode === "isolated_workspace" || persistedMode === "operator_branch"),
  );
}

/* -------------------------------------------------------------------------- */
/*  Sub-components                                                             */
/* -------------------------------------------------------------------------- */

function BreakablePath({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const segments = text.split(/(?<=[\/-])/);
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) parts.push(<wbr key={i} />);
    parts.push(segments[i]);
  }
  return <>{parts}</>;
}

function CopyableInline({ value, label, mono }: { value: string; label?: string; mono?: boolean }) {
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
        title={copied ? "Copied!" : "Copy"}
        aria-label={copied ? "Copied to clipboard" : `Copy ${label ?? "value"}`}
      >
        {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}

function worktreeModeLabel(mode: string | null | undefined) {
  switch (mode) {
    case "isolated_workspace": return "Isolated worktree";
    case "operator_branch": return "Operator branch";
    case "cloud_sandbox": return "Cloud environment";
    case "adapter_managed": return "Adapter managed";
    default: return "Worktree";
  }
}

function configuredWorktreeLabel(
  selection: string | null | undefined,
  reusableWorkspace: ExecutionWorktree | null,
) {
  switch (selection) {
    case "isolated_workspace":
      return "New isolated worktree";
    case "reuse_existing":
      return reusableWorkspace?.mode === "isolated_workspace"
        ? "Existing isolated worktree"
        : "Reuse existing worktree";
    default:
      return "Project default";
  }
}

function projectWorktreeDetailLink(input: {
  projectId: string | null | undefined;
  projectWorkspaceId: string | null | undefined;
}) {
  if (!input.projectId || !input.projectWorkspaceId) return null;
  return projectWorktreeUrl({ id: input.projectId, urlKey: input.projectId }, input.projectWorkspaceId);
}

function worktreeDetailLink(input: {
  projectId: string | null | undefined;
  issueProjectWorkspaceId: string | null | undefined;
  workspace: ExecutionWorktree | null | undefined;
}) {
  const linkedProjectWorktreeId = input.workspace?.projectWorkspaceId ?? input.issueProjectWorkspaceId ?? null;
  if (input.workspace?.mode === "shared_workspace") {
    return projectWorktreeDetailLink({
      projectId: input.projectId,
      projectWorkspaceId: linkedProjectWorktreeId,
    });
  }
  return input.workspace ? `/execution-worktrees/${input.workspace.id}` : null;
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

interface IssueWorktreeCardProps {
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
    currentExecutionWorkspace?: ExecutionWorktree | null;
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
  onDraftChange?: (data: Record<string, unknown>, meta: { canSave: boolean; workspaceBranchName?: string | null }) => void;
  /** Opens the workspace file browser sheet. When omitted, the browse row is hidden. */
  onBrowseFiles?: () => void;
  /** Opens the same browser sheet focused for path entry. */
  onOpenFileByPath?: () => void;
}

export function IssueWorktreeCard({
  issue,
  project,
  onUpdate,
  initialEditing = false,
  livePreview = false,
  onDraftChange,
  onBrowseFiles,
  onOpenFileByPath,
}: IssueWorktreeCardProps) {
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

  const worktree = issue.currentExecutionWorkspace as ExecutionWorktree | null | undefined;
  const { data: environments } = useQuery({
    queryKey: queryKeys.environments.list(companyId!),
    queryFn: () => environmentsApi.list(companyId!),
    enabled: Boolean(companyId) && environmentsEnabled,
  });

  const {
    data: reusableExecutionWorktrees,
    isLoading: reusableExecutionWorktreesLoading,
    isError: reusableExecutionWorktreesError,
  } = useQuery({
    queryKey: queryKeys.executionWorktrees.list(companyId!, {
      projectId: issue.projectId ?? undefined,
      projectWorkspaceId: issue.projectWorkspaceId ?? undefined,
      reuseEligible: true,
    }),
    queryFn: () =>
      executionWorktreesApi.list(companyId!, {
        projectId: issue.projectId ?? undefined,
        projectWorkspaceId: issue.projectWorkspaceId ?? undefined,
        reuseEligible: true,
      }),
    enabled: Boolean(companyId) && Boolean(issue.projectId) && editing,
  });

  const selectableReusableWorktrees = reusableExecutionWorktrees ?? [];

  const selectedReusableExecutionWorktree =
    selectableReusableWorktrees.find((w) => w.id === issue.executionWorkspaceId)
    ?? worktree
    ?? null;

  const currentSelection = shouldPresentExistingWorktreeSelection(issue)
    ? "reuse_existing"
    : (
        issue.executionWorkspacePreference
        ?? issue.executionWorkspaceSettings?.mode
        ?? defaultExecutionWorktreeModeForProject(project)
      );

  const [draftSelection, setDraftSelection] = useState(currentSelection);
  const [draftExecutionWorktreeId, setDraftExecutionWorktreeId] = useState(issue.executionWorkspaceId ?? "");
  const projectEnvironmentId = environmentsEnabled
    ? project?.executionWorkspacePolicy?.environmentId ?? null
    : null;
  const currentReusableEnvironmentId = selectedReusableExecutionWorktree?.config?.environmentId ?? null;
  const currentEnvironmentId = environmentsEnabled
    ? (
        (currentSelection === "reuse_existing" && currentReusableEnvironmentId)
        ?? worktree?.config?.environmentId
        ?? projectEnvironmentId
      )
    : null;
  const currentEnvironment =
    environments?.find((environment) => environment.id === currentEnvironmentId)
    ?? null;

  useEffect(() => {
    if (editing) return;
    setDraftSelection(currentSelection);
    setDraftExecutionWorktreeId(issue.executionWorkspaceId ?? "");
  }, [currentSelection, editing, issue.executionWorkspaceId]);

  const activeNonDefaultWorktree = Boolean(worktree && worktree.mode !== "shared_workspace");

  const configuredReusableWorktree =
    selectableReusableWorktrees.find((w) => w.id === draftExecutionWorktreeId)
    ?? (draftExecutionWorktreeId === issue.executionWorkspaceId ? selectedReusableExecutionWorktree : null);

  const selectedReusableWorktreeLink = worktreeDetailLink({
    projectId: project?.id,
    issueProjectWorkspaceId: issue.projectWorkspaceId,
    workspace: selectedReusableExecutionWorktree,
  });
  const currentWorktreeLink = worktreeDetailLink({
    projectId: project?.id,
    issueProjectWorkspaceId: issue.projectWorkspaceId,
    workspace: worktree,
  });

  const canSaveWorktreeConfig = draftSelection !== "reuse_existing" || draftExecutionWorktreeId.length > 0;
  const draftWorktreeBranchName =
    draftSelection === "reuse_existing" && configuredReusableWorktree?.mode !== "shared_workspace"
      ? configuredReusableWorktree?.branchName ?? null
      : null;

  const buildWorktreeDraftUpdate = useCallback(() => ({
    executionWorkspacePreference: draftSelection,
    executionWorkspaceId: draftSelection === "reuse_existing" ? draftExecutionWorktreeId || null : null,
    executionWorkspaceSettings: {
      mode:
        draftSelection === "reuse_existing"
          ? issueExecutionWorktreeModeForExistingWorktree(configuredReusableWorktree?.mode)
          : draftSelection,
      environmentId: null,
    },
  }), [
    configuredReusableWorktree?.mode,
    draftExecutionWorktreeId,
    draftSelection,
  ]);

  useEffect(() => {
    if (!onDraftChange) return;
    onDraftChange(buildWorktreeDraftUpdate(), {
      canSave: canSaveWorktreeConfig,
      workspaceBranchName: draftWorktreeBranchName,
    });
  }, [buildWorktreeDraftUpdate, canSaveWorktreeConfig, draftWorktreeBranchName, onDraftChange]);

  const handleSave = useCallback(() => {
    if (!canSaveWorktreeConfig) return;
    onUpdate(buildWorktreeDraftUpdate());
    setEditing(false);
  }, [
    buildWorktreeDraftUpdate,
    canSaveWorktreeConfig,
    onUpdate,
  ]);

  const handleCancel = useCallback(() => {
    setDraftSelection(currentSelection);
    setDraftExecutionWorktreeId(issue.executionWorkspaceId ?? "");
    setEditing(false);
  }, [currentSelection, issue.executionWorkspaceId]);

  if (!policyEnabled || !project) return null;

  const showEditingControls = livePreview || editing;

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
          {activeNonDefaultWorktree && worktree
            ? worktreeModeLabel(worktree.mode)
            : configuredWorktreeLabel(currentSelection, selectedReusableExecutionWorktree)}
          {worktree ? statusBadge(worktree.status) : statusBadge("idle")}
        </div>
        <div className="flex items-center gap-1">
          {showEditingControls ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-muted-foreground"
                onClick={handleCancel}
              >
                <X className="h-3 w-3 mr-1" />Cancel
              </Button>
              <Button
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={handleSave}
                disabled={!canSaveWorktreeConfig}
              >
                Save
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-3 w-3 mr-1" />Edit
            </Button>
          )}
        </div>
      </div>

      {/* Read-only info */}
      {!showEditingControls && (
        <div className="space-y-1.5 text-xs">
          {worktree?.branchName && (
            <div className="flex items-center gap-1.5">
              <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
              <CopyableInline value={worktree.branchName} mono />
            </div>
          )}
          {worktree?.cwd && !hideHostPaths && (
            <div className="flex items-center gap-1.5">
              <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
              <CopyableInline value={worktree.cwd} mono />
            </div>
          )}
          {worktree?.repoUrl && (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <span className="text-(length:--text-micro)">Repo:</span>
              <CopyableInline value={worktree.repoUrl} mono />
            </div>
          )}
          {environmentsEnabled && currentEnvironmentId && (
            <div className="text-muted-foreground" style={{ overflowWrap: "anywhere" }}>
              Environment: <span className="text-foreground">{currentEnvironment?.name ?? currentEnvironmentId}</span>
              {currentSelection === "reuse_existing" && currentReusableEnvironmentId === currentEnvironmentId
                ? " · reused worktree"
                : !issue.executionWorkspaceSettings?.environmentId && projectEnvironmentId === currentEnvironmentId
                ? " · project default"
                : null}
            </div>
          )}
          {!worktree && (
            <div className="text-muted-foreground">
              {currentSelection === "isolated_workspace"
                ? "A fresh isolated worktree will be created when this task runs."
                : currentSelection === "reuse_existing"
                  ? "This task will reuse an existing worktree when it runs."
                  : "This task will use the project default worktree configuration when it runs."}
            </div>
          )}
          {currentSelection === "reuse_existing" && selectedReusableExecutionWorktree && (
            <div className="text-muted-foreground" style={{ overflowWrap: "anywhere" }}>
              Reusing:{" "}
              {selectedReusableWorktreeLink ? (
                <Link
                  to={selectedReusableWorktreeLink}
                  className="hover:text-foreground hover:underline"
                >
                  <BreakablePath text={selectedReusableExecutionWorktree.name} />
                </Link>
              ) : (
                <BreakablePath text={selectedReusableExecutionWorktree.name} />
              )}
            </div>
          )}
          {worktree && currentWorktreeLink && (
            <div className="pt-0.5">
              <Link
                to={currentWorktreeLink}
                className="text-(length:--text-micro) text-muted-foreground hover:text-foreground hover:underline"
              >
                View worktree details →
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Editing controls */}
      {editing && (
        <div className="space-y-2 pt-1">
          <select
            className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-xs outline-none"
            value={draftSelection}
            onChange={(e) => {
              const nextMode = e.target.value;
              setDraftSelection(nextMode);
              if (nextMode !== "reuse_existing") {
                setDraftExecutionWorktreeId("");
              } else if (!draftExecutionWorktreeId && issue.executionWorkspaceId) {
                setDraftExecutionWorktreeId(issue.executionWorkspaceId);
              }
            }}
          >
            {EXECUTION_WORKSPACE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.value === "reuse_existing" && configuredReusableWorktree?.mode === "isolated_workspace"
                  ? "Existing isolated worktree"
                  : option.label}
              </option>
            ))}
          </select>

          {draftSelection === "reuse_existing" && (
            <ReusableExecutionWorktreeSelect
              value={draftExecutionWorktreeId}
              worktrees={selectableReusableWorktrees}
              onValueChange={(worktreeId) => setDraftExecutionWorktreeId(worktreeId)}
              loading={reusableExecutionWorktreesLoading}
              error={reusableExecutionWorktreesError}
            />
          )}

          {/* Current workspace summary when editing */}
          {worktree && (
            <div className="text-(length:--text-micro) text-muted-foreground space-y-0.5 pt-1 border-t border-border/50">
              <div style={{ overflowWrap: "anywhere" }}>
                Current:{" "}
                {currentWorktreeLink ? (
                  <Link
                    to={currentWorktreeLink}
                    className="hover:text-foreground hover:underline"
                  >
                    <BreakablePath text={worktree.name} />
                  </Link>
                ) : (
                  <BreakablePath text={worktree.name} />
                )}
                {" · "}
                {worktree.status}
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
            <FolderSearch className="h-3.5 w-3.5 shrink-0" />
            Browse files…
          </button>
          <button
            type="button"
            onClick={onOpenFileByPath ?? onBrowseFiles}
            className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <FileSearch className="h-3.5 w-3.5 shrink-0" />
            Open file by path…
          </button>
        </div>
      )}
    </div>
  );
}
