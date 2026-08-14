import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionWorkspace, Issue, Project, ProjectWorkspace, RoutineListItem, WorkspaceOperation } from "@paperclipai/shared";
import { Copy, ExternalLink, Loader2, Play, Repeat } from "lucide-react";
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
import { useToastActions } from "../context/ToastContext";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, issueUrl, projectRouteRef, projectWorkspaceUrl } from "../lib/utils";
import { t, useTranslation } from "@/i18n";
import {
  getWorkspaceSpecificRoutineVariableNames,
  routineHasWorkspaceSpecificVariables,
  sortWorkspaceRoutinesByName,
} from "../lib/workspace-routines";

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
  { value: "issues", label: t("executionWorkspaceDetail.tab.tasks"), order: 10 },
  { value: "services", label: t("executionWorkspaceDetail.tab.services"), order: 20 },
  { value: "configuration", label: t("executionWorkspaceDetail.tab.configuration"), order: 30 },
  { value: "runtime_logs", label: t("executionWorkspaceDetail.tab.runtimeLogs"), order: 40 },
  { value: "routines", label: t("executionWorkspaceDetail.tab.routines"), order: 60 },
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
  return value ? formatDateTime(value) : t("executionWorkspaceDetail.never");
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
        error: t("executionWorkspaceDetail.runtimeJsonMustBeObject"),
      };
    }
    return { ok: true as const, value: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : t("executionWorkspaceDetail.invalidJson"),
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
        name: typeof config.name === "string" && config.name.trim() ? config.name : t("executionWorkspaceDetail.serviceName", { number: index + 1 }),
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
      t("executionWorkspaceDetail.portConflict", {
        port,
        names: servicesForPort.map((service) => service.name).join(", "),
      }),
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
      return t("executionWorkspaceDetail.repoUrlInvalid");
    }
  }

  if (!form.inheritRuntime) {
    const runtimeJson = parseWorkspaceRuntimeJson(form.workspaceRuntime);
    if (!runtimeJson.ok) {
      return runtimeJson.error;
    }
    const invalidPort = readConfiguredRuntimeServicePorts(runtimeJson.value).find((service) => service.invalidPort);
    if (invalidPort) return t("executionWorkspaceDetail.invalidFixedPort", { name: invalidPort.name });
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
      return t("executionWorkspaceDetail.phase.worktreeSetup");
    case "workspace_config_freshness":
      return t("executionWorkspaceDetail.phase.configFreshness");
    case "workspace_provision":
      return t("executionWorkspaceDetail.phase.provision");
    case "workspace_runtime_provision":
      return t("executionWorkspaceDetail.phase.runtimeProvision");
    case "workspace_teardown":
      return t("executionWorkspaceDetail.phase.teardown");
    case "worktree_cleanup":
      return t("executionWorkspaceDetail.phase.worktreeCleanup");
    case "workspace_finalize":
      return t("executionWorkspaceDetail.phase.finalize");
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
 * `workspace_runtime_provision` operation-log entries (most-recent first). Returns
 * "eager" when no runtime provision command is configured (the legacy path).
 */
export function resolveRuntimeProvisionStatus(input: {
  runtimeProvisionCommand: string | null | undefined;
  operations: WorkspaceOperation[] | undefined;
}): RuntimeProvisionStatus {
  const latest = (input.operations ?? []).find((operation) => operation.phase === "workspace_runtime_provision") ?? null;
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
  return (
    <div className="flex flex-col gap-1.5 py-1.5 sm:flex-row sm:items-start sm:gap-3">
      <div className="shrink-0 text-xs text-muted-foreground sm:w-32">{label}</div>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

function StatusPill({ children, className }: { children: React.ReactNode; className?: string }) {
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
  const { t } = useTranslation();
  if (status.kind === "eager") {
    return (
      <span className="text-sm text-muted-foreground">{t("executionWorkspaceDetail.provisionEager")}</span>
    );
  }
  if (status.kind === "deferred") {
    return (
      <div className="flex flex-col gap-1">
        <StatusPill className="border-amber-500/40 text-amber-600 dark:text-amber-400">{t("executionWorkspaceDetail.provisionDeferred")}</StatusPill>
        <span className="text-xs text-muted-foreground">
          {t("executionWorkspaceDetail.provisionDeferredHint")}
        </span>
      </div>
    );
  }
  if (status.kind === "provisioning") {
    return (
      <StatusPill className="border-border text-muted-foreground">
        <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
        {t("executionWorkspaceDetail.provisioning")}
      </StatusPill>
    );
  }
  if (status.kind === "provisioned") {
    return (
      <StatusPill className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
        {status.at
          ? t("executionWorkspaceDetail.provisionedAt", { at: formatDateTime(status.at) })
          : t("executionWorkspaceDetail.provisioned")}
      </StatusPill>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <StatusPill className="border-destructive/50 text-destructive">
        {status.at
          ? t("executionWorkspaceDetail.provisioningFailedAt", { at: formatDateTime(status.at) })
          : t("executionWorkspaceDetail.provisioningFailed")}
      </StatusPill>
      <button type="button" onClick={onViewLogs} className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
        {t("executionWorkspaceDetail.viewRuntimeLogs")}
      </button>
    </div>
  );
}

function MonoValue({ value, copy }: { value: string; copy?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="inline-flex max-w-full items-start gap-2">
      <span className="break-all font-mono text-xs">{value}</span>
      {copy ? (
        <CopyText text={value} className="shrink-0 text-muted-foreground hover:text-foreground" copiedLabel={t("executionWorkspaceDetail.copied")}>
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

  const liveIssueIds = useMemo(() => collectLiveIssueIds(liveRuns, issues), [issues, liveRuns]);

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByExecutionWorkspace(companyId, workspace.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      if (project?.id) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, project.id) });
      }
    },
  });

  const projectOptions = useMemo(
    () => (project ? [{ id: project.id, name: project.name, workspaces: project.workspaces ?? [] }] : undefined),
    [project],
  );
  const createIssueDefaults = useMemo(
    () => ({
      projectId: workspace.projectId,
      ...(workspace.projectWorkspaceId ? { projectWorkspaceId: workspace.projectWorkspaceId } : {}),
      executionWorkspaceId: workspace.id,
      executionWorkspaceMode: "reuse_existing",
    }),
    [workspace.id, workspace.projectId, workspace.projectWorkspaceId],
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
  const isArchived = routine.status === "archived";
  const isRunning = runningRoutineId === routine.id;
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3 border-b border-border px-3 py-3 last:border-b-0 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/routines/${routine.id}`} className="truncate text-sm font-medium hover:underline">
            {routine.title}
          </Link>
          {routine.status !== "active" ? (
            <span className="text-xs text-muted-foreground">{routine.status}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{routine.assigneeAgentId ? t("executionWorkspaceDetail.defaultAgentSet") : t("executionWorkspaceDetail.chooseAgentWhenRunning")}</span>
          <span>{t("executionWorkspaceDetail.lastRun", { when: formatOptionalDateTime(routine.lastRun?.triggeredAt ?? routine.lastTriggeredAt) })}</span>
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
        {isRunning ? t("executionWorkspaceDetail.running") : t("executionWorkspaceDetail.runNow")}
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
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { t } = useTranslation();
  const [runDialogRoutine, setRunDialogRoutine] = useState<RoutineListItem | null>(null);
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);

  const { data: routines, isLoading, error } = useQuery({
    queryKey: queryKeys.routines.list(workspace.companyId, { projectId: workspace.projectId }),
    queryFn: () => routinesApi.list(workspace.companyId, { projectId: workspace.projectId }),
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(workspace.companyId),
    queryFn: () => agentsApi.list(workspace.companyId),
  });

  const workspaceRoutines = useMemo(
    () => sortWorkspaceRoutinesByName((routines ?? []).filter(routineHasWorkspaceSpecificVariables)),
    [routines],
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
        title: t("executionWorkspaceDetail.toast.routineStarted"),
        body: t("executionWorkspaceDetail.toast.routineStartedBody"),
        tone: "success",
      });
    },
    onSettled: () => {
      setRunningRoutineId(null);
    },
    onError: (mutationError) => {
      pushToast({
        title: t("executionWorkspaceDetail.toast.routineRunFailed"),
        body: mutationError instanceof Error ? mutationError.message : t("executionWorkspaceDetail.toast.routineRunFailedBody"),
        tone: "error",
      });
    },
  });

  return (
    <>
      <Card className="rounded-none">
        <CardHeader>
          <CardTitle>{t("executionWorkspaceDetail.routinesTitle")}</CardTitle>
          <CardDescription>
            {t("executionWorkspaceDetail.routinesDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t("executionWorkspaceDetail.loadingRoutines")}</p>
          ) : error ? (
            <p className="text-sm text-destructive">
              {error instanceof Error ? error.message : t("executionWorkspaceDetail.failedToLoadRoutines")}
            </p>
          ) : workspaceRoutines.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Repeat className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {t("executionWorkspaceDetail.noRoutines")}
              </p>
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
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { t } = useTranslation();
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
  }, [location.search]);
  const activeTab: ExecutionWorkspaceTab | null = activeRouteTab ?? pluginTabFromSearch;

  const workspaceQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.detail(workspaceId!),
    queryFn: () => executionWorkspacesApi.get(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const workspace = workspaceQuery.data ?? null;

  const projectQuery = useQuery({
    queryKey: workspace ? [...queryKeys.projects.detail(workspace.projectId), workspace.companyId] : ["projects", "detail", "__pending__"],
    queryFn: () => projectsApi.get(workspace!.projectId, workspace!.companyId),
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
  const linkedIssues = linkedIssuesQuery.data ?? [];

  const linkedProjectWorkspace = useMemo(
    () => project?.workspaces.find((item) => item.id === workspace?.projectWorkspaceId) ?? null,
    [project, workspace?.projectWorkspaceId],
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
    [workspacePluginDetailSlots],
  );
  const workspaceTabItems = useMemo(
    () => orderExecutionWorkspaceTabItems([...EXECUTION_WORKSPACE_BASE_TAB_ITEMS, ...workspacePluginTabItems]),
    [workspacePluginTabItems],
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
  }, [form, inheritedRuntimeConfig]);
  const configuredRuntimeServicePorts = useMemo(
    () => readConfiguredRuntimeServicePorts(configuredRuntimeConfig),
    [configuredRuntimeConfig],
  );
  const configuredRuntimeServicePortWarnings = useMemo(
    () => getConfiguredRuntimeServicePortWarnings(configuredRuntimeServicePorts),
    [configuredRuntimeServicePorts],
  );

  const initialState = useMemo(() => (workspace ? formStateFromWorkspace(workspace) : null), [workspace]);
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
      { label: t("executionWorkspaceDetail.crumb.projects"), href: "/projects" },
      ...(project ? [{ label: project.name, href: `/projects/${projectRef}` }] : []),
      ...(project ? [{ label: t("executionWorkspaceDetail.crumb.workspaces"), href: `/projects/${projectRef}/workspaces` }] : []),
      { label: workspace.name },
    ];
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, workspace, project, projectRef]);

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
      setErrorMessage(error instanceof Error ? error.message : t("executionWorkspaceDetail.failedToSaveWorkspace"));
    },
  });
  const workspaceOperationsQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.workspaceOperations(workspaceId!),
    queryFn: () => executionWorkspacesApi.listWorkspaceOperations(workspaceId!),
    enabled: Boolean(workspaceId),
  });
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
    [runtimeProvisionCommand, workspaceOperationsQuery.data],
  );
  const controlRuntimeServices = useMutation({
    mutationFn: (request: WorkspaceRuntimeControlRequest) =>
      executionWorkspacesApi.controlRuntimeCommands(workspace!.id, request.action, request),
    onSuccess: (result, request) => {
      queryClient.setQueryData(queryKeys.executionWorkspaces.detail(result.workspace.id), result.workspace);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.overview(result.workspace.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.workspaceOperations(result.workspace.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(result.workspace.projectId) });
      setRuntimeActionErrorMessage(null);
      setRuntimeActionMessage(
        request.action === "run"
          ? t("executionWorkspaceDetail.runtimeAction.jobCompleted")
          : request.action === "stop"
            ? t("executionWorkspaceDetail.runtimeAction.serviceStopped")
            : request.action === "restart"
              ? t("executionWorkspaceDetail.runtimeAction.serviceRestarted")
              : t("executionWorkspaceDetail.runtimeAction.serviceStarted"),
      );
    },
    onError: (error) => {
      setRuntimeActionMessage(null);
      setRuntimeActionErrorMessage(error instanceof Error ? error.message : t("executionWorkspaceDetail.failedToControlCommands"));
    },
    onSettled: (_result, _error, request) => {
      setPendingRuntimeActions((current) => current.filter((pendingRequest) => pendingRequest !== request));
    },
  });

  if (workspaceQuery.isLoading) return <p className="text-sm text-muted-foreground">{t("executionWorkspaceDetail.loadingWorkspace")}</p>;
  if (workspaceQuery.error) {
    return (
      <p className="text-sm text-destructive">
        {workspaceQuery.error instanceof Error ? workspaceQuery.error.message : t("executionWorkspaceDetail.failedToLoadWorkspace")}
      </p>
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

    let patch: Record<string, unknown>;
    try {
      patch = buildWorkspacePatch(initialState, form);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to build workspace update.");
      return;
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
            <div className="text-xs font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
              {t("executionWorkspaceDetail.eyebrow")}
            </div>
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
                ? t("executionWorkspaceDetail.servicesEmpty")
                : t("executionWorkspaceDetail.commandsEmpty")
            }
            jobEmptyMessage={t("executionWorkspaceDetail.jobsEmpty")}
            disabledHint={
              canStartRuntimeServices
                ? null
                : t("executionWorkspaceDetail.runtimeDisabledHint")
            }
            onAction={(request) => runRuntimeControlRequests([request])}
          />
        ) : activeTab === "configuration" ? (
          <div className="space-y-4 sm:space-y-6">
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>{t("executionWorkspaceDetail.workspaceSettings")}</CardTitle>
                <CardDescription>
                  {t("executionWorkspaceDetail.workspaceSettingsDescription")}
                </CardDescription>
                <CardAction>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => setCloseDialogOpen(true)}
                    disabled={workspace.status === "archived"}
                  >
                    {workspace.status === "cleanup_failed" ? t("executionWorkspaceDetail.retryClose") : t("executionWorkspaceDetail.closeWorkspace")}
                  </Button>
                </CardAction>
              </CardHeader>

              <CardContent>

              <div className="space-y-6">
                <div className="space-y-4">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{t("executionWorkspaceDetail.section.general")}</div>
                  <Field label={t("executionWorkspaceDetail.field.workspaceName")}>
                    <Input
                      value={form.name}
                      onChange={(event) => setForm((current) => current ? { ...current, name: event.target.value } : current)}
                      placeholder={t("executionWorkspaceDetail.placeholder.workspaceName")}
                    />
                  </Field>
                </div>

                <Separator />

                <div className="space-y-4">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{t("executionWorkspaceDetail.section.sourceControl")}</div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("executionWorkspaceDetail.field.branchName")} hint={t("executionWorkspaceDetail.hint.branchName")}>
                      <Input
                        className="font-mono"
                        value={form.branchName}
                        onChange={(event) => setForm((current) => current ? { ...current, branchName: event.target.value } : current)}
                        placeholder="PAP-946-workspace"
                      />
                    </Field>

                    <Field label={t("executionWorkspaceDetail.field.baseRef")}>
                      <Input
                        className="font-mono"
                        value={form.baseRef}
                        onChange={(event) => setForm((current) => current ? { ...current, baseRef: event.target.value } : current)}
                        placeholder="origin/main"
                      />
                    </Field>
                  </div>

                  <Field label={t("executionWorkspaceDetail.field.repoUrl")}>
                    <Input
                      value={form.repoUrl}
                      onChange={(event) => setForm((current) => current ? { ...current, repoUrl: event.target.value } : current)}
                      placeholder="https://github.com/org/repo"
                    />
                  </Field>
                </div>

                <Separator />

                <div className="space-y-4">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{t("executionWorkspaceDetail.section.paths")}</div>
                  <Field label={t("executionWorkspaceDetail.field.workingDirectory")}>
                    <Input
                      className="font-mono"
                      value={form.cwd}
                      onChange={(event) => setForm((current) => current ? { ...current, cwd: event.target.value } : current)}
                      placeholder="/absolute/path/to/workspace"
                    />
                  </Field>

                  <Field label={t("executionWorkspaceDetail.field.providerPathRef")}>
                    <Input
                      className="font-mono"
                      value={form.providerRef}
                      onChange={(event) => setForm((current) => current ? { ...current, providerRef: event.target.value } : current)}
                      placeholder="/path/to/worktree or provider ref"
                    />
                  </Field>
                </div>

                <Separator />

                <div className="space-y-4">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{t("executionWorkspaceDetail.section.lifecycleCommands")}</div>
                  <Field label={t("executionWorkspaceDetail.field.provisionCommand")} hint={t("executionWorkspaceDetail.hint.provisionCommand")}>
                    <Textarea
                      className="min-h-20 font-mono"
                      value={form.provisionCommand}
                      onChange={(event) => setForm((current) => current ? { ...current, provisionCommand: event.target.value } : current)}
                      placeholder="bash ./scripts/provision-worktree.sh"
                    />
                  </Field>

                  <Field
                    label={t("executionWorkspaceDetail.field.runtimeProvisionCommand")}
                    hint={t("executionWorkspaceDetail.hint.runtimeProvisionCommand")}
                  >
                    <Textarea
                      className="min-h-20 font-mono"
                      value={form.runtimeProvisionCommand}
                      onChange={(event) => setForm((current) => current ? { ...current, runtimeProvisionCommand: event.target.value } : current)}
                      placeholder="bash ./scripts/provision-worktree-runtime.sh"
                    />
                  </Field>

                  <Field label={t("executionWorkspaceDetail.field.teardownCommand")} hint={t("executionWorkspaceDetail.hint.teardownCommand")}>
                    <Textarea
                      className="min-h-20 font-mono"
                      value={form.teardownCommand}
                      onChange={(event) => setForm((current) => current ? { ...current, teardownCommand: event.target.value } : current)}
                      placeholder="bash ./scripts/teardown-worktree.sh"
                    />
                  </Field>

                  <Field label={t("executionWorkspaceDetail.field.cleanupCommand")} hint={t("executionWorkspaceDetail.hint.cleanupCommand")}>
                    <Textarea
                      className="min-h-16 font-mono"
                      value={form.cleanupCommand}
                      onChange={(event) => setForm((current) => current ? { ...current, cleanupCommand: event.target.value } : current)}
                      placeholder="pkill -f vite || true"
                    />
                  </Field>
                </div>

                <Separator />

                <div className="space-y-4">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{t("executionWorkspaceDetail.section.runtimeConfig")}</div>
                  <div className="rounded-md border border-dashed border-border/70 bg-background px-4 py-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                      <div className="space-y-1">
                        <div className="text-sm font-medium text-foreground">
                          {t("executionWorkspaceDetail.runtimeConfigSource")}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {runtimeConfigSource === "execution_workspace"
                            ? t("executionWorkspaceDetail.runtimeSource.workspace")
                            : runtimeConfigSource === "project_workspace"
                              ? t("executionWorkspaceDetail.runtimeSource.projectWorkspace")
                              : t("executionWorkspaceDetail.runtimeSource.none")}
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
                      >
                        Reset to inherit
                      </Button>
                    </div>
                  </div>

                  <details className="rounded-md border border-dashed border-border/70 bg-background px-4 py-3">
                    <summary className="cursor-pointer text-sm font-medium">{t("executionWorkspaceDetail.advancedRuntimeJson")}</summary>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {t("executionWorkspaceDetail.advancedRuntimeJsonDescription")}
                    </p>
                    <div className="mt-3">
                      <Field label={t("executionWorkspaceDetail.field.workspaceCommandsJson")} hint={t("executionWorkspaceDetail.hint.workspaceCommandsJson")}>
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
                          <label htmlFor="inherit-runtime-config">{t("executionWorkspaceDetail.inheritRuntimeLabel")}</label>
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
                        <div className="text-sm font-medium">{t("executionWorkspaceDetail.servicePorts")}</div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {t("executionWorkspaceDetail.servicePortsDescription")}
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {configuredRuntimeServicePorts.map((service) => (
                          <Field key={`${service.collection}-${service.index}`} label={service.name} hint={t("executionWorkspaceDetail.fixedPort")}>
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
                      <p className="text-sm text-muted-foreground">
                        {t("executionWorkspaceDetail.portConflictCheckNote")}
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <Button className="w-full sm:w-auto" disabled={!isDirty || updateWorkspace.isPending} onClick={saveChanges}>
                  {updateWorkspace.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {t("executionWorkspaceDetail.saveChanges")}
                </Button>
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
                >
                  {t("executionWorkspaceDetail.reset")}
                </Button>
                  {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
                  {!errorMessage && !isDirty ? <p className="text-sm text-muted-foreground">{t("executionWorkspaceDetail.noUnsavedChanges")}</p> : null}
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>{t("executionWorkspaceDetail.workspaceContext")}</CardTitle>
                <CardDescription>{t("executionWorkspaceDetail.workspaceContextDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
              <DetailRow label={t("executionWorkspaceDetail.label.project")}>
                {project ? <Link to={`/projects/${projectRef}`} className="hover:underline">{project.name}</Link> : <MonoValue value={workspace.projectId} />}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.label.projectWorkspace")}>
                {project && linkedProjectWorkspace ? (
                  <WorkspaceLink project={project} workspace={linkedProjectWorkspace} />
                ) : workspace.projectWorkspaceId ? (
                  <MonoValue value={workspace.projectWorkspaceId} />
                ) : (
                  t("executionWorkspaceDetail.none")
                )}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.label.sourceTask")}>
                {sourceIssue ? (
                  <Link to={issueUrl(sourceIssue)} className="hover:underline">
                    {sourceIssue.identifier ?? sourceIssue.id} · {sourceIssue.title}
                  </Link>
                ) : workspace.sourceIssueId ? (
                  <MonoValue value={workspace.sourceIssueId} />
                ) : (
                  t("executionWorkspaceDetail.none")
                )}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.label.derivedFrom")}>
                {derivedWorkspace ? (
                  <Link to={executionWorkspaceTabPath(derivedWorkspace.id, "configuration")} className="hover:underline">
                    {derivedWorkspace.name}
                  </Link>
                ) : workspace.derivedFromExecutionWorkspaceId ? (
                  <MonoValue value={workspace.derivedFromExecutionWorkspaceId} />
                ) : (
                  t("executionWorkspaceDetail.none")
                )}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.label.runtimeProvisioning")}>
                <RuntimeProvisionStatusValue
                  status={runtimeProvisionStatus}
                  onViewLogs={() => handleTabChange("runtime_logs")}
                />
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.label.workspaceId")}>
                <MonoValue value={workspace.id} />
              </DetailRow>
              </CardContent>
            </Card>

            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>{t("executionWorkspaceDetail.concreteLocation")}</CardTitle>
                <CardDescription>{t("executionWorkspaceDetail.pathsAndRefs")}</CardDescription>
              </CardHeader>
              <CardContent>
              <DetailRow label={t("executionWorkspaceDetail.label.workingDir")}>
                {workspace.cwd ? <MonoValue value={workspace.cwd} copy /> : t("executionWorkspaceDetail.none")}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.label.providerRef")}>
                {workspace.providerRef ? <MonoValue value={workspace.providerRef} copy /> : t("executionWorkspaceDetail.none")}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.label.repoUrl")}>
                {workspace.repoUrl && isSafeExternalUrl(workspace.repoUrl) ? (
                  <div className="inline-flex max-w-full items-start gap-2">
                    <a href={workspace.repoUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 break-all hover:underline">
                      {workspace.repoUrl}
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    </a>
                    <CopyText text={workspace.repoUrl} className="shrink-0 text-muted-foreground hover:text-foreground" copiedLabel={t("executionWorkspaceDetail.copied")}>
                      <Copy className="h-3.5 w-3.5" />
                    </CopyText>
                  </div>
                ) : workspace.repoUrl ? (
                  <MonoValue value={workspace.repoUrl} copy />
                ) : (
                  t("executionWorkspaceDetail.none")
                )}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.label.baseRef")}>
                {workspace.baseRef ? <MonoValue value={workspace.baseRef} copy /> : t("executionWorkspaceDetail.none")}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.label.branch")}>
                {workspace.branchName ? <MonoValue value={workspace.branchName} copy /> : t("executionWorkspaceDetail.none")}
              </DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.label.opened")}>{formatDateTime(workspace.openedAt)}</DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.label.lastUsed")}>{formatDateTime(workspace.lastUsedAt)}</DetailRow>
              <DetailRow label={t("executionWorkspaceDetail.label.cleanup")}>
                {workspace.cleanupEligibleAt
                  ? `${formatDateTime(workspace.cleanupEligibleAt)}${workspace.cleanupReason ? ` · ${workspace.cleanupReason}` : ""}`
                  : t("executionWorkspaceDetail.notScheduled")}
              </DetailRow>
              </CardContent>
            </Card>
          </div>
        ) : activeTab === "runtime_logs" ? (
          <Card className="rounded-none">
            <CardHeader>
              <CardTitle>{t("executionWorkspaceDetail.runtimeLogsTitle")}</CardTitle>
              <CardDescription>{t("executionWorkspaceDetail.recentOperations")}</CardDescription>
            </CardHeader>
            <CardContent>
            {workspaceOperationsQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">{t("executionWorkspaceDetail.loadingWorkspaceOperations")}</p>
            ) : workspaceOperationsQuery.error ? (
              <p className="text-sm text-destructive">
                {workspaceOperationsQuery.error instanceof Error
                  ? workspaceOperationsQuery.error.message
                  : t("executionWorkspaceDetail.failedToLoadWorkspaceOperations")}
              </p>
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
                      <StatusPill className="self-start">{operation.status}</StatusPill>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("executionWorkspaceDetail.noWorkspaceOperations")}</p>
            )}
            </CardContent>
          </Card>
        ) : activeTab === "issues" ? (
          <div className="space-y-6">
            <SummarySlotCard
              companyId={workspace.companyId}
              scopeKind="execution_workspace"
              scopeId={workspace.id}
              title={t("executionWorkspaceDetail.workspaceSummary")}
              description={t("executionWorkspaceDetail.workspaceSummaryDescription")}
            />
            <ExecutionWorkspaceIssuesList
              companyId={workspace.companyId}
              workspace={workspace}
              issues={linkedIssues}
              isLoading={linkedIssuesQuery.isLoading}
              error={linkedIssuesQuery.error as Error | null}
              project={project}
            />
          </div>
        ) : activePluginTab ? (
          <PluginSlotMount
            slot={activePluginTab.slot}
            context={pluginSlotContext}
            missingBehavior="placeholder"
          />
        ) : isExecutionWorkspacePluginTab(activeTab) && workspacePluginDetailSlotsLoading ? (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">{t("executionWorkspaceDetail.loadingWorkspacePlugin")}</CardContent>
          </Card>
        ) : isExecutionWorkspacePluginTab(activeTab) && workspacePluginDetailSlotsError ? (
          <Card>
            <CardContent className="py-6 text-sm text-destructive">{workspacePluginDetailSlotsError}</CardContent>
          </Card>
        ) : isExecutionWorkspacePluginTab(activeTab) ? (
          <MissingPluginTabPlaceholder
            defaultTabHref={executionWorkspaceTabPath(workspace.id, "issues")}
            defaultTabLabel={t("executionWorkspaceDetail.backToTasks")}
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
