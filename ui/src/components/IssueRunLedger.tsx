import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ActivityEvent, Issue, Agent, ProviderTraceMetadata } from "@paperclipai/shared";
import {
  isResponsibleUserDenialCode,
  responsibleUserLabel,
} from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { accessApi, type CurrentBoardAccess } from "../api/access";
import {
  activityApi,
  type RunForIssue,
  type RunLivenessState,
} from "../api/activity";
import { ApiError } from "../api/client";
import {
  heartbeatsApi,
  type ActiveRunForIssue,
  type LiveRunForIssue,
  type WatchdogDecisionInput,
} from "../api/heartbeats";
import { useToastActions } from "../context/ToastContext";
import { cn, relativeTime } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../lib/query-placeholder-data";
import { describeRunRetryState } from "../lib/runRetryState";
import { readSourceResolvedWatchdogFold } from "../lib/source-resolved-watchdog-fold";
import { SourceResolvedFoldBadge } from "./SourceResolvedFoldBadge";
import { ResponsibleUserDenialNotice } from "./ResponsibleUserDenialNotice";
import { RunnerInspector } from "./RunnerInspector";
import { agentsApi } from "../api/agents";
import {
  ProviderTraceStatusBadge,
  runRequestedProviderTrace,
} from "./ProviderTraceStatusBadge";
import { t, useTranslation } from "@/i18n";

type IssueRunLedgerProps = {
  issueId: string;
  companyId: string;
  issueStatus: Issue["status"];
  childIssues: Issue[];
  agentMap: ReadonlyMap<string, Agent>;
  hasLiveRuns: boolean;
  activityEvents?: ActivityEvent[];
  renderActivityEvent?: (event: ActivityEvent) => ReactNode;
  resolveUserLabel?: (userId: string) => string | null | undefined;
};

type IssueRunLedgerContentProps = {
  runs: RunForIssue[];
  liveRuns?: LiveRunForIssue[];
  activeRun?: ActiveRunForIssue | null;
  issueStatus: Issue["status"];
  childIssues: Issue[];
  agentMap: ReadonlyMap<string, Pick<Agent, "name">>;
  activityEvents?: ActivityEvent[];
  renderActivityEvent?: (event: ActivityEvent) => ReactNode;
  resolveUserLabel?: (userId: string) => string | null | undefined;
  pendingWatchdogDecision?: WatchdogDecisionInput["decision"] | null;
  canRecordWatchdogDecisions?: boolean;
  watchdogDecisionError?: string | null;
  onWatchdogDecision?: (input: WatchdogDecisionInput) => void;
  onRerunWithTrace?: (run: RunForIssue) => void;
  providerTraceMetadata?: ReadonlyMap<string, ProviderTraceMetadata>;
};

type LedgerRun = RunForIssue & {
  isLive?: boolean;
  agentName?: string;
  outputSilence?: ActiveRunForIssue["outputSilence"];
};

type LedgerFeedItem =
  | {
      kind: "run";
      id: string;
      timestamp: string;
      run: LedgerRun;
    }
  | {
      kind: "activity";
      id: string;
      timestamp: string;
      event: ActivityEvent;
    };

type LivenessCopy = {
  label: string;
  tone: string;
  description: string;
};

function livenessCopyByState(): Record<RunLivenessState, LivenessCopy> {
  return {
    completed: {
      label: t("issues.livenessCopyByState.completed.label"),
      tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      description: t("issues.livenessCopyByState.completed.description"),
    },
    advanced: {
      label: t("issues.livenessCopyByState.advanced.label"),
      tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
      description: t("issues.livenessCopyByState.advanced.description"),
    },
    plan_only: {
      label: t("issues.livenessCopyByState.planOnly.label"),
      tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      description: t("issues.livenessCopyByState.planOnly.description"),
    },
    empty_response: {
      label: t("issues.livenessCopyByState.emptyResponse.label"),
      tone: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
      description: t("issues.livenessCopyByState.emptyResponse.description"),
    },
    blocked: {
      label: t("issues.livenessCopyByState.blocked.label"),
      tone: "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
      description: t("issues.livenessCopyByState.blocked.description"),
    },
    failed: {
      label: t("issues.livenessCopyByState.failed.label"),
      tone: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
      description: t("issues.livenessCopyByState.failed.description"),
    },
    needs_followup: {
      label: t("issues.livenessCopyByState.needsFollowup.label"),
      tone: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
      description: t("issues.livenessCopyByState.needsFollowup.description"),
    },
  };
}

function pendingLivenessCopy(): LivenessCopy {
  return {
    label: t("issues.pendingLivenessCopy.label"),
    tone: "border-border bg-background text-muted-foreground",
    description: t("issues.pendingLivenessCopy.description"),
  };
}

function retryPendingLivenessCopy(): LivenessCopy {
  return {
    label: t("issues.retryPendingLivenessCopy.label"),
    tone: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    description: t("issues.retryPendingLivenessCopy.description"),
  };
}

function missingLivenessCopy(): LivenessCopy {
  return {
    label: t("issues.missingLivenessCopy.label"),
    tone: "border-border bg-background text-muted-foreground",
    description: t("issues.missingLivenessCopy.description"),
  };
}

const TERMINAL_CHILD_STATUSES = new Set<Issue["status"]>(["done", "cancelled"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

type RunOutputSilenceLevel = NonNullable<
  ActiveRunForIssue["outputSilence"]
>["level"];

type RunOutputSilenceCopy = {
  label: string;
  tone: string;
};

function runOutputSilenceCopyByLevel(): Partial<
  Record<RunOutputSilenceLevel, RunOutputSilenceCopy>
> {
  return {
    suspicious: {
      label: t("issues.runOutputSilenceCopyByLevel.suspicious"),
      tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    },
    critical: {
      label: t("issues.runOutputSilenceCopyByLevel.critical"),
      tone: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    },
    snoozed: {
      label: t("issues.runOutputSilenceCopyByLevel.snoozed"),
      tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatDuration(
  start: string | Date | null | undefined,
  end: string | Date | null | undefined,
) {
  if (!start) return null;
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const totalSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60)
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function toIsoString(value: string | Date | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function liveRunToLedgerRun(
  run: LiveRunForIssue | ActiveRunForIssue,
): LedgerRun {
  return {
    runId: run.id,
    status: run.status,
    agentId: run.agentId,
    agentName: run.agentName,
    adapterType: run.adapterType,
    startedAt: toIsoString(run.startedAt),
    finishedAt: toIsoString(run.finishedAt),
    createdAt: toIsoString(run.createdAt) ?? new Date().toISOString(),
    invocationSource: run.invocationSource,
    usageJson: null,
    resultJson: null,
    isLive: run.status === "queued" || run.status === "running",
    outputSilence: run.outputSilence,
  };
}

function mergeRuns(
  runs: RunForIssue[],
  liveRuns: LiveRunForIssue[] | undefined,
  activeRun: ActiveRunForIssue | null | undefined,
) {
  const byId = new Map<string, LedgerRun>();
  for (const run of runs) byId.set(run.runId, run);
  for (const run of liveRuns ?? []) {
    const existing = byId.get(run.id);
    byId.set(
      run.id,
      existing
        ? {
            ...existing,
            isLive: true,
            agentName: run.agentName,
            outputSilence: run.outputSilence,
          }
        : liveRunToLedgerRun(run),
    );
  }
  if (activeRun) {
    const existing = byId.get(activeRun.id);
    if (existing) {
      byId.set(activeRun.id, {
        ...existing,
        isLive: isActiveRun(existing) || isActiveRun(activeRun),
        agentName: activeRun.agentName,
        outputSilence: activeRun.outputSilence,
      });
    } else {
      byId.set(activeRun.id, liveRunToLedgerRun(activeRun));
    }
  }

  return [...byId.values()].sort((a, b) => {
    const aTime = new Date(a.startedAt ?? a.createdAt).getTime();
    const bTime = new Date(b.startedAt ?? b.createdAt).getTime();
    if (aTime !== bTime) return bTime - aTime;
    return b.runId.localeCompare(a.runId);
  });
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function isActiveRun(run: Pick<LedgerRun, "status" | "isLive">) {
  return run.isLive || ACTIVE_RUN_STATUSES.has(run.status);
}

function runSummary(
  run: LedgerRun,
  agentMap: ReadonlyMap<string, Pick<Agent, "name">>,
) {
  const agentName = compactAgentName(run, agentMap);
  if (run.status === "running")
    return t("issues.runSummary.running", { agent: agentName });
  if (run.status === "queued")
    return t("issues.runSummary.queued", { agent: agentName });
  if (run.status === "scheduled_retry")
    return t("issues.runSummary.scheduledRetry", { agent: agentName });
  return t("issues.runSummary.statusBy", {
    status: statusLabel(run.status),
    agent: agentName,
  });
}

function livenessCopyForRun(run: LedgerRun) {
  if (run.status === "scheduled_retry") return retryPendingLivenessCopy();
  if (run.livenessState) return livenessCopyByState()[run.livenessState];
  return isActiveRun(run) ? pendingLivenessCopy() : missingLivenessCopy();
}

function stopReasonLabel(run: RunForIssue) {
  const result = asRecord(run.resultJson);
  const stopReason = readString(result?.stopReason);
  const timeoutFired = result?.timeoutFired === true;
  const effectiveTimeoutSec = readNumber(result?.effectiveTimeoutSec);
  const timeoutText =
    effectiveTimeoutSec && effectiveTimeoutSec > 0
      ? t("issues.stopReasonLabel.timeoutLimit", {
          seconds: effectiveTimeoutSec,
        })
      : null;

  if (timeoutFired || stopReason === "timeout") {
    return timeoutText
      ? t("issues.stopReasonLabel.timeoutWithLimit", { limit: timeoutText })
      : t("issues.stopReasonLabel.timeout");
  }
  if (
    stopReason === "max_turns_exhausted" ||
    stopReason === "turn_limit_exhausted"
  )
    return t("issues.stopReasonLabel.maxTurns");
  if (stopReason === "budget_paused") return t("issues.stopReasonLabel.budgetPaused");
  if (stopReason === "cancelled") return t("issues.stopReasonLabel.cancelled");
  if (stopReason === "paused") return t("issues.stopReasonLabel.pausedByBoard");
  if (stopReason === "process_lost") return t("issues.stopReasonLabel.processLost");
  if (stopReason === "unmanaged_background_task_stopped")
    return t("issues.stopReasonLabel.backgroundStopped");
  if (stopReason === "adapter_failed") return t("issues.stopReasonLabel.adapterFailed");
  if (stopReason === "completed")
    return timeoutText
      ? t("issues.stopReasonLabel.completedWithLimit", { limit: timeoutText })
      : t("issues.stopReasonLabel.completed");
  return timeoutText;
}

function stopStatusLabel(run: LedgerRun, stopReason: string | null) {
  if (stopReason) return stopReason;
  if (run.status === "scheduled_retry") return t("issues.stopStatusLabel.retryPending");
  if (run.status === "queued") return t("issues.stopStatusLabel.waitingToStart");
  if (run.status === "running") return t("issues.stopStatusLabel.stillRunning");
  if (!run.livenessState) return t("issues.stopStatusLabel.unavailable");
  return t("issues.stopStatusLabel.noStopReason");
}

function lastUsefulActionLabel(run: LedgerRun) {
  if (run.status === "scheduled_retry") return t("issues.lastUsefulActionLabel.waitingNextAttempt");
  if (run.lastUsefulActionAt) return relativeTime(run.lastUsefulActionAt);
  if (isActiveRun(run)) return t("issues.lastUsefulActionLabel.noActionYet");
  if (
    run.livenessState === "plan_only" ||
    run.livenessState === "needs_followup"
  ) {
    return t("issues.lastUsefulActionLabel.noConcreteAction");
  }
  if (run.livenessState === "empty_response") return t("issues.lastUsefulActionLabel.noUsefulOutput");
  if (!run.livenessState) return t("issues.lastUsefulActionLabel.unavailable");
  return t("issues.lastUsefulActionLabel.noneRecorded");
}

function continuationLabel(run: LedgerRun) {
  if (!run.continuationAttempt || run.continuationAttempt <= 0) return null;
  return t("issues.continuationLabel.attempt", { n: run.continuationAttempt });
}

function hasExhaustedContinuation(run: RunForIssue) {
  return /continuation attempts exhausted/i.test(run.livenessReason ?? "");
}

function childIssueSummary(childIssues: Issue[]) {
  const active = childIssues.filter(
    (issue) => !TERMINAL_CHILD_STATUSES.has(issue.status),
  );
  const done = childIssues.filter((issue) => issue.status === "done").length;
  const cancelled = childIssues.filter(
    (issue) => issue.status === "cancelled",
  ).length;
  return { active, done, cancelled, total: childIssues.length };
}

function compactAgentName(
  run: LedgerRun,
  agentMap: ReadonlyMap<string, Pick<Agent, "name">>,
) {
  return (
    run.agentName ?? agentMap.get(run.agentId)?.name ?? run.agentId.slice(0, 8)
  );
}

function formatSilenceAge(ms: number | null | undefined) {
  if (!ms || ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return t("issues.formatSilenceAge.underOneMinute");
  if (totalMinutes < 60)
    return t("issues.formatSilenceAge.minutes", { count: totalMinutes });
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return t("issues.formatSilenceAge.hours", { count: hours });
  return `${hours}h ${minutes}m`;
}

function canBoardRecordWatchdogDecision(
  companyId: string,
  boardAccess: CurrentBoardAccess | undefined,
) {
  if (!boardAccess) return false;
  if (boardAccess.source === "local_implicit" || boardAccess.isInstanceAdmin)
    return true;

  const membership = boardAccess.memberships?.find(
    (item) => item.companyId === companyId && item.status === "active",
  );
  if (!membership)
    return (
      boardAccess.companyIds.includes(companyId) && !boardAccess.memberships
    );
  return (
    membership.membershipRole !== "viewer" && membership.membershipRole !== null
  );
}

function watchdogDecisionErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 403) {
    return t("issues.watchdogDecisionErrorMessage.forbidden");
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : t("issues.watchdogDecisionErrorMessage.fallback");
}

export function IssueRunLedger({
  issueId,
  companyId,
  issueStatus,
  childIssues,
  agentMap,
  hasLiveRuns,
  activityEvents,
  renderActivityEvent,
  resolveUserLabel,
}: IssueRunLedgerProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [watchdogDecisionError, setWatchdogDecisionError] = useState<
    string | null
  >(null);
  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });
  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
    refetchInterval:
      hasLiveRuns || issueStatus === "in_progress" ? 5000 : false,
    placeholderData: keepPreviousDataForSameQueryTail<RunForIssue[]>(issueId),
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId),
    enabled: hasLiveRuns,
    refetchInterval: 3000,
    placeholderData:
      keepPreviousDataForSameQueryTail<LiveRunForIssue[]>(issueId),
  });
  const { data: activeRun = null } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId),
    enabled: hasLiveRuns || issueStatus === "in_progress",
    refetchInterval: hasLiveRuns ? false : 3000,
    placeholderData: keepPreviousDataForSameQueryTail<ActiveRunForIssue | null>(
      issueId,
    ),
  });
  const traceRunIds = useMemo(
    () => (runs ?? []).slice(0, 100).map((run) => run.runId),
    [runs],
  );
  const canInspectProviderTrace =
    boardAccess?.source === "local_implicit" || boardAccess?.isInstanceAdmin === true;
  const { data: providerTraceRows } = useQuery({
    queryKey: queryKeys.providerTraceMetadata(companyId, traceRunIds),
    queryFn: () => heartbeatsApi.providerTraceMetadata(companyId, traceRunIds),
    enabled: canInspectProviderTrace && traceRunIds.length > 0,
  });
  const providerTraceMetadata = useMemo(
    () => new Map((providerTraceRows ?? []).map((trace) => [trace.runId, trace])),
    [providerTraceRows],
  );
  const watchdogDecision = useMutation({
    mutationFn: (input: WatchdogDecisionInput) =>
      heartbeatsApi.recordWatchdogDecision(input),
    onMutate: () => {
      setWatchdogDecisionError(null);
    },
    onSuccess: () => {
      setWatchdogDecisionError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.activeRun(issueId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.liveRuns(issueId),
      });
    },
    onError: (error) => {
      const message = watchdogDecisionErrorMessage(error);
      const dedupeSuffix =
        error instanceof ApiError ? String(error.status) : "error";
      setWatchdogDecisionError(message);
      pushToast({
        title: t("issues.IssueRunLedger.watchdogNotRecordedTitle"),
        body: message,
        tone: "error",
        dedupeKey: `watchdog-decision:${issueId}:${dedupeSuffix}`,
      });
    },
  });
  const rerunWithTrace = useMutation({
    mutationFn: async (run: RunForIssue) => {
      const context = asRecord(run.contextSnapshot);
      const payload: Record<string, unknown> = {};
      for (const key of ["issueId", "taskId", "taskKey"] as const) {
        const value = readString(context?.[key]);
        if (value) payload[key] = value;
      }
      const result = await agentsApi.wakeup(
        run.agentId,
        {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "rerun_with_provider_trace",
          payload,
          debug: { providerTrace: "raw" },
        },
        companyId,
      );
      if (!("id" in result))
        throw new Error(result.message ?? t("issues.IssueRunLedger.traceRerunSkipped"));
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.runs(issueId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.liveRuns(issueId),
      });
    },
    onError: (error) =>
      pushToast({
        title: t("issues.IssueRunLedger.traceRerunNotStartedTitle"),
        body:
          error instanceof Error
            ? error.message
            : t("issues.IssueRunLedger.traceRerunFailed"),
        tone: "error",
        dedupeKey: `provider-trace-rerun:${issueId}`,
      }),
  });

  return (
    <IssueRunLedgerContent
      runs={runs ?? []}
      liveRuns={liveRuns}
      activeRun={activeRun}
      issueStatus={issueStatus}
      childIssues={childIssues}
      agentMap={agentMap}
      activityEvents={activityEvents}
      renderActivityEvent={renderActivityEvent}
      resolveUserLabel={resolveUserLabel}
      pendingWatchdogDecision={watchdogDecision.variables?.decision ?? null}
      canRecordWatchdogDecisions={canBoardRecordWatchdogDecision(
        companyId,
        boardAccess,
      )}
      watchdogDecisionError={watchdogDecisionError}
      onWatchdogDecision={(input) => watchdogDecision.mutate(input)}
      onRerunWithTrace={
        canInspectProviderTrace
          ? (run) => rerunWithTrace.mutate(run)
          : undefined
      }
      providerTraceMetadata={providerTraceMetadata}
    />
  );
}

export function IssueRunLedgerContent({
  runs,
  liveRuns,
  activeRun,
  issueStatus,
  childIssues,
  agentMap,
  activityEvents,
  renderActivityEvent,
  resolveUserLabel,
  pendingWatchdogDecision,
  canRecordWatchdogDecisions = true,
  watchdogDecisionError,
  onWatchdogDecision,
  onRerunWithTrace,
  providerTraceMetadata = new Map(),
}: IssueRunLedgerContentProps) {
  const { t } = useTranslation();
  const [inspectedRun, setInspectedRun] = useState<LedgerRun | null>(null);
  const ledgerRuns = useMemo(
    () => mergeRuns(runs, liveRuns, activeRun),
    [activeRun, liveRuns, runs],
  );
  useEffect(() => {
    if (inspectedRun || typeof window === "undefined") return;
    const requestedRunId = new URLSearchParams(window.location.search).get("inspectRun");
    if (!requestedRunId) return;
    const requestedRun = ledgerRuns.find((run) => run.runId === requestedRunId);
    if (requestedRun) setInspectedRun(requestedRun);
  }, [inspectedRun, ledgerRuns]);
  const latestRun = ledgerRuns[0] ?? null;
  const latestSilentRun = useMemo(
    () =>
      ledgerRuns.find(
        (run) =>
          isActiveRun(run) &&
          (run.outputSilence?.level === "critical" ||
            run.outputSilence?.level === "suspicious"),
      ) ?? null,
    [ledgerRuns],
  );
  const children = childIssueSummary(childIssues);
  const canRenderActivityEvents = Boolean(renderActivityEvent);
  const feedItems = useMemo<LedgerFeedItem[]>(() => {
    const items: LedgerFeedItem[] = [];
    for (const run of ledgerRuns) {
      items.push({
        kind: "run",
        id: run.runId,
        timestamp: run.startedAt ?? run.createdAt,
        run,
      });
    }
    if (canRenderActivityEvents) {
      for (const event of activityEvents ?? []) {
        items.push({
          kind: "activity",
          id: event.id,
          timestamp:
            event.createdAt instanceof Date
              ? event.createdAt.toISOString()
              : String(event.createdAt),
          event,
        });
      }
    }
    return items.sort((a, b) => {
      const aTime = new Date(a.timestamp).getTime();
      const bTime = new Date(b.timestamp).getTime();
      if (aTime !== bTime) return bTime - aTime;
      if (a.kind !== b.kind) return a.kind === "run" ? -1 : 1;
      return b.id.localeCompare(a.id);
    });
  }, [activityEvents, canRenderActivityEvents, ledgerRuns]);

  return (
    <section className="space-y-3" aria-label={t("issues.IssueRunLedgerContent.ariaLabel")}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-muted-foreground">
            {t("issues.IssueRunLedgerContent.title")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {latestRun
              ? runSummary(latestRun, agentMap)
              : issueStatus === "in_progress"
                ? t("issues.IssueRunLedgerContent.waitingFirstRun")
                : t("issues.IssueRunLedgerContent.noRunsYet")}
          </p>
        </div>
        {latestRun ? (
          <Link
            to={`/agents/${latestRun.agentId}/runs/${latestRun.runId}`}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("issues.IssueRunLedgerContent.latestRun")}
          </Link>
        ) : null}
      </div>

      {children.total > 0 ? (
        <div className="rounded-md border border-border/70 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-foreground">{t("issues.IssueRunLedgerContent.childWork")}</span>
            <span className="text-muted-foreground">
              {children.active.length > 0
                ? t("issues.IssueRunLedgerContent.childActiveSummary", {
                    active: children.active.length,
                    done: children.done,
                    cancelled: children.cancelled,
                  })
                : t("issues.IssueRunLedgerContent.childTerminalSummary", {
                    total: children.total,
                    done: children.done,
                    cancelled: children.cancelled,
                  })}
            </span>
          </div>
          {children.active.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {children.active.slice(0, 4).map((child) => (
                <Link
                  key={child.id}
                  to={`/issues/${child.identifier ?? child.id}`}
                  className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-(length:--text-micro) hover:bg-accent/40"
                >
                  <span className="shrink-0 font-mono text-muted-foreground">
                    {child.identifier ?? child.id.slice(0, 8)}
                  </span>
                  <span className="truncate">{child.title}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {statusLabel(child.status)}
                  </span>
                </Link>
              ))}
              {children.active.length > 4 ? (
                <span className="rounded-md border border-border px-2 py-1 text-(length:--text-micro) text-muted-foreground">
                  +{t("issues.IssueRunLedgerContent.moreChildren", { n: children.active.length - 4 })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {latestSilentRun?.outputSilence ? (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-xs",
            latestSilentRun.outputSilence.level === "critical"
              ? "border-red-500/30 bg-red-500/10 text-red-900 dark:text-red-200"
              : "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200",
          )}
        >
          <p className="font-medium">
            {latestSilentRun.outputSilence.level === "critical"
              ? t("issues.IssueRunLedgerContent.silenceCritical")
              : t("issues.IssueRunLedgerContent.silenceWarning")}
          </p>
          <p className="mt-1">
            {t("issues.IssueRunLedgerContent.silentFor")}{" "}
            {formatSilenceAge(latestSilentRun.outputSilence.silenceAgeMs) ??
              t("issues.IssueRunLedgerContent.extendedPeriod")}
            .
            {latestSilentRun.outputSilence.evaluationIssueIdentifier ? (
              <>
                {" "}
                {t("issues.IssueRunLedgerContent.review")}{" "}
                <Link
                  to={`/issues/${latestSilentRun.outputSilence.evaluationIssueIdentifier}`}
                  className="font-medium underline underline-offset-2"
                >
                  {latestSilentRun.outputSilence.evaluationIssueIdentifier}
                </Link>{" "}
                {t("issues.IssueRunLedgerContent.recoveryContext")}
              </>
            ) : null}
          </p>
          <p className="mt-1">
            {latestSilentRun.outputSilence.evaluationIssueIdentifier
              ? t("issues.IssueRunLedgerContent.signalDelegated")
              : t("issues.IssueRunLedgerContent.signalNoTask")}
          </p>
          {onWatchdogDecision && canRecordWatchdogDecisions ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                className="rounded-md border border-border bg-background/80 px-2 py-1 text-(length:--text-micro) text-foreground hover:bg-background"
                onClick={() =>
                  onWatchdogDecision({
                    runId: latestSilentRun.runId,
                    decision: "continue",
                    evaluationIssueId:
                      latestSilentRun.outputSilence?.evaluationIssueId ?? null,
                  })
                }
                disabled={pendingWatchdogDecision != null}
              >
                {t("issues.IssueRunLedgerContent.continueMonitoring")}
              </button>
              <button
                type="button"
                className="rounded-md border border-border bg-background/80 px-2 py-1 text-(length:--text-micro) text-foreground hover:bg-background"
                onClick={() =>
                  onWatchdogDecision({
                    runId: latestSilentRun.runId,
                    decision: "snooze",
                    evaluationIssueId:
                      latestSilentRun.outputSilence?.evaluationIssueId ?? null,
                    snoozedUntil: new Date(
                      Date.now() + 60 * 60 * 1000,
                    ).toISOString(),
                    reason: "Snoozed from issue run ledger",
                  })
                }
                disabled={pendingWatchdogDecision != null}
              >
                {t("issues.IssueRunLedgerContent.snooze1h")}
              </button>
              <button
                type="button"
                className="rounded-md border border-border bg-background/80 px-2 py-1 text-(length:--text-micro) text-foreground hover:bg-background"
                onClick={() =>
                  onWatchdogDecision({
                    runId: latestSilentRun.runId,
                    decision: "dismissed_false_positive",
                    evaluationIssueId:
                      latestSilentRun.outputSilence?.evaluationIssueId ?? null,
                    reason: "Dismissed from issue run ledger",
                  })
                }
                disabled={pendingWatchdogDecision != null}
              >
                {t("issues.IssueRunLedgerContent.markFalsePositive")}
              </button>
            </div>
          ) : null}
          {watchdogDecisionError ? (
            <p className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-(length:--text-micro) text-red-900 dark:text-red-200">
              {watchdogDecisionError}
            </p>
          ) : null}
        </div>
      ) : null}

      {feedItems.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
          {renderActivityEvent
            ? t("issues.IssueRunLedgerContent.emptyWithActivity")
            : t("issues.IssueRunLedgerContent.emptyHistorical")}
        </div>
      ) : (
        <div className="space-y-1.5">
          {feedItems.slice(0, 20).map((item) => {
            if (item.kind === "activity") {
              return (
                <div key={`activity:${item.id}`}>
                  {renderActivityEvent?.(item.event)}
                </div>
              );
            }
            const run = item.run;
            const nextAction = run.execution ? run.execution.nextAction : run.nextAction;
            const liveness = livenessCopyForRun(run);
            const stopReason = stopReasonLabel(run);
            const duration = formatDuration(run.startedAt, run.finishedAt);
            const exhausted = hasExhaustedContinuation(run);
            const continuation = continuationLabel(run);
            const retryState = describeRunRetryState(run);
            const agentName = compactAgentName(run, agentMap);
            const onBehalfOfLabel = run.responsibleUserId
              ? responsibleUserLabel(resolveUserLabel?.(run.responsibleUserId))
              : null;
            const denialCode = isResponsibleUserDenialCode(run.errorCode)
              ? run.errorCode
              : null;
            const sourceResolvedFold = readSourceResolvedWatchdogFold(
              run.resultJson,
            );
            return (
              <article
                key={`run:${run.runId}`}
                className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-foreground">{t("issues.IssueRunLedgerContent.runLabel")}</span>
                  <Link
                    to={`/agents/${run.agentId}/runs/${run.runId}`}
                    className="min-w-0 max-w-full truncate font-mono text-foreground hover:underline"
                  >
                    {run.runId.slice(0, 8)}
                  </Link>
                  <span>{t("issues.IssueRunLedgerContent.byAgent", { agent: agentName })}</span>
                  {onBehalfOfLabel ? (
                    <span
                      data-testid="run-on-behalf-of"
                      className="min-w-0 max-w-full truncate text-muted-foreground"
                      title={t("issues.IssueRunLedgerContent.actingOnBehalfOf", { name: onBehalfOfLabel })}
                    >
                      {t("issues.IssueRunLedgerContent.onBehalfOf")}{" "}
                      <span className="text-foreground">{onBehalfOfLabel}</span>
                    </span>
                  ) : null}
                  <span className="rounded-md border border-border px-1.5 py-0.5 text-(length:--text-micro) capitalize text-muted-foreground">
                    {statusLabel(run.status)}
                  </span>
                  {run.isLive ? (
                    <span className="inline-flex items-center gap-1 rounded-md border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-(length:--text-micro) text-blue-700 dark:text-blue-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                      {t("issues.IssueRunLedgerContent.live")}
                    </span>
                  ) : null}
                  <ProviderTraceStatusBadge
                    trace={providerTraceMetadata.get(run.runId)}
                    requested={runRequestedProviderTrace(run.contextSnapshot)}
                    showOff
                  />
                  <span
                    className={cn(
                      "rounded-md border px-1.5 py-0.5 text-(length:--text-micro) font-medium",
                      liveness.tone,
                    )}
                    title={liveness.description}
                  >
                    {liveness.label}
                  </span>
                  {exhausted ? (
                    <span className="rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-(length:--text-micro) font-medium text-red-700 dark:text-red-300">
                      {t("issues.IssueRunLedgerContent.exhausted")}
                    </span>
                  ) : null}
                  {continuation ? (
                    <span className="text-(length:--text-micro) text-muted-foreground">
                      {continuation}
                    </span>
                  ) : null}
                  {retryState ? (
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-(length:--text-micro) font-medium",
                        retryState.tone,
                      )}
                    >
                      {retryState.badgeLabel}
                    </span>
                  ) : null}
                  {run.outputSilence &&
                  runOutputSilenceCopyByLevel()[run.outputSilence.level] ? (
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-(length:--text-micro) font-medium",
                        runOutputSilenceCopyByLevel()[run.outputSilence.level]?.tone,
                      )}
                    >
                      {runOutputSilenceCopyByLevel()[run.outputSilence.level]?.label}
                    </span>
                  ) : null}
                  {sourceResolvedFold ? <SourceResolvedFoldBadge /> : null}
                  <span className="ml-auto shrink-0">
                    {relativeTime(item.timestamp)}
                  </span>
                  <button
                    type="button"
                    className="rounded-md border border-border px-1.5 py-0.5 text-(length:--text-micro) text-foreground hover:bg-accent/40"
                    onClick={() => setInspectedRun(run)}
                  >
                    {t("issues.IssueRunLedgerContent.inspectRun")}
                  </button>
                </div>

                <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                  <div className="min-w-0">
                    <span className="text-foreground">{t("issues.IssueRunLedgerContent.elapsed")}</span>{" "}
                    {duration ?? t("issues.IssueRunLedgerContent.unknown")}
                  </div>
                  <div className="min-w-0">
                    <span className="text-foreground">{t("issues.IssueRunLedgerContent.lastUsefulAction")}</span>{" "}
                    {lastUsefulActionLabel(run)}
                  </div>
                  <div className="min-w-0">
                    <span className="text-foreground">{t("issues.IssueRunLedgerContent.stop")}</span>{" "}
                    {stopStatusLabel(run, stopReason)}
                  </div>
                </div>

                {retryState ? (
                  <div className="rounded-md border border-border/70 bg-accent/20 px-2 py-2 text-xs leading-5 text-muted-foreground">
                    {retryState.detail ? <p>{retryState.detail}</p> : null}
                    {retryState.secondary ? (
                      <p>{retryState.secondary}</p>
                    ) : null}
                    {retryState.retryOfRunId ? (
                      <p>
                        {t("issues.IssueRunLedgerContent.retryOf")}{" "}
                        <Link
                          to={`/agents/${run.agentId}/runs/${retryState.retryOfRunId}`}
                          className="font-mono text-foreground hover:underline"
                        >
                          {retryState.retryOfRunId.slice(0, 8)}
                        </Link>
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {run.livenessReason ? (
                  <p className="min-w-0 break-words text-xs leading-5 text-muted-foreground">
                    {run.livenessReason}
                  </p>
                ) : null}

                {denialCode ? (
                  <ResponsibleUserDenialNotice
                    code={denialCode}
                    userName={
                      run.responsibleUserId
                        ? resolveUserLabel?.(run.responsibleUserId)
                        : null
                    }
                  />
                ) : null}

                {nextAction ? (
                  <div className="min-w-0 rounded-md bg-accent/40 px-2 py-1.5 text-xs leading-5">
                    <span className="font-medium text-foreground">
                      {t("issues.IssueRunLedgerContent.nextAction")}{" "}
                    </span>
                    <span className="break-words text-muted-foreground">
                      {nextAction}
                    </span>
                  </div>
                ) : null}
              </article>
            );
          })}
          {feedItems.length > 20 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t("issues.IssueRunLedgerContent.olderItemsNotShown", { count: feedItems.length - 20 })}
            </div>
          ) : null}
        </div>
      )}
      {inspectedRun ? (
        <RunnerInspector
          runId={inspectedRun.runId}
          run={inspectedRun}
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setInspectedRun(null);
          }}
          onRerunWithTrace={
            !["queued", "running"].includes(inspectedRun.status) &&
            onRerunWithTrace
              ? () => onRerunWithTrace(inspectedRun)
              : undefined
          }
        />
      ) : null}
    </section>
  );
}
