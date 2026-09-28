import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionBlocker, ExecutionReconciliation } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Link } from "../lib/router";

const ACTION_OUTCOMES: Array<{ value: ExecutionReconciliation["actionOutcome"]; label: string }> = [
  { value: "not_performed", label: "It did not perform the recorded action" },
  { value: "completed", label: "It completed the recorded action" },
  { value: "mixed", label: "It partly performed the recorded action" },
];

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
  // A settled automatic no-replay hold keeps parking every wake and is not the
  // issue's active recovery action, so the recovery card never shows it. Read the
  // projection that names the record the blocker references, otherwise the
  // operator sees a stopped task with nothing to resolve.
  const { data: recovery } = useQuery({
    queryKey: queryKeys.issues.recoveryActions(issueId),
    queryFn: () => issuesApi.recoveryActions(issueId),
  });
  const settledHoldId = recovery?.referencedByExecutionBlocker ?? null;
  const settledHold = settledHoldId && settledHoldId === blocker.recoveryActionId
    ? recovery?.actions.find(action => action.id === settledHoldId) ?? null
    : null;
  const failedRun = runs?.find(run => run.runId === blocker.runId &&
    ["failed", "timed_out"].includes(run.status));
  const requiresInspection = blocker.cause === "native_continuation_requires_reconciliation" ||
    blocker.cause === "native_session_cleanup_quarantined";
  // `resolvable` is the server's release predicate, so a hold it would refuse
  // (an unsafe workspace archive) never gets a control that only looks like it
  // works. The resolution carries the reconciliation of the recorded run, so the
  // form needs that run's id.
  const settledHoldRunId = recovery?.referencedByExecutionBlockerResolvable
    ? blocker.runId
    : null;
  const settledHoldAction = settledHoldRunId ? settledHold : null;
  const [providerStopped, setProviderStopped] = useState(false);
  const [actionOutcome, setActionOutcome] =
    useState<ExecutionReconciliation["actionOutcome"]>("not_performed");
  const [outcomeEvidence, setOutcomeEvidence] = useState("");
  const refresh = () => {
    onRetried();
    for (const queryKey of [queryKeys.issues.detail(issueId), queryKeys.issues.runs(issueId),
      queryKeys.issues.liveRuns(issueId), queryKeys.issues.activeRun(issueId),
      queryKeys.issues.recoveryActions(issueId)]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
  const retry = useMutation({
    mutationFn: () => agentsApi.retryFailedRun(failedRun!.agentId, failedRun!.runId, companyId),
    onSuccess: refresh,
  });
  // Resolving the settled action the blocker references releases the hold and
  // resumes the task. The reconciling decision is the operator's: the server
  // still checks the stopped run and its process before it accepts it.
  const resolveSettledHold = useMutation({
    mutationFn: (actionId: string) => issuesApi.resolveRecoveryAction(issueId, {
      actionId,
      outcome: "restored",
      sourceIssueStatus: "todo",
      executionReconciliation: {
        runId: settledHoldRunId!,
        providerStopped: true,
        actionOutcome,
        outcomeEvidence: outcomeEvidence.trim(),
      },
    }),
    onSuccess: refresh,
  });
  return (
    <>
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
      {/* The hold that parks every wake is its own fact with its own operator
          decision, so it is reported next to the notice rather than folded into
          it: the notice stays the statement of what the recorded run did. Both
          controls stay available, because a retry of the recorded run is
          deferred by this same hold. */}
      {settledHoldAction && (
        <div role="status" aria-label="Settled execution hold" className="mx-(--sz-execution-blocker-inline) my-(--sz-execution-blocker-block) flex flex-wrap items-center justify-between execution-blocker-notice border border-border bg-muted text-foreground">
          <p className="w-full text-muted-foreground">
            {`Settled recovery action (${settledHoldAction.cause}) still holds this task. Reconcile the stopped run to resume it.`}
          </p>
          <div className="mt-2 flex w-full flex-wrap items-center gap-2">
            <select
              aria-label="Recorded action outcome"
              className="rounded border border-border bg-background px-2 py-1 text-sm"
              value={actionOutcome}
              onChange={(event) => setActionOutcome(event.target.value as ExecutionReconciliation["actionOutcome"])}
            >
              {ACTION_OUTCOMES.map((outcome) => (
                <option key={outcome.value} value={outcome.value}>{outcome.label}</option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                aria-label="The stopped run has no live provider process"
                checked={providerStopped}
                onChange={(event) => setProviderStopped(event.target.checked)}
              />
              The stopped run has no live process
            </label>
            <input
              type="text"
              aria-label="Verified reconciliation evidence"
              className="min-w-48 flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
              placeholder="What proves the recorded outcome?"
              value={outcomeEvidence}
              onChange={(event) => setOutcomeEvidence(event.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!providerStopped || outcomeEvidence.trim().length === 0 || resolveSettledHold.isPending}
              onClick={() => resolveSettledHold.mutate(settledHoldAction.id)}
            >
              {resolveSettledHold.isPending ? "Resolving…" : "Resolve recovery"}
            </Button>
          </div>
          {resolveSettledHold.isError && (
            <p role="alert" className="w-full text-destructive">{resolveSettledHold.error.message}</p>
          )}
        </div>
      )}
    </>
  );
}
