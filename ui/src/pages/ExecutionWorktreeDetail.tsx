import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionWorktree, Issue, Project, ProjectWorktree, RoutineListItem, WorktreeOperation } from "@paperclipai/shared";
import { Copy, ExternalLink, Loader2, Play, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tabs } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { CopyText } from "../components/CopyText";
import { ExecutionWorktreeCloseDialog } from "../components/ExecutionWorktreeCloseDialog";
import { MissingPluginTabPlaceholder } from "../components/MissingPluginTabPlaceholder";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { executionWorktreesApi } from "../api/execution-worktrees";
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
  buildWorktreeRuntimeControlSections,
  buildWorktreeServiceControlEntries,
  resolveWorktreeServiceControlRequests,
  WorktreeRuntimeControls,
  type WorktreeRuntimeControlRequest,
} from "../components/WorktreeRuntimeControls";
import { WorktreeServiceControlBar } from "../components/WorktreeServiceControlBar";
import { WorktreeAccessCard } from "../components/WorktreeAccessCard";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useManagedSandboxOnly } from "../hooks/useManagedSandboxOnly";
import { useToastActions } from "../context/ToastContext";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, issueUrl, projectRouteRef, projectWorktreeUrl } from "../lib/utils";
import {
  resolveWorktreeAccessState,
  type WorktreeLoginHandoffFailureInfo,
} from "../lib/worktree-access-state";
import {
  getWorktreeSpecificRoutineVariableNames,
  routineHasWorktreeSpecificVariables,
  sortWorktreeRoutinesByName,
} from "../lib/worktree-routines";

type WorktreeFormState = {
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

type ExecutionWorktreeBaseTab = "services" | "configuration" | "runtime_logs" | "issues" | "routines";
type ExecutionWorktreePluginTab = `plugin:${string}`;
type ExecutionWorktreeTab = ExecutionWorktreeBaseTab | ExecutionWorktreePluginTab;
type OrderedExecutionWorktreeTabItem = {
  value: ExecutionWorktreeTab;
  label: string;
  order: number;
};

const DEFAULT_PLUGIN_DETAIL_TAB_ORDER = 100;
const EXECUTION_WORKSPACE_BASE_TAB_ITEMS: OrderedExecutionWorktreeTabItem[] = [
  { value: "issues", label: "Tasks", order: 10 },
  { value: "services", label: "Services", order: 20 },
  { value: "configuration", label: "Configuration", order: 30 },
  { value: "runtime_logs", label: "Runtime logs", order: 40 },
  { value: "routines", label: "Routines", order: 60 },
];

function isExecutionWorktreePluginTab(value: string | null): value is ExecutionWorktreePluginTab {
  return typeof value === "string" && value.startsWith("plugin:");
}

function orderExecutionWorktreeTabItems(items: OrderedExecutionWorktreeTabItem[]) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.order - right.item.order || left.index - right.index)
    .map(({ item }) => item);
}

function resolveExecutionWorktreeTab(pathname: string, workspaceId: string): ExecutionWorktreeBaseTab | null {
  const segments = pathname.split("/").filter(Boolean);
  const executionWorktreesIndex = segments.indexOf("execution-worktrees");
  if (executionWorktreesIndex === -1 || segments[executionWorktreesIndex + 1] !== workspaceId) return null;
  const tab = segments[executionWorktreesIndex + 2];
  if (tab === "services") return "services";
  if (tab === "issues") return "issues";
  if (tab === "routines") return "routines";
  if (tab === "runtime-logs") return "runtime_logs";
  if (tab === "configuration") return "configuration";
  return null;
}

function executionWorktreeTabPath(workspaceId: string, tab: ExecutionWorktreeBaseTab) {
  const segment = tab === "runtime_logs" ? "runtime-logs" : tab;
  return `/execution-worktrees/${workspaceId}/${segment}`;
}

function LegacyWorktreeTabRedirect({ workspaceId }: { workspaceId: string }) {
  useEffect(() => {
    try {
      localStorage.removeItem(`paperclip:execution-workspace-tab:${WorktreeLink}`);
    } catch {}
  }, [WorktreeLink]);

  return <Navigate to={executionWorktreeTabPath(workspaceId, "issues")} replace />;
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
  return value ? formatDateTime(value) : "Never";
}

function normalizeText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseWorktreeRuntimeJson(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true as const, value: null as Record<string, unknown> | null };

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false as const,
        error: "Worktree commands JSON must be a JSON object.",
      };
    }
    return { ok: true as const, value: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Invalid JSON.",
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
        name: typeof config.name === "string" && config.name.trim() ? config.name : `Service ${index + 1}`,
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
      `Port ${port} is assigned to multiple services: ${servicesForPort.map((service) => service.name).join(", ")}.`,
    );
}

function formStateFromWorktree(workspace: ExecutionWorktree): WorktreeFormState {
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

function buildWorktreePatch(initialState: WorktreeFormState, nextState: WorktreeFormState) {
  const patch: Record<string, unknown> = {};
  const configPatch: Record<string, unknown> = {};

  const maybeAssign = (
    key: keyof Pick<WorktreeFormState, "name" | "cwd" | "repoUrl" | "baseRef" | "branchName" | "providerRef">,
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

  const maybeAssignConfigText = (key: keyof Pick<WorktreeFormState, "provisionCommand" | "runtimeProvisionCommand" | "teardownCommand" | "cleanupCommand">) => {
    if (initialState[key] === nextState[key]) return;
    configPatch[key] = normalizeText(nextState[key]);
  };

  maybeAssignConfigText("provisionCommand");
  maybeAssignConfigText("runtimeProvisionCommand");
  maybeAssignConfigText("teardownCommand");
  maybeAssignConfigText("cleanupCommand");

  if (initialState.inheritRuntime !== nextState.inheritRuntime || initialState.workspaceRuntime !== nextState.workspaceRuntime) {
    const parsed = parseWorktreeRuntimeJson(nextState.workspaceRuntime);
    if (!parsed.ok) throw new Error(parsed.error);
    configPatch.workspaceRuntime = nextState.inheritRuntime ? null : parsed.value;
  }

  if (Object.keys(configPatch).length > 0) {
    patch.config = configPatch;
  }

  return patch;
}

function validateForm(form: WorktreeFormState) {
  const repoUrl = normalizeText(form.repoUrl);
  if (repoUrl) {
    try {
      new URL(repoUrl);
    } catch {
      return "Repo URL must be a valid URL.";
    }
  }

  if (!form.inheritRuntime) {
    const runtimeJson = parseWorktreeRuntimeJson(form.workspaceRuntime);
    if (!runtimeJson.ok) {
      return runtimeJson.error;
    }
    const invalidPort = readConfiguredRuntimeServicePorts(runtimeJson.value).find((service) => service.invalidPort);
    if (invalidPort) return `${invalidPort.name} has an invalid fixed port.`;
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

function worktreeOperationPhaseLabel(phase: string) {
  switch (phase) {
    case "worktree_prepare":
      return "Worktree setup";
    case "workspace_config_freshness":
      return "Config freshness";
    case "workspace_provision":
      return "Provision";
    case "workspace_seed":
      return "Database seed";
    case "workspace_runtime_provision":
      return "Runtime provision";
    case "workspace_teardown":
      return "Teardown";
    case "worktree_cleanup":
      return "Worktree cleanup";
    case "workspace_finalize":
      return "Finalize";
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
  operations: WorktreeOperation[] | undefined;
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

/**
 * Read the structured refusal the login-handoff endpoint returns.
 *
 * The server keeps a machine `reason` (and, where it probed, the workspace's own
 * readiness) on the error body so the UI can name the cause instead of showing a
 * bare HTTP failure. Anything else is a genuine transport error.
 */
export function readWorktreeHandoffFailure(error: unknown): WorktreeLoginHandoffFailureInfo | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as
    | { reason?: unknown; detail?: unknown; readiness?: unknown }
    | null
    | undefined;
  if (!body || typeof body.reason !== "string") return null;
  return {
    reason: body.reason,
    detail: typeof body.detail === "string" ? body.detail : null,
    readiness: (body.readiness as WorktreeLoginHandoffFailureInfo["readiness"]) ?? null,
  };
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
  if (status.kind === "eager") {
    return (
      <span className="text-sm text-muted-foreground">Eager · provisioned during worktree setup</span>
    );
  }
  if (status.kind === "deferred") {
    return (
      <div className="flex flex-col gap-1">
        <StatusPill className="border-amber-500/40 text-amber-600 dark:text-amber-400">Deferred</StatusPill>
        <span className="text-xs text-muted-foreground">
          Runs once before the first runtime-service start.
        </span>
      </div>
    );
  }
  if (status.kind === "provisioning") {
    return (
      <StatusPill className="border-border text-muted-foreground">
        <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
        Provisioning…
      </StatusPill>
    );
  }
  if (status.kind === "provisioned") {
    return (
      <StatusPill className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
        Provisioned{status.at ? ` · ${formatDateTime(status.at)}` : ""}
      </StatusPill>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <StatusPill className="border-destructive/50 text-destructive">
        Provisioning failed{status.at ? ` · ${formatDateTime(status.at)}` : ""}
      </StatusPill>
      <button type="button" onClick={onViewLogs} className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
        View runtime logs
      </button>
    </div>
  );
}

function MonoValue({ value, copy }: { value: string; copy?: boolean }) {
  return (
    <div className="inline-flex max-w-full items-start gap-2">
      <span className="break-all font-mono text-xs">{value}</span>
      {copy ? (
        <CopyText text={value} className="shrink-0 text-muted-foreground hover:text-foreground" copiedLabel="Copied">
          <Copy className="h-3.5 w-3.5" />
        </CopyText>
      ) : null}
    </div>
  );
}

function WorktreeLink({
  project,
  workspace,
}: {
  project: Project;
  workspace: ProjectWorktree;
}) {
  return <Link to={projectWorktreeUrl(project, workspace.id)} className="hover:underline">{workspace.name}</Link>;
}

function ExecutionWorktreeIssuesList({
  companyId,
  workspace,
  issues,
  isLoading,
  error,
  project,
}: {
  companyId: string;
  workspace: ExecutionWorktree;
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

function WorktreeRoutineRow({
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
          <span>{routine.assigneeAgentId ? "Default agent set" : "Choose agent when running"}</span>
          <span>Last run {formatOptionalDateTime(routine.lastRun?.triggeredAt ?? routine.lastTriggeredAt)}</span>
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
        {isRunning ? "Running..." : "Run now"}
      </Button>
    </div>
  );
}

function ExecutionWorktreeRoutinesList({
  workspace,
  project,
}: {
  workspace: ExecutionWorktree;
  project: Project | null;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
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

  const worktreeRoutines = useMemo(
    () => sortWorktreeRoutinesByName((routines ?? []).filter(routineHasWorktreeSpecificVariables)),
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
        title: "Routine started",
        body: "Paperclip created a run using this execution worktree.",
        tone: "success",
      });
    },
    onSettled: () => {
      setRunningRoutineId(null);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Routine run failed",
        body: mutationError instanceof Error ? mutationError.message : "Paperclip could not start the routine run.",
        tone: "error",
      });
    },
  });

  return (
    <>
      <Card className="rounded-none">
        <CardHeader>
          <CardTitle>Worktree routines</CardTitle>
          <CardDescription>
            Routines that use worktree-specific variables can be run against this execution worktree.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading routines...</p>
          ) : error ? (
            <p className="text-sm text-destructive">
              {error instanceof Error ? error.message : "Failed to load routines."}
            </p>
          ) : worktreeRoutines.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Repeat className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No routines use worktree-specific variables yet.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-border">
              {worktreeRoutines.map((routine) => (
                <WorktreeRoutineRow
                  key={routine.id}
                  routine={routine}
                  variableNames={getWorktreeSpecificRoutineVariableNames(routine)}
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

export function ExecutionWorktreeDetail() {
  const { worktreeId: worktreeId } = useParams<{ worktreeId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { hideHostPaths } = useManagedSandboxOnly();
  const [form, setForm] = useState<WorktreeFormState | null>(null);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [runtimeActionErrorMessage, setRuntimeActionErrorMessage] = useState<string | null>(null);
  const [runtimeActionMessage, setRuntimeActionMessage] = useState<string | null>(null);
  const [handoffFailure, setHandoffFailure] = useState<WorktreeLoginHandoffFailureInfo | null>(null);
  const [handoffErrorMessage, setHandoffErrorMessage] = useState<string | null>(null);
  const [pendingRuntimeActions, setPendingRuntimeActions] = useState<WorktreeRuntimeControlRequest[]>([]);
  const activeRouteTab = worktreeId ? resolveExecutionWorktreeTab(location.pathname, worktreeId) : null;
  const pluginTabFromSearch = useMemo(() => {
    const tab = new URLSearchParams(location.search).get("tab");
    return isExecutionWorktreePluginTab(tab) ? tab : null;
  }, [location.search]);
  const activeTab: ExecutionWorktreeTab | null = activeRouteTab ?? pluginTabFromSearch;

  const worktreeQuery = useQuery({
    queryKey: queryKeys.executionWorktrees.detail(worktreeId!),
    queryFn: () => executionWorktreesApi.get(worktreeId!),
    enabled: Boolean(worktreeId),
  });
  const worktree = worktreeQuery.data ?? null;

  const projectQuery = useQuery({
    queryKey: worktree ? [...queryKeys.projects.detail(worktree.projectId), worktree.companyId] : ["projects", "detail", "__pending__"],
    queryFn: () => projectsApi.get(worktree!.projectId, worktree!.companyId),
    enabled: Boolean(worktree?.projectId),
  });
  const project = projectQuery.data ?? null;

  const sourceIssueQuery = useQuery({
    queryKey: worktree?.sourceIssueId ? queryKeys.issues.detail(worktree.sourceIssueId) : ["issues", "detail", "__none__"],
    queryFn: () => issuesApi.get(worktree!.sourceIssueId!),
    enabled: Boolean(worktree?.sourceIssueId),
  });
  const sourceIssue = sourceIssueQuery.data ?? null;

  const derivedWorktreeQuery = useQuery({
    queryKey: worktree?.derivedFromExecutionWorkspaceId
      ? queryKeys.executionWorktrees.detail(worktree.derivedFromExecutionWorkspaceId)
      : ["execution-worktrees", "detail", "__none__"],
    queryFn: () => executionWorktreesApi.get(worktree!.derivedFromExecutionWorkspaceId!),
    enabled: Boolean(worktree?.derivedFromExecutionWorkspaceId),
  });
  const derivedWorktree = derivedWorktreeQuery.data ?? null;
  const linkedIssuesQuery = useQuery({
    queryKey: worktree
      ? queryKeys.issues.listByExecutionWorkspace(worktree.companyId, worktree.id)
      : ["issues", "__execution-workspace__", "__none__"],
    queryFn: () => issuesApi.list(worktree!.companyId, { executionWorkspaceId: worktree!.id }),
    enabled: Boolean(worktree?.companyId),
  });
  const linkedIssues = linkedIssuesQuery.data ?? [];

  const linkedProjectWorktree = useMemo(
    () => project?.workspaces.find((item) => item.id === worktree?.projectWorkspaceId) ?? null,
    [project, worktree?.projectWorkspaceId],
  );

  const {
    slots: worktreePluginDetailSlots,
    isLoading: worktreePluginDetailSlotsLoading,
    errorMessage: worktreePluginDetailSlotsError,
  } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "execution_workspace",
    companyId: worktree?.companyId ?? null,
    enabled: !!worktree?.companyId,
  });
  const worktreePluginTabItems = useMemo(
    () => worktreePluginDetailSlots.map((slot) => ({
      value: `plugin:${slot.pluginKey}:${slot.id}` as ExecutionWorktreePluginTab,
      label: slot.displayName,
      order: slot.order ?? DEFAULT_PLUGIN_DETAIL_TAB_ORDER,
      slot,
    })),
    [worktreePluginDetailSlots],
  );
  const worktreeTabItems = useMemo(
    () => orderExecutionWorktreeTabItems([...EXECUTION_WORKSPACE_BASE_TAB_ITEMS, ...worktreePluginTabItems]),
    [worktreePluginTabItems],
  );
  const inheritedRuntimeConfig = linkedProjectWorktree?.runtimeConfig?.workspaceRuntime ?? null;
  const effectiveRuntimeConfig = worktree?.config?.workspaceRuntime ?? inheritedRuntimeConfig;
  const runtimeConfigSource =
    worktree?.config?.workspaceRuntime
      ? "execution_workspace"
      : inheritedRuntimeConfig
        ? "project_workspace"
        : "none";

  const configuredRuntimeConfig = useMemo(() => {
    if (!form || form.inheritRuntime) return inheritedRuntimeConfig;
    const parsed = parseWorktreeRuntimeJson(form.workspaceRuntime);
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

  const initialState = useMemo(() => (worktree ? formStateFromWorktree(worktree) : null), [worktree]);
  const isDirty = Boolean(form && initialState && JSON.stringify(form) !== JSON.stringify(initialState));
  const projectRef = project ? projectRouteRef(project) : worktree?.projectId ?? "";

  useEffect(() => {
    if (!worktree?.companyId || worktree.companyId === selectedCompanyId) return;
    setSelectedCompanyId(worktree.companyId, { source: "route_sync" });
  }, [worktree?.companyId, selectedCompanyId, setSelectedCompanyId]);

  useEffect(() => {
    if (!worktree) return;
    setForm(formStateFromWorktree(worktree));
    setErrorMessage(null);
    setRuntimeActionErrorMessage(null);
    setPendingRuntimeActions([]);
  }, [worktree]);

  useEffect(() => {
    if (!worktree) return;
    const crumbs = [
      { label: "Projects", href: "/projects" },
      ...(project ? [{ label: project.name, href: `/projects/${projectRef}` }] : []),
      ...(project ? [{ label: "Worktrees", href: `/projects/${projectRef}/worktrees` }] : []),
      { label: worktree.name },
    ];
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, worktree, project, projectRef]);

  const updateWorktree = useMutation({
    mutationFn: (patch: Record<string, unknown>) => executionWorktreesApi.update(worktree!.id, patch),
    onSuccess: (nextWorktree) => {
      queryClient.setQueryData(queryKeys.executionWorktrees.detail(nextWorktree.id), nextWorktree);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorktrees.closeReadiness(nextWorktree.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorktrees.worktreeOperations(nextWorktree.id) });
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
      setErrorMessage(error instanceof Error ? error.message : "Failed to save execution worktree.");
    },
  });
  const worktreeOperationsQuery = useQuery({
    queryKey: queryKeys.executionWorktrees.worktreeOperations(worktreeId!),
    queryFn: () => executionWorktreesApi.listWorkspaceOperations(worktreeId!),
    enabled: Boolean(worktreeId),
  });
  const runtimeProvisionCommand =
    worktree?.config?.runtimeProvisionCommand
    ?? project?.executionWorkspacePolicy?.workspaceStrategy?.runtimeProvisionCommand
    ?? null;
  const runtimeProvisionStatus = useMemo(
    () =>
      resolveRuntimeProvisionStatus({
        runtimeProvisionCommand,
        operations: worktreeOperationsQuery.data,
      }),
    [runtimeProvisionCommand, worktreeOperationsQuery.data],
  );
  const controlRuntimeServices = useMutation({
    mutationFn: (request: WorktreeRuntimeControlRequest) =>
      executionWorktreesApi.controlRuntimeCommands(worktree!.id, request.action, request),
    onSuccess: (result, request) => {
      queryClient.setQueryData(queryKeys.executionWorktrees.detail(result.workspace.id), result.workspace);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorktrees.overview(result.workspace.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorktrees.worktreeOperations(result.workspace.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(result.workspace.projectId) });
      setRuntimeActionErrorMessage(null);
      setRuntimeActionMessage(
        request.action === "run"
          ? "Worktree job completed."
          : request.action === "stop"
            ? "Worktree service stopped."
            : request.action === "restart"
              ? "Worktree service restarted."
              : "Worktree service started.",
      );
    },
    onError: (error) => {
      setRuntimeActionMessage(null);
      setRuntimeActionErrorMessage(error instanceof Error ? error.message : "Failed to control worktree commands.");
    },
    onSettled: (_result, _error, request) => {
      setPendingRuntimeActions((current) => current.filter((pendingRequest) => pendingRequest !== request));
    },
  });

  /**
   * Password-independent workspace entry (PAP-17572).
   *
   * The server answers with a ticket-bearing URL, and the workspace answers *that*
   * with a redirect — which is what keeps the ticket out of session history.
   *
   * The target tab is opened synchronously on click and only pointed at the URL
   * once the ticket arrives. Opening it after the request resolves would be a
   * popup the browser did not attribute to the click, and Safari and Firefox
   * block exactly that. If the tab could not be opened anyway, fall back to
   * navigating this one rather than silently doing nothing.
   */
  const openWorktree = useMutation({
    mutationFn: async () => {
      const target = window.open("about:blank", "_blank", "noopener,noreferrer");
      try {
        return { ticket: await executionWorktreesApi.requestLoginHandoff(worktree!.id), target };
      } catch (error) {
        target?.close();
        throw error;
      }
    },
    onSuccess: ({ ticket, target }) => {
      setHandoffFailure(null);
      setHandoffErrorMessage(null);
      if (target && !target.closed) target.location.replace(ticket.url);
      else window.location.assign(ticket.url);
    },
    onError: async (error) => {
      // A structured refusal is rendered as workspace state by the access card,
      // so only an unrecognized transport error needs its own message line.
      const failure = readWorktreeHandoffFailure(error);
      setHandoffFailure(failure);
      setHandoffErrorMessage(
        failure ? null : error instanceof Error ? error.message : "Failed to open the worktree.",
      );
      // The refusal reason often comes from an operation that has since advanced,
      // so refresh the log the access card derives its state from.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.executionWorktrees.worktreeOperations(worktree!.id),
      });
    },
  });
  const repairWorktree = useMutation({
    mutationFn: () => executionWorktreesApi.repair(worktree!.id),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.executionWorktrees.detail(result.workspace.id), result.workspace);
      queryClient.invalidateQueries({
        queryKey: queryKeys.executionWorktrees.worktreeOperations(result.workspace.id),
      });
      setHandoffFailure(null);
      setHandoffErrorMessage(null);
      setRuntimeActionErrorMessage(null);
      setRuntimeActionMessage("Worktree database repaired.");
    },
    onError: (error) => {
      setRuntimeActionMessage(null);
      setRuntimeActionErrorMessage(error instanceof Error ? error.message : "Failed to repair the worktree.");
    },
  });

  if (worktreeQuery.isLoading) return <p className="text-sm text-muted-foreground">Loading worktree…</p>;
  if (worktreeQuery.error) {
    return (
      <p className="text-sm text-destructive">
        {worktreeQuery.error instanceof Error ? worktreeQuery.error.message : "Failed to load worktree"}
      </p>
    );
  }
  if (!worktree || !form || !initialState) return null;

  const canRunWorktreeCommands = Boolean(worktree.cwd);
  const canStartRuntimeServices = Boolean(effectiveRuntimeConfig) && canRunWorktreeCommands;
  const runtimeControlSections = buildWorktreeRuntimeControlSections({
    runtimeConfig: effectiveRuntimeConfig,
    runtimeServices: worktree.runtimeServices ?? [],
    canStartServices: canStartRuntimeServices,
    canRunJobs: canRunWorktreeCommands,
  });
  const pendingRuntimeAction = controlRuntimeServices.isPending ? controlRuntimeServices.variables ?? null : null;
  const serviceControlEntries = buildWorktreeServiceControlEntries({
    sections: runtimeControlSections,
    runtimeServices: worktree.runtimeServices ?? [],
    pendingRequests: pendingRuntimeActions,
  });
  const worktreeAccess = resolveWorktreeAccessState({
    runtimeServices: worktree.runtimeServices ?? [],
    operations: worktreeOperationsQuery.data,
    handoffFailure,
  });

  const pluginSlotContext = {
    companyId: worktree.companyId,
    projectId: worktree.projectId,
    entityId: worktree.id,
    entityType: "execution_workspace" as const,
  };
  const activePluginTab = worktreePluginTabItems.find((item) => item.value === activeTab) ?? null;

  if (worktreeId && activeTab === null) {
    return <LegacyWorktreeTabRedirect workspaceId={worktreeId} />;
  }

  const handleTabChange = (tab: ExecutionWorktreeTab) => {
    if (isExecutionWorktreePluginTab(tab)) {
      navigate(`/execution-worktrees/${worktree.id}?tab=${encodeURIComponent(tab)}`);
      return;
    }
    navigate(executionWorktreeTabPath(worktree.id, tab));
  };

  const saveChanges = () => {
    const validationError = validateForm(form);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    let patch: Record<string, unknown>;
    try {
      patch = buildWorktreePatch(initialState, form);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to build worktree update.");
      return;
    }

    if (Object.keys(patch).length === 0) return;
    updateWorktree.mutate(patch);
  };

  const runRuntimeControlRequests = (requests: WorktreeRuntimeControlRequest[]) => {
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
              Execution worktree
            </div>
            <h1 className="truncate text-xl font-semibold sm:text-2xl">{worktree.name}</h1>
          </div>
          <WorktreeServiceControlBar
            services={serviceControlEntries}
            onAction={(action, serviceKey) => {
              runRuntimeControlRequests(
                resolveWorktreeServiceControlRequests(runtimeControlSections, action, serviceKey),
              );
            }}
            onViewLogs={() => handleTabChange("runtime_logs")}
            onManageServices={() => handleTabChange("services")}
          />
        </div>
        {runtimeActionErrorMessage ? <p className="text-sm text-destructive">{runtimeActionErrorMessage}</p> : null}
        {!runtimeActionErrorMessage && runtimeActionMessage ? <p className="text-sm text-muted-foreground">{runtimeActionMessage}</p> : null}

        <WorktreeAccessCard
          access={worktreeAccess}
          isBusy={openWorktree.isPending || repairWorktree.isPending}
          onOpen={() => openWorktree.mutate()}
          onStart={() => {
            runRuntimeControlRequests(
              resolveWorktreeServiceControlRequests(runtimeControlSections, "start", null),
            );
          }}
          onRepair={() => repairWorktree.mutate()}
          onViewLogs={() => handleTabChange("runtime_logs")}
          errorMessage={handoffErrorMessage}
        />

        <PluginSlotOutlet
          slotTypes={["toolbarButton", "contextMenuItem"]}
          entityType="execution_workspace"
          context={pluginSlotContext}
          className="flex flex-wrap gap-2"
          itemClassName="inline-flex"
          missingBehavior="placeholder"
        />

        <Tabs value={activeTab ?? "issues"} onValueChange={(value) => handleTabChange(value as ExecutionWorktreeTab)}>
          <PageTabBar
            items={worktreeTabItems.map((item) => ({ value: item.value, label: item.label }))}
            align="start"
            value={activeTab ?? "issues"}
            onValueChange={(value) => handleTabChange(value as ExecutionWorktreeTab)}
          />
        </Tabs>

        {activeTab === "services" ? (
          <WorktreeRuntimeControls
            sections={runtimeControlSections}
            isPending={controlRuntimeServices.isPending}
            pendingRequest={pendingRuntimeAction}
            serviceEmptyMessage={
              effectiveRuntimeConfig
                ? "No services have been started for this execution worktree yet."
                : "No worktree command config is defined for this execution worktree yet."
            }
            jobEmptyMessage="No one-shot jobs are configured for this execution worktree yet."
            disabledHint={
              canStartRuntimeServices
                ? null
                : "Execution worktrees need a working directory before local commands can run, and services also need runtime config."
            }
            onAction={(request) => runRuntimeControlRequests([request])}
          />
        ) : activeTab === "configuration" ? (
          <div className="space-y-4 sm:space-y-6">
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>Worktree settings</CardTitle>
                <CardDescription>
                  Edit the concrete path, repo, branch, provisioning, teardown, and runtime overrides attached to this execution worktree. Saved changes affect future runs; Paperclip may refresh or replace a reused worktree when config changes.
                </CardDescription>
                <CardAction>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => setCloseDialogOpen(true)}
                    disabled={worktree.status === "archived"}
                  >
                    {worktree.status === "cleanup_failed" ? "Retry close" : "Close worktree"}
                  </Button>
                </CardAction>
              </CardHeader>

              <CardContent>

              <div className="space-y-6">
                <div className="space-y-4">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">General</div>
                  <Field label="Worktree name">
                    <Input
                      value={form.name}
                      onChange={(event) => setForm((current) => current ? { ...current, name: event.target.value } : current)}
                      placeholder="Execution worktree name"
                    />
                  </Field>
                </div>

                <Separator />

                <div className="space-y-4">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Source control</div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Branch name" hint="Useful for isolated worktrees">
                      <Input
                        className="font-mono"
                        value={form.branchName}
                        onChange={(event) => setForm((current) => current ? { ...current, branchName: event.target.value } : current)}
                        placeholder="PAP-946-workspace"
                      />
                    </Field>

                    <Field label="Base ref">
                      <Input
                        className="font-mono"
                        value={form.baseRef}
                        onChange={(event) => setForm((current) => current ? { ...current, baseRef: event.target.value } : current)}
                        placeholder="origin/main"
                      />
                    </Field>
                  </div>

                  <Field label="Repo URL">
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
                      <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Paths</div>
                      <Field label="Working directory">
                        <Input
                          className="font-mono"
                          value={form.cwd}
                          onChange={(event) => setForm((current) => current ? { ...current, cwd: event.target.value } : current)}
                          placeholder="/absolute/path/to/workspace"
                        />
                      </Field>

                      <Field label="Provider path / ref">
                        <Input
                          className="font-mono"
                          value={form.providerRef}
                          onChange={(event) => setForm((current) => current ? { ...current, providerRef: event.target.value } : current)}
                          placeholder="/path/to/worktree or provider ref"
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
                      <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Lifecycle commands</div>
                      <Field label="Provision command" hint="Runs when Paperclip prepares this execution worktree">
                        <Textarea
                          className="min-h-20 font-mono"
                          value={form.provisionCommand}
                          onChange={(event) => setForm((current) => current ? { ...current, provisionCommand: event.target.value } : current)}
                          placeholder="bash ./scripts/provision-worktree.sh"
                        />
                      </Field>

                      <Field
                        label="Runtime provision command"
                        hint="Runs once before the first runtime-service start. Leave empty to keep eager provisioning."
                      >
                        <Textarea
                          className="min-h-20 font-mono"
                          value={form.runtimeProvisionCommand}
                          onChange={(event) => setForm((current) => current ? { ...current, runtimeProvisionCommand: event.target.value } : current)}
                          placeholder="bash ./scripts/provision-worktree-runtime.sh"
                        />
                      </Field>

                      <Field label="Teardown command" hint="Runs when the execution worktree is archived or cleaned up">
                        <Textarea
                          className="min-h-20 font-mono"
                          value={form.teardownCommand}
                          onChange={(event) => setForm((current) => current ? { ...current, teardownCommand: event.target.value } : current)}
                          placeholder="bash ./scripts/teardown-worktree.sh"
                        />
                      </Field>

                      <Field label="Cleanup command" hint="Worktree-specific cleanup before teardown">
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
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Runtime config</div>
                  <div className="rounded-md border border-dashed border-border/70 bg-background px-4 py-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                      <div className="space-y-1">
                        <div className="text-sm font-medium text-foreground">
                          Runtime config source
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {runtimeConfigSource === "execution_workspace"
                            ? "This execution worktree currently overrides the project worktree runtime config."
                            : runtimeConfigSource === "project_workspace"
                              ? "This execution worktree is inheriting the project worktree runtime config."
                              : "No runtime config is currently defined on this execution worktree or its project worktree."}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        className="w-full sm:w-auto"
                        size="sm"
                        disabled={!linkedProjectWorktree?.runtimeConfig?.workspaceRuntime}
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
                    <summary className="cursor-pointer text-sm font-medium">Advanced runtime JSON</summary>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Override the inherited worktree command model only when this execution worktree truly needs different service or job behavior.
                    </p>
                    <div className="mt-3">
                      <Field label="Worktree commands JSON" hint="Legacy `services` arrays still work, but `commands` supports both services and jobs.">
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
                          <label htmlFor="inherit-runtime-config">Inherit project worktree runtime config</label>
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
                        <div className="text-sm font-medium">Service ports</div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Set a fixed port for a service or leave it blank to use its configured automatic behavior. Editing an inherited service creates an execution-worktree runtime override.
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {configuredRuntimeServicePorts.map((service) => (
                          <Field key={`${service.collection}-${service.index}`} label={service.name} hint="Fixed port">
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
                                    : parseWorktreeRuntimeJson(current.workspaceRuntime);
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
                        Paperclip checks fixed ports again when a service starts and rejects cross-worktree conflicts.
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <Button className="w-full sm:w-auto" disabled={!isDirty || updateWorktree.isPending} onClick={saveChanges}>
                  {updateWorktree.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save changes
                </Button>
                <Button
                  variant="outline"
                  className="w-full sm:w-auto"
                  disabled={!isDirty || updateWorktree.isPending}
                  onClick={() => {
                    setForm(initialState);
                    setErrorMessage(null);
                    setRuntimeActionErrorMessage(null);
                    setRuntimeActionMessage(null);
                  }}
                >
                  Reset
                </Button>
                {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
                {!errorMessage && !isDirty ? <p className="text-sm text-muted-foreground">No unsaved changes.</p> : null}
              </div>
              </CardContent>
            </Card>

            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>Worktree context</CardTitle>
                <CardDescription>Linked objects and relationships</CardDescription>
              </CardHeader>
              <CardContent>
              <DetailRow label="Project">
                {project ? <Link to={`/projects/${projectRef}`} className="hover:underline">{project.name}</Link> : <MonoValue value={worktree.projectId} />}
              </DetailRow>
              <DetailRow label="Project worktree">
                {project && linkedProjectWorktree ? (
                  <WorktreeLink project={project} workspace={linkedProjectWorktree} />
                ) : worktree.projectWorkspaceId ? (
                  <MonoValue value={worktree.projectWorkspaceId} />
                ) : (
                  "None"
                )}
              </DetailRow>
              <DetailRow label="Source task">
                {sourceIssue ? (
                  <Link to={issueUrl(sourceIssue)} className="hover:underline">
                    {sourceIssue.identifier ?? sourceIssue.id} · {sourceIssue.title}
                  </Link>
                ) : worktree.sourceIssueId ? (
                  <MonoValue value={worktree.sourceIssueId} />
                ) : (
                  "None"
                )}
              </DetailRow>
              <DetailRow label="Derived from">
                {derivedWorktree ? (
                  <Link to={executionWorktreeTabPath(derivedWorktree.id, "configuration")} className="hover:underline">
                    {derivedWorktree.name}
                  </Link>
                ) : worktree.derivedFromExecutionWorkspaceId ? (
                  <MonoValue value={worktree.derivedFromExecutionWorkspaceId} />
                ) : (
                  "None"
                )}
              </DetailRow>
              <DetailRow label="Runtime provisioning">
                <RuntimeProvisionStatusValue
                  status={runtimeProvisionStatus}
                  onViewLogs={() => handleTabChange("runtime_logs")}
                />
              </DetailRow>
              <DetailRow label="Worktree ID">
                <MonoValue value={worktree.id} />
              </DetailRow>
              </CardContent>
            </Card>

            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>Concrete location</CardTitle>
                <CardDescription>Paths and refs</CardDescription>
              </CardHeader>
              <CardContent>
              <DetailRow label="Working dir">
                {worktree.cwd ? <MonoValue value={worktree.cwd} copy /> : "None"}
              </DetailRow>
              <DetailRow label="Provider ref">
                {worktree.providerRef ? <MonoValue value={worktree.providerRef} copy /> : "None"}
              </DetailRow>
              <DetailRow label="Repo URL">
                {worktree.repoUrl && isSafeExternalUrl(worktree.repoUrl) ? (
                  <div className="inline-flex max-w-full items-start gap-2">
                    <a href={worktree.repoUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 break-all hover:underline">
                      {worktree.repoUrl}
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    </a>
                    <CopyText text={worktree.repoUrl} className="shrink-0 text-muted-foreground hover:text-foreground" copiedLabel="Copied">
                      <Copy className="h-3.5 w-3.5" />
                    </CopyText>
                  </div>
                ) : worktree.repoUrl ? (
                  <MonoValue value={worktree.repoUrl} copy />
                ) : (
                  "None"
                )}
              </DetailRow>
              <DetailRow label="Base ref">
                {worktree.baseRef ? <MonoValue value={worktree.baseRef} copy /> : "None"}
              </DetailRow>
              <DetailRow label="Branch">
                {worktree.branchName ? <MonoValue value={worktree.branchName} copy /> : "None"}
              </DetailRow>
              <DetailRow label="Opened">{formatDateTime(worktree.openedAt)}</DetailRow>
              <DetailRow label="Last used">{formatDateTime(worktree.lastUsedAt)}</DetailRow>
              <DetailRow label="Cleanup">
                {worktree.cleanupEligibleAt
                  ? `${formatDateTime(worktree.cleanupEligibleAt)}${worktree.cleanupReason ? ` · ${worktree.cleanupReason}` : ""}`
                  : "Not scheduled"}
              </DetailRow>
              </CardContent>
            </Card>
          </div>
        ) : activeTab === "runtime_logs" ? (
          <Card className="rounded-none">
            <CardHeader>
              <CardTitle>Runtime and cleanup logs</CardTitle>
              <CardDescription>Recent operations</CardDescription>
            </CardHeader>
            <CardContent>
            {worktreeOperationsQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading worktree operations…</p>
            ) : worktreeOperationsQuery.error ? (
              <p className="text-sm text-destructive">
                {worktreeOperationsQuery.error instanceof Error
                  ? worktreeOperationsQuery.error.message
                  : "Failed to load worktree operations."}
              </p>
            ) : worktreeOperationsQuery.data && worktreeOperationsQuery.data.length > 0 ? (
              <div className="space-y-3">
                {worktreeOperationsQuery.data.map((operation) => (
                  <div key={operation.id} className="rounded-none border border-border/80 bg-background px-4 py-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1">
                        <div className="text-sm font-medium">{operation.command ?? worktreeOperationPhaseLabel(operation.phase)}</div>
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
              <p className="text-sm text-muted-foreground">No worktree operations have been recorded yet.</p>
            )}
            </CardContent>
          </Card>
        ) : activeTab === "issues" ? (
          <div className="space-y-6">
            <SummarySlotCard
              companyId={worktree.companyId}
              scopeKind="execution_workspace"
              scopeId={worktree.id}
              title="Worktree summary"
              description="Summarizer keeps the latest worktree status, next step, and operator-needed items here."
            />
            <ExecutionWorktreeIssuesList
              companyId={worktree.companyId}
              workspace={worktree}
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
        ) : isExecutionWorktreePluginTab(activeTab) && worktreePluginDetailSlotsLoading ? (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">Loading worktree plugin...</CardContent>
          </Card>
        ) : isExecutionWorktreePluginTab(activeTab) && worktreePluginDetailSlotsError ? (
          <Card>
            <CardContent className="py-6 text-sm text-destructive">{worktreePluginDetailSlotsError}</CardContent>
          </Card>
        ) : isExecutionWorktreePluginTab(activeTab) ? (
          <MissingPluginTabPlaceholder
            defaultTabHref={executionWorktreeTabPath(worktree.id, "issues")}
            defaultTabLabel="Back to tasks"
          />
        ) : activeTab === "routines" ? (
          <ExecutionWorktreeRoutinesList
            workspace={worktree}
            project={project}
          />
        ) : (
          <LegacyWorktreeTabRedirect workspaceId={worktree.id} />
        )}
      </div>
      <ExecutionWorktreeCloseDialog
        workspaceId={worktree.id}
        workspaceName={worktree.name}
        currentStatus={worktree.status}
        open={closeDialogOpen}
        onOpenChange={setCloseDialogOpen}
        onClosed={(nextWorktree) => {
          queryClient.setQueryData(queryKeys.executionWorktrees.detail(nextWorktree.id), nextWorktree);
          queryClient.invalidateQueries({ queryKey: queryKeys.executionWorktrees.overview(nextWorktree.companyId) });
          queryClient.invalidateQueries({ queryKey: queryKeys.executionWorktrees.closeReadiness(nextWorktree.id) });
          queryClient.invalidateQueries({ queryKey: queryKeys.executionWorktrees.worktreeOperations(nextWorktree.id) });
          if (project) {
            queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
            queryClient.invalidateQueries({ queryKey: queryKeys.executionWorktrees.list(project.companyId, { projectId: project.id }) });
          }
          if (sourceIssue) {
            queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(sourceIssue.id) });
          }
        }}
      />
    </>
  );
}
