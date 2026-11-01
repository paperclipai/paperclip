import { useMutation } from "@tanstack/react-query";
import { ENVIRONMENT_LEASE_POLICIES, WORKSPACE_SOURCE_VERIFICATION_REASONS } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { Button } from "./ui/button";
import { formatDateTime } from "../lib/utils";

function recordedFailure(evidence: Record<string, unknown>): string {
  const recovery = evidence.systemRecovery;
  if (!recovery || typeof recovery !== "object" || !("failure" in recovery)) return "No recorded system recovery failure.";
  const failure = recovery.failure;
  if (!failure || typeof failure !== "object" || !("code" in failure) || typeof failure.code !== "string")
    return "No recorded system recovery failure.";
  const detail = "sourceVerification" in failure ? failure.sourceVerification : null;
  if (!detail || typeof detail !== "object" || !("reason" in detail) || typeof detail.reason !== "string" ||
    !(WORKSPACE_SOURCE_VERIFICATION_REASONS as readonly string[]).includes(detail.reason)) return failure.code;
  const policy = "observedLeasePolicy" in detail ? detail.observedLeasePolicy : null;
  const allowedPolicy = typeof policy === "string" &&
    (policy === "unrecognized" || (ENVIRONMENT_LEASE_POLICIES as readonly string[]).includes(policy));
  return [failure.code, detail.reason, ...(allowedPolicy ? [`lease policy ${policy}`] : [])].join(" · ");
}

export function RunWorkspaceSourceInspection({ issueId, runId }: { issueId: string; runId: string }) {
  const listing = useMutation({ mutationFn: () => issuesApi.recoveryActions(issueId, { runId }) });
  const inspection = useMutation({ mutationFn: (actionId: string) => issuesApi.recoveryActions(issueId, { runId, actionId }) });
  const pending = listing.isPending || inspection.isPending;
  const error = listing.error ?? inspection.error;
  const current = inspection.data?.sourceInspection;
  return (
    <div className="space-y-2" data-testid="run-workspace-source-inspection">
      <Button variant="outline" size="sm" disabled={pending} onClick={() => { inspection.reset(); listing.mutate(); }}>
        {pending ? "Inspecting recovery…" : "Inspect recovery"}
      </Button>
      {error ? <p role="alert" className="text-xs text-destructive">
        {error instanceof Error ? error.message : "Recovery inspection failed. Try inspecting again."}
      </p> : null}
      {listing.data?.actions.length === 0 ? <p className="text-xs text-muted-foreground">No recorded recovery action for this run.</p> : null}
      {listing.data?.actions.map(action => (
        <div key={action.id} className="space-y-2 text-xs">
          <p>Recorded failure: <code className="font-mono">{recordedFailure(action.evidence)}</code></p>
          <p className="font-mono text-muted-foreground">{action.id} · {action.status}</p>
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => inspection.mutate(action.id)}>
            Inspect current source
          </Button>
        </div>
      ))}
      {current ? <div className="space-y-2 text-xs" role="status">
        <p className="font-medium">Current recorded-source identity</p>
        <p className="font-mono text-muted-foreground">Action {current.actionId}</p>
        <p className="text-muted-foreground">This read-only observation checks recorded identity. It does not confirm provider termination, local files, or successful preservation.</p>
        {current.status === "verified" ? <p>Recorded-source identity verified.</p>
          : current.status === "not_inspected" ? <p>Source not inspected: this record exceeds the inspection limit. Service attention is required.</p>
          : <p>Blocked: <code className="font-mono">{current.sourceVerification?.reason ?? current.failureCode}</code>
            {current.sourceVerification?.observedLeasePolicy ? <> · lease policy <code className="font-mono">{current.sourceVerification.observedLeasePolicy}</code></> : null}</p>}
        <p className="font-mono text-muted-foreground">Observed {formatDateTime(current.observedAt)}</p>
      </div> : null}
    </div>
  );
}
