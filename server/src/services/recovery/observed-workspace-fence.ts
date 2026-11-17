import { inArray } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { hasConfirmedSandboxStopAndRetain } from "../sandbox-stop-and-retain.js";
import type { InProgressRecord, RecordOwner, SettleOutcome } from "./ownership-registry.js";

export const OBSERVED_WORKSPACE_FENCE_SCOPE = "observed_workspace_preservation_fence";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function observedWorkspaceFenceOwner(evidence: unknown): RecordOwner {
  const fence = object(object(evidence).observedWorkspacePreservation);
  const token = typeof fence.leaseOwner === "string" && fence.leaseOwner ? fence.leaseOwner : null;
  const generation = typeof fence.controllerGeneration === "number" && Number.isSafeInteger(fence.controllerGeneration)
    ? fence.controllerGeneration : null;
  return token ? { kind: "fence", stamp: { kind: "remote", scope: OBSERVED_WORKSPACE_FENCE_SCOPE, generation, fenceToken: token },
    fence: { currentFenceToken: null, currentGeneration: null, leaseExpiresAt: null } } : { kind: "none" };
}

export async function providerStoppedObservedRuns(db: Db, runIds: readonly string[]): Promise<Set<string>> {
  const stopped = new Set<string>();
  if (runIds.length === 0) return stopped;
  const leases = await db.select().from(environmentLeases).where(inArray(environmentLeases.heartbeatRunId, [...runIds]));
  const byRun = new Map<string, typeof leases>();
  for (const lease of leases) byRun.set(lease.heartbeatRunId!, [...(byRun.get(lease.heartbeatRunId!) ?? []), lease]);
  for (const [runId, runLeases] of byRun) {
    if (runLeases.length === 1 && hasRemoteTerminationReceipt(runLeases[0]!) && hasConfirmedSandboxStopAndRetain(runLeases[0]!)) {
      stopped.add(runId);
    }
  }
  return stopped;
}

export async function applyObservedFenceProviderProof(db: Db, records: readonly InProgressRecord[]): Promise<void> {
  const observed = records.filter(record => record.owner.kind === "fence" && record.runId
    && record.owner.stamp.scope === OBSERVED_WORKSPACE_FENCE_SCOPE);
  const stopped = await providerStoppedObservedRuns(db, [...new Set(observed.map(record => record.runId!))]);
  for (const record of observed) {
    if (record.owner.kind === "fence" && stopped.has(record.runId!)) record.owner.fence = { ...record.owner.fence, provider: "stopped" };
  }
}

export async function settleObservedWorkspaceFence(db: Db, record: InProgressRecord): Promise<SettleOutcome> {
  if (!record.companyId || !record.runId) return { settled: false, reason: "owner_not_provable" };
  const { ObservedWorkspacePreservationBusyError, settleStoppedObservedWorkspace } =
    await import("../native-runtime/native-observed-workspace-preservation.js");
  try {
    return await settleStoppedObservedWorkspace(db, record.companyId, record.runId)
      ? { settled: true, reason: "provider_stopped" } : { settled: false, reason: "fence_not_settleable" };
  } catch (error) {
    if (error instanceof ObservedWorkspacePreservationBusyError) return { settled: false, reason: "source_busy" };
    throw error;
  }
}
