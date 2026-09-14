import { createHash } from "node:crypto";
import { z } from "zod";
import type { environmentLeases } from "@paperclipai/db";
import { runtimeServiceRunScopeSchema } from "./run-attachment.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";

type Lease = typeof environmentLeases.$inferSelect;
export const taskDataIdentityHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)).digest("hex");
const secretRef = z.union([z.string().guid(), z.object({ type: z.literal("secret_ref"), secretId: z.string().guid(),
  version: z.literal("latest").nullish() }).strict()]);
const ownershipSchema = z.object({ version: z.literal(1), executionWorkspaceId: z.string().guid(), createdByRunId: z.string().guid(), sandboxName: z.string().min(1) }).strict();
/** Save only the original connection's references, never resolved credentials,
 * process metadata, sync archives or settings from the current environment. */
const connectionConfigSchema = z.object({ provider: z.literal("daytona"), apiKey: secretRef.optional(), apiUrl: z.string().optional(), target: z.string().optional() }).strict();
export const taskProviderDataTargetSchema = z.object({
  provider: z.literal("daytona"), providerLeaseId: z.string().guid(), environmentId: z.string().guid(), pluginId: z.string().guid(),
  leaseIds: z.array(z.string().guid()).min(1), config: connectionConfigSchema,
  workspaceConnection: z.object({ scopeId: z.string().guid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ownership: ownershipSchema,
}).strict();
export type TaskProviderDataTarget = z.infer<typeof taskProviderDataTargetSchema>;

function connectionFromLease(lease: Lease, companyId: string, workspaceId: string) {
  const metadata = lease.metadata ?? {}, scope = runtimeServiceRunScopeSchema.parse(metadata.runtimeServiceRunScope);
  const ownership = ownershipSchema.parse(metadata.taskWorkspaceOwnership);
  if (scope.version !== 1 || scope.companyId !== companyId || scope.environmentId !== lease.environmentId || scope.executionWorkspaceId !== workspaceId ||
      scope.pluginId !== metadata.pluginId || ownership.executionWorkspaceId !== workspaceId || ownership.createdByRunId !== scope.connection.scopeId ||
      metadata.provider !== "daytona" || metadata.sandboxProviderPlugin !== true || lease.companyId !== companyId || lease.executionWorkspaceId !== workspaceId ||
      metadata.serviceAllocationId || metadata.runtimeServiceDataDeletionId && typeof metadata.runtimeServiceDataDeletionId !== "string") throw new Error("Task provider ownership is unavailable");
  const config = connectionConfigSchema.parse({ provider: "daytona", ...Object.fromEntries(["apiKey", "apiUrl", "target"].flatMap((key) => {
    const value = metadata[key]; return value === undefined || value === null || value === "" ? [] : [[key, value]];
  })) });
  return { provider: "daytona" as const, providerLeaseId: lease.providerLeaseId, environmentId: lease.environmentId, pluginId: scope.pluginId,
    config, workspaceConnection: scope.connection, ownership };
}

export function taskProviderDeletionConfirmed(target: TaskProviderDataTarget, leases: Lease[], deletionId: string | undefined) {
  const expected = taskDataIdentityHash(target);
  return !!deletionId && target.leaseIds.every((id) => {
    const lease = leases.find((row) => row.id === id), receipt = lease?.metadata?.runtimeServiceTaskDataDeleted as Record<string, unknown> | undefined;
    return lease?.metadata?.runtimeServiceDataDeletionId === deletionId && receipt?.version === 1 && receipt.deletionId === deletionId &&
      receipt.providerLeaseId === target.providerLeaseId && receipt.targetHash === expected && receipt.state === "destroyed";
  });
}

/** Group every historical claim on a sandbox. A single unowned or conflicting
 * claim blocks the review; task ownership cannot be inferred from its name. */
export function inspectTaskProviderData(input: {
  companyId: string; workspaceId: string; leases: Lease[]; deletionId?: string;
  supported: (target: TaskProviderDataTarget) => boolean;
}) {
  const targets: TaskProviderDataTarget[] = [], blockers: string[] = [];
  const groups = new Map<string, Lease[]>();
  for (const lease of input.leases) {
    if (!lease.provider || lease.provider === "local") continue;
    const key = JSON.stringify([lease.provider, lease.providerLeaseId ?? lease.id]);
    groups.set(key, [...(groups.get(key) ?? []), lease]);
  }
  for (const leases of groups.values()) {
    if (leases.every((lease) => hasRemoteTerminationReceipt(lease) && (lease.metadata?.remoteExecutionTermination as { state?: string })?.state === "destroyed")) continue;
    try {
      if (leases.some((lease) => lease.provider !== "daytona")) throw new Error("Unsupported task provider");
      const connections = leases.map((lease) => connectionFromLease(lease, input.companyId, input.workspaceId));
      if (connections.some((connection) => taskDataIdentityHash(connection) !== taskDataIdentityHash(connections[0]))) throw new Error("Conflicting provider ownership");
      const target = taskProviderDataTargetSchema.parse({ ...connections[0], leaseIds: leases.map((lease) => lease.id).sort() });
      targets.push(target);
      if (!taskProviderDeletionConfirmed(target, input.leases, input.deletionId) && !input.supported(target)) blockers.push("The connected provider is unavailable or does not support explicit task workspace data deletion.");
    } catch {
      blockers.push("Remote workspace data has not been confirmed deleted, and its original task ownership or provider connection could not be verified. Recover that receipt before deleting data.");
    }
  }
  targets.sort((a, b) => a.providerLeaseId.localeCompare(b.providerLeaseId));
  return { targets, blockers };
}
