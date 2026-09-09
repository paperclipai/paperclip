import { useRef, useState } from "react";
import { requiresExecutionReconciliation } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { ExecutionReconciliationDialog } from "@/components/ExecutionReconciliationDialog";
import type { ExecutionProjection } from "@paperclipai/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Loader2 } from "lucide-react";
import { heartbeatsApi } from "@/api/heartbeats";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Link } from "@/lib/router";

export function ExecutionStatus({
  execution,
  runHref,
  onInspect,
}: {
  execution: ExecutionProjection;
  runHref?: string;
  onInspect?: () => void;
}) {
  const moving = ["working", "reconnecting", "finishing"].includes(
    execution.phase,
  );
  return (
    <Card
      className="gap-2 px-3 py-3"
      role="status"
      aria-live="polite"
      data-execution-phase={execution.phase}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          {moving ? (
            <Loader2
              className="size-4 shrink-0 motion-safe:animate-spin"
              aria-hidden
            />
          ) : execution.phase === "recovery_needed" ? (
            <CircleAlert
              className="size-4 shrink-0 text-destructive"
              aria-hidden
            />
          ) : null}
          <span>{execution.label}</span>
        </div>
        {execution.recoveryOwner ? (
          <span className="text-xs text-muted-foreground">
            Attempt {execution.attempt} of {execution.maxAttempts}
          </span>
        ) : null}
      </div>
      {execution.nextAction ? (
        <p className="break-words text-sm text-muted-foreground">
          {execution.nextAction}
        </p>
      ) : null}
      {execution.retryAt &&
      ["retry_scheduled", "reconnecting"].includes(execution.phase) ? (
        <p className="text-xs text-muted-foreground">
          Retry scheduled for{" "}
          <time dateTime={execution.retryAt}>
            {new Date(execution.retryAt).toLocaleTimeString()}
          </time>
        </p>
      ) : null}
      {onInspect || runHref ? (
        <div className="flex justify-end">
          {onInspect ? (
            <Button variant="outline" size="sm" onClick={onInspect}>
              Inspect run
            </Button>
          ) : (
            <Button variant="outline" size="sm" asChild>
              <Link to={runHref!}>Inspect run</Link>
            </Button>
          )}
        </div>
      ) : null}
    </Card>
  );
}

export function IssueExecutionStatus({ issueId }: { issueId: string }) {
  const reconcileButton = useRef<HTMLButtonElement>(null);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["issues", issueId, "execution"],
    queryFn: () => heartbeatsApi.executionForIssue(issueId),
    refetchInterval: 15_000,
  });
  if (query.isError)
    return (
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>Execution status is unavailable.</span>
        <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  if (
    !query.data?.execution ||
    ["completed", "queued"].includes(query.data.execution.phase)
  )
    return null;
  const action = query.data.recoveryAction;
  const sourceRunId = action?.evidence.runId ?? action?.evidence.sourceRunId;
  return (
    <div className="space-y-2">
      <ExecutionStatus
        execution={query.data.execution}
        runHref={`/agents/${query.data.agentId}/runs/${query.data.runId}`}
      />
      {action &&
      requiresExecutionReconciliation(action.cause) &&
      typeof sourceRunId === "string" ? (
        <>
          <div className="flex justify-end">
            <Button
              ref={reconcileButton}
              variant="outline"
              size="sm"
              onClick={() => setReconcileOpen(true)}
            >
              Reconcile and continue
            </Button>
          </div>
          <ExecutionReconciliationDialog
            key={sourceRunId}
            returnFocusRef={reconcileButton}
            open={reconcileOpen}
            onOpenChange={setReconcileOpen}
            runId={sourceRunId}
            nextAction={action.nextAction}
            onSubmit={async (decision) => {
              await issuesApi.resolveRecoveryAction(issueId, {
                actionId: action.id,
                outcome: "restored",
                sourceIssueStatus: "todo",
                executionReconciliation: decision,
                resolutionNote: decision.outcomeEvidence,
              });
              // Close and restore focus before refreshed data removes the trigger.
              void client.invalidateQueries({ queryKey: ["issues"] });
            }}
          />
        </>
      ) : null}
    </div>
  );
}
