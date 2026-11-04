import { environmentTaskResultSchema } from "@paperclipai/plugin-sdk";
import type { DurableRecoveryIdentity } from "../../vendor/paperclip-runner/index.js";
import { NativeRunnerOwnershipUnverifiedError } from "./native-runner-ownership.js";
import { isSettledRemoteWarmControlState } from "./remote-warm-session-recovery.js";

/** Before run.attach, the canonical checkpoint still belongs to the completed source. */
export function isCompletedParkedSourceRecovery(input: {
  currentRunId: string; claimId: string; hasCurrentCheckpoint: boolean;
  identity: Record<string, unknown>; control: Record<string, unknown>;
}): boolean {
  return !input.hasCurrentCheckpoint && input.claimId === input.currentRunId && input.identity.runId !== input.currentRunId &&
    ["runnerInstanceId", "environmentLeaseId", "runId", "normalizedSessionId", "turnId", "itemId"].every(key => typeof input.identity[key] === "string" && input.identity[key] !== "") &&
    input.control.stagedRunAttachment == null && input.control.warmTransition == null &&
    isSettledRemoteWarmControlState(input.control, input.identity);
}

/** A bound, undelivered ticket cannot be regenerated. Retire only a source that
 * has never accepted the successor; active or staged work remains adoptable. */
export async function retireBoundParkedRunner(input: {
  task: (operation: unknown) => Promise<unknown>;
  identity: DurableRecoveryIdentity;
  targetRunId: string;
  parkedClaim: { parkId: string; claimId: string };
  control: Record<string, unknown>;
  authorize: () => Promise<void>;
}): Promise<boolean> {
  const status = environmentTaskResultSchema.parse(await input.task({ kind: "status" }));
  if (status.kind !== "status" || status.executionStopped === true || status.retention?.state !== "claiming" ||
      status.retention.bootstrapBound !== true) return false;
  if (status.retention.parkId !== input.parkedClaim.parkId || status.retention.claimId !== input.parkedClaim.claimId ||
      status.retention.claimId !== input.targetRunId) throw new NativeRunnerOwnershipUnverifiedError();
  if (input.identity.runId === input.targetRunId || input.control.stagedRunAttachment != null || input.control.warmTransition != null ||
      !isSettledRemoteWarmControlState(input.control, { ...input.identity })) return false;
  const result = environmentTaskResultSchema.parse(await input.task({ kind: "read_state", identity: input.identity }));
  if (result.kind !== "state") throw new NativeRunnerOwnershipUnverifiedError();
  const state = result.state;
  if (state.schema !== "paperclip.runner.durable.state.v1" || state.lifecycle !== "ready" ||
      Object.entries(input.identity).some(([key, value]) => state[key] !== value) ||
      !Array.isArray(state.outbox) || state.outbox.length !== 0 || state.warmTransition != null ||
      state.pendingProviderCleanup != null || state.pendingTerminalDelivery != null) return false;
  await input.authorize();
  await input.task({ kind: "stop" });
  const stopped = environmentTaskResultSchema.parse(await input.task({ kind: "status" }));
  if (stopped.kind !== "status" || stopped.executionStopped !== true) throw new NativeRunnerOwnershipUnverifiedError();
  await input.task({ kind: "complete" });
  // The provider replaces only this independently stopped task; a failed reply
  // leaves the same durable lease to reconcile, never a parallel executor.
  await input.task({ kind: "describe" });
  return true;
}
