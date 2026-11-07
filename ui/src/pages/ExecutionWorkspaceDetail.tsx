import { getPageValueLabel } from "@/pages/tools/shared";
import { useTranslation, t } from "@/i18n";
import { useWorkspaceIsolationControls } from "@/hooks/useWorkspaceIsolationControls";
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionWorkspace, Issue, Project, ProjectWorkspace, RoutineListItem, WorkspaceOperation } from "@paperclipai/shared";
import { Copy, ExternalLink, Loader2, Play, Repeat } from "lucide-react";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { describeError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tabs } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { CopyText } from "../components/CopyText";
import { ExecutionWorkspaceCloseDialog } from "../components/ExecutionWorkspaceCloseDialog";
import { MissingPluginTabPlaceholder } from "../components/MissingPluginTabPlaceholder";
import { agentsApi } from "../api/agents";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { routinesApi } from "../api/routines";
import { IssuesList } from "../components/IssuesList";
import { PageTabBar } from "../components/PageTabBar";
import { SummarySlotCard } from "../components/SummarySlotCard";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import {
  RoutineRunVariablesDialog,
  type RoutineRunDialogSubmitData,
} from "../components/RoutineRunVariablesDialog";
import {
  buildWorkspaceRuntimeControlSections,
  buildWorkspaceServiceControlEntries,
  resolveWorkspaceServiceControlRequests,
  WorkspaceRuntimeControls,
  type WorkspaceRuntimeControlRequest,
} from "../components/WorkspaceRuntimeControls";
import { WorkspaceServiceControlBar } from "../components/WorkspaceServiceControlBar";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useManagedSandboxOnly } from "../hooks/useManagedSandboxOnly";
import { useToastActions } from "../context/ToastContext";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, issueUrl, projectRouteRef, projectWorkspaceUrl } from "../lib/utils";
import {
  getWorkspaceSpecificRoutineVariableNames,
  routineHasWorkspaceSpecificVariables,
  sortWorkspaceRoutinesByName,
} from "../lib/workspace-routines";
import { useUpdateIssueMutation } from "../hooks/useUpdateIssueMutation";

type WorkspaceFormState = {
  name: string;
  cwd: string;
  repoUrl: string;
  baseRef: string;
  branchName: string;
  providerRef: string;
  provisionCommand: string;
  runtimeProvisionCommand: string;
  teardownCommand: string;
  cleanupCommand: string;
  inheritRuntime: boolean;
  workspaceRuntime: string;
};

type ConfiguredRuntimeServicePort = {
  collection: "commands" | "services";
  index: number;
  name: string;
  port: number | null;
  invalidPort: boolean;
};

type ExecutionWorkspaceBaseTab = "services" | "configuration" | "runtime_logs" | "issues" | "routines";
type ExecutionWorkspacePluginTab = `plugin:${string}`;
type ExecutionWorkspaceTab = ExecutionWorkspaceBaseTab | ExecutionWorkspacePluginTab;
type OrderedExecutionWorkspaceTabItem = {
  value: ExecutionWorkspaceTab;
  label: string;
  order: number;
};

const DEFAULT_PLUGIN_DETAIL_TAB_ORDER = 100;
const EXECUTION_WORKSPACE_BASE_TAB_ITEMS: OrderedExecutionWorkspaceTabItem[] = [
  { value: "issues", get label() { return t("work:copy.tasks_b3a60e"); }, order: 10 },
  { value: "services", get label() { return t("work:copy.services_604dce"); }, order: 20 },
  { value: "configuration", get label() { return t("work:copy.configuration_b332c3"); }, order: 30 },
  { value: "runtime_logs", get label() { return t("work:copy.runtimeLogs_36d4ba"); }, order: 40 },
  { value: "routines", get label() { return t("work:copy.routines_61b7bb"); }, order: 60 },
];

function isExecutionWorkspacePluginTab(value: string | null): value is ExecutionWorkspacePluginTab {
  return typeof value === "string" && value.startsWith("plugin:");
}

function orderExecutionWorkspaceTabItems(items: OrderedExecutionWorkspaceTabItem[]) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.order - right.item.order || left.index - right.index)
    .map(({ item }) => item);
}

function resolveExecutionWorkspaceTab(pathname: string, workspaceId: string): ExecutionWorkspaceBaseTab | null {
  const segments = pathname.split("/").filter(Boolean);
  const executionWorkspacesIndex = segments.indexOf("execution-workspaces");
  if (executionWorkspacesIndex === -1 || segments[executionWorkspacesIndex + 1] !== workspaceId) return null;
  const tab = segments[executionWorkspacesIndex + 2];
  if (tab === "services") return "services";
  if (tab === "issues") return "issues";
  if (tab === "routines") return "routines";
  if (tab === "runtime-logs") return "runtime_logs";
  if (tab === "configuration") return "configuration";
  return null;
}

function executionWorkspaceTabPath(workspaceId: string, tab: ExecutionWorkspaceBaseTab) {
  const segment = tab === "runtime_logs" ? "runtime-logs" : tab;
  return `/execution-workspaces/${workspaceId}/${segment}`;
}

function LegacyWorkspaceTabRedirect({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation("work");
  useEffect(() => {
    try {
      localStorage.removeItem(`paperclip:execution-workspace-tab:${workspaceId}`);
    } catch {}
  }, [workspaceId]);

  return <Navigate to={executionWorkspaceTabPath(workspaceId, "issues")} replace />;
}

function isSafeExternalUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function readText(value: string | null | undefined) {
  return value ?? "";
}

function formatJson(value: Record<string, unknown> | null | undefined) {
  if (!value || Object.keys(value).length === 0) return "";
  return JSON.stringify(value, null, 2);
}

function formatOptionalDateTime(value: Date | string | null | undefined) {
  return value ? formatDateTime(value) : t("work:copy.never_6300ef");
}

function normalizeText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseWorkspaceRuntimeJson(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true as const, value: null as Record<string, unknown> | null };

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false as const,
        error: t("work:copy.workspaceCommandsJSONMustBeAJSONObject_0274dc"),
      };
    }
    return { ok: true as const, value: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : t("work:copy.invalidJSON_70fdde"),
    };
  }
}

export function readConfiguredRuntimeServicePorts(runtimeConfig: Record<string, unknown> | null) {
  if (!runtimeConfig) return [] as ConfiguredRuntimeServicePort[];

  const entries: ConfiguredRuntimeServicePort[] = [];
  const addServices = (collection: ConfiguredRuntimeServicePort["collection"], services: unknown, commandsRequireServiceKind: boolean) => {
    if (!Array.isArray(services)) return;
    services.forEach((service, index) => {
      if (!service || typeof service !== "object" || Array.isArray(service)) return;
      const config = service as Record<string, unknown>;
      if (commandsRequireServiceKind && config.kind !== "service") return;
      const portConfig = config.port;
      const hasObjectPortValue = Boolean(
        portConfig
        && typeof portConfig === "object"
        && !Array.isArray(portConfig)
        && Object.hasOwn(portConfig, "value"),
      );
      const portValue =
        typeof portConfig === "number"
          ? portConfig
          : hasObjectPortValue
            ? (portConfig as Record<string, unknown>).value
            : null;
      entries.push({
        collection,
        index,
        name: typeof config.name === "string" && config.name.trim() ? config.name : t("work:extra.message_0ac10d21c1", { value1: index + 1 }),
        port: typeof portValue === "number" ? portValue : null,
        invalidPort: (typeof portConfig === "number" || hasObjectPortValue)
          && (typeof portValue !== "number" || !Number.isInteger(portValue) || portValue < 1 || portValue > 65535),
      });
    });
  };

  addServices("commands", runtimeConfig.commands, true);
  addServices("services", runtimeConfig.services, false);
  return entries;
}

export function updateConfiguredRuntimeServicePort(input: {
  runtimeConfig: Record<string, unknown>;
  service: ConfiguredRuntimeServicePort;
  port: string;
}) {
  const runtimeConfig = structuredClone(input.runtimeConfig);
  const entries = runtimeConfig[input.service.collection];
  if (!Array.isArray(entries)) return runtimeConfig;
  const entry = entries[input.service.index];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return runtimeConfig;
  const config = entry as Record<string, unknown>;
  const existingPort = config.port && typeof config.port === "object" && !Array.isArray(config.port)
    ? config.port as Record<string, unknown>
    : null;

  const trimmedPort = input.port.trim();
  if (!trimmedPort) {
    if (existingPort) {
      const autoPort: Record<string, unknown> = { ...existingPort, type: "auto" };
      delete autoPort.value;
      config.port = autoPort;
    } else {
      delete config.port;
    }
    return runtimeConfig;
  }
  const port = Number(trimmedPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return runtimeConfig;
  config.port = { ...existingPort, type: "fixed", value: port };
  return runtimeConfig;
}

export function getConfiguredRuntimeServicePortWarnings(services: ConfiguredRuntimeServicePort[]) {
  const servicesByPort = new Map<number, ConfiguredRuntimeServicePort[]>();
  for (const service of services) {
    if (service.invalidPort || !service.port) continue;
    const servicesForPort = servicesByPort.get(service.port) ?? [];
    servicesForPort.push(service);
    servicesByPort.set(service.port, servicesForPort);
  }

  return Array.from(servicesByPort.entries())
    .filter(([, servicesForPort]) => servicesForPort.length > 1)
    .map(([port, servicesForPort]) =>
      t("work:copy.portIsAssignedToMultipleServices_e58ee9", { value1: port, value2: servicesForPort.map((service) => service.name).join(", ") }),
    );
}

function formStateFromWorkspace(workspace: ExecutionWorkspace): WorkspaceFormState {
  return {
    name: workspace.name,
    cwd: readText(workspace.cwd),
    repoUrl: readText(workspace.repoUrl),
    baseRef: readText(workspace.baseRef),
    branchName: readText(workspace.branchName),
    providerRef: readText(workspace.providerRef),
    provisionCommand: readText(workspace.config?.provisionCommand),
    runtimeProvisionCommand: readText(workspace.config?.runtimeProvisionCommand),
    teardownCommand: readText(workspace.config?.teardownCommand),
    cleanupCommand: readText(workspace.config?.cleanupCommand),
    inheritRuntime: !workspace.config?.workspaceRuntime,
    workspaceRuntime: formatJson(workspace.config?.workspaceRuntime),
  };
}

function buildWorkspacePatch(initialState: WorkspaceFormState, nextState: WorkspaceFormState) {
  const patch: Record<string, unknown> = {};
  const configPatch: Record<string, unknown> = {};

  const maybeAssign = (
    key: keyof Pick<WorkspaceFormState, "name" | "cwd" | "repoUrl" | "baseRef" | "branchName" | "providerRef">,
  ) => {
    if (initialState[key] === nextState[key]) return;
    patch[key] = key === "name" ? (normalizeText(nextState[key]) ?? initialState.name) : normalizeText(nextState[key]);
  };

  maybeAssign("name");
  maybeAssign("cwd");
  maybeAssign("repoUrl");
  maybeAssign("baseRef");
  maybeAssign("branchName");
  maybeAssign("providerRef");

  const maybeAssignConfigText = (key: keyof Pick<WorkspaceFormState, "provisionCommand" | "runtimeProvisionCommand" | "teardownCommand" | "cleanupCommand">) => {
    if (initialState[key] === nextState[key]) return;
    configPatch[key] = normalizeText(nextState[key]);
  };

  maybeAssignConfigText("provisionCommand");
  maybeAssignConfigText("runtimeProvisionCommand");
  maybeAssignConfigText("teardownCommand");
  maybeAssignConfigText("cleanupCommand");

  if (initialState.inheritRuntime !== nextState.inheritRuntime || initialState.workspaceRuntime !== nextState.workspaceRuntime) {
    const parsed = parseWorkspaceRuntimeJson(nextState.workspaceRuntime);
    if (!parsed.ok) throw new Error(parsed.error);
    configPatch.workspaceRuntime = nextState.inheritRuntime ? null : parsed.value;
  }

  if (Object.keys(configPatch).length > 0) {
    patch.config = configPatch;
  }

  return patch;
}

function validateForm(form: WorkspaceFormState) {
  const repoUrl = normalizeText(form.repoUrl);
  if (repoUrl) {
    try {
      new URL(repoUrl);
    } catch {
      return t("work:copy.repoURLMustBeAValidURL_fe0386");
    }
  }

  if (!form.inheritRuntime) {
    const runtimeJson = parseWorkspaceRuntimeJson(form.workspaceRuntime);
    if (!runtimeJson.ok) {
      return runtimeJson.error;
    }
    const invalidPort = readConfiguredRuntimeServicePorts(runtimeJson.value).find((service) => service.invalidPort);
    if (invalidPort) return t("work:copy.hasAnInvalidFixedPort_9a3e1c", { value1: invalidPort.name });
  }

  return null;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("work");
  return (
    <label className="block space-y-2">
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {hint ? <span className="text-xs text-muted-foreground sm:text-right">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

function workspaceOperationPhaseLabel(phase: string) {
  switch (phase) {
    case "worktree_prepare":
      return t("work:copy.worktreeSetup_550db5");
    case "workspace_config_freshness":
      return t("work:copy.configFreshness_bf4c3a");
    case "workspace_provision":
      return t("work:copy.provision_41112a");
    case "workspace_seed":
      return t("work:copy.databaseSeed_42ea0f");
    case "workspace_runtime_provision":
      return t("work:copy.runtimeProvision_7f8e2d");
    case "workspace_teardown":
      return t("work:copy.teardown_3a0130");
    case "worktree_cleanup":
      return t("work:copy.worktreeCleanup_2a0930");
    case "workspace_finalize":
      return t("work:copy.finalize_bcc55d");
    default:
      return phase;
  }
}

export type RuntimeProvisionStatus =
  | { kind: "eager" }
  | { kind: "deferred" }
  | { kind: "provisioning"; at: Date | null }
  | { kind: "provisioned"; at: Date | null }
  | { kind: "failed"; at: Date | null };

/**
 * Derives the lazy runtime-provisioning state from the configured command and the
 * database-seed or runtime-provision operation-log entries (most-recent first). Returns
 * "eager" when no runtime provision command is configured (the legacy path).
 */
export function resolveRuntimeProvisionStatus(input: {
  runtimeProvisionCommand: string | null | undefined;
  operations: WorkspaceOperation[] | undefined;
}): RuntimeProvisionStatus {
  const latest = (input.operations ?? []).find((operation) => (
    operation.phase === "workspace_seed" || operation.phase === "workspace_runtime_provision"
  )) ?? null;
  if (latest) {
    const at = latest.finishedAt ?? latest.startedAt ?? null;
    if (latest.status === "running") return { kind: "provisioning", at };
    if (latest.status === "succeeded") return { kind: "provisioned", at };
    if (latest.status === "failed") return { kind: "failed", at };
    // "skipped" falls through to the config-derived state below.
  }
  const configured = Boolean(input.runtimeProvisionCommand && input.runtimeProvisionCommand.trim());
  return configured ? { kind: "deferred" } : { kind: "eager" };
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  const { t } = useTranslation("work");
  return (
    <div className="flex flex-col gap-1.5 py-1.5 sm:flex-row sm:items-start sm:gap-3">
      <div className="shrink-0 text-xs text-muted-foreground sm:w-32">{label}</div>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

function StatusPill({ children, className }: { children: React.ReactNode; className?: string }) {
  const { t } = useTranslation("work");
  return (
    <div className={cn("inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground", className)}>
      {children}
    </div>
  );
}

export function RuntimeProvisionStatusValue({
  status,
  onViewLogs,
}: {
  status: RuntimeProvisionStatus;
  onViewLogs: () => void;
}) {
  const { t } = useTranslation("work");
  if (status.kind === "eager") {
    return (
      <span className="text-sm text-muted-foreground">{t("work:copy.eagerProvisionedDuringWorkspaceSetup_c4fcca")}</span>
    );
  }
  if (status.kind === "deferred") {
    return (
      <div className="flex flex-col gap-1">
        <StatusPill className="border-amber-500/40 text-amber-600 dark:text-amber-400">{t("work:copy.deferred_1fc4d2")}</StatusPill>
        <span className="text-xs text-muted-foreground">{t("work:copy.runsOnceBeforeTheFirstRuntimeServiceStart_12f7ac")}</span>
      </div>
    );
  }
  if (status.kind === "provisioning") {
    return (
      <StatusPill className="border-border text-muted-foreground">
        <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />{t("work:copy.provisioning_62cd0e")}</StatusPill>
    );
  }
  if (status.kind === "provisioned") {
    return (
      <StatusPill className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">{t("work:copy.provisioned_a73be0")}{status.at ? ` · ${formatDateTime(status.at)}` : ""}
      </StatusPill>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <StatusPill className="border-destructive/50 text-destructive">{t("work:copy.provisioningFailed_e02430")}{status.at ? ` · ${formatDateTime(status.at)}` : ""}
      </StatusPill>
      <button type="button" onClick={onViewLogs} className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">{t("work:copy.viewRuntimeLogs_ac37f8")}</button>
    </div>
  );
}

function MonoValue({ value, copy }: { value: string; copy?: boolean }) {
  const { t } = useTranslation("work");
  return (
    <div className="inline-flex max-w-full items-start gap-2">
      <span className="break-all font-mono text-xs">{value}</span>
      {copy ? (
        <CopyText text={value} className="shrink-0 text-muted-foreground hover:text-foreground" copiedLabel={t("work:copy.copied_8d525e")}>
          <Copy className="h-3.5 w-3.5" />
        </CopyText>
      ) : null}
    </div>
  );
}

function WorkspaceLink({
  project,
  workspace,
}: {
  project: Project;
  workspace: ProjectWorkspace;
}) {
  const { t } = useTranslation("work");
  return <Link to={projectWorkspaceUrl(project, workspace.id)} className="hover:underline">{workspace.name}</Link>;
}

function ExecutionWorkspaceIssuesList({
  companyId,
  workspace,
  issues,
  isLoading,
  error,
  project,
}: {
  companyId: string;
  workspace: ExecutionWorkspace;
  issues: Issue[];
  isLoading: boolean;
  error: Error | null;
  project: Project | null;
}) {
  const { t } = useTranslation("work");
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const liveRunsQueryKey = queryKeys.liveRuns(companyId);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!companyId,
    // Event-sourced via LiveUpdatesProvider (issue 9627); no interval poll needed.
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);

  const liveIssueIds = useMemo(() => collectLiveIssueIds(liveRuns, issues), [issues, liveRuns, t]);

  const updateIssue = useUpdateIssueMutation({
    companyId,
    invalidateKeys: [
      queryKeys.issues.listByExecutionWorkspace(companyId, workspace.id),
      queryKeys.issues.list(companyId),
      ...(project?.id ? [queryKeys.issues.listByProject(companyId, project.id)] : []),
    ],
  });

  const projectOptions = useMemo(
    () => (project ? [{ id: project.id, name: project.name, workspaces: project.workspaces ?? [] }] : undefined),
    [project, t],
  );
  const createIssueDefaults = useMemo(
    () => ({
      projectId: workspace.projectId,
      ...(workspace.projectWorkspaceId ? { projectWorkspaceId: workspace.projectWorkspaceId } : {}),
      executionWorkspaceId: workspace.id,
      executionWorkspaceMode: "reuse_existing",
    }),
    [workspace.id, workspace.projectId, workspace.projectWorkspaceId, t],
  );

  return (
    <IssuesList
      issues={issues}
      isLoading={isLoading}
      error={error}
      agents={agents}
      projects={projectOptions}
      liveIssueIds={liveIssueIds}
      projectId={project?.id}
      viewStateKey="paperclip:execution-workspace-issues-view"
      baseCreateIssueDefaults={createIssueDefaults}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}

function WorkspaceRoutineRow({
  routine,
  variableNames,
  runningRoutineId,
  onRunNow,
}: {
  routine: RoutineListItem;
  variableNames: string[];
  runningRoutineId: string | null;
  onRunNow: (routine: RoutineListItem) => void;
}) {
  const { t } = useTranslation("work");
  const isArchived = routine.status === "archived";
  const isRunning = runningRoutineId === routine.id;

  return (
    <div className="flex flex-col gap-3 border-b border-border px-3 py-3 last:border-b-0 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/routines/${routine.id}`} className="truncate text-sm font-medium hover:underline">
            {routine.title}
          </Link>
          {routine.status !== "active" ? (
            <span className="text-xs text-muted-foreground">{getPageValueLabel(routine.status)}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{routine.assigneeAgentId ? t("work:copy.defaultAgentSet_7b88c3") : t("work:copy.chooseAgentWhenRunning_792eed")}</span>
          <span>{t("work:copy.lastRun_512a48")}{" "}{formatOptionalDateTime(routine.lastRun?.triggeredAt ?? routine.lastTriggeredAt)}</span>
          <span className="flex flex-wrap gap-1">
            {variableNames.map((name) => (
              <span key={name} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-(length:--text-micro) text-muted-foreground">
                {name}
              </span>
            ))}
          </span>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="w-full sm:w-auto"
        disabled={isArchived || isRunning}
        onClick={() => onRunNow(routine)}
      >
        {isRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
        {isRunning ? t("work:copy.running_4977a7") : t("work:copy.runNow_099139")}
      </Button>
    </div>
  );
}

function ExecutionWorkspaceRoutinesList({
  workspace,
  project,
}: {
  workspace: ExecutionWorkspace;
  project: Project | null;
}) {
  const { t } = useTranslation("work");
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [runDialogRoutine, setRunDialogRoutine] = useState<RoutineListItem | null>(null);
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);

  const routinesQuery = useQuery({
    queryKey: queryKeys.routines.list(workspace.companyId, { projectId: workspace.projectId }),
    queryFn: () => routinesApi.list(workspace.companyId, { projectId: workspace.projectId }),
  });
  // Read the routine list through the shared view: cached rows stay usable
  // during a transient refetch failure,and a no-data failure shows readable
  // copy with Retry.
  const routinesView = useQueryView(routinesQuery);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(workspace.companyId),
    queryFn: () => agentsApi.list(workspace.companyId),
  });

  const workspaceRoutines = useMemo(
    () => sortWorkspaceRoutinesByName((routinesQuery.data ?? []).filter(routineHasWorkspaceSpecificVariables)),
    [routinesQuery.data, t],
  );

  const runRoutine = useMutation({
    mutationFn: ({ id, data }: { id: string; data?: RoutineRunDialogSubmitData }) => routinesApi.run(id, {
      ...(data?.variables && Object.keys(data.variables).length > 0 ? { variables: data.variables } : {}),
      ...(data?.assigneeAgentId !== undefined ? { assigneeAgentId: data.assigneeAgentId } : {}),
      ...(data?.projectId !== undefined ? { projectId: data.projectId } : {}),
      ...(data?.executionWorkspaceId !== undefined ? { executionWorkspaceId: data.executionWorkspaceId } : {}),
      ...(data?.executionWorkspacePreference !== undefined
        ? { executionWorkspacePreference: data.executionWorkspacePreference }
        : {}),
      ...(data?.executionWorkspaceSettings !== undefined
        ? { executionWorkspaceSettings: data.executionWorkspaceSettings }
        : {}),
    }),
    onMutate: ({ id }) => {
      setRunningRoutineId(id);
    },
    onSuccess: async (_, { id }) => {
      setRunDialogRoutine(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["routines", workspace.companyId] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByExecutionWorkspace(workspace.companyId, workspace.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(workspace.companyId) }),
      ]);
      pushToast({
        title: t("work:copy.routineStarted_768fcb"),
        body: t("work:copy.paperclipCreatedARunUsingThisExecutionWorkspace_cf288a"),
        tone: "success",
      });
    },
    onSettled: () => {
      setRunningRoutineId(null);
    },
    onError: (mutationError) => {
      pushToast({
        title: t("work:copy.routineRunFailed_296c7c"),
        body: describeError(mutationError).body,
        tone: "error",
      });
    },
  });

  return (
    <>
      <Card className="rounded-none">
        <CardHeader>
          <CardTitle>{t("work:copy.workspaceRoutines_b58481")}</CardTitle>
          <CardDescription>{t("work:copy.routinesThatUseWorkspaceSpecificVariablesCanBeRun_a72021")}</CardDescription>
        </CardHeader>
        <CardContent>
          {routinesView.kind === "loading" || routinesView.kind === "reconnecting" ? (
            <p className="text-sm text-muted-foreground">{t("work:copy.loadingRoutines_e35112")}</p>
          ) : routinesView.kind === "error" ? (
            <QueryErrorState
              size="inline"
              error={routinesView.error}
              action={t("work:copy.loadWorkspaceRoutines_ebda6f")}
              onRetry={routinesView.retry}
              retrying={routinesView.isFetching}
            />
          ) : workspaceRoutines.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Repeat className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t("work:copy.noRoutinesUseWorkspaceSpecificVariablesYet_fbd893")}</p>
            </div>
          ) : (
            <div className="rounded-lg border border-border">
              {workspaceRoutines.map((routine) => (
                <WorkspaceRoutineRow
                  key={routine.id}
                  routine={routine}
                  variableNames={getWorkspaceSpecificRoutineVariableNames(routine)}
                  runningRoutineId={runningRoutineId}
                  onRunNow={setRunDialogRoutine}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <RoutineRunVariablesDialog
        open={runDialogRoutine !== null}
        onOpenChange={(next) => {
          if (!next) setRunDialogRoutine(null);
        }}
        companyId={workspace.companyId}
        routineName={runDialogRoutine?.title ?? null}
        agents={agents ?? []}
        projects={project ? [project] : []}
        defaultProjectId={workspace.projectId}
        defaultAssigneeAgentId={runDialogRoutine?.assigneeAgentId ?? null}
        defaultExecutionWorkspace={workspace}
        variables={runDialogRoutine?.variables ?? []}
        isPending={runRoutine.isPending}
        onSubmit={(data) => {
          if (!runDialogRoutine) return;
          runRoutine.mutate({ id: runDialogRoutine.id, data });
        }}
      />
    </>
  );
}

export function ExecutionWorkspaceDetail() {
  const { t } = useTranslation("work");
  const { visible: workspaceIsolationControlsVisible, loaded: workspaceVisibilityLoaded } = useWorkspaceIsolationControls();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { hideHostPaths } = useManagedSandboxOnly();
  const [form, setForm] = useState<WorkspaceFormState | null>(null);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [runtimeActionErrorMessage, setRuntimeActionErrorMessage] = useState<string | null>(null);
  const [runtimeActionMessage, setRuntimeActionMessage] = useState<string | null>(null);
  const [pendingRuntimeActions, setPendingRuntimeActions] = useState<WorkspaceRuntimeControlRequest[]>([]);
  const activeRouteTab = workspaceId ? resolveExecutionWorkspaceTab(location.pathname, workspaceId) : null;
  const pluginTabFromSearch = useMemo(() => {
    const tab = new URLSearchParams(location.search).get("tab");
    return isExecutionWorkspacePluginTab(tab) ? tab : null;
  }, [location.search, t]);
  const activeTab: ExecutionWorkspaceTab | null = activeRouteTab ?? pluginTabFromSearch;

  const workspaceQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.detail(workspaceId!),
    queryFn: () => executionWorkspacesApi.get(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const workspaceView = useQueryView(workspaceQuery);
  const workspace = workspaceQuery.data ?? null;

  const projectQuery = useQuery({
    queryKey: workspace?.projectId ? [...queryKeys.projects.detail(workspace.projectId), workspace.companyId] : ["projects", "detail", "__pending__"],
    queryFn: () => projectsApi.get(workspace!.projectId!, workspace!.companyId),
    enabled: Boolean(workspace?.projectId),
  });
  const project = projectQuery.data ?? null;

  const sourceIssueQuery = useQuery({
    queryKey: workspace?.sourceIssueId ? queryKeys.issues.detail(workspace.sourceIssueId) : ["issues", "detail", "__none__"],
    queryFn: () => issuesApi.get(workspace!.sourceIssueId!),
    enabled: Boolean(workspace?.sourceIssueId),
  });
  const sourceIssue = sourceIssueQuery.data ?? null;

  const derivedWorkspaceQuery = useQuery({
    queryKey: workspace?.derivedFromExecutionWorkspaceId
      ? queryKeys.executionWorkspaces.detail(workspace.derivedFromExecutionWorkspaceId)
      : ["execution-workspaces", "detail", "__none__"],
    queryFn: () => executionWorkspacesApi.get(workspace!.derivedFromExecutionWorkspaceId!),
    enabled: Boolean(workspace?.derivedFromExecutionWorkspaceId),
  });
  const derivedWorkspace = derivedWorkspaceQuery.data ?? null;
  const linkedIssuesQuery = useQuery({
    queryKey: workspace
      ? queryKeys.issues.listByExecutionWorkspace(workspace.companyId, workspace.id)
      : ["issues", "__execution-workspace__", "__none__"],
    queryFn: () => issuesApi.list(workspace!.companyId, { executionWorkspaceId: workspace!.id }),
    enabled: Boolean(workspace?.companyId),
  });
  const linkedIssuesView = useQueryView(linkedIssuesQuery);
  const linkedIssues = linkedIssuesQuery.data ?? [];

  const linkedProjectWorkspace = useMemo(
    () => project?.workspaces.find((item) => item.id === workspace?.projectWorkspaceId) ?? null,
    [project, workspace?.projectWorkspaceId, t],
  );

  const {
    slots: workspacePluginDetailSlots,
    isLoading: workspacePluginDetailSlotsLoading,
    errorMessage: workspacePluginDetailSlotsError,
  } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "execution_workspace",
    companyId: workspace?.companyId ?? null,
    enabled: !!workspace?.companyId,
  });
  const workspacePluginTabItems = useMemo(
    () => workspacePluginDetailSlots.map((slot) => ({
      value: `plugin:${slot.pluginKey}:${slot.id}` as ExecutionWorkspacePluginTab,
      label: slot.displayName,
      order: slot.order ?? DEFAULT_PLUGIN_DETAIL_TAB_ORDER,
      slot,
    })),
    [workspacePluginDetailSlots, t],
  );
  const workspaceTabItems = useMemo(
    () => orderExecutionWorkspaceTabItems([
      ...EXECUTION_WORKSPACE_BASE_TAB_ITEMS.filter((item) => item.value !== "configuration" || workspaceIsolationControlsVisible),
      ...workspacePluginTabItems,
    ]),
    [workspacePluginTabItems, workspaceIsolationControlsVisible, t],
  );
  const inheritedRuntimeConfig = linkedProjectWorkspace?.runtimeConfig?.workspaceRuntime ?? null;
  const effectiveRuntimeConfig = workspace?.config?.workspaceRuntime ?? inheritedRuntimeConfig;
  const runtimeConfigSource =
    workspace?.config?.workspaceRuntime
      ? "execution_workspace"
      : inheritedRuntimeConfig
        ? "project_workspace"
        : "none";

  const configuredRuntimeConfig = useMemo(() => {
    if (!form || form.inheritRuntime) return inheritedRuntimeConfig;
    const parsed = parseWorkspaceRuntimeJson(form.workspaceRuntime);
    return parsed.ok ? parsed.value : null;
  }, [form, inheritedRuntimeConfig, t]);
  const configuredRuntimeServicePorts = useMemo(
    () => readConfiguredRuntimeServicePorts(configuredRuntimeConfig),
    [configuredRuntimeConfig, t],
  );
  const configuredRuntimeServicePortWarnings = useMemo(
    () => getConfiguredRuntimeServicePortWarnings(configuredRuntimeServicePorts),
    [configuredRuntimeServicePorts, t],
  );

  const initialState = useMemo(() => (workspace ? formStateFromWorkspace(workspace) : null), [workspace, t]);
  const isDirty = Boolean(form && initialState && JSON.stringify(form) !== JSON.stringify(initialState));
  const projectRef = project ? projectRouteRef(project) : workspace?.projectId ?? "";

  useEffect(() => {
    if (!workspace?.companyId || workspace.companyId === selectedCompanyId) return;
    setSelectedCompanyId(workspace.companyId, { source: "route_sync" });
  }, [workspace?.companyId, selectedCompanyId, setSelectedCompanyId]);

  useEffect(() => {
    if (!workspace) return;
    setForm(formStateFromWorkspace(workspace));
    setErrorMessage(null);
    setRuntimeActionErrorMessage(null);
    setPendingRuntimeActions([]);
  }, [workspace]);

  useEffect(() => {
    if (!workspace) return;
    const crumbs = [
      { label: t("work:copy.projects_04e2a9"), href: "/projects" },
      ...(project ? [{ label: project.name, href: `/projects/${projectRef}` }] : []),
      ...(project ? [{ label: t("work:copy.workspaces_137726"), href: `/projects/${projectRef}/workspaces` }] : []),
      { label: workspace.name },
    ];
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, workspace, project, projectRef, t]);

  const updateWorkspace = useMutation({
    mutationFn: (patch: Record<string, unknown>) => executionWorkspacesApi.update(workspace!.id, patch),
    onSuccess: (nextWorkspace) => {
      queryClient.setQueryData(queryKeys.executionWorkspaces.detail(nextWorkspace.id), nextWorkspace);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.closeReadiness(nextWorkspace.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.workspaceOperations(nextWorkspace.id) });
      if (project) {
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.urlKey) });
      }
      if (sourceIssue) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(sourceIssue.id) });
      }
      setErrorMessage(null);
    },
    onError: (error) => {
      setErrorMessage(describeError(error).body);
    },
  });
  const workspaceOperationsQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.workspaceOperations(workspaceId!),
    queryFn: () => executionWorkspacesApi.listWorkspaceOperations(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  // Read workspace operations through the shared view: cached rows stay
  // visible during a transient refetch failure,and a no-data failure shows
  // readable copy with Retry.

  const opsView = useQueryView(workspaceOperationsQuery);
  const runtimeProvisionCommand =
    workspace?.config?.runtimeProvisionCommand
    ?? project?.executionWorkspacePolicy?.workspaceStrategy?.runtimeProvisionCommand
    ?? null;
  const runtimeProvisionStatus = useMemo(
    () =>
      resolveRuntimeProvisionStatus({
        runtimeProvisionCommand,
        operations: workspaceOperationsQuery.data,
      }),
    [runtimeProvisionCommand, workspaceOperationsQuery.data, t],
  );
  const controlRuntimeServices = useMutation({
    mutationFn: (request: WorkspaceRuntimeControlRequest) =>
      executionWorkspacesApi.controlRuntimeCommands(workspace!.id, request.action, request),
    onSuccess: (result, request) => {
      queryClient.setQueryData(queryKeys.executionWorkspaces.detail(result.workspace.id), result.workspace);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.overview(result.workspace.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.workspaceOperations(result.workspace.id) });
      if (result.workspace.projectId) queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(result.workspace.projectId) });
      setRuntimeActionErrorMessage(null);
      setRuntimeActionMessage(
        request.action === "run"
          ? t("work:copy.workspaceJobCompleted_776134")
          : request.action === "stop"
            ? t("work:copy.workspaceServiceStopped_7989e1")
            : request.action === "restart"
              ? t("work:copy.workspaceServiceRestarted_115d37")
              : t("work:copy.workspaceServiceStarted_26704e"),
      );
    },
    onError: (error) => {
      setRuntimeActionMessage(null);
      setRuntimeActionErrorMessage(describeError(error).body);
    },
    onSettled: (_result, _error, request) => {
      setPendingRuntimeActions((current) => current.filter((pendingRequest) => pendingRequest !== request));
    },
  });

  if (workspaceQuery.isLoading || workspaceView.kind === "reconnecting") {
    return <p className="text-sm text-muted-foreground">{t("work:copy.loadingWorkspace_86ffad")}</p>;
  }
  if (workspaceView.kind === "error") {
    return (
      <QueryErrorState
        size="page"
        error={workspaceQuery.error}
        action={t("work:copy.loadThisWorkspace_4e8682")}
        onRetry={workspaceView.retry}
        retrying={workspaceView.isFetching}
      />
    );
  }
  if (!workspace || !form || !initialState) return null;

  const canRunWorkspaceCommands = Boolean(workspace.cwd);
  const canStartRuntimeServices = Boolean(effectiveRuntimeConfig) && canRunWorkspaceCommands;
  const runtimeControlSections = buildWorkspaceRuntimeControlSections({
    runtimeConfig: effectiveRuntimeConfig,
    runtimeServices: workspace.runtimeServices ?? [],
    canStartServices: canStartRuntimeServices,
    canRunJobs: canRunWorkspaceCommands,
  });
  const pendingRuntimeAction = controlRuntimeServices.isPending ? controlRuntimeServices.variables ?? null : null;
  const serviceControlEntries = buildWorkspaceServiceControlEntries({
    sections: runtimeControlSections,
    runtimeServices: workspace.runtimeServices ?? [],
    pendingRequests: pendingRuntimeActions,
  });
  const pluginSlotContext = {
    companyId: workspace.companyId,
    projectId: workspace.projectId,
    entityId: workspace.id,
    entityType: "execution_workspace" as const,
  };
  const activePluginTab = workspacePluginTabItems.find((item) => item.value === activeTab) ?? null;

  if (activeTab === "configuration" && !workspaceVisibilityLoaded) return null;
  if (workspaceId && activeTab === "configuration" && !workspaceIsolationControlsVisible) {
    return <LegacyWorkspaceTabRedirect workspaceId={workspaceId} />;
  }

  if (workspaceId && activeTab === null) {
    return <LegacyWorkspaceTabRedirect workspaceId={workspaceId} />;
  }

  const handleTabChange = (tab: ExecutionWorkspaceTab) => {
    if (isExecutionWorkspacePluginTab(tab)) {
      navigate(`/execution-workspaces/${workspace.id}?tab=${encodeURIComponent(tab)}`);
      return;
    }
    navigate(executionWorkspaceTabPath(workspace.id, tab));
  };

  const saveChanges = () => {
    const validationError = validateForm(form);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    let patch: Record<string, unknown> = {};
    try {
      patch = buildWorkspacePatch(initialState, form);
} catch (error) {
      setErrorMessage(describeError(error).body);
    }

    if (Object.keys(patch).length === 0) return;
    updateWorkspace.mutate(patch);
  };

  const runRuntimeControlRequests = (requests: WorkspaceRuntimeControlRequest[]) => {
    if (requests.length === 0) return;
    setPendingRuntimeActions((current) => [...current, ...requests]);
    for (const request of requests) controlRuntimeServices.mutate(request);
  };

  return (
    <>
      <div className="space-y-4 overflow-hidden sm:space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="text-xs font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("work:copy.executionWorkspace_d31c92")}</div>
            <h1 className="truncate text-xl font-semibold sm:text-2xl">{workspace.name}</h1>
          </div>
          <WorkspaceServiceControlBar
            services={serviceControlEntries}
            onAction={(action, serviceKey) => {
              runRuntimeControlRequests(
                resolveWorkspaceServiceControlRequests(runtimeControlSections, action, serviceKey),
              );
            }}
            onViewLogs={() => handleTabChange("runtime_logs")}
            onManageServices={() => handleTabChange("services")}
          />
        </div>
        {runtimeActionErrorMessage ? <p className="text-sm text-destructive">{runtimeActionErrorMessage}</p> : null}
        {!runtimeActionErrorMessage && runtimeActionMessage ? <p className="text-sm text-muted-foreground">{runtimeActionMessage}</p> : null}

        <PluginSlotOutlet
          slotTypes={["toolbarButton", "contextMenuItem"]}
          entityType="execution_workspace"
          context={pluginSlotContext}
          className="flex flex-wrap gap-2"
          itemClassName="inline-flex"
          missingBehavior="placeholder"
        />

        <Tabs value={activeTab ?? "issues"} onValueChange={(value) => handleTabChange(value as ExecutionWorkspaceTab)}>
          <PageTabBar
            items={workspaceTabItems.map((item) => ({ value: item.value, label: item.label }))}
            align="start"
            value={activeTab ?? "issues"}
            onValueChange={(value) => handleTabChange(value as ExecutionWorkspaceTab)}
          />
        </Tabs>

        {activeTab === "services" ? (
          <WorkspaceRuntimeControls
            sections={runtimeControlSections}
            isPending={controlRuntimeServices.isPending}
            pendingRequest={pendingRuntimeAction}
            serviceEmptyMessage={
              effectiveRuntimeConfig
                ? t("work:copy.noServicesHaveBeenStartedForThisExecutionWorkspace_cc3534")
                : t("work:copy.noWorkspaceCommandConfigIsDefinedForThisExecution_0a490e")
            }
            jobEmptyMessage={t("work:copy.noOneShotJobsAreConfiguredForThisExecution_2b3666")}
            disabledHint={
              canStartRuntimeServices
                ? null
                : t("work:copy.executionWorkspacesNeedAWorkingDirectoryBeforeLocalCommands_d64aaf")
            }
            onAction={(request) => runRuntimeControlRequests([request])}
          />
        ) : activeTab === "configuration" ? (
          <div className="space-y-4 sm:space-y-6">
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>{t("work:copy.workspaceSettings_5ebc59")}</CardTitle>
                <CardDescription>{t("work:copy.editTheConcretePathRepoBranchProvisioningTeardownAnd_3e811d")}</CardDescription>
                <CardAction>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => setCloseDialogOpen(true)}
                    disabled={workspace.status === "archived"}
                  >
                    {workspace.status === "cleanup_failed" ? t("work:copy.retryClose_46dde3") : t("work:copy.closeWorkspace_e5086f")}
                  </Button>
                </CardAction>
              </CardHeader>

              <CardContent>

              <div className="space-y-6">
                <div className="space-y-4">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{t("work:copy.general_c910d4")}</div>
                  <Field label={t("work:copy.workspaceName_961964")}>
                    <Input
                      value={form.name}
                      onChange={(event) => setForm((current) => current ? { ...current, name: event.target.value } : current)}
                      placeholder={t("work:copy.executionWorkspaceName_762ada")}
                    />
                  </Field>
                </div>

                <Separator />

                <div className="space-y-4">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{t("work:copy.sourceControl_9bd7ea")}</div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("work:copy.branchName_06f6bb")} hint={t("work:copy.usefulForIsolatedWorktrees_8837c7")}>
                      <Input
                        className="font-mono"
                        value={form.branchName}
                        onChange={(event) => setForm((current) => current ? { ...current, branchName: event.target.value } : current)}
                        placeholder="PAP-946-workspace"
                      />
                    </Field>

                    <Field label={t("work:copy.baseRef_9c6c10")}>
                      <Input
                        className="font-mono"
                        value={form.baseRef}
                        onChange={(event) => setForm((current) => current ? { ...current, baseRef: event.target.value } : current)}
                        placeholder="origin/main"
                      />
                    </Field>
                  </div>

                  <Field label={t("work:copy.repoURL_de5c1d")}>
                    <Input
                      value={form.repoUrl}
                      onChange={(event) => setForm((current) => current ? { ...current, repoUrl: event.target.value } : current)}
                      placeholder="https://github.com/org/repo"
                    />
                  </Field>
                </div>

                <Separator />

                {/*
                  Both fields name a path on the execution host. Under the
                  managed-sandbox-only policy every agent runs in the
                  platform-managed environment, which owns the paths, so the
                  whole group and its separator disappear, and stay hidden
                  until that policy is known.
                */}
                {!hideHostPaths && (
                  <>
                    <div className="space-y-4">
                      <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{t("work:copy.paths_9c7995")}</div>
                      <Field label={t("work:copy.workingDirectory_865e85")}>
                        <Input
                          className="font-mono"
                          value={form.cwd}
                          onChange={(event) => setForm((current) => current ? { ...current, cwd: event.target.value } : current)}
                          placeholder="/absolute/path/to/workspace"
                        />
                      </Field>

                      <Field label={t("work:copy.providerPathRef_efa81c")}>
                        <Input
                          className="font-mono"
                          value={form.providerRef}
                          onChange={(event) => setForm((current) => current ? { ...current, providerRef: event.target.value } : current)}
                          placeholder={t("work:extra.message_31642385dc")}
                        />
                      </Field>
                    </div>

                    <Separator />
                  </>
                )}

                {/*
                  Every lifecycle command runs a shell on the execution host and
                  its placeholder names a host script path. The platform-managed
                  environment owns that lifecycle, so the managed-sandbox-only
                  policy hides the group and its separator, and keeps them
                  hidden until that policy is known.
                */}
                {!hideHostPaths && (
                  <>
                    <div className="space-y-4">
                      <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{t("work:copy.lifecycleCommands_9ccf41")}</div>
                      <Field label={t("work:copy.provisionCommand_bfbc86")} hint={t("work:copy.runsWhenPaperclipPreparesThisExecutionWorkspace_577ae5")}>
                        <Textarea
                          className="min-h-20 font-mono"
                          value={form.provisionCommand}
                          onChange={(event) => setForm((current) => current ? { ...current, provisionCommand: event.target.value } : current)}
                          placeholder="bash ./scripts/provision-worktree.sh"
                        />
                      </Field>

                      <Field
                        label={t("work:copy.runtimeProvisionCommand_e538ba")}
                        hint={t("work:copy.runsOnceBeforeTheFirstRuntimeServiceStartLeave_46e46d")}
                      >
                        <Textarea
                          className="min-h-20 font-mono"
                          value={form.runtimeProvisionCommand}
                          onChange={(event) => setForm((current) => current ? { ...current, runtimeProvisionCommand: event.target.value } : current)}
                          placeholder="bash ./scripts/provision-worktree-runtime.sh"
                        />
                      </Field>

                      <Field label={t("work:copy.teardownCommand_b6a156")} hint={t("work:copy.runsWhenTheExecutionWorkspaceIsArchivedOrCleaned_58d660")}>
                        <Textarea
                          className="min-h-20 font-mono"
                          value={form.teardownCommand}
                          onChange={(event) => setForm((current) => current ? { ...current, teardownCommand: event.target.value } : current)}
                          placeholder="bash ./scripts/teardown-worktree.sh"
                        />
                      </Field>

                      <Field label={t("work:copy.cleanupCommand_062a91")} hint={t("work:copy.workspaceSpecificCleanupBeforeTeardown_e97c4a")}>
                        <Textarea
                          className="min-h-16 font-mono"
                          value={form.cleanupCommand}
                          onChange={(event) => setForm((current) => current ? { ...current, cleanupCommand: event.target.value } : current)}
                          placeholder="pkill -f vite || true"
                        />
                      </Field>
                    </div>

                    <Separator />
                  </>
                )}

                <div className="space-y-4">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{t("work:copy.runtimeConfig_a6d1b9")}</div>
                  <div className="rounded-md border border-dashed border-border/70 bg-background px-4 py-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                      <div className="space-y-1">
                        <div className="text-sm font-medium text-foreground">{t("work:copy.runtimeConfigSource_588af7")}</div>
                        <p className="text-sm text-muted-foreground">
                          {runtimeConfigSource === "execution_workspace"
                            ? t("work:copy.thisExecutionWorkspaceCurrentlyOverridesTheProjectWorkspaceRuntime_40b231")
                            : runtimeConfigSource === "project_workspace"
                              ? t("work:copy.thisExecutionWorkspaceIsInheritingTheProjectWorkspaceRuntime_ac9c47")
                              : t("work:copy.noRuntimeConfigIsCurrentlyDefinedOnThisExecution_dfdc2f")}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        className="w-full sm:w-auto"
                        size="sm"
                        disabled={!linkedProjectWorkspace?.runtimeConfig?.workspaceRuntime}
                        onClick={() =>
                          setForm((current) => current ? {
                            ...current,
                            inheritRuntime: true,
                            workspaceRuntime: "",
                          } : current)
                        }
                      >{t("work:copy.resetToInherit_739c28")}</Button>
                    </div>
                  </div>

                  <details className="rounded-md border border-dashed border-border/70 bg-background px-4 py-3">
                    <summary className="cursor-pointer text-sm font-medium">{t("work:copy.advancedRuntimeJSON_8dfbbb")}</summary>
                    <p className="mt-2 text-sm text-muted-foreground">{t("work:copy.overrideTheInheritedWorkspaceCommandModelOnlyWhenThis_be49f0")}</p>
                    <div className="mt-3">
                      <Field label={t("work:copy.workspaceCommandsJSON_bd7ac3")} hint={t("work:copy.legacyServicesArraysStillWorkButCommandsSupportsBoth_208df7")}>
                        <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
                          <input
                            id="inherit-runtime-config"
                            type="checkbox"
                            className="rounded border-border"
                            checked={form.inheritRuntime}
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setForm((current) => {
                                if (!current) return current;
                                if (!checked && !current.workspaceRuntime.trim() && inheritedRuntimeConfig) {
                                  return { ...current, inheritRuntime: checked, workspaceRuntime: formatJson(inheritedRuntimeConfig) };
                                }
                                return { ...current, inheritRuntime: checked };
                              });
                            }}
                          />
                          <label htmlFor="inherit-runtime-config">{t("work:copy.inheritProjectWorkspaceRuntimeConfig_c90daa")}</label>
                        </div>
                        <Textarea
                          className="min-h-64 font-mono sm:min-h-96"
                          value={form.workspaceRuntime}
                          onChange={(event) => setForm((current) => current ? { ...current, workspaceRuntime: event.target.value } : current)}
                          disabled={form.inheritRuntime}
                          placeholder={'{\n  "commands": [\n    {\n      "id": "web",\n      "name": "web",\n      "kind": "service",\n      "command": "pnpm dev",\n      "cwd": ".",\n      "port": { "type": "auto" }\n    },\n    {\n      "id": "db-migrate",\n      "name": "db:migrate",\n      "kind": "job",\n      "command": "pnpm db:migrate",\n      "cwd": "."\n    }\n  ]\n}'}
                        />
                      </Field>
                    </div>
                  </details>

                  {configuredRuntimeServicePorts.length > 0 ? (
                    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
                      <div>
                        <div className="text-sm font-medium">{t("work:copy.servicePorts_a7a131")}</div>
                        <p className="mt-1 text-sm text-muted-foreground">{t("work:copy.setAFixedPortForAServiceOrLeave_a2cf4f")}</p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {configuredRuntimeServicePorts.map((service) => (
                          <Field key={`${service.collection}-${service.index}`} label={service.name} hint={t("work:copy.fixedPort_9b46ad")}>
                            <Input
                              type="number"
                              min="1"
                              max="65535"
                              inputMode="numeric"
                              value={service.port ?? ""}
                              onChange={(event) => {
                                setForm((current) => {
                                  if (!current) return current;
                                  const parsed = current.inheritRuntime
                                    ? { ok: true as const, value: inheritedRuntimeConfig }
                                    : parseWorkspaceRuntimeJson(current.workspaceRuntime);
                                  if (!parsed.ok || !parsed.value) return current;
                                  return {
                                    ...current,
                                    inheritRuntime: false,
                                    workspaceRuntime: formatJson(updateConfiguredRuntimeServicePort({
                                      runtimeConfig: parsed.value,
                                      service,
                                      port: event.target.value,
                                    })),
                                  };
                                });
                              }}
                            />
                          </Field>
                        ))}
                      </div>
                      {configuredRuntimeServicePortWarnings.length > 0 ? (
                        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                          {configuredRuntimeServicePortWarnings.map((warning) => <p key={warning}>{warning}</p>)}
                        </div>
                      ) : null}
                      <p className="text-sm text-muted-foreground">{t("work:copy.paperclipChecksFixedPortsAgainWhenAServiceStarts_082c9a")}</p>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <Button className="w-full sm:w-auto" disabled={!isDirty || updateWorkspace.isPending} onClick={saveChanges}>
                  {updateWorkspace.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{t("work:copy.saveChanges_dd0ae7")}</Button>
                <Button
                  variant="outline"
                  className="w-full sm:w-auto"
                  disabled={!isDirty || updateWorkspace.isPending}
                  onClick={() => {
                    setForm(initialState);
                    setErrorMessage(null);
                    setRuntimeActionErrorMessage(null);
                    setRuntimeActionMessage(null);
                  }}
                >{t("work:copy.reset_daee76")}</Button>
                {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
                {!errorMessage && !isDirty ? <p className="text-sm text-muted-foreground">{t("work:copy.noUnsavedChanges_75d79f")}</p> : null}
              </div>
              </CardContent>
            </Card>

            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>{t("work:copy.workspaceContext_dc6fa4")}</CardTitle>
                <CardDescription>{t("work:copy.linkedObjectsAndRelationships_84a181")}</CardDescription>
              </CardHeader>
              <CardContent>
              <DetailRow label={t("work:copy.project_985959")}>
                {project ? <Link to={`/projects/${projectRef}`} className="hover:underline">{project.name}</Link> : <MonoValue value={workspace.projectId ?? t("work:copy.noProject_f34c2b")} />}
              </DetailRow>
              <DetailRow label={t("work:copy.projectWorkspace_ce016e")}>
                {project && linkedProjectWorkspace ? (
                  <WorkspaceLink project={project} workspace={linkedProjectWorkspace} />
                ) : workspace.projectWorkspaceId ? (
                  <MonoValue value={workspace.projectWorkspaceId} />
                ) : (
                  t("work:copy.none_dc937b")
                )}
              </DetailRow>
              <DetailRow label={t("work:copy.sourceTask_d0e467")}>
                {sourceIssue ? (
                  <Link to={issueUrl(sourceIssue)} className="hover:underline">
                    {sourceIssue.identifier ?? sourceIssue.id} · {sourceIssue.title}
                  </Link>
                ) : workspace.sourceIssueId ? (
                  <MonoValue value={workspace.sourceIssueId} />
                ) : (
                  t("work:copy.none_dc937b")
                )}
              </DetailRow>
              <DetailRow label={t("work:copy.derivedFrom_fc1509")}>
                {derivedWorkspace ? (
                  <Link to={executionWorkspaceTabPath(derivedWorkspace.id, workspaceIsolationControlsVisible ? "configuration" : "issues")} className="hover:underline">
                    {derivedWorkspace.name}
                  </Link>
                ) : workspace.derivedFromExecutionWorkspaceId ? (
                  <MonoValue value={workspace.derivedFromExecutionWorkspaceId} />
                ) : (
                  t("work:copy.none_dc937b")
                )}
              </DetailRow>
              <DetailRow label={t("work:copy.runtimeProvisioning_090737")}>
                <RuntimeProvisionStatusValue
                  status={runtimeProvisionStatus}
                  onViewLogs={() => handleTabChange("runtime_logs")}
                />
              </DetailRow>
              <DetailRow label={t("work:copy.workspaceID_889d89")}>
                <MonoValue value={workspace.id} />
              </DetailRow>
              </CardContent>
            </Card>

            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>{t("work:copy.concreteLocation_3b8a15")}</CardTitle>
                <CardDescription>{t("work:copy.pathsAndRefs_4dbe94")}</CardDescription>
              </CardHeader>
              <CardContent>
              <DetailRow label={t("work:copy.workingDir_33f4ce")}>
                {workspace.cwd ? <MonoValue value={workspace.cwd} copy /> : t("work:copy.none_dc937b")}
              </DetailRow>
              <DetailRow label={t("work:copy.providerRef_c9a25d")}>
                {workspace.providerRef ? <MonoValue value={workspace.providerRef} copy /> : t("work:copy.none_dc937b")}
              </DetailRow>
              <DetailRow label={t("work:copy.repoURL_de5c1d")}>
                {workspace.repoUrl && isSafeExternalUrl(workspace.repoUrl) ? (
                  <div className="inline-flex max-w-full items-start gap-2">
                    <a href={workspace.repoUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 break-all hover:underline">
                      {workspace.repoUrl}
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    </a>
                    <CopyText text={workspace.repoUrl} className="shrink-0 text-muted-foreground hover:text-foreground" copiedLabel={t("work:copy.copied_8d525e")}>
                      <Copy className="h-3.5 w-3.5" />
                    </CopyText>
                  </div>
                ) : workspace.repoUrl ? (
                  <MonoValue value={workspace.repoUrl} copy />
                ) : (
                  t("work:copy.none_dc937b")
                )}
              </DetailRow>
              <DetailRow label={t("work:copy.baseRef_9c6c10")}>
                {workspace.baseRef ? <MonoValue value={workspace.baseRef} copy /> : t("work:copy.none_dc937b")}
              </DetailRow>
              <DetailRow label={t("work:copy.branch_52656e")}>
                {workspace.branchName ? <MonoValue value={workspace.branchName} copy /> : t("work:copy.none_dc937b")}
              </DetailRow>
              <DetailRow label={t("work:copy.opened_b19fb8")}>{formatDateTime(workspace.openedAt)}</DetailRow>
              <DetailRow label={t("work:copy.lastUsed_830ec7")}>{formatDateTime(workspace.lastUsedAt)}</DetailRow>
              <DetailRow label={t("work:copy.cleanup_9f1b23")}>
                {workspace.cleanupEligibleAt
                  ? `${formatDateTime(workspace.cleanupEligibleAt)}${workspace.cleanupReason ? ` · ${workspace.cleanupReason}` : ""}`
                  : t("work:copy.notScheduled_b3e247")}
              </DetailRow>
              </CardContent>
            </Card>
          </div>
        ) : activeTab === "runtime_logs" ? (
          <Card className="rounded-none">
            <CardHeader>
              <CardTitle>{t("work:copy.runtimeAndCleanupLogs_83f452")}</CardTitle>
              <CardDescription>{t("work:copy.recentOperations_da6d32")}</CardDescription>
            </CardHeader>
            <CardContent>
            {(opsView.kind === "loading" || opsView.kind === "reconnecting") ? (
              <p className="text-sm text-muted-foreground">{t("work:copy.loadingWorkspaceOperations_4b8ebe")}</p>
            ) : opsView.kind === "error" ? (
              <QueryErrorState
                size="inline"
                error={opsView.error}
                action={t("work:copy.loadWorkspaceOperations_9b05b4")}
                onRetry={opsView.retry}
                retrying={opsView.isFetching}
              />
            ) : workspaceOperationsQuery.data && workspaceOperationsQuery.data.length > 0 ? (
              <div className="space-y-3">
                {workspaceOperationsQuery.data.map((operation) => (
                  <div key={operation.id} className="rounded-none border border-border/80 bg-background px-4 py-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1">
                        <div className="text-sm font-medium">{operation.command ?? workspaceOperationPhaseLabel(operation.phase)}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatDateTime(operation.startedAt)}
                          {operation.finishedAt ? ` → ${formatDateTime(operation.finishedAt)}` : ""}
                        </div>
                        {operation.stderrExcerpt ? (
                          <div className="whitespace-pre-wrap break-words text-xs text-destructive">{operation.stderrExcerpt}</div>
                        ) : operation.stdoutExcerpt ? (
                          <div className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{operation.stdoutExcerpt}</div>
                        ) : null}
                      </div>
                      <StatusPill className="self-start">{getPageValueLabel(operation.status)}</StatusPill>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("work:copy.noWorkspaceOperationsHaveBeenRecordedYet_b321fc")}</p>
            )}
            </CardContent>
          </Card>
        ) : activeTab === "issues" ? (
          <div className="space-y-6">
            <SummarySlotCard
              companyId={workspace.companyId}
              scopeKind="execution_workspace"
              scopeId={workspace.id}
              title={t("work:copy.workspaceSummary_970a90")}
              description={t("work:copy.summarizerKeepsTheLatestWorkspaceStatusNextStepAnd_d76f8f")}
            />
            {linkedIssuesView.kind === "error" ? <QueryErrorState error={linkedIssuesView.error} action={t("work:copy.loadWorkspaceTasks_4de99f")} onRetry={linkedIssuesView.retry} retrying={linkedIssuesView.isFetching} /> : (
            <ExecutionWorkspaceIssuesList
              companyId={workspace.companyId}
              workspace={workspace}
              issues={linkedIssues}
              isLoading={linkedIssuesView.kind === "loading" || linkedIssuesView.kind === "reconnecting"}
              error={null}
              project={project}
            />
            )}
          </div>
        ) : activePluginTab ? (
          <PluginSlotMount
            slot={activePluginTab.slot}
            context={pluginSlotContext}
            missingBehavior="placeholder"
          />
        ) : isExecutionWorkspacePluginTab(activeTab) && workspacePluginDetailSlotsLoading ? (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">{t("work:copy.loadingWorkspacePlugin_dc194c")}</CardContent>
          </Card>
        ) : isExecutionWorkspacePluginTab(activeTab) && workspacePluginDetailSlotsError ? (
          <Card>
            <CardContent className="py-6 text-sm text-destructive">{workspacePluginDetailSlotsError}</CardContent>
          </Card>
        ) : isExecutionWorkspacePluginTab(activeTab) ? (
          <MissingPluginTabPlaceholder
            defaultTabHref={executionWorkspaceTabPath(workspace.id, "issues")}
            defaultTabLabel={t("work:copy.backToTasks_f94dc6")}
          />
        ) : activeTab === "routines" ? (
          <ExecutionWorkspaceRoutinesList
            workspace={workspace}
            project={project}
          />
        ) : (
          <LegacyWorkspaceTabRedirect workspaceId={workspace.id} />
        )}
      </div>
      <ExecutionWorkspaceCloseDialog
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        currentStatus={workspace.status}
        open={closeDialogOpen}
        onOpenChange={setCloseDialogOpen}
        onClosed={(nextWorkspace) => {
          queryClient.setQueryData(queryKeys.executionWorkspaces.detail(nextWorkspace.id), nextWorkspace);
          queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.overview(nextWorkspace.companyId) });
          queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.closeReadiness(nextWorkspace.id) });
          queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.workspaceOperations(nextWorkspace.id) });
          if (project) {
            queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
            queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(project.companyId, { projectId: project.id }) });
          }
          if (sourceIssue) {
            queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(sourceIssue.id) });
          }
        }}
      />
    </>
  );
}
