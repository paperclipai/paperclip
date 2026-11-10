import type { Db } from "@paperclipai/db";
import { readNativeLocalProcessStop } from "../native-local-process-stop.js";
import { NATIVE_PROVIDER_RECOVERY_ATTEMPT_LIMIT } from "./native-restart-recovery.js";

export type ScheduledResumeContinuationRefusal =
  | "restart_recovery_claim"
  | "remote_target"
  | "not_a_scheduled_same_run_resume"
  | "not_an_exact_checkpoint_resume"
  | "failure_not_recoverable"
  | "provider_session_not_established"
  | "checkpoint_missing"
  | "replacement_recorded"
  | "attempt_not_admitted"
  | "local_stop_unverified";

export interface ScheduledResumeContinuationEvidence {
  restartRecovery: boolean;
  targetKind: "local" | "remote";
  coordinatorPhase: string | null;
  failureDetail: Record<string, unknown> | null | undefined;
  admittedAttempt: number;
  localStop: { processPid: number } | null;
}

export type ScheduledResumeContinuationDecision =
  | { allowed: true }
  | { allowed: false; reason: ScheduledResumeContinuationRefusal };

export function decideScheduledResumeContinuation(
  evidence: ScheduledResumeContinuationEvidence,
): ScheduledResumeContinuationDecision {
  const refuse = (reason: ScheduledResumeContinuationRefusal) => ({ allowed: false as const, reason });
  if (evidence.restartRecovery) return refuse("restart_recovery_claim");
  if (evidence.targetKind !== "local") return refuse("remote_target");
  if (evidence.coordinatorPhase !== "retryable_failure") return refuse("not_a_scheduled_same_run_resume");
  const detail = evidence.failureDetail ?? {};
  if (detail.recoveryMode !== "exact_checkpoint_resume") return refuse("not_an_exact_checkpoint_resume");
  if (detail.recoverable !== true) return refuse("failure_not_recoverable");
  if (detail.providerSessionEstablished !== true) return refuse("provider_session_not_established");
  if (detail.checkpointExists !== true) return refuse("checkpoint_missing");
  if (detail.successorRunId || detail.replacementDenied) return refuse("replacement_recorded");
  if (!Number.isSafeInteger(evidence.admittedAttempt) || evidence.admittedAttempt < 1
    || evidence.admittedAttempt > NATIVE_PROVIDER_RECOVERY_ATTEMPT_LIMIT) return refuse("attempt_not_admitted");
  if (!evidence.localStop) return refuse("local_stop_unverified");
  return { allowed: true };
}

export async function scheduledResumeContinuationAllowed(
  db: Db,
  input: Omit<ScheduledResumeContinuationEvidence, "localStop"> & { companyId: string; runId: string },
): Promise<ScheduledResumeContinuationDecision> {
  const { companyId, runId, ...evidence } = input;
  const localStop = evidence.restartRecovery || evidence.targetKind !== "local"
    ? null : await readNativeLocalProcessStop(db, companyId, runId);
  return decideScheduledResumeContinuation({ ...evidence, localStop });
}
