import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";

type Lease = typeof environmentLeases.$inferSelect;
type Binding = Pick<Lease, "id" | "companyId" | "environmentId" | "executionWorkspaceId" | "issueId" |
  "heartbeatRunId" | "provider" | "providerLeaseId" | "metadata" | "acquiredAt">;
const outgoingKey = "reusableLeaseSuccessor";
const incomingKey = "reusableLeasePredecessor";

export function withoutReusableLeaseHandoff(metadata: Record<string, unknown> | null | undefined) {
  if (metadata == null) return null;
  const result = { ...metadata };
  delete result[outgoingKey];
  delete result[incomingKey];
  return result;
}

export function preserveReusableLeaseHandoff(previous: Record<string, unknown> | null,
  metadata: Record<string, unknown> | null | undefined) {
  const result = withoutReusableLeaseHandoff(metadata);
  const proof = Object.fromEntries([outgoingKey, incomingKey]
    .filter(key => Object.hasOwn(previous ?? {}, key)).map(key => [key, previous![key]]));
  return Object.keys(proof).length ? { ...result, ...proof } : result;
}

function handoffBinding(previous: Binding, current: Binding) {
  return { schema: "paperclip.reusable-lease-handoff.v1",
    previousLeaseId: previous.id, successorLeaseId: current.id,
    previousRunId: previous.heartbeatRunId, successorRunId: current.heartbeatRunId,
    companyId: current.companyId, environmentId: current.environmentId,
    workspaceId: current.executionWorkspaceId, issueId: current.issueId,
    agentId: current.metadata?.agentId ?? null, provider: current.provider,
    providerLeaseId: current.providerLeaseId, recordedAt: current.acquiredAt.toISOString() };
}

export function createReusableLeaseHandoff(previous: Binding, current: Binding) {
  return { ...handoffBinding(previous, current), handoffId: randomUUID() };
}

export function retiredReusableLeasePredecessors(current: Lease, history: Lease[]): Lease[] | null {
  if (Object.hasOwn(current.metadata ?? {}, outgoingKey)) return null;
  const remaining = new Map(history.map(lease => [lease.id, lease]));
  if (remaining.size !== history.length) return null;
  const result: Lease[] = [];
  let successor = current;
  while (remaining.size) {
    const raw = successor.metadata?.[incomingKey];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const receipt = raw as Record<string, unknown>;
    const previous = remaining.get(String(receipt.previousLeaseId));
    if (!previous || previous.status !== "expired" || previous.cleanupStatus !== "success" ||
        previous.leasePolicy !== "reuse_by_environment" || !previous.heartbeatRunId ||
        !successor.heartbeatRunId || previous.heartbeatRunId === successor.heartbeatRunId ||
        typeof receipt.handoffId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.handoffId)) return null;
    const expected = { ...handoffBinding(previous, successor), handoffId: receipt.handoffId };
    const outgoing = previous.metadata?.[outgoingKey];
    if (!outgoing || typeof outgoing !== "object" || Array.isArray(outgoing) ||
        Object.keys(receipt).length !== Object.keys(expected).length ||
        Object.keys(outgoing).length !== Object.keys(expected).length ||
        Object.entries(expected).some(([key, value]) => receipt[key] !== value ||
          (outgoing as Record<string, unknown>)[key] !== value) ||
        !previous.environmentId || !previous.issueId || typeof previous.metadata?.agentId !== "string" ||
        previous.companyId !== current.companyId || previous.environmentId !== current.environmentId ||
        previous.executionWorkspaceId !== current.executionWorkspaceId ||
        (current.executionWorkspaceId === null && previous.issueId !== current.issueId) ||
        previous.metadata.agentId !== current.metadata?.agentId ||
        previous.provider !== current.provider || previous.providerLeaseId !== current.providerLeaseId ||
        previous.releasedAt?.getTime() !== successor.acquiredAt.getTime() ||
        previous.acquiredAt.getTime() > successor.acquiredAt.getTime()) return null;
    result.push(previous);
    remaining.delete(previous.id);
    successor = previous;
  }
  return Object.hasOwn(successor.metadata ?? {}, incomingKey) ? null : result;
}

export const SUPERSEDED_REUSABLE_SANDBOX_KEY = "reusableSandboxLeaseSuperseded";
const SUPERSEDED_REUSABLE_SANDBOX_SCHEMA = "paperclip.reusable-sandbox-lease-superseded.v1";

/**
 * Takes a reusable sandbox lease out of reuse. Removing its reuse scope makes
 * the next acquisition for this workspace treat it as obsolete and clean it up
 * through the existing obsolete-lease path, which keeps every protection. The
 * write is a compare-and-swap on the row as read: a run that resumed or
 * changed the lease in the meantime wins, and this returns false.
 */
export async function supersedeReusableSandboxLease(db: Db, lease: Lease, input: {
  reason: "harness_backup_restored_elsewhere" | "sandbox_disk_full";
  supersededByRunId: string;
  supersededByProviderLeaseId?: string | null;
  manifestSha256?: string;
}): Promise<boolean> {
  if (lease.leasePolicy !== "reuse_by_environment" || !lease.heartbeatRunId) return false;
  const { reusableSandboxLease: scope, ...metadata } = lease.metadata ?? {};
  const [claimed] = await db.update(environmentLeases).set({
    metadata: { ...metadata, [SUPERSEDED_REUSABLE_SANDBOX_KEY]: {
      schema: SUPERSEDED_REUSABLE_SANDBOX_SCHEMA, reason: input.reason,
      supersededByRunId: input.supersededByRunId, supersededByProviderLeaseId: input.supersededByProviderLeaseId ?? null,
      ...(input.manifestSha256 ? { manifestSha256: input.manifestSha256 } : {}),
      reusableSandboxLease: scope ?? null, supersededAt: new Date().toISOString(),
    } },
    updatedAt: new Date(),
  }).where(and(
    eq(environmentLeases.companyId, lease.companyId), eq(environmentLeases.id, lease.id),
    eq(environmentLeases.status, lease.status), eq(environmentLeases.leasePolicy, "reuse_by_environment"),
    eq(environmentLeases.heartbeatRunId, lease.heartbeatRunId),
    sql`${environmentLeases.metadata} = ${JSON.stringify(lease.metadata)}::jsonb`,
  )).returning({ id: environmentLeases.id });
  return Boolean(claimed);
}
