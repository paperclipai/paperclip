import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useNavigate, Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  agentsApi,
  type ClaudeLoginResult,
} from "../../api/agents";
import { heartbeatsApi } from "../../api/heartbeats";
import { activityApi } from "../../api/activity";
import { useSidebar } from "../../context/SidebarContext";
import { queryKeys } from "../../lib/queryKeys";
import { StatusBadge } from "../../components/StatusBadge";
import { CopyText } from "../../components/CopyText";
import { ScrollToBottom } from "../../components/ScrollToBottom";
import { formatTokens, relativeTime } from "../../lib/utils";
import { cn } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Timer,
  Loader2,
  Slash,
  RotateCcw,
  ChevronRight,
  ArrowLeft,
} from "lucide-react";
import type {
  HeartbeatRun,
} from "@paperclipai/shared";
import {
  runStatusIcons,
  sourceLabels,
  runMetrics,
  asRecord,
  asNonEmptyString,
  type ScrollContainer,
} from "./utils";
import LogViewer from "./LogViewer";

function RunListItem({ run, isSelected, agentId }: { run: HeartbeatRun; isSelected: boolean; agentId: string }) {
  const statusInfo = runStatusIcons[run.status] ?? { icon: Clock, color: "text-neutral-400" };
  const StatusIcon = statusInfo.icon;
  const metrics = runMetrics(run);
  const summary = run.resultJson
    ? String((run.resultJson as Record<string, unknown>).summary ?? (run.resultJson as Record<string, unknown>).result ?? "")
    : run.error ?? "";

  return (
    <Link
      to={isSelected ? `/agents/${agentId}/runs` : `/agents/${agentId}/runs/${run.id}`}
      className={cn(
        "flex flex-col gap-1 w-full px-3 py-2.5 text-left border-b border-border last:border-b-0 transition-colors no-underline text-inherit",
        isSelected ? "bg-accent/40" : "hover:bg-accent/20",
      )}
    >
      <div className="flex items-center gap-2">
        <StatusIcon className={cn("h-3.5 w-3.5 shrink-0", statusInfo.color, run.status === "running" && "animate-spin")} />
        <span className="font-mono text-xs text-muted-foreground">
          {run.id.slice(0, 8)}
        </span>
        <span className={cn(
          "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0",
          run.invocationSource === "timer" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
            : run.invocationSource === "assignment" ? "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"
            : run.invocationSource === "on_demand" ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300"
            : "bg-muted text-muted-foreground"
        )}>
          {sourceLabels[run.invocationSource] ?? run.invocationSource}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
          {relativeTime(run.createdAt)}
        </span>
      </div>
      {summary && (
        <span className="text-xs text-muted-foreground truncate pl-5.5">
          {summary.slice(0, 60)}
        </span>
      )}
      {(metrics.totalTokens > 0 || metrics.cost > 0) && (
        <div className="flex items-center gap-2 pl-5.5 text-[11px] text-muted-foreground tabular-nums">
          {metrics.totalTokens > 0 && <span>{formatTokens(metrics.totalTokens)} tok</span>}
          {metrics.cost > 0 && <span>${metrics.cost.toFixed(3)}</span>}
        </div>
      )}
    </Link>
  );
}

export function RunsTab({
  runs,
  companyId,
  agentId,
  agentRouteId,
  selectedRunId,
  adapterType,
}: {
  runs: HeartbeatRun[];
  companyId: string;
  agentId: string;
  agentRouteId: string;
  selectedRunId: string | null;
  adapterType: string;
}) {
  const { isMobile } = useSidebar();

  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }

  // Sort by created descending
  const sorted = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // On mobile, don't auto-select so the list shows first; on desktop, auto-select latest
  const effectiveRunId = isMobile ? selectedRunId : (selectedRunId ?? sorted[0]?.id ?? null);
  const selectedRun = sorted.find((r) => r.id === effectiveRunId) ?? null;

  // Mobile: show either run list OR run detail with back button
  if (isMobile) {
    if (selectedRun) {
      return (
        <div className="space-y-3 min-w-0 overflow-x-hidden">
          <Link
            to={`/agents/${agentRouteId}/runs`}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to runs
          </Link>
          <RunDetail key={selectedRun.id} run={selectedRun} agentRouteId={agentRouteId} adapterType={adapterType} />
        </div>
      );
    }
    return (
      <div className="border border-border rounded-lg overflow-x-hidden">
        {sorted.map((run) => (
          <RunListItem key={run.id} run={run} isSelected={false} agentId={agentRouteId} />
        ))}
      </div>
    );
  }

  // Desktop: side-by-side layout
  return (
    <div className="flex gap-0">
      {/* Left: run list — border stretches full height, content sticks */}
      <div className={cn(
        "shrink-0 border border-border rounded-lg",
        selectedRun ? "w-72" : "w-full",
      )}>
        <div className="sticky top-4 overflow-y-auto" style={{ maxHeight: "calc(100vh - 2rem)" }}>
        {sorted.map((run) => (
          <RunListItem key={run.id} run={run} isSelected={run.id === effectiveRunId} agentId={agentRouteId} />
        ))}
        </div>
      </div>

      {/* Right: run detail — natural height, page scrolls */}
      {selectedRun && (
        <div className="flex-1 min-w-0 pl-4">
          <RunDetail key={selectedRun.id} run={selectedRun} agentRouteId={agentRouteId} adapterType={adapterType} />
        </div>
      )}
    </div>
  );
}

/* ---- Run Detail (expanded) ---- */

export function RunDetail({ run: initialRun, agentRouteId, adapterType }: { run: HeartbeatRun; agentRouteId: string; adapterType: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: hydratedRun } = useQuery({
    queryKey: queryKeys.runDetail(initialRun.id),
    queryFn: () => heartbeatsApi.get(initialRun.id),
    enabled: Boolean(initialRun.id),
  });
  const run = hydratedRun ?? initialRun;
  const metrics = runMetrics(run);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [claudeLoginResult, setClaudeLoginResult] = useState<ClaudeLoginResult | null>(null);

  useEffect(() => {
    setClaudeLoginResult(null);
  }, [run.id]);

  const cancelRun = useMutation({
    mutationFn: () => heartbeatsApi.cancel(run.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.companyId, run.agentId) });
    },
  });
  const canResumeLostRun = run.errorCode === "process_lost" && run.status === "failed";
  const resumePayload = useMemo(() => {
    const payload: Record<string, unknown> = {
      resumeFromRunId: run.id,
    };
    const context = asRecord(run.contextSnapshot);
    if (!context) return payload;
    const issueId = asNonEmptyString(context.issueId);
    const taskId = asNonEmptyString(context.taskId);
    const taskKey = asNonEmptyString(context.taskKey);
    const commentId = asNonEmptyString(context.wakeCommentId) ?? asNonEmptyString(context.commentId);
    if (issueId) payload.issueId = issueId;
    if (taskId) payload.taskId = taskId;
    if (taskKey) payload.taskKey = taskKey;
    if (commentId) payload.commentId = commentId;
    return payload;
  }, [run.contextSnapshot, run.id]);
  const resumeRun = useMutation({
    mutationFn: async () => {
      const result = await agentsApi.wakeup(run.agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "resume_process_lost_run",
        payload: resumePayload,
      }, run.companyId);
      if (!("id" in result)) {
        throw new Error("Resume request was skipped because the agent is not currently invokable.");
      }
      return result;
    },
    onSuccess: (resumedRun) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.companyId, run.agentId) });
      navigate(`/agents/${agentRouteId}/runs/${resumedRun.id}`);
    },
  });

  const canRetryRun = run.status === "failed" || run.status === "timed_out";
  const retryPayload = useMemo(() => {
    const payload: Record<string, unknown> = {};
    const context = asRecord(run.contextSnapshot);
    if (!context) return payload;
    const issueId = asNonEmptyString(context.issueId);
    const taskId = asNonEmptyString(context.taskId);
    const taskKey = asNonEmptyString(context.taskKey);
    if (issueId) payload.issueId = issueId;
    if (taskId) payload.taskId = taskId;
    if (taskKey) payload.taskKey = taskKey;
    return payload;
  }, [run.contextSnapshot]);
  const retryRun = useMutation({
    mutationFn: async () => {
      const result = await agentsApi.wakeup(run.agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        payload: retryPayload,
      }, run.companyId);
      if (!("id" in result)) {
        throw new Error("Retry was skipped because the agent is not currently invokable.");
      }
      return result;
    },
    onSuccess: (newRun) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.companyId, run.agentId) });
      navigate(`/agents/${agentRouteId}/runs/${newRun.id}`);
    },
  });

  const { data: touchedIssues } = useQuery({
    queryKey: queryKeys.runIssues(run.id),
    queryFn: () => activityApi.issuesForRun(run.id),
  });
  const touchedIssueIds = useMemo(
    () => Array.from(new Set((touchedIssues ?? []).map((issue) => issue.issueId))),
    [touchedIssues],
  );

  const clearSessionsForTouchedIssues = useMutation({
    mutationFn: async () => {
      if (touchedIssueIds.length === 0) return 0;
      await Promise.all(touchedIssueIds.map((issueId) => agentsApi.resetSession(run.agentId, issueId, run.companyId)));
      return touchedIssueIds.length;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(run.agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(run.agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.runIssues(run.id) });
    },
  });

  const runClaudeLogin = useMutation({
    mutationFn: () => agentsApi.loginWithClaude(run.agentId, run.companyId),
    onSuccess: (data) => {
      setClaudeLoginResult(data);
    },
  });

  const isRunning = run.status === "running" && !!run.startedAt && !run.finishedAt;
  const [elapsedSec, setElapsedSec] = useState<number>(() => {
    if (!run.startedAt) return 0;
    return Math.max(0, Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000));
  });

  useEffect(() => {
    if (!isRunning || !run.startedAt) return;
    const startMs = new Date(run.startedAt).getTime();
    setElapsedSec(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
    const id = setInterval(() => {
      setElapsedSec(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [isRunning, run.startedAt]);

  const timeFormat: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
  const startTime = run.startedAt ? new Date(run.startedAt).toLocaleTimeString("en-US", timeFormat) : null;
  const endTime = run.finishedAt ? new Date(run.finishedAt).toLocaleTimeString("en-US", timeFormat) : null;
  const durationSec = run.startedAt && run.finishedAt
    ? Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
    : null;
  const displayDurationSec = durationSec ?? (isRunning ? elapsedSec : null);
  const hasMetrics = metrics.input > 0 || metrics.output > 0 || metrics.cached > 0 || metrics.cost > 0;
  const hasSession = !!(run.sessionIdBefore || run.sessionIdAfter);
  const sessionChanged = run.sessionIdBefore && run.sessionIdAfter && run.sessionIdBefore !== run.sessionIdAfter;
  const sessionId = run.sessionIdAfter || run.sessionIdBefore;
  const hasNonZeroExit = run.exitCode !== null && run.exitCode !== 0;

  return (
    <div className="space-y-4 min-w-0">
      {/* Run summary card */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="flex flex-col sm:flex-row">
          {/* Left column: status + timing */}
          <div className="flex-1 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <StatusBadge status={run.status} />
              {(run.status === "running" || run.status === "queued") && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive text-xs h-6 px-2"
                  onClick={() => cancelRun.mutate()}
                  disabled={cancelRun.isPending}
                >
                  {cancelRun.isPending ? "Cancelling…" : "Cancel"}
                </Button>
              )}
              {canResumeLostRun && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-6 px-2"
                  onClick={() => resumeRun.mutate()}
                  disabled={resumeRun.isPending}
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                  {resumeRun.isPending ? "Resuming…" : "Resume"}
                </Button>
              )}
              {canRetryRun && !canResumeLostRun && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-6 px-2"
                  onClick={() => retryRun.mutate()}
                  disabled={retryRun.isPending}
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                  {retryRun.isPending ? "Retrying…" : "Retry"}
                </Button>
              )}
            </div>
            {resumeRun.isError && (
              <div className="text-xs text-destructive">
                {resumeRun.error instanceof Error ? resumeRun.error.message : "Failed to resume run"}
              </div>
            )}
            {retryRun.isError && (
              <div className="text-xs text-destructive">
                {retryRun.error instanceof Error ? retryRun.error.message : "Failed to retry run"}
              </div>
            )}
            {startTime && (
              <div className="space-y-0.5">
                <div className="text-sm font-mono">
                  {startTime}
                  {endTime && <span className="text-muted-foreground"> &rarr; </span>}
                  {endTime}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {relativeTime(run.startedAt!)}
                  {run.finishedAt && <> &rarr; {relativeTime(run.finishedAt)}</>}
                </div>
                {displayDurationSec !== null && (
                  <div className="text-xs text-muted-foreground">
                    Duration: {displayDurationSec >= 60 ? `${Math.floor(displayDurationSec / 60)}m ${displayDurationSec % 60}s` : `${displayDurationSec}s`}
                  </div>
                )}
              </div>
            )}
            {run.error && (
              <div className="text-xs">
                <span className="text-red-600 dark:text-red-400">{run.error}</span>
                {run.errorCode && <span className="text-muted-foreground ml-1">({run.errorCode})</span>}
              </div>
            )}
            {run.errorCode === "claude_auth_required" && adapterType === "claude_local" && (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => runClaudeLogin.mutate()}
                  disabled={runClaudeLogin.isPending}
                >
                  {runClaudeLogin.isPending ? "Running claude login..." : "Login to Claude Code"}
                </Button>
                {runClaudeLogin.isError && (
                  <p className="text-xs text-destructive">
                    {runClaudeLogin.error instanceof Error
                      ? runClaudeLogin.error.message
                      : "Failed to run Claude login"}
                  </p>
                )}
                {claudeLoginResult?.loginUrl && (
                  <p className="text-xs">
                    Login URL:
                    <a
                      href={claudeLoginResult.loginUrl}
                      className="text-blue-600 underline underline-offset-2 ml-1 break-all dark:text-blue-400"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {claudeLoginResult.loginUrl}
                    </a>
                  </p>
                )}
                {claudeLoginResult && (
                  <>
                    {!!claudeLoginResult.stdout && (
                      <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap">
                        {claudeLoginResult.stdout}
                      </pre>
                    )}
                    {!!claudeLoginResult.stderr && (
                      <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-red-700 dark:text-red-300 overflow-x-auto whitespace-pre-wrap">
                        {claudeLoginResult.stderr}
                      </pre>
                    )}
                  </>
                )}
              </div>
            )}
            {hasNonZeroExit && (
              <div className="text-xs text-red-600 dark:text-red-400">
                Exit code {run.exitCode}
                {run.signal && <span className="text-muted-foreground ml-1">(signal: {run.signal})</span>}
              </div>
            )}
          </div>

          {/* Right column: metrics */}
          {hasMetrics && (
            <div className="border-t sm:border-t-0 sm:border-l border-border p-4 grid grid-cols-2 gap-x-4 sm:gap-x-8 gap-y-3 content-center tabular-nums">
              <div>
                <div className="text-xs text-muted-foreground">Input</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.input)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Output</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.output)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cached</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.cached)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cost</div>
                <div className="text-sm font-medium font-mono">{metrics.cost > 0 ? `$${metrics.cost.toFixed(4)}` : "-"}</div>
              </div>
            </div>
          )}
        </div>

        {/* Collapsible session row */}
        {hasSession && (
          <div className="border-t border-border">
            <button
              className="flex items-center gap-1.5 w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setSessionOpen((v) => !v)}
            >
              <ChevronRight className={cn("h-3 w-3 transition-transform", sessionOpen && "rotate-90")} />
              Session
              {sessionChanged && <span className="text-yellow-400 ml-1">(changed)</span>}
            </button>
            {sessionOpen && (
              <div className="px-4 pb-3 space-y-1 text-xs">
                {run.sessionIdBefore && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-12">{sessionChanged ? "Before" : "ID"}</span>
                    <CopyText text={run.sessionIdBefore} className="font-mono" />
                  </div>
                )}
                {sessionChanged && run.sessionIdAfter && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-12">After</span>
                    <CopyText text={run.sessionIdAfter} className="font-mono" />
                  </div>
                )}
                {touchedIssueIds.length > 0 && (
                  <div className="pt-1">
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-60"
                      disabled={clearSessionsForTouchedIssues.isPending}
                      onClick={() => {
                        const issueCount = touchedIssueIds.length;
                        const confirmed = window.confirm(
                          `Clear session for ${issueCount} issue${issueCount === 1 ? "" : "s"} touched by this run?`,
                        );
                        if (!confirmed) return;
                        clearSessionsForTouchedIssues.mutate();
                      }}
                    >
                      {clearSessionsForTouchedIssues.isPending
                        ? "clearing session..."
                        : "clear session for these issues"}
                    </button>
                    {clearSessionsForTouchedIssues.isError && (
                      <p className="text-[11px] text-destructive mt-1">
                        {clearSessionsForTouchedIssues.error instanceof Error
                          ? clearSessionsForTouchedIssues.error.message
                          : "Failed to clear sessions"}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Issues touched by this run */}
      {touchedIssues && touchedIssues.length > 0 && (
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">Issues Touched ({touchedIssues.length})</span>
          <div className="border border-border rounded-lg divide-y divide-border">
            {touchedIssues.map((issue) => (
              <Link
                key={issue.issueId}
                to={`/issues/${issue.identifier ?? issue.issueId}`}
                className="flex items-center justify-between w-full px-3 py-2 text-xs hover:bg-accent/20 transition-colors text-left no-underline text-inherit"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <StatusBadge status={issue.status} />
                  <span className="truncate">{issue.title}</span>
                </div>
                <span className="font-mono text-muted-foreground shrink-0 ml-2">{issue.identifier ?? issue.issueId.slice(0, 8)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* stderr excerpt for failed runs */}
      {run.stderrExcerpt && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-red-600 dark:text-red-400">stderr</span>
          <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-red-700 dark:text-red-300 overflow-x-auto whitespace-pre-wrap">{run.stderrExcerpt}</pre>
        </div>
      )}

      {/* stdout excerpt when no log is available */}
      {run.stdoutExcerpt && !run.logRef && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">stdout</span>
          <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap">{run.stdoutExcerpt}</pre>
        </div>
      )}

      {/* Log viewer */}
      <LogViewer run={run} adapterType={adapterType} />
      <ScrollToBottom />
    </div>
  );
}
