import { useMemo, useState, type ReactNode } from "react";
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
import {
  formatIssueStatus,
  formatRunStatus,
  getLivenessCopyZh,
  LIVENESS_MISSING_ZH,
  LIVENESS_PENDING_ZH,
  LIVENESS_RETRY_PENDING_ZH,
  runLedger,
  runOutputSilenceLabelZh,
} from "../lib/i18n";

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

type LivenessCopy = {
  label: string;
  tone: string;
  description: string;
};

const LIVENESS_STATE_TONE: Record<RunLivenessState, string> = {
  completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  advanced: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  plan_only: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  empty_response: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  blocked: "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
  failed: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  needs_followup: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
};

const PENDING_LIVENESS_TONE = "border-border bg-background text-muted-foreground";
const RETRY_PENDING_LIVENESS_TONE = "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300";

const TERMINAL_CHILD_STATUSES = new Set<Issue["status"]>(["done", "cancelled"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

type RunOutputSilenceLevel = NonNullable<ActiveRunForIssue["outputSilence"]>["level"];

const RUN_OUTPUT_SILENCE_TONE: Partial<Record<RunOutputSilenceLevel, string>> = {
  suspicious: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  critical: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  snoozed: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
};

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
  const lines = [runLedger.modelProfileLineRequested(summary.requested)];
  if (summary.applied) lines.push(runLedger.modelProfileLineApplied(summary.applied));
  if (summary.configSource) lines.push(runLedger.modelProfileLineSource(summary.configSource));
  if (summary.fallbackReason) lines.push(runLedger.modelProfileLineFallback(summary.fallbackReason));
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
  if (totalSeconds < 60) return runLedger.durationSeconds(totalSeconds);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return runLedger.durationMinutesSeconds(minutes, seconds);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return runLedger.durationHoursMinutes(hours, remainingMinutes);
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

function isActiveRun(run: Pick<LedgerRun, "status" | "isLive">) {
  return run.isLive || ACTIVE_RUN_STATUSES.has(run.status);
}

function runSummary(run: LedgerRun, agentMap: ReadonlyMap<string, Pick<Agent, "name">>) {
  const agentName = compactAgentName(run, agentMap);
  if (run.status === "running") return runLedger.runningNowBy(agentName);
  if (run.status === "queued") return runLedger.queuedFor(agentName);
  if (run.status === "scheduled_retry") return runLedger.autoRetryScheduledFor(agentName);
  return runLedger.genericStatusBy(formatRunStatus(run.status), agentName);
}

function livenessCopyForRun(run: LedgerRun): LivenessCopy {
  if (run.status === "scheduled_retry") {
    return {
      label: LIVENESS_RETRY_PENDING_ZH.label,
      description: LIVENESS_RETRY_PENDING_ZH.description,
      tone: RETRY_PENDING_LIVENESS_TONE,
    };
  }
  if (run.livenessState) {
    const zh = getLivenessCopyZh(run.livenessState);
    return {
      label: zh?.label ?? run.livenessState,
      description: zh?.description ?? "",
      tone: LIVENESS_STATE_TONE[run.livenessState],
    };
  }
  if (isActiveRun(run)) {
    return {
      label: LIVENESS_PENDING_ZH.label,
      description: LIVENESS_PENDING_ZH.description,
      tone: PENDING_LIVENESS_TONE,
    };
  }
  return {
    label: LIVENESS_MISSING_ZH.label,
    description: LIVENESS_MISSING_ZH.description,
    tone: PENDING_LIVENESS_TONE,
  };
}

function stopReasonLabel(run: RunForIssue) {
  const result = asRecord(run.resultJson);
  const stopReason = readString(result?.stopReason);
  const timeoutFired = result?.timeoutFired === true;
  const effectiveTimeoutSec = readNumber(result?.effectiveTimeoutSec);
  const timeoutText =
    effectiveTimeoutSec && effectiveTimeoutSec > 0 ? `${effectiveTimeoutSec}s` : null;

  if (timeoutFired || stopReason === "timeout") {
    return timeoutText ? runLedger.stopTimeout(timeoutText) : runLedger.stopTimeoutShort;
  }
  if (stopReason === "max_turns_exhausted" || stopReason === "turn_limit_exhausted") return runLedger.stopMaxTurns;
  if (stopReason === "budget_paused") return runLedger.stopBudgetPaused;
  if (stopReason === "cancelled") return runLedger.stopCancelled;
  if (stopReason === "paused") return runLedger.stopPausedByBoard;
  if (stopReason === "process_lost") return runLedger.stopProcessLost;
  if (stopReason === "adapter_failed") return runLedger.stopAdapterFailed;
  if (stopReason === "completed") return timeoutText ? runLedger.stopCompleted(`${timeoutText}`) : runLedger.stopCompleted();
  return timeoutText ?? null;
}

function stopStatusLabel(run: LedgerRun, stopReason: string | null) {
  if (stopReason) return stopReason;
  if (run.status === "scheduled_retry") return runLedger.stopRetryPending;
  if (run.status === "queued") return runLedger.stopQueued;
  if (run.status === "running") return runLedger.stopRunning;
  if (!run.livenessState) return runLedger.stopUnavailable;
  return runLedger.stopNoReason;
}

function lastUsefulActionLabel(run: LedgerRun) {
  if (run.status === "scheduled_retry") return runLedger.waitingNextAttempt;
  if (run.lastUsefulActionAt) return relativeTime(run.lastUsefulActionAt);
  if (isActiveRun(run)) return runLedger.noActionYet;
  if (run.livenessState === "plan_only" || run.livenessState === "needs_followup") {
    return runLedger.noConcreteAction;
  }
  if (run.livenessState === "empty_response") return runLedger.noUsefulOutput;
  if (!run.livenessState) return runLedger.stopUnavailable;
  return runLedger.noneRecorded;
}

function continuationLabel(run: LedgerRun) {
  if (!run.continuationAttempt || run.continuationAttempt <= 0) return null;
  return runLedger.continuationAttempt(run.continuationAttempt);
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
  if (totalMinutes < 1) return runLedger.underOneMinute;
  if (totalMinutes < 60) return runLedger.minutes(totalMinutes);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return runLedger.hours(hours);
  return runLedger.hoursMinutes(hours, minutes);
}

function watchdogDecisionErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 403) {
    return runLedger.watchdog403;
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : runLedger.watchdogGenericError;
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
      const message = watchdogDecisionErrorMessage(error);
      const dedupeSuffix = error instanceof ApiError ? String(error.status) : "error";
      setWatchdogDecisionError(message);
      pushToast({
        title: runLedger.toastWatchdogFailed,
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
    <section className="space-y-3" aria-label={runLedger.ariaSection}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-muted-foreground">{runLedger.sectionTitle}</h3>
          <p className="text-xs text-muted-foreground">
            {latestRun
              ? runSummary(latestRun, agentMap)
              : issueStatus === "in_progress"
                ? runLedger.waitingFirst
                : runLedger.noRunsLinked}
          </p>
        </div>
        {latestRun ? (
          <Link
            to={`/agents/${latestRun.agentId}/runs/${latestRun.runId}`}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {runLedger.latestRun}
          </Link>
        ) : null}
      </div>

      {children.total > 0 ? (
        <div className="rounded-md border border-border/70 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-foreground">{runLedger.childWork}</span>
            <span className="text-muted-foreground">
              {children.active.length > 0
                ? runLedger.childSummaryActive(children.active.length, children.done, children.cancelled)
                : runLedger.childSummaryTerminal(children.total, children.done, children.cancelled)}
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
                  <span className="shrink-0 text-muted-foreground">{formatIssueStatus(child.status)}</span>
                </Link>
              ))}
              {children.active.length > 4 ? (
                <span className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
                  {runLedger.more(children.active.length - 4)}
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
              ? runLedger.watchdogStaleTitle
              : runLedger.watchdogSilenceTitle}
          </p>
          <p className="mt-1">
            {runLedger.silentForPrefix}{" "}
            {formatSilenceAge(latestSilentRun.outputSilence.silenceAgeMs) ?? runLedger.extended}
            {latestSilentRun.outputSilence.evaluationIssueIdentifier ? (
              <>
                {" "}
                <Link
                  to={`/issues/${latestSilentRun.outputSilence.evaluationIssueIdentifier}`}
                  className="font-medium underline underline-offset-2"
                >
                  {latestSilentRun.outputSilence.evaluationIssueIdentifier}
                </Link>
                {runLedger.recoveryReview}
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
                {runLedger.continueMonitoring}
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
                    reason: runLedger.snoozeReasonLedger,
                  })}
                disabled={pendingWatchdogDecision != null}
              >
                {runLedger.snooze1h}
              </button>
              <button
                type="button"
                className="rounded-md border border-border bg-background/80 px-2 py-1 text-[11px] text-foreground hover:bg-background"
                onClick={() =>
                  onWatchdogDecision({
                    runId: latestSilentRun.runId,
                    decision: "dismissed_false_positive",
                    evaluationIssueId: latestSilentRun.outputSilence?.evaluationIssueId ?? null,
                    reason: runLedger.dismissReasonLedger,
                  })}
                disabled={pendingWatchdogDecision != null}
              >
                {runLedger.falsePositive}
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
            ? runLedger.emptyFeedWithActivity
            : runLedger.emptyFeedLegacy}
        </div>
      ) : (
        <div className="space-y-1.5">
          {feedItems.slice(0, 20).map((item) => {
            if (item.kind === "activity") {
              return <div key={`activity:${item.id}`}>{renderActivityEvent?.(item.event)}</div>;
            }
            const run = item.run;
            const liveness = livenessCopyForRun(run);
            const stopReason = stopReasonLabel(run);
            const duration = formatDuration(run.startedAt, run.finishedAt);
            const exhausted = hasExhaustedContinuation(run);
            const continuation = continuationLabel(run);
            const retryState = describeRunRetryState(run);
            const agentName = compactAgentName(run, agentMap);
            const sourceResolvedFold = readSourceResolvedWatchdogFold(run.resultJson);
            return (
              <article
                key={`run:${run.runId}`}
                className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-foreground">{runLedger.runLabel}</span>
                  <Link
                    to={`/agents/${run.agentId}/runs/${run.runId}`}
                    className="min-w-0 max-w-full truncate font-mono text-foreground hover:underline"
                  >
                    {run.runId.slice(0, 8)}
                  </Link>
                  <span>{runLedger.byAgent} {agentName}</span>
                  <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {formatRunStatus(run.status)}
                  </span>
                  {run.isLive ? (
                    <span className="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[11px] text-cyan-700 dark:text-cyan-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                      {runLedger.liveChip}
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
                      {runLedger.exhaustedChip}
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
                  {run.outputSilence && run.outputSilence.level && RUN_OUTPUT_SILENCE_TONE[run.outputSilence.level] ? (
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
                        RUN_OUTPUT_SILENCE_TONE[run.outputSilence.level],
                      )}
                    >
                      {runOutputSilenceLabelZh(run.outputSilence.level) ?? run.outputSilence.level}
                    </span>
                  ) : null}
                  {(() => {
                    const profile = modelProfileForRun(run);
                    if (!profile) return null;
                    const label = profile.applied === profile.requested
                      ? runLedger.modelProfileEqual(profile.requested)
                      : profile.applied
                        ? runLedger.modelProfileArrow(profile.requested, profile.applied)
                        : runLedger.modelProfileUnavailable(profile.requested);
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
                  {sourceResolvedFold ? <SourceResolvedFoldBadge /> : null}
                  <span className="ml-auto shrink-0">{relativeTime(item.timestamp)}</span>
                </div>

                <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                  <div className="min-w-0">
                    <span className="text-foreground">{runLedger.elapsed}</span>{" "}
                    {duration ?? runLedger.unknownDuration}
                  </div>
                  <div className="min-w-0">
                    <span className="text-foreground">{runLedger.lastUsefulAction}</span>{" "}
                    {lastUsefulActionLabel(run)}
                  </div>
                  <div className="min-w-0">
                    <span className="text-foreground">{runLedger.stopColumn}</span>{" "}
                    {stopStatusLabel(run, stopReason)}
                  </div>
                </div>

                {retryState ? (
                  <div className="rounded-md border border-border/70 bg-accent/20 px-2 py-2 text-xs leading-5 text-muted-foreground">
                    {retryState.detail ? <p>{retryState.detail}</p> : null}
                    {retryState.secondary ? <p>{retryState.secondary}</p> : null}
                    {retryState.retryOfRunId ? (
                      <p>
                        {runLedger.retryOfRun}{" "}
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
                        ? runLedger.cheapFallbackPrimary
                        : runLedger.profileUnavailable(profile.requested)}
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
                    <span className="font-medium text-foreground">{runLedger.nextActionPrefix}</span>
                    <span className="break-words text-muted-foreground">{run.nextAction}</span>
                  </div>
                ) : null}
              </article>
            );
          })}
          {feedItems.length > 20 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {runLedger.olderItemsHidden(feedItems.length - 20)}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
