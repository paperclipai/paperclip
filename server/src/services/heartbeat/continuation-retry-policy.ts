import type { heartbeatRuns } from "@paperclipai/db";
import { classifyContinuationFailure } from "../recovery/service.js";
import { executionFailureRetryCount } from "../execution-recovery-attempt.js";

type Run = typeof heartbeatRuns.$inferSelect;

/** Keep automatic failure retries and the recovery sweeper on one durable budget. */
export function continuationFailureRetryOptions(run: Run) {
  const policy = classifyContinuationFailure(run);
  if (policy.kind !== "transient_infra") return undefined;
  return {
    maxAttempts: policy.maxAttempts,
    delayMs: Math.min(
      policy.baseBackoffMs * 2 ** executionFailureRetryCount(run),
      24 * 60 * 60 * 1000,
    ),
  };
}
