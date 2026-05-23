import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { Link } from "@/lib/router";
import type { Issue, ExecutionWorkspace } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { environmentsApi } from "../api/environments";
import { instanceSettingsApi } from "../api/instanceSettings";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { orderReusableExecutionWorkspaces } from "../lib/reusable-execution-workspaces";
import { cn, projectWorkspaceUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Check, Copy, GitBranch, FolderOpen, Pencil, X } from "lucide-react";

/* -------------------------------------------------------------------------- */
/*  Utility helpers (mirrored from IssueProperties for self-containment)      */
/* -------------------------------------------------------------------------- */

function issueModeForExistingWorkspace(mode: string | null | undefined) {
  if (mode === "isolated_workspace" || mode === "operator_branch" || mode === "shared_workspace") return mode;
  if (mode === "adapter_managed" || mode === "cloud_sandbox") return "agent_default";
  return "shared_workspace";
}

function shouldPresentExistingWorkspaceSelection(
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

function defaultExecutionWorkspaceModeForProject(project: { executionWorkspacePolicy?: { enabled?: boolean; defaultMode?: string | null } | null } | null | undefined) {
  const defaultMode = project?.executionWorkspacePolicy?.enabled ? project.executionWorkspacePolicy.defaultMode : null;
  if (defaultMode === "isolated_workspace" || defaultMode === "operator_branch") return defaultMode;
  if (defaultMode === "adapter_default") return "agent_default";
  return "shared_workspace";
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
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
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
        title={
          copied
            ? t("issueWorkspaceCard.copied", { defaultValue: "Copied!" })
            : t("issueWorkspaceCard.copy", { defaultValue: "Copy" })
        }
      >
        {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}

function workspaceModeLabel(t: TFunction, mode: string | null | undefined) {
  switch (mode) {
    case "isolated_workspace":
      return t("issueWorkspaceCard.mode.isolatedWorkspace", { defaultValue: "Isolated workspace" });
    case "operator_branch":
      return t("issueWorkspaceCard.mode.operatorBranch", { defaultValue: "Operator branch" });
    case "cloud_sandbox":
      return t("issueWorkspaceCard.mode.cloudSandbox", { defaultValue: "Cloud sandbox" });
    case "adapter_managed":
      return t("issueWorkspaceCard.mode.adapterManaged", { defaultValue: "Adapter managed" });
    default:
      return t("issueWorkspaceCard.mode.workspace", { defaultValue: "Workspace" });
  }
}

function configuredWorkspaceLabel(
  t: TFunction,
  selection: string | null | undefined,
  reusableWorkspace: ExecutionWorkspace | null,
) {
  switch (selection) {
    case "isolated_workspace":
      return t("issueWorkspaceCard.selection.newIsolated", { defaultValue: "New isolated workspace" });
    case "reuse_existing":
      return reusableWorkspace?.mode === "isolated_workspace"
        ? t("issueWorkspaceCard.selection.existingIsolated", { defaultValue: "Existing isolated workspace" })
        : t("issueWorkspaceCard.selection.reuseExisting", { defaultValue: "Reuse existing workspace" });
    default:
      return t("issueWorkspaceCard.selection.projectDefault", { defaultValue: "Project default" });
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

function statusBadge(t: TFunction, status: string) {
  const colors: Record<string, string> = {
    active: "bg-green-500/15 text-green-700 dark:text-green-400",
    idle: "bg-muted text-muted-foreground",
    in_review: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
    archived: "bg-muted text-muted-foreground",
  };
  return (
    <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", colors[status] ?? colors.idle)}>
      {t(`issueWorkspaceCard.status.${status}`, { defaultValue: status.replace(/_/g, " ") })}
    </span>
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
  onDraftChange?: (data: Record<string, unknown>, meta: { canSave: boolean; workspaceBranchName?: string | null }) => void;
}

export function IssueWorkspaceCard({
  issue,
  project,
  onUpdate,
  initialEditing = false,
  livePreview = false,
  onDraftChange,
}: IssueWorkspaceCardProps) {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const companyId = issue.companyId ?? selectedCompanyId;
  const [editing, setEditing] = useState(initialEditing);

  const executionWorkspaceOptions = useMemo(
    () => [
      {
        value: "shared_workspace",
        label: t("issueWorkspaceCard.option.projectDefault", { defaultValue: "Project default" }),
      },
      {
        value: "isolated_workspace",
        label: t("issueWorkspaceCard.option.newIsolated", { defaultValue: "New isolated workspace" }),
      },
      {
        value: "reuse_existing",
        label: t("issueWorkspaceCard.option.reuseExisting", { defaultValue: "Reuse existing workspace" }),
      },
    ] as const,
    [t],
  );

  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  const environmentsEnabled = experimentalSettings?.enableEnvironments === true;
  const policyEnabled = experimentalSettings?.enableIsolatedWorkspaces === true
    && Boolean(project?.executionWorkspacePolicy?.enabled);

  const workspace = issue.currentExecutionWorkspace as ExecutionWorkspace | null | undefined;
  const { data: environments } = useQuery({
    queryKey: queryKeys.environments.list(companyId!),
    queryFn: () => environmentsApi.list(companyId!),
    enabled: Boolean(companyId) && environmentsEnabled,
  });

  const { data: reusableExecutionWorkspaces } = useQuery({
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
    enabled: Boolean(companyId) && Boolean(issue.projectId) && editing,
  });

  const deduplicatedReusableWorkspaces = useMemo(() => {
    return orderReusableExecutionWorkspaces(reusableExecutionWorkspaces ?? []);
  }, [reusableExecutionWorkspaces]);

  const selectedReusableExecutionWorkspace =
    deduplicatedReusableWorkspaces.find((w) => w.id === issue.executionWorkspaceId)
    ?? workspace
    ?? null;

  const currentSelection = shouldPresentExistingWorkspaceSelection(issue)
    ? "reuse_existing"
    : (
        issue.executionWorkspacePreference
        ?? issue.executionWorkspaceSettings?.mode
        ?? defaultExecutionWorkspaceModeForProject(project)
      );

  const [draftSelection, setDraftSelection] = useState(currentSelection);
  const [draftExecutionWorkspaceId, setDraftExecutionWorkspaceId] = useState(issue.executionWorkspaceId ?? "");
  const [draftEnvironmentId, setDraftEnvironmentId] = useState(issue.executionWorkspaceSettings?.environmentId ?? "");
  const projectEnvironmentId = environmentsEnabled
    ? project?.executionWorkspacePolicy?.environmentId ?? null
    : null;
  const currentReusableEnvironmentId = selectedReusableExecutionWorkspace?.config?.environmentId ?? null;
  const currentEnvironmentId = environmentsEnabled
    ? (
        (currentSelection === "reuse_existing" && currentReusableEnvironmentId)
        ?? workspace?.config?.environmentId
        ?? issue.executionWorkspaceSettings?.environmentId
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
    setDraftEnvironmentId(issue.executionWorkspaceSettings?.environmentId ?? "");
  }, [currentSelection, editing, issue.executionWorkspaceId, issue.executionWorkspaceSettings?.environmentId]);

  const activeNonDefaultWorkspace = Boolean(workspace && workspace.mode !== "shared_workspace");

  const configuredReusableWorkspace =
    deduplicatedReusableWorkspaces.find((w) => w.id === draftExecutionWorkspaceId)
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
  const reuseExistingSelection = draftSelection === "reuse_existing";
  const selectedReusableEnvironmentId = configuredReusableWorkspace?.config?.environmentId ?? "";
  const runSelectableEnvironments = useMemo(
    () => environmentsEnabled ? (environments ?? []).filter((environment) => {
      if (environment.driver === "local" || environment.driver === "ssh") return true;
      if (environment.driver !== "sandbox") return false;
      const provider = typeof environment.config?.provider === "string" ? environment.config.provider : null;
      return provider !== null && provider !== "fake";
    }) : [],
    [environments, environmentsEnabled],
  );
  const draftWorkspaceBranchName =
    draftSelection === "reuse_existing" && configuredReusableWorkspace?.mode !== "shared_workspace"
      ? configuredReusableWorkspace?.branchName ?? null
      : null;

  const buildWorkspaceDraftUpdate = useCallback(() => ({
    executionWorkspacePreference: draftSelection,
    executionWorkspaceId: draftSelection === "reuse_existing" ? draftExecutionWorkspaceId || null : null,
    executionWorkspaceSettings: {
      mode:
        draftSelection === "reuse_existing"
          ? issueModeForExistingWorkspace(configuredReusableWorkspace?.mode)
          : draftSelection,
      environmentId: draftSelection === "reuse_existing" ? null : draftEnvironmentId || null,
    },
  }), [
    configuredReusableWorkspace?.mode,
    draftEnvironmentId,
    draftExecutionWorkspaceId,
    draftSelection,
  ]);

  useEffect(() => {
    if (!onDraftChange) return;
    onDraftChange(buildWorkspaceDraftUpdate(), {
      canSave: canSaveWorkspaceConfig,
      workspaceBranchName: draftWorkspaceBranchName,
    });
  }, [buildWorkspaceDraftUpdate, canSaveWorkspaceConfig, draftWorkspaceBranchName, onDraftChange]);

  const handleSave = useCallback(() => {
    if (!canSaveWorkspaceConfig) return;
    onUpdate(buildWorkspaceDraftUpdate());
    setEditing(false);
  }, [
    buildWorkspaceDraftUpdate,
    canSaveWorkspaceConfig,
    onUpdate,
  ]);

  const handleCancel = useCallback(() => {
    setDraftSelection(currentSelection);
    setDraftExecutionWorkspaceId(issue.executionWorkspaceId ?? "");
    setDraftEnvironmentId(issue.executionWorkspaceSettings?.environmentId ?? "");
    setEditing(false);
  }, [currentSelection, issue.executionWorkspaceId, issue.executionWorkspaceSettings?.environmentId]);

  if (!policyEnabled || !project) return null;

  const showEditingControls = livePreview || editing;

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
          {activeNonDefaultWorkspace && workspace
            ? workspaceModeLabel(t, workspace.mode)
            : configuredWorkspaceLabel(t, currentSelection, selectedReusableExecutionWorkspace)}
          {workspace ? statusBadge(t, workspace.status) : statusBadge(t, "idle")}
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
                <X className="h-3 w-3 mr-1" />
                {t("issueWorkspaceCard.cancel", { defaultValue: "Cancel" })}
              </Button>
              <Button
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={handleSave}
                disabled={!canSaveWorkspaceConfig}
              >
                {t("issueWorkspaceCard.save", { defaultValue: "Save" })}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-3 w-3 mr-1" />
              {t("issueWorkspaceCard.edit", { defaultValue: "Edit" })}
            </Button>
          )}
        </div>
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
          {workspace?.cwd && (
            <div className="flex items-center gap-1.5">
              <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
              <CopyableInline value={workspace.cwd} mono />
            </div>
          )}
          {workspace?.repoUrl && (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <span className="text-[11px]">{t("issueWorkspaceCard.repoLabel", { defaultValue: "Repo:" })}</span>
              <CopyableInline value={workspace.repoUrl} mono />
            </div>
          )}
          {environmentsEnabled && currentEnvironmentId && (
            <div className="text-muted-foreground" style={{ overflowWrap: "anywhere" }}>
              {t("issueWorkspaceCard.environmentLabel", { defaultValue: "Environment:" })}{" "}
              <span className="text-foreground">{currentEnvironment?.name ?? currentEnvironmentId}</span>
              {currentSelection === "reuse_existing" && currentReusableEnvironmentId === currentEnvironmentId
                ? ` · ${t("issueWorkspaceCard.reusedWorkspaceSuffix", { defaultValue: "reused workspace" })}`
                : !issue.executionWorkspaceSettings?.environmentId && projectEnvironmentId === currentEnvironmentId
                ? ` · ${t("issueWorkspaceCard.projectDefaultSuffix", { defaultValue: "project default" })}`
                : null}
            </div>
          )}
          {!workspace && (
            <div className="text-muted-foreground">
              {currentSelection === "isolated_workspace"
                ? t("issueWorkspaceCard.willCreateIsolated", {
                    defaultValue: "A fresh isolated workspace will be created when this issue runs.",
                  })
                : currentSelection === "reuse_existing"
                  ? t("issueWorkspaceCard.willReuseExisting", {
                      defaultValue: "This issue will reuse an existing workspace when it runs.",
                    })
                  : t("issueWorkspaceCard.willUseProjectDefault", {
                      defaultValue: "This issue will use the project default workspace configuration when it runs.",
                    })}
            </div>
          )}
          {currentSelection === "reuse_existing" && selectedReusableExecutionWorkspace && (
            <div className="text-muted-foreground" style={{ overflowWrap: "anywhere" }}>
              {t("issueWorkspaceCard.reusingLabel", { defaultValue: "Reusing:" })}{" "}
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
                className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
              >
                {t("issueWorkspaceCard.viewWorkspaceDetails", { defaultValue: "View workspace details →" })}
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
                setDraftExecutionWorkspaceId("");
              } else if (!draftExecutionWorkspaceId && issue.executionWorkspaceId) {
                setDraftExecutionWorkspaceId(issue.executionWorkspaceId);
              }
            }}
          >
            {executionWorkspaceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.value === "reuse_existing" && configuredReusableWorkspace?.mode === "isolated_workspace"
                  ? t("issueWorkspaceCard.selection.existingIsolated", { defaultValue: "Existing isolated workspace" })
                  : option.label}
              </option>
            ))}
          </select>

          {draftSelection === "reuse_existing" && (
            <select
              className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-xs outline-none"
              value={draftExecutionWorkspaceId}
              onChange={(e) => {
                setDraftExecutionWorkspaceId(e.target.value);
              }}
            >
              <option value="">
                {t("issueWorkspaceCard.chooseExistingWorkspace", { defaultValue: "Choose an existing workspace" })}
              </option>
              {deduplicatedReusableWorkspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · {w.status} · {w.branchName ?? w.cwd ?? w.id.slice(0, 8)}
                </option>
              ))}
            </select>
          )}

          {environmentsEnabled ? (
            <>
              <select
                className={cn(
                  "w-full rounded border border-border bg-transparent px-2 py-1.5 text-xs outline-none",
                  reuseExistingSelection && "cursor-not-allowed opacity-70",
                )}
                value={reuseExistingSelection ? selectedReusableEnvironmentId : draftEnvironmentId}
                onChange={(e) => setDraftEnvironmentId(e.target.value)}
                disabled={reuseExistingSelection}
              >
                <option value="">
                  {reuseExistingSelection
                    ? configuredReusableWorkspace
                      ? t("issueWorkspaceCard.noEnvironmentOnReused", {
                          defaultValue: "No environment on reused workspace",
                        })
                      : t("issueWorkspaceCard.selectWorkspaceForEnvironment", {
                          defaultValue: "Select an existing workspace to inspect its environment",
                        })
                    : projectEnvironmentId
                      ? t("issueWorkspaceCard.projectDefaultEnvironment", {
                          defaultValue: "Project default environment",
                        })
                      : t("issueWorkspaceCard.noEnvironment", { defaultValue: "No environment" })}
                </option>
                {runSelectableEnvironments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name} · {environment.driver}
                  </option>
                ))}
              </select>
              {reuseExistingSelection && (
                <div className="text-[11px] text-muted-foreground">
                  {configuredReusableWorkspace
                    ? t("issueWorkspaceCard.environmentLockedReuse", {
                        defaultValue:
                          "Environment selection is locked while reusing an existing workspace. The next run will use that workspace's persisted environment config.",
                      })
                    : t("issueWorkspaceCard.environmentLockedChooseFirst", {
                        defaultValue:
                          "Choose an existing workspace first. Its persisted environment config will determine the next run.",
                      })}
                </div>
              )}
            </>
          ) : null}

          {/* Current workspace summary when editing */}
          {workspace && (
            <div className="text-[11px] text-muted-foreground space-y-0.5 pt-1 border-t border-border/50">
              <div style={{ overflowWrap: "anywhere" }}>
                {t("issueWorkspaceCard.currentLabel", { defaultValue: "Current:" })}{" "}
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
                {workspace.status}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
