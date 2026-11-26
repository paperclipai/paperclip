import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { ExecutionBlocker, Issue } from "@paperclipai/shared";
import { WorkspaceReconstructionRecovery } from "./WorkspaceReconstructionRecovery";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { Link } from "../lib/router";
import { deriveRecoveryDisplayState } from "../lib/recovery-display";
import { readRecoveryRetryLineage } from "../lib/recovery-lineage";
import { useSecondTick } from "../hooks/useSecondTick";

export function ExecutionBlockerNotice({ companyId, issueId, issueStatus, canManage = false, canRecover = canManage, blocker, onRetried, className }: {
  className?: string;
  companyId: string;
  issueId: string;
  issueStatus?: Issue["status"];
  canManage?: boolean;
  canRecover?: boolean;
  blocker: ExecutionBlocker;
  onRetried: () => void;
}) {
  const queryClient = useQueryClient();
  const recoveryRequestKey = useRef<string | null>(null);
  const { data: recovery, error: recoveryError } = useQuery({
    queryKey: queryKeys.issues.recoveryActions(issueId, blocker.recoveryActionId ?? null, blocker.runId ?? null),
    queryFn: () => issuesApi.recoveryActions(issueId),
    enabled: Boolean(blocker.recoveryActionId) && !["done", "cancelled"].includes(issueStatus ?? ""),
    refetchInterval: 5_000,
  });
  const hold = recovery?.actions.find(action => action.id === blocker.recoveryActionId &&
    (action.evidence.runId ?? action.evidence.sourceRunId) === blocker.runId);
  const replayBlocked = (hold?.evidence.automaticRecovery as { replay?: unknown } | undefined)?.replay === "blocked";
  const { data: runs, error: runsError } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });
  const failedRun = runs?.find(run => run.runId === blocker.runId &&
    ["failed", "timed_out"].includes(run.status));
  const modelRejected = failedRun?.errorCode === "native_provider_model_rejected";
  const requiresInspection = blocker.cause === "native_continuation_requires_reconciliation" ||
    blocker.cause === "native_session_cleanup_quarantined";
  const retry = useMutation({
    mutationFn: () => agentsApi.retryFailedRun(blocker.agentId!, blocker.runId!, companyId),
    onSuccess: () => {
      onRetried();
      for (const queryKey of [queryKeys.issues.detail(issueId), queryKeys.issues.runs(issueId),
        queryKeys.issues.liveRuns(issueId), queryKeys.issues.activeRun(issueId)]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
  const repair = useMutation({
    mutationFn: () => {
      recoveryRequestKey.current ??= crypto.randomUUID();
      return issuesApi.recoverWorkspace(issueId, { actionId: blocker.recoveryActionId!, runId: blocker.runId!,
        idempotencyKey: recoveryRequestKey.current });
    },
    onSuccess: () => {
      recoveryRequestKey.current = null;
      onRetried();
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.recoveryActions(issueId, blocker.recoveryActionId, blocker.runId) });
    },
  });
  useEffect(() => {
    if (recovery) void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
  }, [recovery, queryClient, issueId]);
  const workspaceRecovery = blocker.workspaceRecovery;
  const repairing = workspaceRecovery?.status === "queued" || workspaceRecovery?.status === "recovering";
  const now = Date.now();
  const lineage = hold ? readRecoveryRetryLineage(hold, { now }) : null;
  const recovering = Boolean(!recoveryError && !runsError && hold && !replayBlocked &&
    deriveRecoveryDisplayState(hold, { now }) === "in_progress" && lineage?.hasDurablePath);
  // Identical poll responses do not render again. Recheck a scheduled path's
  // expiry with the shared clock, and stop ticking once it expires or starts.
  useSecondTick(Boolean(recovering && lineage?.nextRetryAt && !lineage.liveRunId));
  if (recovering && !workspaceRecovery) return null;
  const hasDetails = Boolean(blocker.runError || (blocker.workspaceRepairRequired && blocker.nextAction) ||
    (canManage && hold && (replayBlocked || hold.resolutionNote)));
  return (
    <div role="status" aria-label="Task recovery" className={cn("task-context-notice flex flex-wrap items-center justify-between gap-2", className)}>
      <div className="min-w-0 flex-1 break-words">
        <p className="font-medium">{repairing ? "Recovering saved work…" : workspaceRecovery?.status === "blocked" ? "Recovery needs attention." : blocker.workspaceReconstructionPending ? "Continuation queued." : modelRejected ? "Model unavailable." : "Work paused."}</p>
        {modelRejected && <p>Choose a supported model or clear the task's model override, then retry.</p>}
        {workspaceRecovery ? (
          repairing ? Boolean(blocker.savedMessageCount) && <p>Your message is saved and will continue after recovery.</p>
            : <p>{workspaceRecovery.message}</p>
        ) : blocker.workspaceReconstructionPending ? <p>{blocker.nextAction}</p> : blocker.workspaceRepairRequired ? (
          <p>Paperclip must recover the saved workspace before work can continue.</p>
        ) : <p>{blocker.nextAction}</p>}
        {!workspaceRecovery && Boolean(blocker.savedMessageCount) && (
          <p>{blocker.savedMessageCount} saved {blocker.savedMessageCount === 1 ? "message is" : "messages are"} waiting for recovery.</p>
        )}
        {workspaceRecovery && !repairing && !workspaceRecovery.canRetry && Boolean(blocker.savedMessageCount) && (
          <p>Your message is saved.</p>
        )}
      </div>
      {blocker.agentId && blocker.runId && (
        <Button variant="outline" size="sm" asChild>
          <Link to={`/agents/${blocker.agentId}/runs/${blocker.runId}`}>Inspect run</Link>
        </Button>
      )}
      {canRecover && workspaceRecovery?.canRetry && blocker.recoveryActionId && blocker.runId && (
        <Button size="sm" disabled={repair.isPending} onClick={() => repair.mutate()}>
          {repair.isPending ? "Queuing recovery…" : "Retry recovery"}
        </Button>
      )}
      {repair.isError && <p role="alert" className="w-full text-destructive">{repair.error.message}</p>}
      {!blocker.workspaceRepairRequired && (!requiresInspection || blocker.canRetry) && blocker.agentId && blocker.runId &&
        ((blocker.cause === "legacy_execution_requires_reconciliation" && failedRun) || blocker.canContinue || blocker.canRetry) && (
        <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isPending ? "Starting…" : blocker.canContinue ? "Continue" : "Retry"}
        </Button>
      )}
      {retry.isError && (
        <p role="alert" className="w-full text-destructive">{retry.error.message}</p>
      )}
      {runsError && <p role="alert" className="w-full text-destructive">{runsError.message}</p>}
      {hasDetails && <details className="w-full text-muted-foreground">
        <summary className="cursor-pointer">Recovery details</summary>
        {blocker.runError && <p className="break-words">{blocker.runError}</p>}
        {!blocker.workspaceRepairRequired && <p>{blocker.nextAction}</p>}
        {canManage && replayBlocked &&
          <p>Paperclip stopped automatic retries to avoid repeating work with an unknown outcome. Inspect the run before requesting continuation.</p>}
        {canManage && hold?.resolutionNote && <p>{hold.resolutionNote}</p>}
      </details>}
      {recoveryError && <p role="alert" className="w-full text-destructive">Unable to load recovery details: {recoveryError.message}</p>}
      {blocker.canReconstructWorkspace && <WorkspaceReconstructionRecovery key={`reconstruct:${blocker.recoveryActionId}:${blocker.runId}`}
        issueId={issueId} blocker={blocker} canManage={canManage} onRecorded={onRetried} />}
    </div>
  );
}
