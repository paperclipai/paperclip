import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionBlocker, Issue } from "@paperclipai/shared";
import { WorkspaceFileRecovery } from "./WorkspaceFileRecovery";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { Link } from "../lib/router";

export function ExecutionBlockerNotice({ companyId, issueId, issueStatus, canManage = false, blocker, onRetried, className }: {
  className?: string;
  companyId: string;
  issueId: string;
  issueStatus?: Issue["status"];
  canManage?: boolean;
  blocker: ExecutionBlocker;
  onRetried: () => void;
}) {
  const queryClient = useQueryClient();
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
  return (
    <div role="status" aria-label="Task recovery" className={cn("task-context-notice flex flex-wrap items-center justify-between gap-2", className)}>
      <div className="min-w-0 flex-1 break-words">
        <p>{modelRejected ? "Model unavailable." : "Recovery needed."}{blocker.runError ? ` ${blocker.runError}` : ""}</p>
        {modelRejected && <p>Choose a supported model or clear the task's model override, then retry.</p>}
        {blocker.workspaceRepairRequired ? (
          <>
            {/* The stored next action is an operator runbook step; lead with what happened. This hold also covers
                unsafe archives and local runs, so do not claim retries or a retained sandbox here. */}
            <p>
              Paperclip could not restore the agent's workspace files after its last run. A board operator must
              recover the files before the agent can continue.
            </p>
            <details>
              <summary className="cursor-pointer">Technical details</summary>
              <p>{blocker.nextAction}</p>
            </details>
          </>
        ) : <p>{blocker.nextAction}</p>}
        {Boolean(blocker.savedMessageCount) && (
          <p>{blocker.savedMessageCount} saved {blocker.savedMessageCount === 1 ? "message is" : "messages are"} waiting for recovery.</p>
        )}
      </div>
      {blocker.agentId && blocker.runId && (
        <Button variant="outline" size="sm" asChild>
          <Link to={`/agents/${blocker.agentId}/runs/${blocker.runId}`}>Inspect run</Link>
        </Button>
      )}
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
      {issueStatus && <WorkspaceFileRecovery key={`${blocker.recoveryActionId}:${blocker.runId}`} issueId={issueId}
        issueStatus={issueStatus} blocker={blocker} canManage={canManage} onRecorded={onRetried} />}
    </div>
  );
}
