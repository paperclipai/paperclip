import { setTimeout as delay } from "node:timers/promises";
import { environmentTaskResultSchema, type PluginEnvironmentTaskColdCheckpoint } from "@paperclipai/plugin-sdk";
import type { DurableRecoveryIdentity } from "../../vendor/paperclip-runner/index.js";
import { NativeRunnerOwnershipUnverifiedError } from "./native-runner-ownership.js";
import { isSettledRemoteWarmControlState } from "./remote-warm-session-recovery.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Live adoption may retain completed history; rollback must not discard it. */
function isUnchangedParkedSourceControlState(control: Record<string, unknown>, identity: Record<string, unknown>): boolean {
  if (!isSettledRemoteWarmControlState(control, identity)) return false;
  const events = control.committedEvents as unknown[];
  const terminal = events.findLastIndex(event => record(event).eventType === "run.terminal");
  return events.slice(terminal + 1).every(event => {
    const type = record(event).eventType;
    const payload = record(record(record(event).envelope).payload).payload;
    const value = record(payload);
    return type === "session.goal.snapshot"
      ? value.schema === "paperclip.session_goal.snapshot.v1" && value.goal === null && value.workingNow === false
      : type === "provider.notice.recorded" && value.schema === "paperclip.provider.notice.v1" &&
        value.recoverable === true && (value.severity === "info" || value.severity === "warning");
  });
}

/** Before run.attach, the canonical checkpoint still belongs to the completed source. */
export function isCompletedParkedSourceRecovery(input: {
  currentRunId: string; claimId: string; hasCurrentCheckpoint: boolean;
  identity: Record<string, unknown>; control: Record<string, unknown>;
}): boolean {
  return !input.hasCurrentCheckpoint && input.claimId === input.currentRunId && input.identity.runId !== input.currentRunId &&
    ["runnerInstanceId", "environmentLeaseId", "runId", "normalizedSessionId", "turnId", "itemId"].every(key => typeof input.identity[key] === "string" && input.identity[key] !== "") &&
    input.control.stagedRunAttachment == null && input.control.warmTransition == null &&
    isUnchangedParkedSourceControlState(input.control, input.identity);
}

/** A bound, undelivered ticket cannot be regenerated. Retire only a source that
 * has never accepted the successor; active or staged work remains adoptable. */
export async function retireBoundParkedRunner(input: {
  task: (operation: unknown) => Promise<unknown>;
  identity: DurableRecoveryIdentity;
  targetRunId: string;
  parkedClaim: { parkId: string; claimId: string };
  resumeCheckpoint: PluginEnvironmentTaskColdCheckpoint;
  control: Record<string, unknown>;
  authorize: () => Promise<void>;
}): Promise<boolean> {
  const status = environmentTaskResultSchema.parse(await input.task({ kind: "status" }));
  if (status.kind !== "status" || status.executionStopped === true || status.retention?.state !== "claiming" ||
      status.retention.bootstrapBound !== true) return false;
  if (status.retention.parkId !== input.parkedClaim.parkId || status.retention.claimId !== input.parkedClaim.claimId ||
      status.retention.claimId !== input.targetRunId) throw new NativeRunnerOwnershipUnverifiedError();
  if (input.identity.runId === input.targetRunId || input.control.stagedRunAttachment != null || input.control.warmTransition != null ||
      !isUnchangedParkedSourceControlState(input.control, { ...input.identity })) return false;
  const result = environmentTaskResultSchema.parse(await input.task({ kind: "read_state", identity: input.identity }));
  if (result.kind !== "state") throw new NativeRunnerOwnershipUnverifiedError();
  const state = result.state;
  if (state.schema !== "paperclip.runner.durable.state.v1" || state.lifecycle !== "ready" ||
      Object.entries(input.identity).some(([key, value]) => state[key] !== value) ||
      !Array.isArray(state.outbox) || state.outbox.length !== 0 || state.warmTransition != null ||
      state.pendingProviderCleanup != null || state.pendingTerminalDelivery != null) return false;
  await input.authorize();
  // The provider maps this to a dedicated conditional-retirement endpoint.
  // It verifies the captured source cut before signalling; never use bare Stop.
  await input.task({ kind: "stop", ifParkedClaim: { ...input.parkedClaim, resumeCheckpoint: input.resumeCheckpoint } });
  const deadline = Date.now() + 15_000;
  for (;;) {
    const stopped = environmentTaskResultSchema.parse(await input.task({ kind: "status" }));
    if (stopped.kind === "status" && stopped.executionStopped === true) break;
    if (stopped.kind !== "status" || stopped.retention?.state !== "retiring" || Date.now() >= deadline) {
      throw new NativeRunnerOwnershipUnverifiedError();
    }
    await delay(100);
  }
  await input.task({ kind: "complete" });
  // The provider replaces only this independently stopped task; a failed reply
  // leaves the same durable lease to reconcile, never a parallel executor.
  await input.task({ kind: "describe" });
  return true;
}

/** Adopt only the target identity already recorded by its current Core authority. */
export async function canAdoptAttachedParkedRunner(input: {
  task: (operation: unknown) => Promise<unknown>;
  identity: Record<string, unknown>;
  targetRunId: string;
  parkedClaim: { parkId: string; claimId: string };
}): Promise<boolean> {
  const keys = ["runnerInstanceId", "environmentLeaseId", "runId", "normalizedSessionId", "turnId", "itemId"];
  if (input.identity.runId !== input.targetRunId || input.parkedClaim.claimId !== input.targetRunId ||
      keys.some(key => typeof input.identity[key] !== "string" || !input.identity[key])) return false;
  const status = environmentTaskResultSchema.parse(await input.task({ kind: "status" }));
  if (status.kind !== "status" || status.phase !== "running" || status.executionStopped === true || status.retention !== undefined) return false;
  const result = environmentTaskResultSchema.parse(await input.task({ kind: "read_state", identity: input.identity }));
  return result.kind === "state" && result.state.schema === "paperclip.runner.durable.state.v1" && result.state.lifecycle === "ready" &&
    keys.every(key => result.state[key] === input.identity[key]);
}
