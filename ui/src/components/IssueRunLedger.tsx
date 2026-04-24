import { useMemo } from "react";
import type { Issue, Agent } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { activityApi, type RunForIssue, type RunLivenessState } from "../api/activity";
import { heartbeatsApi, type ActiveRunForIssue, type LiveRunForIssue } from "../api/heartbeats";
import { cn, relativeTime } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../lib/query-placeholder-data";
import { describeRunRetryState } from "../lib/runRetryState";
import { useI18n } from "../context/LocaleContext";

type IssueRunLedgerProps = {
  issueId: string;
  issueStatus: Issue["status"];
  childIssues: Issue[];
  agentMap: ReadonlyMap<string, Agent>;
  hasLiveRuns: boolean;
};

type IssueRunLedgerContentProps = {
  runs: RunForIssue[];
  liveRuns?: LiveRunForIssue[];
  activeRun?: ActiveRunForIssue | null;
  issueStatus: Issue["status"];
  childIssues: Issue[];
  agentMap: ReadonlyMap<string, Pick<Agent, "name">>;
  t?: ReturnType<typeof useI18n>["t"];
};

type LedgerRun = RunForIssue & {
  isLive?: boolean;
  agentName?: string;
};

type LivenessCopy = {
  label: string;
  tone: string;
  description: string;
};

function getLivenessCopyMap(t: ReturnType<typeof useI18n>["t"]): Record<RunLivenessState, LivenessCopy> {
  return {
    completed: {
      label: t("issue.runLedger.completed"),
      tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      description: t("issue.runLedger.completedDesc"),
    },
    advanced: {
      label: t("issue.runLedger.advanced"),
      tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
      description: t("issue.runLedger.advancedDesc"),
    },
    plan_only: {
      label: t("issue.runLedger.planOnly"),
      tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      description: t("issue.runLedger.planOnlyDesc"),
    },
    empty_response: {
      label: t("issue.runLedger.emptyResponse"),
      tone: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
      description: t("issue.runLedger.emptyResponseDesc"),
    },
    blocked: {
      label: t("issue.runLedger.blocked"),
      tone: "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
      description: t("issue.runLedger.blockedDesc"),
    },
    failed: {
      label: t("issue.runLedger.failed"),
      tone: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
      description: t("issue.runLedger.failedDesc"),
    },
    needs_followup: {
      label: t("issue.runLedger.needsFollowUp"),
      tone: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
      description: t("issue.runLedger.needsFollowUpDesc"),
    },
  };
}

function getPendingLivenessCopy(t: ReturnType<typeof useI18n>["t"]): LivenessCopy {
  return {
    label: t("issue.runLedger.checksAfterFinish"),
    tone: "border-border bg-background text-muted-foreground",
    description: t("issue.runLedger.checksAfterFinishDesc"),
  };
}

function getRetryPendingLivenessCopy(t: ReturnType<typeof useI18n>["t"]): LivenessCopy {
  return {
    label: t("issue.runLedger.retryPending"),
    tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
    description: t("issue.runLedger.retryPendingDesc"),
  };
}

function getMissingLivenessCopy(t: ReturnType<typeof useI18n>["t"]): LivenessCopy {
  return {
    label: t("issue.runLedger.noLivenessData"),
    tone: "border-border bg-background text-muted-foreground",
    description: t("issue.runLedger.noLivenessDataDesc"),
  };
}

const TERMINAL_CHILD_STATUSES = new Set<Issue["status"]>(["done", "cancelled"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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
    byId.set(run.id, existing ? { ...existing, isLive: true, agentName: run.agentName } : liveRunToLedgerRun(run));
  }
  if (activeRun && !byId.has(activeRun.id)) {
    byId.set(activeRun.id, liveRunToLedgerRun(activeRun));
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
  t: ReturnType<typeof useI18n>["t"],
) {
  const agentName = compactAgentName(run, agentMap);
  if (run.status === "running") return t("issue.runLedger.summaryRunning", { agent: agentName });
  if (run.status === "queued") return t("issue.runLedger.summaryQueued", { agent: agentName });
  if (run.status === "scheduled_retry") return t("issue.runLedger.summaryRetryScheduled", { agent: agentName });
  return t("issue.runLedger.summaryStatusByAgent", {
    status: statusLabel(run.status),
    agent: agentName,
  });
}

function livenessCopyForRun(
  run: LedgerRun,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (run.status === "scheduled_retry") return getRetryPendingLivenessCopy(t);
  if (run.livenessState) return getLivenessCopyMap(t)[run.livenessState];
  return isActiveRun(run) ? getPendingLivenessCopy(t) : getMissingLivenessCopy(t);
}

function stopReasonLabel(run: RunForIssue, t: ReturnType<typeof useI18n>["t"]) {
  const result = asRecord(run.resultJson);
  const stopReason = readString(result?.stopReason);
  const timeoutFired = result?.timeoutFired === true;
  const effectiveTimeoutSec = readNumber(result?.effectiveTimeoutSec);
  const timeoutText =
    effectiveTimeoutSec && effectiveTimeoutSec > 0 ? `${effectiveTimeoutSec}s` : null;

  if (timeoutFired || stopReason === "timeout") {
    return timeoutText
      ? t("issue.runLedger.stopReason.timeoutWithValue", { value: timeoutText })
      : t("issue.runLedger.stopReason.timeout");
  }
  if (stopReason === "budget_paused") return t("issue.runLedger.stopReason.budgetPaused");
  if (stopReason === "cancelled") return t("issue.runLedger.stopReason.cancelled");
  if (stopReason === "paused") return t("issue.runLedger.stopReason.paused");
  if (stopReason === "process_lost") return t("issue.runLedger.stopReason.processLost");
  if (stopReason === "adapter_failed") return t("issue.runLedger.stopReason.adapterFailed");
  if (stopReason === "completed") {
    return timeoutText
      ? t("issue.runLedger.stopReason.completedWithValue", { value: timeoutText })
      : t("issue.runLedger.stopReason.completed");
  }
  return timeoutText;
}

function stopStatusLabel(run: LedgerRun, stopReason: string | null, t: ReturnType<typeof useI18n>["t"]) {
  if (stopReason) return stopReason;
  if (run.status === "scheduled_retry") return t("issue.runLedger.retryPending");
  if (run.status === "queued") return t("issue.runLedger.waitingToStart");
  if (run.status === "running") return t("issue.runLedger.stillRunning");
  if (!run.livenessState) return t("issue.runLedger.unavailable");
  return t("issue.runLedger.noStopReason");
}

function lastUsefulActionLabel(run: LedgerRun, t: ReturnType<typeof useI18n>["t"]) {
  if (run.status === "scheduled_retry") return t("issue.runLedger.waitingNextAttempt");
  if (run.lastUsefulActionAt) return relativeTime(run.lastUsefulActionAt);
  if (isActiveRun(run)) return t("issue.runLedger.noActionRecorded");
  if (run.livenessState === "plan_only" || run.livenessState === "needs_followup") {
    return t("issue.runLedger.noConcreteAction");
  }
  if (run.livenessState === "empty_response") return t("issue.runLedger.noUsefulOutput");
  if (!run.livenessState) return t("issue.runLedger.unavailable");
  return t("common.none");
}

function continuationLabel(run: LedgerRun, t: ReturnType<typeof useI18n>["t"]) {
  if (!run.continuationAttempt || run.continuationAttempt <= 0) return null;
  return t("issue.runLedger.continuationAttempt", { count: run.continuationAttempt });
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

export function IssueRunLedger({
  issueId,
  issueStatus,
  childIssues,
  agentMap,
  hasLiveRuns,
}: IssueRunLedgerProps) {
  const { t } = useI18n();
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

  return (
    <IssueRunLedgerContent
      runs={runs ?? []}
      liveRuns={liveRuns}
      activeRun={activeRun}
      issueStatus={issueStatus}
      childIssues={childIssues}
      agentMap={agentMap}
      t={t}
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
  t,
}: IssueRunLedgerContentProps) {
  const translate = t ?? useI18n().t;
  const ledgerRuns = useMemo(() => mergeRuns(runs, liveRuns, activeRun), [activeRun, liveRuns, runs]);
  const latestRun = ledgerRuns[0] ?? null;
  const children = childIssueSummary(childIssues);

  return (
    <section className="space-y-3" aria-label={translate("issue.runLedger.title")}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-muted-foreground">{translate("issue.runLedger.title")}</h3>
          <p className="text-xs text-muted-foreground">
            {latestRun
              ? runSummary(latestRun, agentMap, translate)
              : issueStatus === "in_progress"
                ? translate("issue.runLedger.waitingFirstRun")
                : translate("issue.runLedger.noRunsLinked")}
          </p>
        </div>
        {latestRun ? (
          <Link
            to={`/agents/${latestRun.agentId}/runs/${latestRun.runId}`}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {translate("issue.runLedger.latestRun")}
          </Link>
        ) : null}
      </div>

      {children.total > 0 ? (
        <div className="rounded-md border border-border/70 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-foreground">{translate("issue.runLedger.childWork")}</span>
            <span className="text-muted-foreground">
              {children.active.length > 0
                ? translate("issue.runLedger.childSummaryActive", {
                  active: children.active.length,
                  done: children.done,
                  cancelled: children.cancelled,
                })
                : translate("issue.runLedger.childSummaryTerminal", {
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
                  className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] hover:bg-accent/40"
                >
                  <span className="shrink-0 font-mono text-muted-foreground">{child.identifier ?? child.id.slice(0, 8)}</span>
                  <span className="truncate">{child.title}</span>
                  <span className="shrink-0 text-muted-foreground">{statusLabel(child.status)}</span>
                </Link>
              ))}
              {children.active.length > 4 ? (
                <span className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
                  +{translate("issue.runLedger.more", { count: children.active.length - 4 })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {ledgerRuns.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
          {translate("issue.runLedger.historyHint")}
        </div>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border/70">
          {ledgerRuns.slice(0, 8).map((run) => {
            const liveness = livenessCopyForRun(run, translate);
            const stopReason = stopReasonLabel(run, translate);
            const duration = formatDuration(run.startedAt, run.finishedAt);
            const exhausted = hasExhaustedContinuation(run);
            const continuation = continuationLabel(run, translate);
            const retryState = describeRunRetryState(run);
            return (
              <article key={run.runId} className="space-y-2 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/agents/${run.agentId}/runs/${run.runId}`}
                    className="min-w-0 max-w-full truncate font-mono text-xs text-foreground hover:underline"
                  >
                    {run.runId.slice(0, 8)}
                  </Link>
                  <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px] capitalize text-muted-foreground">
                    {statusLabel(run.status)}
                  </span>
                  {run.isLive ? (
                    <span className="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[11px] text-cyan-700 dark:text-cyan-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                      {translate("common.live")}
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
                      {translate("issue.runLedger.exhausted")}
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
                </div>

                <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                  <div className="min-w-0">
                    <span className="text-foreground">{translate("issue.runLedger.elapsed")}</span>{" "}
                    {duration ?? translate("issue.runLedger.unknown")}
                  </div>
                  <div className="min-w-0">
                    <span className="text-foreground">{translate("issue.runLedger.lastUsefulAction")}</span>{" "}
                    {lastUsefulActionLabel(run, translate)}
                  </div>
                  <div className="min-w-0">
                    <span className="text-foreground">{translate("issue.runLedger.stop")}</span>{" "}
                    {stopStatusLabel(run, stopReason, translate)}
                  </div>
                </div>

                {retryState ? (
                  <div className="rounded-md border border-border/70 bg-accent/20 px-2 py-2 text-xs leading-5 text-muted-foreground">
                    {retryState.detail ? <p>{retryState.detail}</p> : null}
                    {retryState.secondary ? <p>{retryState.secondary}</p> : null}
                    {retryState.retryOfRunId ? (
                      <p>
                        Retry of{" "}
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

                {run.nextAction ? (
                  <div className="min-w-0 rounded-md bg-accent/40 px-2 py-1.5 text-xs leading-5">
                    <span className="font-medium text-foreground">{translate("issue.runLedger.nextAction")}</span>
                    <span className="break-words text-muted-foreground">{run.nextAction}</span>
                  </div>
                ) : null}
              </article>
            );
          })}
          {ledgerRuns.length > 8 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {translate("issue.runLedger.olderRunsHidden", { count: ledgerRuns.length - 8 })}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
