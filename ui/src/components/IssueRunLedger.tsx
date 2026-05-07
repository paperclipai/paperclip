import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ActivityEvent, Issue, Agent } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { accessApi, type CurrentBoardAccess } from "../api/access";
import { activityApi, type RunForIssue, type RunLivenessState } from "../api/activity";
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

type IssueRunLedgerProps = {
  issueId: string;
  companyId: string;
  issueStatus: Issue["status"];
  childIssues: Issue[];
  agentMap: ReadonlyMap<string, Agent>;
  hasLiveRuns: boolean;
  activityEvents?: ActivityEvent[];
  renderActivityEvent?: (event: ActivityEvent) => ReactNode;
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
  pendingWatchdogDecision?: WatchdogDecisionInput["decision"] | null;
  canRecordWatchdogDecisions?: boolean;
  watchdogDecisionError?: string | null;
  onWatchdogDecision?: (input: WatchdogDecisionInput) => void;
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

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

type LivenessCopy = {
  label: string;
  tone: string;
  description: string;
};

function getLivenessCopy(t: TFunc): Record<RunLivenessState, LivenessCopy> {
  return {
    completed: {
      label: t("ledger.liveness_completed_label"),
      tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      description: t("ledger.liveness_completed_desc"),
    },
    advanced: {
      label: t("ledger.liveness_advanced_label"),
      tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
      description: t("ledger.liveness_advanced_desc"),
    },
    plan_only: {
      label: t("ledger.liveness_plan_only_label"),
      tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      description: t("ledger.liveness_plan_only_desc"),
    },
    empty_response: {
      label: t("ledger.liveness_empty_response_label"),
      tone: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
      description: t("ledger.liveness_empty_response_desc"),
    },
    blocked: {
      label: t("ledger.liveness_blocked_label"),
      tone: "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
      description: t("ledger.liveness_blocked_desc"),
    },
    failed: {
      label: t("ledger.liveness_failed_label"),
      tone: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
      description: t("ledger.liveness_failed_desc"),
    },
    needs_followup: {
      label: t("ledger.liveness_needs_followup_label"),
      tone: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
      description: t("ledger.liveness_needs_followup_desc"),
    },
  };
}

function getPendingLivenessCopy(t: TFunc): LivenessCopy {
  return {
    label: t("ledger.liveness_pending_label"),
    tone: "border-border bg-background text-muted-foreground",
    description: t("ledger.liveness_pending_desc"),
  };
}

function getRetryPendingLivenessCopy(t: TFunc): LivenessCopy {
  return {
    label: t("ledger.liveness_retry_label"),
    tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
    description: t("ledger.liveness_retry_desc"),
  };
}

function getMissingLivenessCopy(t: TFunc): LivenessCopy {
  return {
    label: t("ledger.liveness_missing_label"),
    tone: "border-border bg-background text-muted-foreground",
    description: t("ledger.liveness_missing_desc"),
  };
}

const TERMINAL_CHILD_STATUSES = new Set<Issue["status"]>(["done", "cancelled"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

type RunOutputSilenceLevel = NonNullable<ActiveRunForIssue["outputSilence"]>["level"];

type RunOutputSilenceCopy = {
  label: string;
  tone: string;
};

function getRunOutputSilenceCopy(t: TFunc): Partial<Record<RunOutputSilenceLevel, RunOutputSilenceCopy>> {
  return {
    suspicious: {
      label: t("ledger.silence_suspicious_label"),
      tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    },
    critical: {
      label: t("ledger.silence_critical_label"),
      tone: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    },
    snoozed: {
      label: t("ledger.silence_snoozed_label"),
      tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

interface ModelProfileSummary {
  requested: string;
  applied: string | null;
  configSource: string | null;
  fallbackReason: string | null;
}

function modelProfileForRun(run: RunForIssue): ModelProfileSummary | null {
  const result = asRecord(run.resultJson);
  const profile = asRecord(result?.modelProfile);
  if (!profile) return null;
  const requested = readString(profile.requested);
  if (!requested) return null;
  return {
    requested,
    applied: readString(profile.applied),
    configSource: readString(profile.configSource),
    fallbackReason: readString(profile.fallbackReason),
  };
}

function modelProfileBadgeTone(summary: ModelProfileSummary) {
  if (summary.applied === summary.requested) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (summary.fallbackReason) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "border-border bg-background text-muted-foreground";
}

function modelProfileTitle(summary: ModelProfileSummary) {
  const lines = [`Requested: ${summary.requested}`];
  if (summary.applied) lines.push(`Applied: ${summary.applied}`);
  if (summary.configSource) lines.push(`Source: ${summary.configSource}`);
  if (summary.fallbackReason) lines.push(`Fallback: ${summary.fallbackReason}`);
  return lines.join("\n");
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatDuration(start: string | Date | null | undefined, end: string | Date | null | undefined) {
  if (!start) return null;
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const totalSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function toIsoString(value: string | Date | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function liveRunToLedgerRun(run: LiveRunForIssue | ActiveRunForIssue): LedgerRun {
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
        ? { ...existing, isLive: true, agentName: run.agentName, outputSilence: run.outputSilence }
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

function runSummary(run: LedgerRun, agentMap: ReadonlyMap<string, Pick<Agent, "name">>, t: TFunc) {
  const agentName = compactAgentName(run, agentMap);
  if (run.status === "running") return t("ledger.running_now_by", { name: agentName });
  if (run.status === "queued") return t("ledger.queued_for", { name: agentName });
  if (run.status === "scheduled_retry") return t("ledger.retry_scheduled_for", { name: agentName });
  return t("ledger.status_by", { status: statusLabel(run.status), name: agentName });
}

function livenessCopyForRun(run: LedgerRun, t: TFunc) {
  if (run.status === "scheduled_retry") return getRetryPendingLivenessCopy(t);
  if (run.livenessState) return getLivenessCopy(t)[run.livenessState];
  return isActiveRun(run) ? getPendingLivenessCopy(t) : getMissingLivenessCopy(t);
}

function stopReasonLabel(run: RunForIssue, t: TFunc) {
  const result = asRecord(run.resultJson);
  const stopReason = readString(result?.stopReason);
  const timeoutFired = result?.timeoutFired === true;
  const effectiveTimeoutSec = readNumber(result?.effectiveTimeoutSec);
  const timeoutText =
    effectiveTimeoutSec && effectiveTimeoutSec > 0 ? `${effectiveTimeoutSec}s timeout` : null;

  if (timeoutFired || stopReason === "timeout") {
    return timeoutText
      ? t("ledger.stop_reason_timeout_with_duration", { duration: timeoutText })
      : t("ledger.stop_reason_timeout");
  }
  if (stopReason === "max_turns_exhausted" || stopReason === "turn_limit_exhausted") return t("ledger.stop_reason_max_turns");
  if (stopReason === "budget_paused") return t("ledger.stop_reason_budget_paused");
  if (stopReason === "cancelled") return t("ledger.stop_reason_cancelled");
  if (stopReason === "paused") return t("ledger.stop_reason_paused");
  if (stopReason === "process_lost") return t("ledger.stop_reason_process_lost");
  if (stopReason === "adapter_failed") return t("ledger.stop_reason_adapter_failed");
  if (stopReason === "completed") return timeoutText
    ? t("ledger.stop_reason_completed_with_duration", { duration: timeoutText })
    : t("ledger.stop_reason_completed");
  return timeoutText;
}

function stopStatusLabel(run: LedgerRun, stopReason: string | null, t: TFunc) {
  if (stopReason) return stopReason;
  if (run.status === "scheduled_retry") return t("ledger.stop_retry_pending");
  if (run.status === "queued") return t("ledger.stop_waiting");
  if (run.status === "running") return t("ledger.stop_still_running");
  if (!run.livenessState) return t("ledger.stop_unavailable");
  return t("ledger.stop_no_reason");
}

function lastUsefulActionLabel(run: LedgerRun, t: TFunc) {
  if (run.status === "scheduled_retry") return t("ledger.action_waiting");
  if (run.lastUsefulActionAt) return relativeTime(run.lastUsefulActionAt);
  if (isActiveRun(run)) return t("ledger.action_no_recorded");
  if (run.livenessState === "plan_only" || run.livenessState === "needs_followup") {
    return t("ledger.action_no_concrete");
  }
  if (run.livenessState === "empty_response") return t("ledger.action_no_output");
  if (!run.livenessState) return t("ledger.action_unavailable");
  return t("ledger.action_none");
}

function continuationLabel(run: LedgerRun, t: TFunc) {
  if (!run.continuationAttempt || run.continuationAttempt <= 0) return null;
  return t("ledger.continuation", { n: run.continuationAttempt });
}

function hasExhaustedContinuation(run: RunForIssue) {
  return /continuation attempts exhausted/i.test(run.livenessReason ?? "");
}

function childIssueSummary(childIssues: Issue[]) {
  const active = childIssues.filter((issue) => !TERMINAL_CHILD_STATUSES.has(issue.status));
  const done = childIssues.filter((issue) => issue.status === "done").length;
  const cancelled = childIssues.filter((issue) => issue.status === "cancelled").length;
  return { active, done, cancelled, total: childIssues.length };
}

function compactAgentName(run: LedgerRun, agentMap: ReadonlyMap<string, Pick<Agent, "name">>) {
  return run.agentName ?? agentMap.get(run.agentId)?.name ?? run.agentId.slice(0, 8);
}

function formatSilenceAge(ms: number | null | undefined) {
  if (!ms || ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "under 1 minute";
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours}h ${minutes}m`;
}

function canBoardRecordWatchdogDecision(
  companyId: string,
  boardAccess: CurrentBoardAccess | undefined,
) {
  if (!boardAccess) return false;
  if (boardAccess.source === "local_implicit" || boardAccess.isInstanceAdmin) return true;

  const membership = boardAccess.memberships?.find(
    (item) => item.companyId === companyId && item.status === "active",
  );
  if (!membership) return boardAccess.companyIds.includes(companyId) && !boardAccess.memberships;
  return membership.membershipRole !== "viewer" && membership.membershipRole !== null;
}

function watchdogDecisionErrorMessage(error: unknown, t: TFunc) {
  if (error instanceof ApiError && error.status === 403) {
    return t("ledger.watchdog_forbidden");
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : t("ledger.watchdog_cannot_record");
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
}: IssueRunLedgerProps) {
  const { t } = useTranslation("issues");
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [watchdogDecisionError, setWatchdogDecisionError] = useState<string | null>(null);
  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
    refetchInterval: hasLiveRuns || issueStatus === "in_progress" ? 5000 : false,
    placeholderData: keepPreviousDataForSameQueryTail<RunForIssue[]>(issueId),
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId),
    enabled: hasLiveRuns,
    refetchInterval: 3000,
    placeholderData: keepPreviousDataForSameQueryTail<LiveRunForIssue[]>(issueId),
  });
  const { data: activeRun = null } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId),
    enabled: hasLiveRuns || issueStatus === "in_progress",
    refetchInterval: hasLiveRuns ? false : 3000,
    placeholderData: keepPreviousDataForSameQueryTail<ActiveRunForIssue | null>(issueId),
  });
  const watchdogDecision = useMutation({
    mutationFn: (input: WatchdogDecisionInput) => heartbeatsApi.recordWatchdogDecision(input),
    onMutate: () => {
      setWatchdogDecisionError(null);
    },
    onSuccess: () => {
      setWatchdogDecisionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId) });
    },
    onError: (error) => {
      const message = watchdogDecisionErrorMessage(error, t);
      const dedupeSuffix = error instanceof ApiError ? String(error.status) : "error";
      setWatchdogDecisionError(message);
      pushToast({
        title: t("ledger.watchdog_decision_not_recorded"),
        body: message,
        tone: "error",
        dedupeKey: `watchdog-decision:${issueId}:${dedupeSuffix}`,
      });
    },
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
      pendingWatchdogDecision={watchdogDecision.variables?.decision ?? null}
      canRecordWatchdogDecisions={canBoardRecordWatchdogDecision(companyId, boardAccess)}
      watchdogDecisionError={watchdogDecisionError}
      onWatchdogDecision={(input) => watchdogDecision.mutate(input)}
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
  pendingWatchdogDecision,
  canRecordWatchdogDecisions = true,
  watchdogDecisionError,
  onWatchdogDecision,
}: IssueRunLedgerContentProps) {
  const { t } = useTranslation("issues");
  const ledgerRuns = useMemo(() => mergeRuns(runs, liveRuns, activeRun), [activeRun, liveRuns, runs]);
  const latestRun = ledgerRuns[0] ?? null;
  const latestSilentRun = useMemo(
    () =>
      ledgerRuns.find((run) =>
        isActiveRun(run)
        && (run.outputSilence?.level === "critical" || run.outputSilence?.level === "suspicious"),
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
          timestamp: event.createdAt instanceof Date
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
    <section className="space-y-3" aria-label={t("detail.run_ledger_aria_label")}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-muted-foreground">{t("detail.run_ledger_heading")}</h3>
          <p className="text-xs text-muted-foreground">
            {latestRun
              ? runSummary(latestRun, agentMap, t)
              : issueStatus === "in_progress"
                ? t("detail.run_ledger_waiting")
                : t("detail.run_ledger_no_runs")}
          </p>
        </div>
        {latestRun ? (
          <Link
            to={`/agents/${latestRun.agentId}/runs/${latestRun.runId}`}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("detail.run_ledger_latest_run")}
          </Link>
        ) : null}
      </div>

      {children.total > 0 ? (
        <div className="rounded-md border border-border/70 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-foreground">{t("ledger.child_work")}</span>
            <span className="text-muted-foreground">
              {children.active.length > 0
                ? t("ledger.child_work_active", { active: children.active.length, done: children.done, cancelled: children.cancelled })
                : t("ledger.child_work_terminal", { total: children.total, done: children.done, cancelled: children.cancelled })}
            </span>
          </div>
          {children.active.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {children.active.slice(0, 4).map((child) => (
                <Link
                  key={child.id}
                  to={`/issues/${child.identifier ?? child.id}`}
                  className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] hover:bg-accent/40"
                >
                  <span className="shrink-0 font-mono text-muted-foreground">{child.identifier ?? child.id.slice(0, 8)}</span>
                  <span className="truncate">{child.title}</span>
                  <span className="shrink-0 text-muted-foreground">{statusLabel(child.status)}</span>
                </Link>
              ))}
              {children.active.length > 4 ? (
                <span className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
                  {t("ledger.child_work_more", { count: children.active.length - 4 })}
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
              ? t("ledger.watchdog_stale_title")
              : t("ledger.watchdog_silence_title")}
          </p>
          <p className="mt-1">
            {t("ledger.watchdog_silence_body", { duration: formatSilenceAge(latestSilentRun.outputSilence.silenceAgeMs) ?? t("ledger.watchdog_silence_extended") })}
            {latestSilentRun.outputSilence.evaluationIssueIdentifier ? (
              <>
                {" "}
                {t("ledger.watchdog_review_pre")}{" "}
                <Link
                  to={`/issues/${latestSilentRun.outputSilence.evaluationIssueIdentifier}`}
                  className="font-medium underline underline-offset-2"
                >
                  {latestSilentRun.outputSilence.evaluationIssueIdentifier}
                </Link>
                {" "}{t("ledger.watchdog_review_post")}
              </>
            ) : null}
          </p>
          {onWatchdogDecision && canRecordWatchdogDecisions ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                className="rounded-md border border-border bg-background/80 px-2 py-1 text-[11px] text-foreground hover:bg-background"
                onClick={() =>
                  onWatchdogDecision({
                    runId: latestSilentRun.runId,
                    decision: "continue",
                    evaluationIssueId: latestSilentRun.outputSilence?.evaluationIssueId ?? null,
                  })}
                disabled={pendingWatchdogDecision != null}
              >
                {t("ledger.watchdog_continue")}
              </button>
              <button
                type="button"
                className="rounded-md border border-border bg-background/80 px-2 py-1 text-[11px] text-foreground hover:bg-background"
                onClick={() =>
                  onWatchdogDecision({
                    runId: latestSilentRun.runId,
                    decision: "snooze",
                    evaluationIssueId: latestSilentRun.outputSilence?.evaluationIssueId ?? null,
                    snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                    reason: "Snoozed from issue run ledger",
                  })}
                disabled={pendingWatchdogDecision != null}
              >
                {t("ledger.watchdog_snooze")}
              </button>
              <button
                type="button"
                className="rounded-md border border-border bg-background/80 px-2 py-1 text-[11px] text-foreground hover:bg-background"
                onClick={() =>
                  onWatchdogDecision({
                    runId: latestSilentRun.runId,
                    decision: "dismissed_false_positive",
                    evaluationIssueId: latestSilentRun.outputSilence?.evaluationIssueId ?? null,
                    reason: "Dismissed from issue run ledger",
                  })}
                disabled={pendingWatchdogDecision != null}
              >
                {t("ledger.watchdog_false_positive")}
              </button>
            </div>
          ) : null}
          {watchdogDecisionError ? (
            <p className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-900 dark:text-red-200">
              {watchdogDecisionError}
            </p>
          ) : null}
        </div>
      ) : null}

      {feedItems.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
          {renderActivityEvent
            ? t("ledger.empty_with_activity")
            : t("ledger.empty_without_activity")}
        </div>
      ) : (
        <div className="space-y-1.5">
          {feedItems.slice(0, 20).map((item) => {
            if (item.kind === "activity") {
              return <div key={`activity:${item.id}`}>{renderActivityEvent?.(item.event)}</div>;
            }
            const run = item.run;
            const liveness = livenessCopyForRun(run, t);
            const stopReason = stopReasonLabel(run, t);
            const duration = formatDuration(run.startedAt, run.finishedAt);
            const exhausted = hasExhaustedContinuation(run);
            const continuation = continuationLabel(run, t);
            const retryState = describeRunRetryState(run);
            const agentName = compactAgentName(run, agentMap);
            return (
              <article
                key={`run:${run.runId}`}
                className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-foreground">{t("ledger.run_label")}</span>
                  <Link
                    to={`/agents/${run.agentId}/runs/${run.runId}`}
                    className="min-w-0 max-w-full truncate font-mono text-foreground hover:underline"
                  >
                    {run.runId.slice(0, 8)}
                  </Link>
                  <span>{t("ledger.by_agent", { name: agentName })}</span>
                  <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px] capitalize text-muted-foreground">
                    {statusLabel(run.status)}
                  </span>
                  {run.isLive ? (
                    <span className="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[11px] text-cyan-700 dark:text-cyan-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                      {t("ledger.live")}
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      "rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
                      liveness.tone,
                    )}
                    title={liveness.description}
                  >
                    {liveness.label}
                  </span>
                  {exhausted ? (
                    <span className="rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-300">
                      {t("ledger.exhausted")}
                    </span>
                  ) : null}
                  {continuation ? (
                    <span className="text-[11px] text-muted-foreground">{continuation}</span>
                  ) : null}
                  {retryState ? (
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
                        retryState.tone,
                      )}
                    >
                      {retryState.badgeLabel}
                    </span>
                  ) : null}
                  {run.outputSilence && getRunOutputSilenceCopy(t)[run.outputSilence.level] ? (
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
                        getRunOutputSilenceCopy(t)[run.outputSilence.level]?.tone,
                      )}
                    >
                      {getRunOutputSilenceCopy(t)[run.outputSilence.level]?.label}
                    </span>
                  ) : null}
                  {(() => {
                    const profile = modelProfileForRun(run);
                    if (!profile) return null;
                    const label = profile.applied === profile.requested
                      ? t("ledger.profile_label", { name: profile.requested })
                      : profile.applied
                        ? t("ledger.profile_applied_label", { requested: profile.requested, applied: profile.applied })
                        : t("ledger.profile_unavailable_label", { requested: profile.requested });
                    return (
                      <span
                        className={cn(
                          "rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
                          modelProfileBadgeTone(profile),
                        )}
                        title={modelProfileTitle(profile)}
                      >
                        {label}
                      </span>
                    );
                  })()}
                  <span className="ml-auto shrink-0">{relativeTime(item.timestamp)}</span>
                </div>

                <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                  <div className="min-w-0">
                    <span className="text-foreground">{t("ledger.elapsed")}</span>{" "}
                    {duration ?? t("ledger.elapsed_unknown")}
                  </div>
                  <div className="min-w-0">
                    <span className="text-foreground">{t("ledger.last_useful_action")}</span>{" "}
                    {lastUsefulActionLabel(run, t)}
                  </div>
                  <div className="min-w-0">
                    <span className="text-foreground">{t("ledger.stop")}</span>{" "}
                    {stopStatusLabel(run, stopReason, t)}
                  </div>
                </div>

                {retryState ? (
                  <div className="rounded-md border border-border/70 bg-accent/20 px-2 py-2 text-xs leading-5 text-muted-foreground">
                    {retryState.detail ? <p>{retryState.detail}</p> : null}
                    {retryState.secondary ? <p>{retryState.secondary}</p> : null}
                    {retryState.retryOfRunId ? (
                      <p>
                        {t("ledger.retry_of")}{" "}
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

                {(() => {
                  const profile = modelProfileForRun(run);
                  if (!profile?.fallbackReason || profile.applied === profile.requested) return null;
                  return (
                    <p className="min-w-0 break-words text-[11px] leading-5 text-amber-700 dark:text-amber-300">
                      {profile.requested === "cheap"
                        ? t("ledger.profile_cheap_fallback")
                        : t("ledger.profile_unavailable_reason", { name: profile.requested })}
                      {": "}
                      <span className="font-mono">{profile.fallbackReason}</span>
                    </p>
                  );
                })()}

                {run.livenessReason ? (
                  <p className="min-w-0 break-words text-xs leading-5 text-muted-foreground">
                    {run.livenessReason}
                  </p>
                ) : null}

                {run.nextAction ? (
                  <div className="min-w-0 rounded-md bg-accent/40 px-2 py-1.5 text-xs leading-5">
                    <span className="font-medium text-foreground">{t("ledger.next_action_prefix")} </span>
                    <span className="break-words text-muted-foreground">{run.nextAction}</span>
                  </div>
                ) : null}
              </article>
            );
          })}
          {feedItems.length > 20 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t("ledger.older_items", { count: feedItems.length - 20 })}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
