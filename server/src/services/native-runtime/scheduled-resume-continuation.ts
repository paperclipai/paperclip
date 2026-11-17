import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";
import { readNativeLocalProcessStop, readUnidentifiedLocalRunnerStop, recordUnidentifiedLocalRunnerStop } from "../native-local-process-stop.js";
import { NATIVE_PROVIDER_RECOVERY_ATTEMPT_LIMIT } from "./native-restart-recovery.js";

export const SAME_RUN_RESUME_DISPOSITION = "same_run_resume";

export function sameRunResumeClaimEntry(input: {
  at: Date; controllerBootId: string; providerAttempt: number; failureDetail: Record<string, unknown> | null | undefined;
}) {
  const detail = input.failureDetail ?? {};
  return {
    at: input.at.toISOString(),
    disposition: SAME_RUN_RESUME_DISPOSITION,
    controllerBootId: input.controllerBootId,
    providerAttempt: input.providerAttempt,
    evidence: {
      recoveryMode: detail.recoveryMode ?? null,
      recoverable: detail.recoverable ?? null,
      providerSessionEstablished: detail.providerSessionEstablished ?? null,
      checkpointExists: detail.checkpointExists ?? null,
      successorRunId: detail.successorRunId ?? null,
      replacementDenied: detail.replacementDenied ?? null,
    },
  };
}

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
  resumeClaim?: Record<string, unknown> | null;
  controllerBootId?: string;
  admittedAttempt: number;
  localStop: { processPid: number | null } | null;
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
  const claimed = evidence.coordinatorPhase === "observed" && evidence.resumeClaim?.disposition === SAME_RUN_RESUME_DISPOSITION
    && typeof evidence.controllerBootId === "string" && evidence.resumeClaim.controllerBootId === evidence.controllerBootId;
  if (evidence.coordinatorPhase !== "retryable_failure" && !claimed) return refuse("not_a_scheduled_same_run_resume");
  const detail = (claimed ? evidence.resumeClaim?.evidence as Record<string, unknown> | undefined : evidence.failureDetail) ?? {};
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
  const decision = decideScheduledResumeContinuation({ ...evidence, localStop });
  if (decision.allowed || decision.reason !== "local_stop_unverified") return decision;
  if (await readUnidentifiedLocalRunnerStop(db, companyId, runId))
    return decideScheduledResumeContinuation({ ...evidence, localStop: { processPid: null } });
  const [run] = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    runtimeMode: heartbeatRuns.runtimeMode, processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
    runnerProfileJson: heartbeatRuns.runnerProfileJson })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))).limit(1);
  if (!run || !await recordUnidentifiedLocalRunnerStop(db, run)) return decision;
  return decideScheduledResumeContinuation({ ...evidence, localStop: { processPid: null } });
}
