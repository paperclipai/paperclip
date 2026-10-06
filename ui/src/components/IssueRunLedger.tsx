import { t, useTranslation, i18n } from "@/i18n";
import { Trans } from "react-i18next";
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

const LIVENESS_COPY: Record<RunLivenessState, LivenessCopy> = {
  completed: {
    get label() { return t("localizationTaskRuntime.ui_Completed_1tmo59u"); },
    tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    get description() { return t("localizationTaskRuntime.ui_Task_reached_a_terminal_state_28r4o0"); },
  },
  advanced: {
    get label() { return t("localizationTaskRuntime.ui_Advanced_qwfkor"); },
    tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
    get description() { return t("localizationTaskRuntime.ui_Run_produced_concrete_evidence_of_progress_9mvhx4"); },
  },
  plan_only: {
    get label() { return t("localizationTaskRuntime.ui_Plan_only_g6xu00"); },
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    get description() { return t("localizationTaskRuntime.ui_Run_described_future_work_without_concrete_action_evidence_wu7qon"); },
  },
  empty_response: {
    get label() { return t("localizationTaskRuntime.ui_Empty_response_9fq0gt"); },
    tone: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
    get description() { return t("localizationTaskRuntime.ui_Run_finished_without_useful_output_e90en7"); },
  },
  blocked: {
    get label() { return t("localizationTaskRuntime.ui_Blocked_1r45c2b"); },
    tone: "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
    get description() { return t("localizationTaskRuntime.ui_Run_or_task_declared_a_blocker_1xc4zwn"); },
  },
  failed: {
    get label() { return t("localizationTaskRuntime.ui_Failed_npsixg"); },
    tone: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    get description() { return t("localizationTaskRuntime.ui_Run_ended_unsuccessfully_neo24m"); },
  },
  needs_followup: {
    get label() { return t("localizationTaskRuntime.ui_Needs_follow_up_1ty5qfz"); },
    tone: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    get description() { return t("localizationTaskRuntime.ui_Run_produced_useful_output_but_did_not_prove_concrete_progress_q21a84"); },
  },
};

const PENDING_LIVENESS_COPY: LivenessCopy = {
  get label() { return t("localizationTaskRuntime.ui_Checks_after_finish_nzg1ad"); },
  tone: "border-border bg-background text-muted-foreground",
  get description() { return t("localizationTaskRuntime.ui_Liveness_is_evaluated_after_the_run_finishes_1d1zhwa"); },
};

const RETRY_PENDING_LIVENESS_COPY: LivenessCopy = {
  get label() { return t("localizationTaskRuntime.ui_Retry_pending_bwqdx6"); },
  tone: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  get description() { return t("localizationTaskRuntime.ui_Paperclip_queued_an_automatic_retry_that_has_not_started_yet_1pcw7lx"); },
};

const MISSING_LIVENESS_COPY: LivenessCopy = {
  get label() { return t("localizationTaskRuntime.ui_No_liveness_data_1blry79"); },
  tone: "border-border bg-background text-muted-foreground",
  get description() { return t("localizationTaskRuntime.ui_This_run_has_no_persisted_liveness_classification_hxrbwh"); },
};

const TERMINAL_CHILD_STATUSES = new Set<Issue["status"]>(["done", "cancelled"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

type RunOutputSilenceLevel = NonNullable<
  ActiveRunForIssue["outputSilence"]
>["level"];

type RunOutputSilenceCopy = {
  label: string;
  tone: string;
};

const RUN_OUTPUT_SILENCE_COPY: Partial<
  Record<RunOutputSilenceLevel, RunOutputSilenceCopy>
> = {
  suspicious: {
    get label() { return t("localizationTaskRuntime.ui_Output_silence_7050jj"); },
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  critical: {
    get label() { return t("localizationTaskRuntime.ui_Critical_silence_112wp8j"); },
    tone: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  },
  snoozed: {
    get label() { return t("localizationTaskRuntime.ui_Silence_snoozed_18imc5a"); },
    tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  },
};

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
  if (totalSeconds < 60) return t("localizationTaskRuntime.durationSeconds", { seconds: totalSeconds });
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60)
    return seconds > 0 ? t("localizationTaskRuntime.durationMinutesSeconds", { minutes, seconds }) : t("localizationTaskRuntime.durationMinutes", { minutes });
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? t("localizationTaskRuntime.durationHoursMinutes", { hours, minutes: remainingMinutes }) : t("localizationTaskRuntime.durationHours", { hours });
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
  return status === "scheduled_retry" ? t("localizationTaskRuntime.ui_Retry_pending_bwqdx6") : t(`status.${status}`, { defaultValue: status.replace(/_/g, " ") });
}

function isActiveRun(run: Pick<LedgerRun, "status" | "isLive">) {
  return run.isLive || ACTIVE_RUN_STATUSES.has(run.status);
}

function runSummary(
  run: LedgerRun,
  agentMap: ReadonlyMap<string, Pick<Agent, "name">>,
) {
  const agentName = compactAgentName(run, agentMap);
  if (run.status === "running") return t("localizationTaskRuntime.runRunningBy", { agent: agentName });
  if (run.status === "queued") return t("localizationTaskRuntime.runQueuedFor", { agent: agentName });
  if (run.status === "scheduled_retry")
    return t("localizationTaskRuntime.runRetryFor", { agent: agentName });
  return t("localizationTaskRuntime.runStatusBy", { status: statusLabel(run.status), agent: agentName });
}

function livenessCopyForRun(run: LedgerRun) {
  if (run.status === "scheduled_retry") return RETRY_PENDING_LIVENESS_COPY;
  if (run.livenessState) return LIVENESS_COPY[run.livenessState];
  return isActiveRun(run) ? PENDING_LIVENESS_COPY : MISSING_LIVENESS_COPY;
}

function stopReasonLabel(run: RunForIssue) {
  const result = asRecord(run.resultJson);
  const stopReason = readString(result?.stopReason);
  const timeoutFired = result?.timeoutFired === true;
  const effectiveTimeoutSec = readNumber(result?.effectiveTimeoutSec);
  const timeoutText =
    effectiveTimeoutSec && effectiveTimeoutSec > 0
      ? t("localizationTaskRuntime.timeoutSeconds", { count: effectiveTimeoutSec })
      : null;

  if (timeoutFired || stopReason === "timeout") {
    return timeoutText ? t("localizationTaskRuntime.timeoutDetail", { timeout: timeoutText }) : t("localizationTaskRuntime.timeout");
  }
  if (
    stopReason === "max_turns_exhausted" ||
    stopReason === "turn_limit_exhausted"
  )
    return t("localizationTaskRuntime.ui_max_turns_exhausted_3xo7wa");
  if (stopReason === "budget_paused") return t("localizationTaskRuntime.ui_budget_paused_1xssosa");
  if (stopReason === "cancelled") return t("localizationTaskRuntime.cancelled");
  if (stopReason === "paused") return t("localizationTaskRuntime.ui_paused_by_board_10p834g");
  if (stopReason === "process_lost") return t("localizationTaskRuntime.ui_process_lost_1nx646s");
  if (stopReason === "unmanaged_background_task_stopped")
    return t("localizationTaskRuntime.ui_unmanaged_background_task_stopped_ro89fb");
  if (stopReason === "adapter_failed") return t("localizationTaskRuntime.ui_adapter_failed_12m9vap");
  if (stopReason === "completed")
    return timeoutText ? t("localizationTaskRuntime.completedDetail", { timeout: timeoutText }) : t("localizationTaskRuntime.completed");
  return timeoutText;
}

function stopStatusLabel(run: LedgerRun, stopReason: string | null) {
  if (stopReason) return stopReason;
  if (run.status === "scheduled_retry") return t("localizationTaskRuntime.ui_Retry_pending_bwqdx6");
  if (run.status === "queued") return t("localizationTaskRuntime.ui_Waiting_to_start_1ekquxd");
  if (run.status === "running") return t("localizationTaskRuntime.ui_Still_running_2etln6");
  if (!run.livenessState) return t("localizationTaskRuntime.ui_Unavailable_1okhrqh");
  return t("localizationTaskRuntime.ui_No_stop_reason_1x9ncbq");
}

function lastUsefulActionLabel(run: LedgerRun) {
  if (run.status === "scheduled_retry") return t("localizationTaskRuntime.ui_Waiting_for_next_attempt_vrnvq9");
  if (run.lastUsefulActionAt) return relativeTime(run.lastUsefulActionAt);
  if (isActiveRun(run)) return t("localizationTaskRuntime.ui_No_action_recorded_yet_5eh7m2");
  if (
    run.livenessState === "plan_only" ||
    run.livenessState === "needs_followup"
  ) {
    return t("localizationTaskRuntime.ui_No_concrete_action_bxvwhh");
  }
  if (run.livenessState === "empty_response") return t("localizationTaskRuntime.ui_No_useful_output_1mdlv6h");
  if (!run.livenessState) return t("localizationTaskRuntime.ui_Unavailable_1okhrqh");
  return t("localizationTaskRuntime.ui_None_recorded_sqpl4x");
}

function continuationLabel(run: LedgerRun) {
  if (!run.continuationAttempt || run.continuationAttempt <= 0) return null;
  return t("localizationTaskRuntime.continuationAttempt", { attempt: run.continuationAttempt });
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
  if (totalMinutes < 1) return t("localizationTaskRuntime.underMinute");
  if (totalMinutes < 60)
    return t("localizationTaskRuntime.silenceMinutes", { count: totalMinutes });
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return t("localizationTaskRuntime.silenceHours", { count: hours });
  return t("localizationTaskRuntime.durationHoursMinutes", { hours, minutes });
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
    return t("localizationTaskRuntime.ui_Only_the_board_or_the_assigned_recovery_owner_can_record_watchdog_146cg6j");
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : t("localizationTaskRuntime.ui_Paperclip_could_not_record_the_watchdog_decision_1qzyjme");
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
    retry: false,
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
    [i18n.resolvedLanguage, runs],
  );
  const canInspectProviderTrace =
    boardAccess?.source === "local_implicit" || boardAccess?.isInstanceAdmin === true;
  const { data: providerTraceRows } = useQuery({
    queryKey: queryKeys.providerTraceMetadata(companyId, traceRunIds),
    queryFn: () => heartbeatsApi.providerTraceMetadata(companyId, traceRunIds),
    enabled: canInspectProviderTrace && traceRunIds.length > 0,
    retry: false,
  });
  const providerTraceMetadata = useMemo(
    () => new Map((providerTraceRows ?? []).map((trace) => [trace.runId, trace])),
    [i18n.resolvedLanguage, providerTraceRows],
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
        get title() { return t("localizationTaskRuntime.ui_Watchdog_decision_not_recorded_16zzdw7"); },
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
        throw new Error(result.message ?? t("localizationTaskRuntime.ui_Trace_re_run_was_skipped_1dzofs"));
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
        get title() { return t("localizationTaskRuntime.ui_Trace_re_run_not_started_135wpvz"); },
        body:
          error instanceof Error
            ? error.message
            : t("localizationTaskRuntime.ui_Paperclip_could_not_start_the_trace_re_run_1ubyhwo"),
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
    [i18n.resolvedLanguage, activeRun, liveRuns, runs],
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
    [i18n.resolvedLanguage, ledgerRuns],
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
  }, [i18n.resolvedLanguage, activityEvents, canRenderActivityEvents, ledgerRuns]);

  return (
    <section className="space-y-3" aria-label={t("localizationTaskRuntime.ui_Task_run_ledger_1wkqi76")}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-muted-foreground">
            {t("localizationTaskRuntime.ui_Run_ledger_qqlilj")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {latestRun
              ? runSummary(latestRun, agentMap)
              : issueStatus === "in_progress"
                ? t("localizationTaskRuntime.ui_Waiting_for_the_first_run_record_2bwn6e")
                : t("localizationTaskRuntime.ui_No_runs_linked_yet_zbvos7")}
          </p>
        </div>
        {latestRun ? (
          <Link
            to={`/agents/${latestRun.agentId}/runs/${latestRun.runId}`}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("localizationTaskRuntime.ui_Latest_run_243xn7")}
          </Link>
        ) : null}
      </div>

      {children.total > 0 ? (
        <div className="rounded-md border border-border/70 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-foreground">{t("localizationTaskRuntime.ui_Child_work_kkprzm")}</span>
            <span className="text-muted-foreground">
              {children.active.length > 0
                ? t("localizationTaskRuntime.childWorkActive", { active: children.active.length, done: children.done, cancelled: children.cancelled })
                : t("localizationTaskRuntime.childWorkTerminal", { total: children.total, done: children.done, cancelled: children.cancelled })}
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
                  {t("localizationTaskRuntime.moreCount", { count: children.active.length - 4 })}
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
              ? t("localizationTaskRuntime.ui_Critical_output_silence_1bu2u4e")
              : t("localizationTaskRuntime.ui_Output_silence_watchdog_warning_l5mfma")}
          </p>
          <p className="mt-1">
            {t("localizationTaskRuntime.latestSilence", { duration: formatSilenceAge(latestSilentRun.outputSilence.silenceAgeMs) ?? t("localizationTaskRuntime.extendedPeriod") })}
            {latestSilentRun.outputSilence.evaluationIssueIdentifier ? (
              <>
                {" "}
                <Trans i18nKey="localizationTaskRuntime.recoveryContext" values={{ identifier: latestSilentRun.outputSilence.evaluationIssueIdentifier }} components={{ issue: <Link to={`/issues/${latestSilentRun.outputSilence.evaluationIssueIdentifier}`} className="font-medium underline underline-offset-2" /> }} />
              </>
            ) : null}
          </p>
          <p className="mt-1">
            {latestSilentRun.outputSilence.evaluationIssueIdentifier
              ? t("localizationTaskRuntime.ui_This_signal_is_informational_Paperclip_did_not_create_new_delegat_rd55zj")
              : t("localizationTaskRuntime.ui_This_signal_is_informational_Paperclip_did_not_create_or_assign_a_2q3eax")}
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
                {t("localizationTaskRuntime.ui_Continue_monitoring_1r76exq")}
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
                {t("localizationTaskRuntime.ui_Snooze_1h_ab98c4")}
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
                {t("localizationTaskRuntime.ui_Mark_false_positive_1uyncym")}
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
            ? t("localizationTaskRuntime.ui_Runs_and_activity_will_appear_here_once_this_task_has_history_14tmrmm")
            : t("localizationTaskRuntime.ui_Historical_runs_without_liveness_metadata_will_appear_here_once_l_c80wkk")}
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
                  <span className="font-medium text-foreground">{t("localizationTaskRuntime.ui_Run_137u7vu")}</span>
                  <Link
                    to={`/agents/${run.agentId}/runs/${run.runId}`}
                    className="min-w-0 max-w-full truncate font-mono text-foreground hover:underline"
                  >
                    {run.runId.slice(0, 8)}
                  </Link>
                  <span>{t("localizationTaskRuntime.byAgent", { agent: agentName })}</span>
                  {onBehalfOfLabel ? (
                    <span
                      data-testid="run-on-behalf-of"
                      className="min-w-0 max-w-full truncate text-muted-foreground"
                      title={t("localizationTaskRuntime.actingOnBehalfOf", { actor: onBehalfOfLabel })}
                    >
                      <Trans i18nKey="localizationTaskRuntime.onBehalfOf" values={{ actor: onBehalfOfLabel }} components={{ actor: <span className="text-foreground" /> }} />
                    </span>
                  ) : null}
                  <span className="rounded-md border border-border px-1.5 py-0.5 text-(length:--text-micro) capitalize text-muted-foreground">
                    {statusLabel(run.status)}
                  </span>
                  {run.isLive ? (
                    <span className="inline-flex items-center gap-1 rounded-md border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-(length:--text-micro) text-blue-700 dark:text-blue-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                      {t("localizationTaskRuntime.live")}
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
                      {t("localizationTaskRuntime.ui_Exhausted_wsq9d8")}
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
                  RUN_OUTPUT_SILENCE_COPY[run.outputSilence.level] ? (
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-(length:--text-micro) font-medium",
                        RUN_OUTPUT_SILENCE_COPY[run.outputSilence.level]?.tone,
                      )}
                    >
                      {RUN_OUTPUT_SILENCE_COPY[run.outputSilence.level]?.label}
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
                  >{t("localizationAgents.ui73_Inspect_run")}</button>
                </div>

                <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                  <div className="min-w-0">
                    <span className="text-foreground">{t("localizationTaskRuntime.ui_Elapsed_14qdum3")}</span>{" "}
                    {duration ?? t("localizationTaskRuntime.ui_unknown_174uabd")}
                  </div>
                  <div className="min-w-0">
                    <span className="text-foreground">{t("localizationTaskRuntime.ui_Last_useful_action_1j9b2y5")}</span>{" "}
                    {lastUsefulActionLabel(run)}
                  </div>
                  <div className="min-w-0">
                    <span className="text-foreground">{t("workspaces.actions.stop")}</span>{" "}
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
                        {t("localizationTaskRuntime.ui_Retry_of_5o17n2")}{" "}
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

                {run.nextAction ? (
                  <div className="min-w-0 rounded-md bg-accent/40 px-2 py-1.5 text-xs leading-5">
                    <span className="font-medium text-foreground">
                      {t("localizationTaskRuntime.ui_Next_action_n7deyw")}{" "}
                    </span>
                    <span className="break-words text-muted-foreground">
                      {run.nextAction}
                    </span>
                  </div>
                ) : null}
              </article>
            );
          })}
          {feedItems.length > 20 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t("localizationTaskRuntime.olderItems", { count: feedItems.length - 20 })}
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
