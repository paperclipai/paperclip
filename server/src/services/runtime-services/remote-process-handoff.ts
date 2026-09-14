import path from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { environmentLeases, heartbeatRuns, runtimeServiceAllocations, runtimeServices, type Db } from "@paperclipai/db";
import { isRemoteProcessIdentity, type RemoteProcessIdentity } from "@paperclipai/adapter-utils";
import type { PluginEnvironmentProcessHandoffParams, PluginEnvironmentProcessHandoffResult } from "@paperclipai/plugin-sdk";
import { RuntimeServiceFault } from "./fault.js";
import { assertRuntimeServiceLeaseDataAvailable, withRuntimeServiceLeaseLock } from "./retention.js";
import { runtimeServiceRunScopeSchema, sameRuntimeServiceConfiguration } from "./run-attachment.js";

type Lease = typeof environmentLeases.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
export const remoteRuntimeServiceProcessOwnerSchema = z.object({ version: z.literal(1), provider: z.literal("daytona"), runId: z.string().guid(),
  providerLeaseId: z.string().guid(), environmentLeaseId: z.string().guid(), workspaceRoot: z.string().startsWith("/"),
  process: z.custom<RemoteProcessIdentity>(isRemoteProcessIdentity),
}).strict();
const connectionSchema = z.object({ scopeId: z.string().guid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const receiptSchema = z.object({ version: z.literal(1), provider: z.literal("daytona"), companyId: z.string().guid(),
  environmentId: z.string().guid(), environmentLeaseId: z.string().guid(), providerLeaseId: z.string().guid(), sourceRunId: z.string().guid(),
  connection: connectionSchema, process: z.record(z.string(), z.unknown()),
}).strict();

/** Only a pre-exec provider receipt persisted by heartbeat can identify a remote root. */
export function remoteRuntimeServiceProcessOwner(lease: Lease | undefined, run: Run | undefined) {
  const owner = remoteRuntimeServiceProcessOwnerSchema.safeParse(lease?.metadata?.runtimeServiceProcessOwner);
  const boundary = lease?.metadata?.runtimeServiceBoundary as { provider?: unknown; workspaceRoot?: unknown } | undefined;
  if (!owner.success || !lease || !run || lease.companyId !== run.companyId || lease.heartbeatRunId !== run.id || lease.status !== "active"
    || run.status !== "running" || lease.provider !== "daytona" || !run.processStartedAt || run.processGroupId !== null
    || owner.data.environmentLeaseId !== lease.id || owner.data.runId !== run.id || owner.data.providerLeaseId !== lease.providerLeaseId
    || boundary?.provider !== "daytona" || boundary.workspaceRoot !== owner.data.workspaceRoot || owner.data.workspaceRoot === "/"
    || owner.data.process.pid !== run.processPid) throw new RuntimeServiceFault("process_ownership_unverified");
  return owner.data;
}

export type RuntimeServiceProcessHandoffOperation = {
  action: "capture"; companyId: string; environmentLeaseId: string; runId: string; sourcePid: number; cwd: string; workspaceRoot: string;
} | { action: "stop"; companyId: string; serviceId: string; receipt: Record<string, unknown> };

/** The callback is reachable only under the physical allocation lock, with
 * fresh ownership and, for Stop, the exact receipt committed by the manager. */
export async function operateRemoteRuntimeServiceProcessHandoff(db: Db, input: RuntimeServiceProcessHandoffOperation,
  call: (lease: Lease, operation: PluginEnvironmentProcessHandoffParams["operation"], connection: PluginEnvironmentProcessHandoffParams["workspaceConnection"]) => Promise<PluginEnvironmentProcessHandoffResult>,
): Promise<PluginEnvironmentProcessHandoffResult> {
  const saved = input.action === "stop" ? receiptSchema.safeParse(input.receipt) : null;
  if (saved && !saved.success) throw new RuntimeServiceFault("process_handoff_unverified");
  const receipt = saved?.success ? saved.data : null;
  if (receipt && receipt.companyId !== input.companyId) throw new RuntimeServiceFault("process_handoff_unverified");
  const leaseId = input.action === "capture" ? input.environmentLeaseId : receipt!.environmentLeaseId;
  const [initial] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, leaseId), eq(environmentLeases.companyId, input.companyId)));
  if (!initial) throw new RuntimeServiceFault("registration_unavailable");
  return withRuntimeServiceLeaseLock(db, initial, async (tx) => {
    const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, leaseId), eq(environmentLeases.companyId, input.companyId)));
    if (!lease || lease.provider !== "daytona" || lease.providerLeaseId !== initial.providerLeaseId || lease.environmentId !== initial.environmentId) throw new RuntimeServiceFault("process_ownership_unverified");
    await assertRuntimeServiceLeaseDataAvailable(tx, lease);
    const scope = runtimeServiceRunScopeSchema.safeParse(lease.metadata?.runtimeServiceRunScope);
    if (!scope.success || scope.data.companyId !== lease.companyId || scope.data.environmentId !== lease.environmentId || scope.data.pluginId !== lease.metadata?.pluginId) throw new RuntimeServiceFault("registration_unavailable");
    let operation: PluginEnvironmentProcessHandoffParams["operation"];
    if (input.action === "capture") {
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
      const owner = remoteRuntimeServiceProcessOwner(lease, run);
      const relative = path.posix.relative(owner.workspaceRoot, input.cwd);
      if (input.workspaceRoot !== owner.workspaceRoot || !path.posix.isAbsolute(input.cwd) || relative === ".." || relative.startsWith("../")) throw new RuntimeServiceFault("process_ownership_unverified");
      operation = { action: "capture", sourcePid: input.sourcePid, owner: owner.process, cwd: input.cwd, workspaceRoot: owner.workspaceRoot };
    } else {
      if (!receipt || receipt.providerLeaseId !== lease.providerLeaseId || receipt.environmentId !== lease.environmentId || receipt.sourceRunId !== lease.heartbeatRunId
        || !sameRuntimeServiceConfiguration(receipt.connection, scope.data.connection)) throw new RuntimeServiceFault("process_handoff_unverified");
      const [binding] = await tx.select({ service: runtimeServices, allocation: runtimeServiceAllocations }).from(runtimeServices)
        .innerJoin(runtimeServiceAllocations, and(eq(runtimeServiceAllocations.id, runtimeServices.allocationId), eq(runtimeServiceAllocations.companyId, runtimeServices.companyId)))
        .where(and(eq(runtimeServices.id, input.serviceId), eq(runtimeServices.companyId, input.companyId)));
      if (!binding || binding.allocation.provider !== "daytona" || binding.allocation.dataDeletionId || binding.allocation.metadata.retentionReleased === true
        || binding.service.processHandoff?.sourceRunId !== receipt.sourceRunId || !sameRuntimeServiceConfiguration(binding.service.processHandoff.receipt, input.receipt)) throw new RuntimeServiceFault("process_handoff_unverified");
      // A later task run may have registered against the same allocation's
      // older retained lease. Compare physical identity, not lease-row IDs.
      const [allocationLease] = binding.allocation.environmentLeaseId ? await tx.select().from(environmentLeases)
        .where(and(eq(environmentLeases.id, binding.allocation.environmentLeaseId), eq(environmentLeases.companyId, input.companyId))) : [];
      if (!allocationLease || allocationLease.provider !== lease.provider || allocationLease.providerLeaseId !== lease.providerLeaseId || allocationLease.environmentId !== lease.environmentId) throw new RuntimeServiceFault("process_handoff_unverified");
      if (binding.service.processHandoff.phase !== "pending") return { state: "stopped", workspaceConnection: scope.data.connection };
      operation = { action: "stop", receipt: receipt.process };
    }
    const result = await call(lease, operation, scope.data.connection);
    if (!sameRuntimeServiceConfiguration(result.workspaceConnection, scope.data.connection)) throw new RuntimeServiceFault("registration_unavailable");
    if (result.errorCode || result.state !== (input.action === "capture" ? "captured" : "stopped")) {
      throw new RuntimeServiceFault(result.errorCode === "PROCESS_HANDOFF_UNAVAILABLE" ? "registration_unavailable" : input.action === "capture" ? "process_ownership_unverified" : "process_handoff_unverified");
    }
    if (input.action === "stop") return { state: "stopped", workspaceConnection: scope.data.connection };
    if (!result.key || !/^[a-f0-9]{64}$/.test(result.key) || !result.receipt || !lease.providerLeaseId || !lease.environmentId) throw new RuntimeServiceFault("process_ownership_unverified");
    return { state: "captured", key: result.key, receipt: { version: 1, provider: "daytona", companyId: input.companyId,
      environmentId: lease.environmentId, environmentLeaseId: lease.id, providerLeaseId: lease.providerLeaseId, sourceRunId: input.runId,
      connection: scope.data.connection, process: result.receipt }, workspaceConnection: scope.data.connection };
  });
}
