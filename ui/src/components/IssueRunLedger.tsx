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

const LIVENESS_COPY: Record<RunLivenessState, LivenessCopy> = {
  completed: {
    label: "Completed",
    tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    description: "Issue reached a terminal state.",
  },
  advanced: {
    label: "Advanced",
    tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
    description: "Run produced concrete evidence of progress.",
  },
  plan_only: {
    label: "Plan only",
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    description: "Run described future work without concrete action evidence.",
  },
  empty_response: {
    label: "Empty response",
    tone: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
    description: "Run finished without useful output.",
  },
  blocked: {
    label: "Blocked",
    tone: "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
    description: "Run or issue declared a blocker.",
  },
  failed: {
    label: "Failed",
    tone: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    description: "Run ended unsuccessfully.",
  },
  needs_followup: {
    label: "Needs follow-up",
    tone: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    description: "Run produced useful output but did not prove concrete progress.",
  },
};

const PENDING_LIVENESS_COPY: LivenessCopy = {
  label: "Checks after finish",
  tone: "border-border bg-background text-muted-foreground",
  description: "Liveness is evaluated after the run finishes.",
};

const RETRY_PENDING_LIVENESS_COPY: LivenessCopy = {
  label: "Retry pending",
  tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  description: "Paperclip queued an automatic retry that has not started yet.",
};

const MISSING_LIVENESS_COPY: LivenessCopy = {
  label: "No liveness data",
  tone: "border-border bg-background text-muted-foreground",
  description: "This run has no persisted liveness classification.",
};

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

function runSummary(run: LedgerRun, agentMap: ReadonlyMap<string, Pick<Agent, "name">>) {
  const agentName = compactAgentName(run, agentMap);
  if (run.status === "running") return `Running now by ${agentName}`;
  if (run.status === "queued") return `Queued for ${agentName}`;
  if (run.status === "scheduled_retry") return `Automatic retry scheduled for ${agentName}`;
  return `${statusLabel(run.status)} by ${agentName}`;
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
    effectiveTimeoutSec && effectiveTimeoutSec > 0 ? `${effectiveTimeoutSec}s timeout` : null;

  if (timeoutFired || stopReason === "timeout") {
    return timeoutText ? `timeout (${timeoutText})` : "timeout";
  }
  if (stopReason === "budget_paused") return "budget paused";
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "paused") return "paused";
  if (stopReason === "process_lost") return "process lost";
  if (stopReason === "adapter_failed") return "adapter failed";
  if (stopReason === "completed") return timeoutText ? `completed (${timeoutText})` : "completed";
  return timeoutText;
}

function stopStatusLabel(run: LedgerRun, stopReason: string | null) {
  if (stopReason) return stopReason;
  if (run.status === "scheduled_retry") return "Retry pending";
  if (run.status === "queued") return "Waiting to start";
  if (run.status === "running") return "Still running";
  if (!run.livenessState) return "Unavailable";
  return "No stop reason";
}

function lastUsefulActionLabel(run: LedgerRun) {
  if (run.status === "scheduled_retry") return "Waiting for next attempt";
  if (run.lastUsefulActionAt) return relativeTime(run.lastUsefulActionAt);
  if (isActiveRun(run)) return "No action recorded yet";
  if (run.livenessState === "plan_only" || run.livenessState === "needs_followup") {
    return "No concrete action";
  }
  if (run.livenessState === "empty_response") return "No useful output";
  if (!run.livenessState) return "Unavailable";
  return "None recorded";
}

function continuationLabel(run: LedgerRun) {
  if (!run.continuationAttempt || run.continuationAttempt <= 0) return null;
  return `Continuation attempt ${run.continuationAttempt}`;
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
}: IssueRunLedgerContentProps) {
  const ledgerRuns = useMemo(() => mergeRuns(runs, liveRuns, activeRun), [activeRun, liveRuns, runs]);
  const latestRun = ledgerRuns[0] ?? null;
  const children = childIssueSummary(childIssues);

  return (
    <section className="space-y-3" aria-label="Issue run ledger">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-muted-foreground">Run ledger</h3>
          <p className="text-xs text-muted-foreground">
            {latestRun
              ? runSummary(latestRun, agentMap)
              : issueStatus === "in_progress"
                ? "Waiting for the first run record."
                : "No runs linked yet."}
          </p>
        </div>
        {latestRun ? (
          <Link
            to={`/agents/${latestRun.agentId}/runs/${latestRun.runId}`}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Latest run
          </Link>
        ) : null}
      </div>

      {children.total > 0 ? (
        <div className="rounded-md border border-border/70 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-foreground">Child work</span>
            <span className="text-muted-foreground">
              {children.active.length > 0
                ? `${children.active.length} active, ${children.done} done, ${children.cancelled} cancelled`
                : `all ${children.total} terminal (${children.done} done, ${children.cancelled} cancelled)`}
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
                  +{children.active.length - 4} more
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {ledgerRuns.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
          Historical runs without liveness metadata will appear here once linked to this issue.
        </div>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border/70">
          {ledgerRuns.slice(0, 8).map((run) => {
            const liveness = livenessCopyForRun(run);
            const stopReason = stopReasonLabel(run);
            const duration = formatDuration(run.startedAt, run.finishedAt);
            const exhausted = hasExhaustedContinuation(run);
            const continuation = continuationLabel(run);
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
                      live
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
                      Exhausted
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
                    <span className="text-foreground">Elapsed</span>{" "}
                    {duration ?? "unknown"}
                  </div>
                  <div className="min-w-0">
                    <span className="text-foreground">Last useful action</span>{" "}
                    {lastUsefulActionLabel(run)}
                  </div>
                  <div className="min-w-0">
                    <span className="text-foreground">Stop</span>{" "}
                    {stopStatusLabel(run, stopReason)}
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
                    <span className="font-medium text-foreground">Next action: </span>
                    <span className="break-words text-muted-foreground">{run.nextAction}</span>
                  </div>
                ) : null}
              </article>
            );
          })}
          {ledgerRuns.length > 8 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {ledgerRuns.length - 8} older runs not shown
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
