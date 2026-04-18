import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, Issue, ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import { AlertTriangle, HardDriveDownload, Play, RefreshCw, RotateCcw, Square, Zap } from "lucide-react";
import { agentsApi } from "../api/agents";
import { costsApi } from "../api/costs";
import type { AutomationPreflightResult, AutomationPreflightState } from "../api/instanceSettings";
import { instanceSettingsApi } from "../api/instanceSettings";
import { issuesApi } from "../api/issues";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";
import { Link } from "@/lib/router";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ToggleSwitch } from "./ui/toggle-switch";

type BulkAgentAction = "start" | "restart" | "stop" | "freeMemory";
type PlannedOperation = "resume" | "clearError" | "pause" | "pauseThenResume";

interface BulkAgentControlsProps {
  companyId: string;
  agents?: Agent[];
  showOpenAgentsLink?: boolean;
}

interface PlannedAgentTarget {
  agent: Agent;
  operation: PlannedOperation;
}

interface BulkAgentPlan {
  targets: PlannedAgentTarget[];
  totalControllable: number;
  skippedManualPaused: number;
}

interface LastFleetActionSummary {
  action: BulkAgentAction;
  succeeded: number;
  failed: number;
  skippedManualPaused: number;
  executedAt: Date;
}

interface LastDashboardSyncSummary {
  syncedAt: Date;
  sourceHead: string | null;
  targetHead: string | null;
}

interface AgentHeartbeatConfigLike {
  heartbeat?: {
    enabled?: boolean;
  };
}

type ProviderQuotaState = "available" | "pressured" | "unavailable" | "unknown";

interface ProviderQuotaSummary {
  provider: "anthropic" | "openai";
  label: string;
  state: ProviderQuotaState;
  detail: string;
  resetsAt: string | null;
  source: string | null;
}

type FlowBottleneckState = "loading" | "clear" | "detected";
type FlowBottleneckReason = "blocked" | "stale" | "packetization" | "none";

interface FlowBottleneckSummary {
  state: FlowBottleneckState;
  reason: FlowBottleneckReason;
  headline: string;
  detail: string;
  issueRefs: Array<Pick<Issue, "id" | "identifier" | "title">>;
}

function automationPreflightClass(state: AutomationPreflightState | "loading") {
  if (state === "degraded") {
    return "border-red-500/25 bg-red-500/[0.08] text-red-700 dark:text-red-300";
  }
  if (state === "healthy") {
    return "border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-300";
  }
  return "border-border/60 bg-background/50 text-muted-foreground";
}

const ACTION_LABELS: Record<BulkAgentAction, string> = {
  start: "Start",
  restart: "Restart",
  stop: "Stop",
  freeMemory: "Free Memory",
};

const ACTION_PROGRESS_LABELS: Record<BulkAgentAction, string> = {
  start: "Starting",
  restart: "Restarting",
  stop: "Stopping",
  freeMemory: "Freeing memory",
};

function isManualPaused(agent: Agent) {
  return agent.status === "paused" && agent.pauseReason === "manual";
}

function requiresManualRecovery(agent: Agent) {
  return agent.status === "error" && agent.adapterType === "process";
}

function isOpenIssue(issue: Issue) {
  return issue.hiddenAt == null && issue.status !== "done" && issue.status !== "cancelled";
}

function matchesManualRecoveryIssue(issue: Issue, agent: Agent) {
  const title = issue.title.toLowerCase();
  const description = (issue.description ?? "").toLowerCase();
  const agentName = agent.name.toLowerCase();
  const agentId = agent.id.toLowerCase();
  const agentUrlKey = agent.urlKey.toLowerCase();
  const recoveryLanguage =
    title.includes("recovery") ||
    description.includes("manual recovery") ||
    description.includes("process-lane");
  const agentMentioned =
    title.includes(agentName) ||
    description.includes(agentName) ||
    description.includes(agentId) ||
    title.includes(agentUrlKey) ||
    description.includes(agentUrlKey);

  return recoveryLanguage && agentMentioned;
}

function summarizeProviderQuota(
  results: ProviderQuotaResult[] | undefined,
  provider: "anthropic" | "openai",
): ProviderQuotaSummary {
  const result = results?.find((entry) => entry.provider === provider);
  const isOauthSource = result?.source === "anthropic-oauth";
  const label = provider === "anthropic" ? (isOauthSource ? "Claude Max (OAuth)" : "Anthropic") : "OpenAI";
  if (!result) {
    return {
      provider,
      label,
      state: "unknown",
      detail: "No live quota signal yet",
      resetsAt: null,
      source: null,
    };
  }

  if (!result.ok) {
    return {
      provider,
      label,
      state: "unknown",
      detail: result.error?.trim() || "Quota probe unavailable",
      resetsAt: null,
      source: result.source ?? null,
    };
  }

  const windows = result.windows.filter((window): window is QuotaWindow => !!window);
  const usageWindows = windows.filter((window) => typeof window.usedPercent === "number");
  const highestWindow = usageWindows.sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0] ?? null;

  if (highestWindow?.usedPercent != null && highestWindow.usedPercent >= 100) {
    return {
      provider,
      label,
      state: "unavailable",
      detail: isOauthSource
        ? `${highestWindow.label} exhausted — agent API key calls unaffected`
        : `${highestWindow.label} exhausted`,
      resetsAt: highestWindow.resetsAt ?? null,
      source: result.source ?? null,
    };
  }

  if (highestWindow?.usedPercent != null && highestWindow.usedPercent >= 85) {
    return {
      provider,
      label,
      state: "pressured",
      detail: `${highestWindow.label} at ${highestWindow.usedPercent}% used`,
      resetsAt: highestWindow.resetsAt ?? null,
      source: result.source ?? null,
    };
  }

  if (highestWindow?.usedPercent != null) {
    return {
      provider,
      label,
      state: "available",
      detail: `${highestWindow.label} at ${highestWindow.usedPercent}% used`,
      resetsAt: highestWindow.resetsAt ?? null,
      source: result.source ?? null,
    };
  }

  const creditWindow = windows.find((window) => typeof window.valueLabel === "string" && window.valueLabel.trim().length > 0);
  if (creditWindow) {
    return {
      provider,
      label,
      state: "available",
      detail: creditWindow.valueLabel?.trim() || "Quota window healthy",
      resetsAt: creditWindow.resetsAt ?? null,
      source: result.source ?? null,
    };
  }

  return {
    provider,
    label,
    state: "available",
    detail: "Quota windows healthy",
    resetsAt: null,
    source: result.source ?? null,
  };
}

function providerStatusClass(state: ProviderQuotaState) {
  if (state === "unavailable") {
    return "border-red-500/30 bg-red-500/[0.08] text-red-700 dark:text-red-300";
  }
  if (state === "pressured") {
    return "border-amber-500/30 bg-amber-500/[0.08] text-amber-700 dark:text-amber-300";
  }
  if (state === "available") {
    return "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300";
  }
  return "border-border/70 bg-background/70 text-muted-foreground";
}

function watcherStatusClass(active: boolean, degraded: boolean) {
  if (degraded) {
    return "border-amber-500/20 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300";
  }
  if (active) {
    return "border-sky-500/20 bg-sky-500/[0.06] text-sky-700 dark:text-sky-300";
  }
  return "border-border/60 bg-background/50 text-muted-foreground";
}

function flowBottleneckClass(state: FlowBottleneckState) {
  if (state === "detected") {
    return "border-red-500/25 bg-red-500/[0.08] text-red-700 dark:text-red-300";
  }
  if (state === "clear") {
    return "border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-300";
  }
  return "border-border/60 bg-background/50 text-muted-foreground";
}

function isHeartbeatEnabled(agent: Agent) {
  return ((agent.runtimeConfig as AgentHeartbeatConfigLike | null | undefined)?.heartbeat?.enabled ?? false) === true;
}

export function buildFlowBottleneckSummary(
  agents: Agent[] | undefined,
  issues: Issue[] | undefined,
): FlowBottleneckSummary {
  if (!agents || !issues) {
    return {
      state: "loading",
      reason: "none",
      headline: "Flow Bottleneck",
      detail: "Scanning board flow and staffing signals.",
      issueRefs: [],
    };
  }

  const openIssues = issues.filter(isOpenIssue);
  const blockedIssues = openIssues.filter((issue) => issue.status === "blocked");
  if (blockedIssues.length > 0) {
    return {
      state: "detected",
      reason: "blocked",
      headline: "Flow Bottleneck",
      detail: `${blockedIssues.length} blocked issue${blockedIssues.length === 1 ? "" : "s"} are constraining delivery flow.`,
      issueRefs: blockedIssues.slice(0, 3).map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
      })),
    };
  }

  const assignedAgentIds = new Set(
    openIssues
      .filter((issue) => !!issue.assigneeAgentId)
      .map((issue) => issue.assigneeAgentId!),
  );
  const idleAvailableAgents = agents.filter(
    (agent) =>
      agent.status === "idle" &&
      !requiresManualRecovery(agent) &&
      (isHeartbeatEnabled(agent) || agent.adapterType === "process"),
  );
  const idleUnassignedAgents = idleAvailableAgents.filter((agent) => !assignedAgentIds.has(agent.id));

  const staleCutoffMs = 18 * 60 * 60 * 1000;
  const staleActiveIssues = openIssues.filter((issue) => {
    if (issue.status !== "in_progress" && issue.status !== "in_review") return false;
    const updatedAt = new Date(issue.updatedAt).getTime();
    return Number.isFinite(updatedAt) && Date.now() - updatedAt >= staleCutoffMs;
  });
  if (staleActiveIssues.length > 0 && idleUnassignedAgents.length > 0) {
    return {
      state: "detected",
      reason: "stale",
      headline: "Flow Bottleneck",
      detail: `${staleActiveIssues.length} active issue${staleActiveIssues.length === 1 ? "" : "s"} look stale while ${idleUnassignedAgents.length} lane${idleUnassignedAgents.length === 1 ? "" : "s"} are idle.`,
      issueRefs: staleActiveIssues.slice(0, 3).map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
      })),
    };
  }

  const unassignedReadyIssues = openIssues.filter(
    (issue) =>
      (issue.status === "todo" || issue.status === "backlog") &&
      !issue.assigneeAgentId,
  );
  if (unassignedReadyIssues.length > 0 && idleUnassignedAgents.length > 0) {
    return {
      state: "detected",
      reason: "packetization",
      headline: "Flow Bottleneck",
      detail: `${unassignedReadyIssues.length} ready issue${unassignedReadyIssues.length === 1 ? "" : "s"} are unowned while ${idleUnassignedAgents.length} lane${idleUnassignedAgents.length === 1 ? "" : "s"} are idle.`,
      issueRefs: unassignedReadyIssues.slice(0, 3).map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
      })),
    };
  }

  return {
    state: "clear",
    reason: "none",
    headline: "Flow Bottleneck",
    detail: "No board-level bottleneck is identified right now.",
    issueRefs: [],
  };
}

export function buildBulkAgentPlan(
  agents: Agent[] | undefined,
  action: BulkAgentAction,
  includeManualPaused: boolean,
  issues?: Issue[],
): BulkAgentPlan {
  const source = agents ?? [];
  const targets: PlannedAgentTarget[] = [];
  let totalControllable = 0;
  let skippedManualPaused = 0;
  const assignedAgentIds = new Set(
    (issues ?? [])
      .filter(
        (issue) =>
          !!issue.assigneeAgentId &&
          issue.hiddenAt == null &&
          issue.status !== "done" &&
          issue.status !== "cancelled",
      )
      .map((issue) => issue.assigneeAgentId!),
  );

  for (const agent of source) {
    if (agent.status === "terminated") continue;
    totalControllable += 1;

    const skippedForManualPause =
      action === "start" &&
      isManualPaused(agent) &&
      !includeManualPaused;

    if (skippedForManualPause) {
      skippedManualPaused += 1;
      continue;
    }

    if (action === "start") {
      if (agent.status === "paused") {
        targets.push({ agent, operation: "resume" });
      }
      continue;
    }

    if (action === "stop") {
      if (agent.status !== "paused") {
        targets.push({ agent, operation: "pause" });
      }
      continue;
    }

    if (action === "freeMemory") {
      if (agent.status === "idle" && !assignedAgentIds.has(agent.id)) {
        targets.push({ agent, operation: "pause" });
      }
      continue;
    }

    if (action === "restart") {
      if (agent.status === "error" && !requiresManualRecovery(agent)) {
        targets.push({ agent, operation: "clearError" });
      }
      continue;
    }

  }

  return {
    targets,
    totalControllable,
    skippedManualPaused,
  };
}

function formatFailureSummary(failed: PlannedAgentTarget[]) {
  const names = failed.slice(0, 3).map(({ agent }) => agent.name);
  if (names.length === 0) return undefined;
  const suffix = failed.length > names.length ? ` and ${failed.length - names.length} more` : "";
  return `${names.join(", ")}${suffix}`;
}

async function runPlannedOperation(
  companyId: string,
  target: PlannedAgentTarget,
) {
  const { agent, operation } = target;

  if (operation === "resume") {
    await agentsApi.resume(agent.id, companyId);
    return;
  }

  if (operation === "clearError") {
    await agentsApi.update(
      agent.id,
      {
        status: "idle",
        pauseReason: null,
        pausedAt: null,
      },
      companyId,
    );
    return;
  }

  if (operation === "pause") {
    await agentsApi.pause(agent.id, companyId);
    return;
  }

  await agentsApi.pause(agent.id, companyId);
  await agentsApi.resume(agent.id, companyId);
}

function actionDescription(
  action: BulkAgentAction,
  targetCount: number,
  skippedManualPaused: number,
) {
  if (action === "start") {
    return targetCount === 0
      ? "No paused agents are eligible to start right now."
      : `This will resume ${targetCount} paused agent${targetCount === 1 ? "" : "s"} back to idle.`;
  }
  if (action === "restart") {
    return targetCount === 0
      ? "No agents currently need recovery."
      : `This will recover ${targetCount} errored agent${targetCount === 1 ? "" : "s"} back to idle without interrupting healthy work.`;
  }
  if (action === "freeMemory") {
    return targetCount === 0
      ? "No idle agents are currently free of assigned work."
      : `This will pause ${targetCount} idle agent${targetCount === 1 ? "" : "s"} with no open assigned issues to free local resources.`;
  }
  const skippedText =
    skippedManualPaused > 0
      ? ` Agents already paused stay paused.`
      : "";
  return targetCount === 0
    ? "All controllable agents are already stopped."
    : `This will pause ${targetCount} running or available agent${targetCount === 1 ? "" : "s"}.${skippedText}`;
}

function disabledReason(
  action: BulkAgentAction,
  plan: BulkAgentPlan,
  agents?: Agent[],
  assignmentsReady: boolean = true,
) {
  if (!agents) return "Loading agents";
  if (agents.length === 0) return "No agents yet";
  if (action === "freeMemory" && !assignmentsReady) return "Loading assignments";
  if (action === "start" && plan.targets.length === 0) return "Nothing paused";
  if (action === "restart" && plan.targets.length === 0) {
    const manualRecoveryCount = agents.filter(requiresManualRecovery).length;
    return manualRecoveryCount > 0 ? "Manual recovery needed" : "Nothing needs recovery";
  }
  if (action === "stop" && plan.targets.length === 0) return "Already stopped";
  if (action === "freeMemory" && plan.targets.length === 0) return "No free idle agents";
  return null;
}

export function BulkAgentControls({
  companyId,
  agents,
  showOpenAgentsLink = false,
}: BulkAgentControlsProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [includeManualPaused, setIncludeManualPaused] = useState(false);
  const [pendingAction, setPendingAction] = useState<BulkAgentAction | null>(null);
  const [activeAction, setActiveAction] = useState<BulkAgentAction | null>(null);
  const [lastActionSummary, setLastActionSummary] = useState<LastFleetActionSummary | null>(null);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [syncingDashboardRepo, setSyncingDashboardRepo] = useState(false);
  const [lastDashboardSync, setLastDashboardSync] = useState<LastDashboardSyncSummary | null>(null);
  const { data: issues, isLoading: issuesLoading } = useQuery({
    queryKey: queryKeys.issues.list(companyId),
    queryFn: () => issuesApi.list(companyId),
    enabled: !!companyId,
  });
  const { data: quotaWindows, isLoading: quotaWindowsLoading } = useQuery({
    queryKey: queryKeys.usageQuotaWindows(companyId),
    queryFn: () => costsApi.quotaWindows(companyId),
    enabled: !!companyId,
    staleTime: 60_000,
  });
  const { data: automationPreflight, isLoading: automationPreflightLoading } = useQuery({
    queryKey: queryKeys.instance.automationPreflight,
    queryFn: () => instanceSettingsApi.getAutomationPreflight(),
    enabled: !!companyId,
    staleTime: 60_000,
  });

  const startPlan = useMemo(
    () => buildBulkAgentPlan(agents, "start", includeManualPaused),
    [agents, includeManualPaused],
  );
  const restartPlan = useMemo(
    () => buildBulkAgentPlan(agents, "restart", includeManualPaused),
    [agents, includeManualPaused],
  );
  const stopPlan = useMemo(() => buildBulkAgentPlan(agents, "stop", includeManualPaused), [agents, includeManualPaused]);
  const freeMemoryPlan = useMemo(
    () => buildBulkAgentPlan(agents, "freeMemory", includeManualPaused, issues),
    [agents, includeManualPaused, issues],
  );

  const plans = {
    start: startPlan,
    restart: restartPlan,
    stop: stopPlan,
    freeMemory: freeMemoryPlan,
  } satisfies Record<BulkAgentAction, BulkAgentPlan>;

  const activePlan = pendingAction ? plans[pendingAction] : null;
  const controllableCount = startPlan.totalControllable;
  const pausedCount = (agents ?? []).filter((agent) => agent.status === "paused").length;
  const errorCount = (agents ?? []).filter((agent) => agent.status === "error").length;
  const erroredAgents = (agents ?? []).filter((agent) => agent.status === "error");
  const manualRecoveryAgents = erroredAgents.filter(requiresManualRecovery);
  const runningCount = (agents ?? []).filter((agent) => agent.status === "running").length;
  const manualPausedCount = (agents ?? []).filter(isManualPaused).length;
  const protectedManualPausedCount = includeManualPaused ? 0 : manualPausedCount;
  const providerSummaries = useMemo(
    () => ({
      anthropic: summarizeProviderQuota(quotaWindows, "anthropic"),
      openai: summarizeProviderQuota(quotaWindows, "openai"),
    }),
    [quotaWindows],
  );
  const providerPressureActive = Object.values(providerSummaries).some(
    (summary) => summary.state === "pressured" || summary.state === "unavailable",
  );
  const providerUnknown = Object.values(providerSummaries).every((summary) => summary.state === "unknown");
  const watcherDetail = quotaWindowsLoading
    ? "Checking provider quota windows."
    : providerSummaries.anthropic.source === "anthropic-oauth" && (providerSummaries.anthropic.state === "pressured" || providerSummaries.anthropic.state === "unavailable")
      ? "Claude Max OAuth quota elevated — agent API key calls (claude_local) are unaffected."
      : providerPressureActive
        ? "Provider quota pressure detected — review agent run errors for details."
        : providerUnknown
          ? "No live quota signal yet."
          : "Provider quotas nominal.";
  const agentNameById = useMemo(
    () =>
      new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const recoveryTicketAssignments = useMemo(
    () =>
      erroredAgents.map((agent) => {
        const issue = (issues ?? []).find(
          (candidate) => isOpenIssue(candidate) && matchesManualRecoveryIssue(candidate, agent),
        );
        return {
          agent,
          issue: issue ?? null,
          assigneeName:
            issue?.assigneeAgentId != null ? agentNameById.get(issue.assigneeAgentId) ?? null : null,
        };
      }),
    [agentNameById, erroredAgents, issues],
  );
  const ticketedRecoveryAssignments = recoveryTicketAssignments.filter(({ issue, agent }) => issue != null || requiresManualRecovery(agent));
  const unticketedAutoRecoverableErrorCount = erroredAgents.filter(
    (agent) =>
      !requiresManualRecovery(agent) &&
      !recoveryTicketAssignments.some(
        (assignment) => assignment.agent.id === agent.id && assignment.issue != null,
      ),
  ).length;
  const flowBottleneck = useMemo(
    () => buildFlowBottleneckSummary(agents, issues),
    [agents, issues],
  );
  const automationPreflightState = automationPreflightLoading
    ? "loading"
    : (automationPreflight?.state ?? "unknown");

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(companyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.activity(companyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(companyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(companyId) }),
    ]);
  };

  const handleSyncDashboardRepo = async () => {
    setSyncingDashboardRepo(true);
    try {
      const result = await instanceSettingsApi.syncDashboardRepo();
      setLastDashboardSync({
        syncedAt: new Date(result.syncedAt),
        sourceHead: result.sourceHead,
        targetHead: result.targetHead,
      });
      pushToast({
        tone: "success",
        title: "Dashboard copy synced",
        body: result.restartRecommended
          ? `Copied ${result.sourceHead ?? "latest"} into the dashboard-owned Paperclip repo. Restart the dashboard to load code changes.`
          : `Copied ${result.sourceHead ?? "latest"} into the dashboard-owned Paperclip repo.`,
      });
      setSyncDialogOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to sync the dashboard-owned repo.";
      pushToast({
        tone: "error",
        title: "Dashboard copy sync failed",
        body: message,
      });
    } finally {
      setSyncingDashboardRepo(false);
    }
  };

  const handleExecute = async () => {
    if (!pendingAction || !activePlan) return;
    const { targets, skippedManualPaused } = activePlan;
    const action = pendingAction;
    setActiveAction(action);

    if (targets.length === 0) {
      pushToast({
        tone: "info",
        title: `${ACTION_LABELS[action]} skipped`,
        body: "No agents matched that action.",
      });
      setActiveAction(null);
      setPendingAction(null);
      return;
    }

    const failed: PlannedAgentTarget[] = [];

    for (const target of targets) {
      try {
        await runPlannedOperation(companyId, target);
      } catch {
        failed.push(target);
      }
    }

    await invalidate();
    const succeeded = targets.length - failed.length;
    setLastActionSummary({
      action,
      succeeded,
      failed: failed.length,
      skippedManualPaused,
      executedAt: new Date(),
    });

    if (failed.length === 0) {
      pushToast({
        tone: "success",
        title: `${ACTION_LABELS[action]} complete`,
        body:
          skippedManualPaused > 0 && (action === "start" || action === "restart")
            ? `${succeeded} agents updated. ${skippedManualPaused} manually paused lane${skippedManualPaused === 1 ? "" : "s"} stayed untouched.`
            : `${succeeded} agents updated successfully.`,
      });
    } else {
      const failureSummary = formatFailureSummary(failed);
      pushToast({
        tone: failed.length === targets.length ? "error" : "warn",
        title: `${ACTION_LABELS[action]} finished with issues`,
        body: failureSummary
          ? `${succeeded} succeeded, ${failed.length} failed: ${failureSummary}.`
          : `${succeeded} succeeded, ${failed.length} failed.`,
      });
    }

    setActiveAction(null);
    setPendingAction(null);
  };

  const pendingLabel = pendingAction ? ACTION_LABELS[pendingAction] : null;
  const busy = activeAction !== null;
  const controlsBusy = busy || syncingDashboardRepo;
  const startDisabledReason = disabledReason("start", startPlan, agents);
  const restartDisabledReason = disabledReason("restart", restartPlan, agents);
  const stopDisabledReason = disabledReason("stop", stopPlan, agents);
  const freeMemoryDisabledReason = disabledReason("freeMemory", freeMemoryPlan, agents, !issuesLoading);
  const lastActionTone =
    !lastActionSummary ? null : lastActionSummary.failed > 0 ? "warn" : "success";
  const lastActionText = !lastActionSummary
    ? null
    : `${ACTION_LABELS[lastActionSummary.action]} ${relativeTime(lastActionSummary.executedAt)}: ${lastActionSummary.succeeded} succeeded` +
      (lastActionSummary.failed > 0 ? `, ${lastActionSummary.failed} failed` : "") +
      (lastActionSummary.skippedManualPaused > 0
        ? `, ${lastActionSummary.skippedManualPaused} manual lane${lastActionSummary.skippedManualPaused === 1 ? "" : "s"} skipped`
        : "");
  return (
    <>
      <div className="rounded-xl border border-border bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))] p-4 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Fleet Controls
              </h3>
              <p className="mt-1 text-sm text-foreground">
                Start, stop, or restart the full agent fleet from the dashboard.
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              These controls change agent availability. They do not automatically assign new work.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <span className="inline-flex items-center rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-[11px] font-medium text-foreground">
                {controllableCount} controllable
              </span>
              <span className="inline-flex items-center rounded-full border border-cyan-500/20 bg-cyan-500/[0.08] px-2.5 py-1 text-[11px] font-medium text-cyan-700 dark:text-cyan-300">
                {runningCount} running
              </span>
              <span
                className={
                  includeManualPaused
                    ? "inline-flex items-center rounded-full border border-amber-500/20 bg-amber-500/[0.1] px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300"
                    : "inline-flex items-center rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
                }
              >
                {includeManualPaused
                  ? `${manualPausedCount} manual lane${manualPausedCount === 1 ? "" : "s"} included`
                  : `${protectedManualPausedCount} manual hold${protectedManualPausedCount === 1 ? "" : "s"} protected`}
              </span>
            </div>
          </div>

          <div className="flex flex-col items-stretch gap-3">
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSyncDialogOpen(true)}
                disabled={controlsBusy}
              >
                <RefreshCw className="h-4 w-4" />
                Sync Dashboard Copy
              </Button>
              {showOpenAgentsLink && (
                <Button asChild size="sm" variant="outline">
                  <Link to="/agents">Open Agents Console</Link>
                </Button>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 hover:text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20 dark:hover:text-emerald-200"
                  onClick={() => setPendingAction("start")}
                  disabled={controlsBusy || startPlan.targets.length === 0 || !agents}
                >
                  <Play className="h-4 w-4" />
                  Start All
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  {startDisabledReason ?? "Resume paused lanes without touching recovery cases"}
                </p>
              </div>
              <div className="space-y-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 hover:text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20 dark:hover:text-amber-200"
                  onClick={() => setPendingAction("restart")}
                  disabled={controlsBusy || restartPlan.targets.length === 0 || !agents}
                >
                  <RotateCcw className="h-4 w-4" />
                  Restart All
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  {restartDisabledReason ?? "Recover only errored agents without interrupting healthy work"}
                </p>
              </div>
              <div className="space-y-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full border-sky-500/30 bg-sky-500/10 text-sky-700 hover:bg-sky-500/15 hover:text-sky-800 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-300 dark:hover:bg-sky-500/20 dark:hover:text-sky-200"
                  onClick={() => setPendingAction("freeMemory")}
                  disabled={controlsBusy || freeMemoryPlan.targets.length === 0 || !agents || issuesLoading}
                >
                  <HardDriveDownload className="h-4 w-4" />
                  Free Memory
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  {freeMemoryDisabledReason ?? "Pause idle agents with no open assigned work"}
                </p>
              </div>
              <div className="space-y-1">
                <Button
                  size="sm"
                  variant="destructive"
                  className="w-full shadow-sm shadow-red-950/20"
                  onClick={() => setPendingAction("stop")}
                  disabled={controlsBusy || stopPlan.targets.length === 0 || !agents}
                >
                  <Square className="h-4 w-4" />
                  Stop All
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  {stopDisabledReason ?? "Pause all active controllable agents"}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-4">
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <div className="font-medium text-foreground">{controllableCount}</div>
            <div>Controllable agents</div>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <div className="font-medium text-foreground">{runningCount}</div>
            <div>Running now</div>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <div className="font-medium text-foreground">{pausedCount}</div>
            <div>Paused lanes</div>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <div className="font-medium text-foreground">{errorCount}</div>
            <div>Errored agents</div>
          </div>
        </div>

        <div className={`mt-3 rounded-lg border px-3 py-3 text-xs ${flowBottleneckClass(flowBottleneck.state)}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={
                    flowBottleneck.state === "detected"
                      ? "inline-flex h-2.5 w-2.5 rounded-full bg-red-500 shadow-[0_0_0_4px_rgba(239,68,68,0.12)]"
                      : flowBottleneck.state === "clear"
                        ? "inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]"
                        : "inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/60"
                  }
                />
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  {flowBottleneck.headline}
                </span>
                {flowBottleneck.state === "detected" ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-red-500/20 bg-red-500/[0.12] px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-300">
                    <AlertTriangle className="h-3 w-3" />
                    Detected
                  </span>
                ) : flowBottleneck.state === "clear" ? (
                  <span className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/[0.12] px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                    Clear
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    Scanning
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm text-foreground">{flowBottleneck.detail}</p>
            </div>
            <Link to="/issues" className="text-xs underline underline-offset-2 text-foreground">
              Open issues
            </Link>
          </div>
          {flowBottleneck.issueRefs.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {flowBottleneck.issueRefs.map((issue) => (
                <Link
                  key={issue.id}
                  to={`/issues/${issue.identifier ?? issue.id}`}
                  className="inline-flex items-center rounded-full border border-current/15 bg-background/50 px-2.5 py-1 text-[11px] font-medium underline-offset-2 hover:underline"
                  title={issue.title}
                >
                  {issue.identifier ?? issue.title}
                </Link>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/50 px-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Provider Watch
            </span>
            {(["anthropic", "openai"] as const).map((provider) => {
              const summary = providerSummaries[provider];
              return (
                <span
                  key={provider}
                  className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${providerStatusClass(summary.state)}`}
                  title={summary.resetsAt ? `${summary.detail}. Resets ${new Date(summary.resetsAt).toLocaleString()}` : summary.detail}
                >
                  {summary.label} {summary.state}
                </span>
              );
            })}
          </div>
          <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            {(["anthropic", "openai"] as const).map((provider) => {
              const summary = providerSummaries[provider];
              return (
                <div key={provider} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                  <div className="font-medium text-foreground">{summary.label}</div>
                  <div>{summary.detail}</div>
                </div>
              );
            })}
          </div>
          <div
            className={`mt-2 rounded-lg border px-3 py-2 text-xs ${watcherStatusClass(!quotaWindowsLoading && !providerUnknown && !providerPressureActive, providerPressureActive)}`}
          >
            {watcherDetail}
          </div>
        </div>

        <div className={`mt-3 rounded-lg border px-3 py-3 ${automationPreflightClass(automationPreflightState)}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={
                    automationPreflightState === "degraded"
                      ? "inline-flex h-2.5 w-2.5 rounded-full bg-red-500 shadow-[0_0_0_4px_rgba(239,68,68,0.12)]"
                      : automationPreflightState === "healthy"
                        ? "inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]"
                        : "inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/60"
                  }
                />
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Automation Preflight
                </span>
                {automationPreflightState === "degraded" ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-red-500/20 bg-red-500/[0.12] px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-300">
                    <AlertTriangle className="h-3 w-3" />
                    Degraded
                  </span>
                ) : automationPreflightState === "healthy" ? (
                  <span className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/[0.12] px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                    Healthy
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    Checking
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm text-foreground">
                {automationPreflight?.detail ?? "Checking dashboard-owned GitHub, Claude, and Codex auth."}
              </p>
            </div>
          </div>
          <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            {(automationPreflight?.checks ?? [
              { id: "github", label: "GitHub", state: "unknown", detail: "Checking GitHub auth.", impacts: [], lastUpdatedAt: null },
              { id: "claude", label: "Claude", state: "unknown", detail: "Checking Claude auth.", impacts: [], lastUpdatedAt: null },
              { id: "codex", label: "Codex", state: "unknown", detail: "Checking Codex auth.", impacts: [], lastUpdatedAt: null },
            ] satisfies AutomationPreflightResult["checks"]).map((check) => (
              <div key={check.id} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span
                    className={
                      check.state === "degraded"
                        ? "inline-flex h-2 w-2 rounded-full bg-red-500"
                        : check.state === "healthy"
                          ? "inline-flex h-2 w-2 rounded-full bg-emerald-500"
                          : "inline-flex h-2 w-2 rounded-full bg-muted-foreground/60"
                    }
                  />
                  <span className="font-medium text-foreground">{check.label}</span>{" "}
                  <span className="text-[11px] capitalize">{check.state}</span>
                </div>
                <div className="mt-1">{check.detail}</div>
                {check.lastUpdatedAt ? (
                  <div className="mt-1 text-[11px]">
                    Last updated {relativeTime(new Date(check.lastUpdatedAt))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {automationPreflight?.prAutomationDegraded ? (
            <div className="mt-2 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs">
              PR and merge automation is degraded until dashboard-home GitHub auth is repaired.
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Zap className="h-4 w-4 text-muted-foreground" />
              Include manually paused lanes
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Keep this off to avoid restarting intentionally paused trading or execution lanes by accident.
            </p>
          </div>
          <ToggleSwitch
            checked={includeManualPaused}
            onCheckedChange={setIncludeManualPaused}
            disabled={controlsBusy || !agents}
            aria-label="Include manually paused lanes in start and restart actions"
          />
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-muted-foreground">
          <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <div className="space-y-1">
            {ticketedRecoveryAssignments.length > 0 ? (
              <>
                {ticketedRecoveryAssignments.map(({ agent, issue, assigneeName }) => (
                <p key={agent.id}>
                  <span className="font-medium text-foreground">{agent.name}</span>{" "}
                  {requiresManualRecovery(agent) ? "needs manual recovery." : "needs recovery."}
                  {issue ? (
                    <>
                      {" "}Recovery assigned as an IT ticket{" "}
                      <Link
                        to={`/issues/${issue.identifier ?? issue.id}`}
                        className="font-medium text-foreground underline underline-offset-2"
                      >
                        {issue.identifier ?? issue.title}
                      </Link>
                      {assigneeName ? ` to ${assigneeName}.` : "."}
                    </>
                  ) : (
                    " No IT recovery ticket is assigned yet."
                  )}
                </p>
                ))}
                {unticketedAutoRecoverableErrorCount > 0 ? (
                  <p>
                    {unticketedAutoRecoverableErrorCount} other agent{unticketedAutoRecoverableErrorCount === 1 ? "" : "s"} currently need recovery.
                    {" "}Restart all will recover them without assigning new work.
                  </p>
                ) : null}
              </>
            ) : errorCount > 0 ? (
              <p>
                {errorCount} agent{errorCount === 1 ? "" : "s"} currently need recovery.
                {" "}Restart all will recover them without assigning new work.
              </p>
            ) : (
              <p>
                Start resumes paused lanes, Restart recovers errored agents, and Free Memory pauses idle agents with no active assigned work.
              </p>
            )}
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-xs text-muted-foreground">
          {lastActionSummary ? (
            <div className="flex items-center gap-2">
              <span
                className={
                  lastActionTone === "warn"
                    ? "inline-flex h-2 w-2 rounded-full bg-amber-500"
                    : "inline-flex h-2 w-2 rounded-full bg-emerald-500"
                }
              />
              <span className="font-medium text-foreground">Last action</span>
              <span>{lastActionText}</span>
            </div>
          ) : (
            <span>No fleet-wide action has been run from this page yet.</span>
          )}
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-xs text-muted-foreground">
          {lastDashboardSync ? (
            <div className="flex items-center gap-2">
              <span className="inline-flex h-2 w-2 rounded-full bg-sky-500" />
              <span className="font-medium text-foreground">Dashboard copy</span>
              <span>
                Synced {relativeTime(lastDashboardSync.syncedAt)}
                {lastDashboardSync.sourceHead ? ` from ${lastDashboardSync.sourceHead}` : ""}.
                Restart the dashboard to load copied code.
              </span>
            </div>
          ) : (
            <span>Use Sync Dashboard Copy to refresh the dashboard-owned Paperclip repo before a restart.</span>
          )}
        </div>
      </div>

      <Dialog open={pendingAction !== null} onOpenChange={(open) => !open && !busy && setPendingAction(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pendingAction === "freeMemory" ? "Free memory across idle agents?" : `${pendingLabel} all agents?`}
            </DialogTitle>
            <DialogDescription>
              {activePlan
                ? actionDescription(pendingAction!, activePlan.targets.length, activePlan.skippedManualPaused)
                : "Choose an action for the current company fleet."}
            </DialogDescription>
          </DialogHeader>

          {activePlan && pendingAction === "start" && activePlan.skippedManualPaused > 0 ? (
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
              {activePlan.skippedManualPaused} manually paused lane
              {activePlan.skippedManualPaused === 1 ? "" : "s"} will stay paused unless you toggle them on first.
            </div>
          ) : null}

          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            Target agents: <span className="font-medium text-foreground">{activePlan?.targets.length ?? 0}</span>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingAction(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={pendingAction === "stop" ? "destructive" : "default"}
              onClick={handleExecute}
              disabled={busy}
            >
              {busy
                ? `${ACTION_PROGRESS_LABELS[activeAction!]}...`
                : pendingAction === "freeMemory"
                  ? "Free Memory"
                  : `${pendingLabel} All`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={syncDialogOpen} onOpenChange={(open) => !syncingDashboardRepo && setSyncDialogOpen(open)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sync dashboard-owned Paperclip copy?</DialogTitle>
            <DialogDescription>
              This copies the latest Paperclip code from the canonical repo into the dashboard-owned copy.
              The running dashboard keeps serving current code until it is restarted.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            Target repo: <span className="font-medium text-foreground">dashboard-home/paperclip</span>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSyncDialogOpen(false)} disabled={syncingDashboardRepo}>
              Cancel
            </Button>
            <Button onClick={handleSyncDashboardRepo} disabled={syncingDashboardRepo}>
              {syncingDashboardRepo ? "Syncing..." : "Sync Dashboard Copy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export type { BulkAgentAction, BulkAgentPlan, PlannedAgentTarget };
