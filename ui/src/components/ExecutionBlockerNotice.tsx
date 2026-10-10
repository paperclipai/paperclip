import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionBlocker } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { describeError } from "../api/errors";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Link } from "../lib/router";
import { QueryErrorState, useQueryView } from "./QueryView";

export function ExecutionBlockerNotice({ companyId, issueId, blocker, onRetried }: {
  companyId: string;
  issueId: string;
  blocker: ExecutionBlocker;
  onRetried: () => void;
}) {
  const queryClient = useQueryClient();
  const runsQuery = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });
  // Read the run list through the shared view: cached runs stay usable while a
  // transient refetch fails,and a no-data failure shows readable copy with Retry.

  const runsView = useQueryView(runsQuery);
  const failedRun = runsView.data?.find(run => run.runId === blocker.runId &&
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
    <div role="status" aria-label="Task recovery" className="mx-(--sz-execution-blocker-inline) my-(--sz-execution-blocker-block) flex flex-wrap items-center justify-between execution-blocker-notice border border-border bg-muted text-foreground">
      <div className="min-w-0 flex-1 break-words">
        <p>{modelRejected ? "Model unavailable." : "Recovery needed."}{blocker.runError ? ` ${blocker.runError}` : ""}</p>
        {modelRejected && <p>Choose a supported model or clear the task's model override, then retry.</p>}
        <p>{blocker.nextAction}</p>
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
      {retry.isError && ( // query-error-ok: mutation result
        <p role="alert" className="w-full text-destructive">{describeError(retry.error).body}</p>
      )}
      {runsView.kind === "error" && (
        <QueryErrorState
          size="inline"
          className="w-full"
          error={runsView.error}
          action="load run history"
          onRetry={runsView.retry}
          retrying={runsView.isFetching}
        />
      )}
    </div>
  );
}
