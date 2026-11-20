import { continuesAutomatically } from "../continuation-cause.js";

export const STRANDED_CONTINUATION_MAX_AGE_MS = 24 * 60 * 60_000;
export const STRANDED_KIND = "stranded_assigned_issue";

export type StrandedHoldRun = {
  agentId: string;
  status: string;
  errorCode: string | null;
  error: string | null;
  finishedAt: Date | null;
  executionRecovery: { kind?: unknown; providerWorkStarted?: unknown } | null;
  retryOfRunId?: string | null;
  scheduledRetryReason?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
  runnerProfileJson?: unknown;
};

export function strandedHoldContinuesAutomatically(
  hold: { kind: string; ownerType: string },
  run: StrandedHoldRun | null,
  assigneeAgentId: string | null,
  now: Date,
): boolean {
  if (hold.kind !== STRANDED_KIND || hold.ownerType !== "board") return false;
  if (!run || !assigneeAgentId || run.agentId !== assigneeAgentId || !run.finishedAt) return false;
  if (now.getTime() - run.finishedAt.getTime() > STRANDED_CONTINUATION_MAX_AGE_MS) return false;
  return strandedRunCauseIsTemporary(run);
}

export function strandedRunCauseIsTemporary(
  run: Pick<StrandedHoldRun, "status" | "errorCode" | "error" | "executionRecovery" | "retryOfRunId" | "scheduledRetryReason"
    | "contextSnapshot" | "runnerProfileJson">,
): boolean {
  return continuesAutomatically({ status: run.status, errorCode: run.errorCode, error: run.error,
    retryOfRunId: run.retryOfRunId ?? null, scheduledRetryReason: run.scheduledRetryReason ?? null,
    contextSnapshot: run.contextSnapshot ?? null, runnerProfileJson: run.runnerProfileJson,
    resultJson: { executionRecovery: run.executionRecovery } });
}
