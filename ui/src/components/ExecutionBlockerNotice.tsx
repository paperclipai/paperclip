import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionBlocker } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Link } from "../lib/router";

export function ExecutionBlockerNotice({ companyId, issueId, blocker, onRetried }: {
  companyId: string;
  issueId: string;
  blocker: ExecutionBlocker;
  onRetried: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });
  const failedRun = runs?.find(run => run.runId === blocker.runId &&
    ["failed", "timed_out"].includes(run.status));
  const requiresInspection = blocker.cause === "native_continuation_requires_reconciliation";
  const retry = useMutation({
    mutationFn: () => agentsApi.retryFailedRun(failedRun!.agentId, failedRun!.runId, companyId),
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
      <span>{blocker.cause === "legacy_execution_requires_reconciliation"
        ? "Automatic recovery of this task stopped."
        : `${requiresInspection ? "Recovery needed. " : ""}${blocker.nextAction}`}</span>
      {requiresInspection && blocker.agentId && blocker.runId && (
        <Button variant="outline" size="sm" asChild>
          <Link to={`/agents/${blocker.agentId}/runs/${blocker.runId}`}>Inspect run</Link>
        </Button>
      )}
      {!requiresInspection && failedRun && (
        <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isPending ? "Retrying…" : "Retry"}
        </Button>
      )}
      {retry.isError && (
        <p role="alert" className="w-full text-destructive">{retry.error.message}</p>
      )}
    </div>
  );
}
