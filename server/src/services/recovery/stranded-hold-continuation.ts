import { continuesAutomatically, isSetupFailureBeforeProviderWork } from "../continuation-cause.js";
import { STALE_BLOCK_MS } from "./assigned-work-invariant.js";

export const STRANDED_CONTINUATION_MAX_AGE_MS = 24 * 60 * 60_000;
/**
 * A task blocked by a setup failure before any provider work never started,
 * so continuing it days later repeats nothing: it stays eligible for as long
 * as the sweep continues blocks at all (STALE_BLOCK_MS), so tasks blocked
 * before a release that fixed the cause continue after its deploy.
 */
export const STRANDED_PRE_PROVIDER_SETUP_MAX_AGE_MS = STALE_BLOCK_MS;
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
  const maxAge = isSetupFailureBeforeProviderWork({ errorCode: run.errorCode, resultJson: { executionRecovery: run.executionRecovery } })
    ? STRANDED_PRE_PROVIDER_SETUP_MAX_AGE_MS : STRANDED_CONTINUATION_MAX_AGE_MS;
  if (now.getTime() - run.finishedAt.getTime() > maxAge) return false;
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
