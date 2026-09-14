import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { activityLog, environmentLeases, heartbeatRuns, issues, runtimeServiceAllocations, runtimeServiceCompanyPolicies, runtimeServiceDataDeletions, runtimeServiceEvents, runtimeServices, runtimeServiceTaskWorkspaces, type Db } from "@paperclipai/db";
import type { DeleteRuntimeServiceData, RuntimeServiceDataDeletion, RuntimeServiceDataDeletionPlan } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../../errors.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { parseEnvironmentDriverConfig, resolveEnvironmentDriverConfigForRuntime, resolveSandboxCleanupConfigSecrets, stripSandboxProviderEnvelope } from "../environment-config.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { lockRuntimeServiceCompany, readRuntimeServiceCompanyPolicy, reservesRunningCapacity } from "./company-policy.js";
import type { RuntimeServiceActor } from "./manager.js";
import { assertServiceEnvironmentCompany, runtimeServiceAllocationRequestSchema } from "./provisioning.js";
import { lockRuntimeServiceLease } from "./retention.js";
import { assertRuntimeServiceDataExpired, readRuntimeServiceDataExpiration } from "./retention-expiry.js";
import { createTaskWorkspaceDataDeletionStore } from "./workspace-data-deletion.js";
import type { TaskProviderDataTarget } from "./workspace-provider-data-deletion.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reader = Pick<Db, "select">;
type Job = typeof runtimeServiceDataDeletions.$inferSelect;
type Allocation = typeof runtimeServiceAllocations.$inferSelect;
const mirrorSchema = z.object({ allocationId: z.string().guid(), path: z.string(), dev: z.number(), ino: z.number() }).strict();
const targetSchema = z.object({
  version: z.literal(1), allocationId: z.string().guid(), allocationIds: z.array(z.string().guid()).min(1),
  leaseIds: z.array(z.string().guid()).min(1), serviceIds: z.array(z.string().guid()).min(1),
  environmentLeaseId: z.string().guid(), providerLeaseId: z.string().guid().nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(), request: runtimeServiceAllocationRequestSchema,
  mirrors: z.array(mirrorSchema),
}).strict();
type Target = z.infer<typeof targetSchema>;
const failureMessage = "Data deletion could not be confirmed. The workspace remains unavailable to new runs and services; retry after restoring its provider connection or resolving the cleanup failure.";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// A bounded durable claim replaces the transaction that used to remain open
// throughout provider RPCs. The attempt number fences late completions after a
// crash/reclaim; retryAt also paces recovery of an interrupted deleting job.
const DELETION_CLAIM_MS = 5 * 60_000;
export async function claimRuntimeServiceDataDeletion(db: Db, companyId: string, id: string, now: () => Date) {
  return db.transaction(async (tx) => {
    const lock = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${`runtime-service-data-deletion:${id}`})) as acquired`);
    if (!lock[0]?.acquired) return null;
    const [job] = await tx.select().from(runtimeServiceDataDeletions)
      .where(and(eq(runtimeServiceDataDeletions.companyId, companyId), eq(runtimeServiceDataDeletions.id, id))).for("update");
    if (!job || job.state === "deleted" || (job.state === "failed" && !job.retryAt) || (job.retryAt && job.retryAt > now())) return null;
    const [claimed] = await tx.update(runtimeServiceDataDeletions).set({ state: "deleting", attempts: job.attempts + 1,
      retryAt: new Date(now().getTime() + DELETION_CLAIM_MS), error: null,
      updatedAt: sql`greatest(${now().toISOString()}::timestamptz, ${runtimeServiceDataDeletions.updatedAt} + interval '1 millisecond')` })
      .where(eq(runtimeServiceDataDeletions.id, id)).returning();
    return claimed!;
  });
}

/** Database-only checkpoint; never place a provider or filesystem mutation here. */
export async function withRuntimeServiceDataDeletionClaim<T>(db: Db, job: Job, now: () => Date, action: (tx: Transaction) => Promise<T>) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(runtimeServiceDataDeletions).where(and(eq(runtimeServiceDataDeletions.companyId, job.companyId),
      eq(runtimeServiceDataDeletions.id, job.id), eq(runtimeServiceDataDeletions.state, "deleting"), eq(runtimeServiceDataDeletions.attempts, job.attempts))).for("update");
    if (!current) throw conflict("The data deletion attempt was replaced; its result cannot update the current operation");
    await tx.update(runtimeServiceDataDeletions).set({ retryAt: new Date(now().getTime() + DELETION_CLAIM_MS) }).where(eq(runtimeServiceDataDeletions.id, job.id));
    return action(tx);
  });
}

export function runtimeServiceDataDeletionView(job: Job | null | undefined): RuntimeServiceDataDeletion | null {
  return job ? { reason: job.authorization.kind, ...(job.authorization.kind === "retention" ? { policyRevision: job.authorization.policyRevision } : {}), id: job.id, state: job.state as RuntimeServiceDataDeletion["state"], attempts: job.attempts,
    error: job.error, requestedAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null, retryAt: job.retryAt?.toISOString() ?? null } : null;
}

async function mirrorIdentity(companyId: string, allocationId: string, hostCwd: string) {
  const expected = path.join(resolvePaperclipInstanceRoot(), "runtime-services-v2", "workspaces", companyId, allocationId);
  if (hostCwd !== expected) throw conflict("The retained host workspace has an unrecognized ownership path");
  const stat = await fs.lstat(expected).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return null;
  const root = await fs.realpath(resolvePaperclipInstanceRoot());
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(expected) !== path.join(root, "runtime-services-v2", "workspaces", companyId, allocationId)) {
    throw conflict("The retained host workspace identity changed; recover it before deleting data");
  }
  return { allocationId, path: expected, dev: stat.dev, ino: stat.ino };
}

/** The quarantine name is derived from the durable job, never a caller path. */
async function removeMirror(companyId: string, deletionId: string, allocationId: string, mirror: z.infer<typeof mirrorSchema>) {
  const current = await mirrorIdentity(companyId, allocationId, mirror.path);
  if (current && (current.dev !== mirror.dev || current.ino !== mirror.ino)) throw conflict("The retained host workspace was replaced after deletion was requested");
  const root = await fs.realpath(resolvePaperclipInstanceRoot());
  const parent = path.join(root, "runtime-services-v2", "deleted-workspaces", companyId, deletionId);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  if (await fs.realpath(parent) !== parent) throw conflict("The host deletion directory changed ownership");
  const quarantine = path.join(parent, allocationId);
  const moved = await fs.lstat(quarantine).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (moved && (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== mirror.dev || moved.ino !== mirror.ino)) throw conflict("The host deletion receipt does not match its workspace");
  if (current && moved) throw conflict("The retained host workspace was recreated during deletion");
  if (current) await fs.rename(mirror.path, quarantine);
  const captured = await fs.lstat(quarantine).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!captured) return;
  // A replacement racing rename is retained for recovery, never recursively
  // removed under the older inode's authorization.
  if (!captured.isDirectory() || captured.isSymbolicLink() || captured.dev !== mirror.dev || captured.ino !== mirror.ino) throw conflict("The host workspace changed during deletion");
  await fs.rm(quarantine, { recursive: true });
}

export function createRuntimeServiceDataDeletionExecutor(db: Db, worker: PluginWorkerManager | undefined) {
  return {
    supported(allocation: Allocation) {
      const request = runtimeServiceAllocationRequestSchema.safeParse(allocation.metadata.allocationRequest);
      return request.success && !!worker?.isRunning(request.data.pluginId) && (worker.getWorker(request.data.pluginId)?.supportedMethods ?? []).includes("environmentDeleteServiceData");
    },
    supportsTaskProvider(target: TaskProviderDataTarget) {
      return !!worker?.isRunning(target.pluginId) && (worker.getWorker(target.pluginId)?.supportedMethods ?? []).includes("environmentDeleteTaskWorkspaceData");
    },
    async removeTaskProvider(companyId: string, deletionId: string, target: TaskProviderDataTarget) {
      if (!worker?.isRunning(target.pluginId) || !(worker.getWorker(target.pluginId)?.supportedMethods ?? []).includes("environmentDeleteTaskWorkspaceData")) throw new Error("Task provider data deletion is unavailable");
      await assertServiceEnvironmentCompany(db, companyId, target.environmentId);
      const runtime = parseEnvironmentDriverConfig({ driver: "sandbox", config: target.config });
      if (runtime.driver !== "sandbox" || runtime.config.provider !== "daytona") throw new Error("The original task deletion connection is unavailable");
      // The durable, operator-authorized job must still be able to clean up
      // after environment edits remove its old binding. The existing teardown
      // resolver enforces company ownership; the provider checks the captured
      // connection fingerprint before any lookup, including a not-found retry.
      const config = await resolveSandboxCleanupConfigSecrets(db, companyId, runtime.config);
      const receipt = await worker.call(target.pluginId, "environmentDeleteTaskWorkspaceData", {
        driverKey: "daytona", companyId, environmentId: target.environmentId, config: stripSandboxProviderEnvelope(config),
        providerLeaseId: target.providerLeaseId, workspaceConnection: target.workspaceConnection, ownership: target.ownership, deletionId,
      }, 150_000);
      if (receipt.state !== "destroyed" || receipt.providerLeaseId !== target.providerLeaseId || receipt.executionWorkspaceId !== target.ownership.executionWorkspaceId || receipt.deletionId !== deletionId) {
        throw new Error("The provider did not confirm this task data deletion");
      }
    },
    async removeProvider(companyId: string, deletionId: string, target: Target) {
      if (!target.providerLeaseId) return;
      const { request } = target;
      if (!worker?.isRunning(request.pluginId) || !(worker.getWorker(request.pluginId)?.supportedMethods ?? []).includes("environmentDeleteServiceData")) throw new Error("Provider data deletion is unavailable");
      await assertServiceEnvironmentCompany(db, companyId, request.environmentId);
      const runtime = await resolveEnvironmentDriverConfigForRuntime(db, companyId, { id: request.environmentId, driver: "sandbox", config: request.launchConfig });
      if (runtime.driver !== "sandbox" || runtime.config.provider !== "daytona" || !target.fingerprint) throw new Error("The original data deletion connection is unavailable");
      const receipt = await worker.call(request.pluginId, "environmentDeleteServiceData", {
        driverKey: "daytona", companyId, environmentId: request.environmentId, config: stripSandboxProviderEnvelope(runtime.config),
        providerLeaseId: target.providerLeaseId, serviceAllocationId: target.allocationId, serviceConnectionFingerprint: target.fingerprint, deletionId,
      }, 150_000);
      if (receipt.state !== "destroyed" || receipt.providerLeaseId !== target.providerLeaseId || receipt.serviceAllocationId !== target.allocationId || receipt.deletionId !== deletionId) {
        throw new Error("The provider did not confirm this data deletion");
      }
    },
  };
}

export function createRuntimeServiceDataDeletionStore(db: Db, options: {
  now: () => Date;
  executor?: ReturnType<typeof createRuntimeServiceDataDeletionExecutor>;
  clearEnvironment?: (tx: Transaction, row: typeof runtimeServices.$inferSelect) => Promise<void>;
}) {
  const jobUpdatedAt = () => sql`greatest(${options.now().toISOString()}::timestamptz, ${runtimeServiceDataDeletions.updatedAt} + interval '1 millisecond')`;
  const taskWorkspace = createTaskWorkspaceDataDeletionStore(db, options);
  async function inspect(reader: Reader, companyId: string, serviceId: string) {
    const [selected] = await reader.select({ allocation: runtimeServiceAllocations }).from(runtimeServices)
      .innerJoin(runtimeServiceAllocations, and(eq(runtimeServiceAllocations.id, runtimeServices.allocationId), eq(runtimeServiceAllocations.companyId, runtimeServices.companyId)))
      .where(and(eq(runtimeServices.id, serviceId), eq(runtimeServices.companyId, companyId)));
    if (!selected) throw notFound("Service not found");
    const [selectedLease] = selected.allocation.environmentLeaseId ? await reader.select().from(environmentLeases).where(and(eq(environmentLeases.id, selected.allocation.environmentLeaseId), eq(environmentLeases.companyId, companyId))) : [];
    const leases = selectedLease ? await reader.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, companyId),
      selectedLease.providerLeaseId ? and(eq(environmentLeases.provider, selectedLease.provider ?? "local"), eq(environmentLeases.providerLeaseId, selectedLease.providerLeaseId)) : eq(environmentLeases.id, selectedLease.id))).orderBy(asc(environmentLeases.id)) : [];
    const allocations = leases.length ? await reader.select().from(runtimeServiceAllocations).where(and(eq(runtimeServiceAllocations.companyId, companyId), inArray(runtimeServiceAllocations.environmentLeaseId, leases.map((lease) => lease.id)))).orderBy(asc(runtimeServiceAllocations.id)) : [selected.allocation];
    const owners = allocations.filter((allocation) => allocation.metadata.allocationRequest && leases.find((lease) => lease.id === allocation.environmentLeaseId &&
      (lease.metadata?.serviceAllocationId === allocation.id || (!lease.providerLeaseId && allocation.metadata.acquisitionStarted !== true))));
    const owner = owners.length === 1 ? owners[0]! : selected.allocation;
    const lease = leases.find((candidate) => candidate.id === owner.environmentLeaseId);
    const ids = allocations.map((allocation) => allocation.id);
    const services = await reader.select().from(runtimeServices).where(and(eq(runtimeServices.companyId, companyId), inArray(runtimeServices.allocationId, ids))).orderBy(asc(runtimeServices.id));
    const bindings = await reader.select().from(runtimeServiceTaskWorkspaces).where(and(eq(runtimeServiceTaskWorkspaces.companyId, companyId), inArray(runtimeServiceTaskWorkspaces.allocationId, ids))).orderBy(asc(runtimeServiceTaskWorkspaces.id));
    const taskIds = bindings.flatMap((binding) => binding.issueId ? [binding.issueId] : []);
    const tasks = taskIds.length ? await reader.select({ id: issues.id, title: issues.title, identifier: issues.identifier, updatedAt: issues.updatedAt }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, taskIds))).orderBy(asc(issues.id)) : [];
    const runIds = leases.flatMap((candidate) => candidate.heartbeatRunId ? [candidate.heartbeatRunId] : []);
    const activeRuns = runIds.length ? await reader.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]))).orderBy(asc(heartbeatRuns.id)) : [];
    const [job] = owner.dataDeletionId ? await reader.select().from(runtimeServiceDataDeletions).where(and(eq(runtimeServiceDataDeletions.companyId, companyId), eq(runtimeServiceDataDeletions.id, owner.dataDeletionId))) : [];
    const request = runtimeServiceAllocationRequestSchema.safeParse(owner.metadata.allocationRequest);
    const scope: RuntimeServiceDataDeletionPlan["scope"] = owners.length === 1 && owner.provider === "daytona" ? "independent_allocation" : allocations.some((allocation) => allocation.executionWorkspaceId) ? "task_workspace" : "external_workspace";
    const blockers: string[] = [];
    if (scope !== "independent_allocation" || !request.success || !lease) blockers.push(scope === "task_workspace" ? "Deleting retained task-workspace data is not supported by this control yet." : "This is an existing workspace, not an independently owned service allocation. Its files cannot be deleted through this control.");
    if (allocations.some((allocation) => allocation.executionWorkspaceId) || leases.some((candidate) => candidate.executionWorkspaceId)) blockers.push("A task workspace still owns these files. Resolve that workspace dependency before deleting data.");
    if (bindings.some((binding) => binding.issueId)) blockers.push("Detach every attached task before deleting this workspace's data.");
    if (activeRuns.length || leases.some((candidate) => candidate.heartbeatRunId && candidate.status === "active")) blockers.push("An agent run or its final workspace sync is still using this allocation. Wait for it to finish.");
    if (services.some((service) => reservesRunningCapacity(service) || !["stopped", "sleeping", "deleted"].includes(service.state) || (service.controllerId && (!service.controllerExpiresAt || service.controllerExpiresAt > options.now())))) blockers.push("Stop all services and wait for their current operations to finish before deleting data.");
    if (owner.metadata.acquisitionStarted && !owner.metadata.provisionedAt) blockers.push("Allocation creation has an uncertain result. Recover its provider identity before deleting data.");
    const neverProvisioned = !owner.metadata.acquisitionStarted && !owner.metadata.provisionedAt && !lease?.providerLeaseId;
    if (!neverProvisioned && (!lease?.providerLeaseId || !/^[a-f0-9]{64}$/.test(String(owner.metadata.serviceConnectionFingerprint)))) blockers.push("The original provider identity must be recovered before deleting data.");
    const dependenciesAllowDeletion = blockers.length === 0;
    if (!neverProvisioned && !job?.providerDeletedAt && !options.executor?.supported(owner)) blockers.push("The connected provider is unavailable or does not support explicit service data deletion.");
    const mirrors: Target["mirrors"] = [];
    if (!job) for (const binding of bindings) {
      try {
        const mirror = await mirrorIdentity(companyId, binding.allocationId, binding.hostCwd);
        if (mirror) mirrors.push(mirror);
      } catch { blockers.push("A retained host workspace has changed identity. Recover it before deleting data."); }
    }
    const target = request.success && lease ? {
      version: 1 as const, allocationId: owner.id, allocationIds: ids, leaseIds: leases.map((candidate) => candidate.id), serviceIds: services.map((service) => service.id),
      environmentLeaseId: lease.id, providerLeaseId: lease.providerLeaseId, fingerprint: typeof owner.metadata.serviceConnectionFingerprint === "string" ? owner.metadata.serviceConnectionFingerprint : null,
      request: request.data, mirrors,
    } : null;
    const plan: RuntimeServiceDataDeletionPlan = { allocationId: owner.id, provider: owner.provider, scope, blockers,
      services: services.map((service) => ({ id: service.id, name: service.name, state: service.state as RuntimeServiceDataDeletionPlan["services"][number]["state"] })), tasks,
      includesHostMirror: job ? Boolean(targetSchema.safeParse(job.target).data?.mirrors.length) : mirrors.length > 0,
      deletion: runtimeServiceDataDeletionView(job), planToken: hash({ target, bindings, services: services.map((service) => [service.id, service.revision, service.processRef, service.controllerId]),
        leases: leases.map((candidate) => [candidate.id, candidate.status]), activeRuns, blockers, deletion: job ? [job.id, job.state, job.attempts] : null }),
    };
    return { plan, owner, allocations, leases, lease, services, tasks, target, job, dependenciesAllowDeletion };
  }

  async function event(tx: Transaction, companyId: string, serviceId: string, actor: RuntimeServiceActor, kind: string, details: Record<string, unknown>, requestKey?: string) {
    const [service] = await tx.select().from(runtimeServices).where(and(eq(runtimeServices.id, serviceId), eq(runtimeServices.companyId, companyId)));
    if (!service) throw notFound("Service not found");
    await tx.insert(runtimeServiceEvents).values({ companyId, serviceId, kind, actor, revision: service.revision, details, requestKey });
    await tx.insert(activityLog).values({ companyId, actorType: actor.type === "board" ? "user" : "system", actorId: actor.id,
      action: `runtime_service.${kind}`, entityType: "runtime_service_allocation", entityId: String(details.allocationId), details });
  }

  async function request(companyId: string, serviceId: string, actor: RuntimeServiceActor, input: DeleteRuntimeServiceData, retentionRevision?: number) {
    if (await taskWorkspace.supports(companyId, serviceId)) return retentionRevision === undefined ? taskWorkspace.request(companyId, serviceId, actor, input) : taskWorkspace.requestExpired(companyId, serviceId, input, retentionRevision);
    if (retentionRevision === undefined && actor.type !== "board") throw forbidden("Only an operator can authorize service data deletion");
    const requestKey = `data-delete:${actor.id}:${input.requestId}`, inputHash = hash(input);
    await db.transaction(async (tx) => {
      await lockRuntimeServiceCompany(tx, companyId);
      const [prior] = await tx.select().from(runtimeServiceEvents).where(and(eq(runtimeServiceEvents.companyId, companyId), eq(runtimeServiceEvents.serviceId, serviceId), eq(runtimeServiceEvents.requestKey, requestKey)));
      if (prior) { if (prior.details.inputHash !== inputHash) throw conflict("This request ID was already used for a different data deletion"); return; }
      let current = await inspect(tx, companyId, serviceId);
      for (const allocation of current.allocations) {
        const result = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${`runtime-service-retention:${allocation.id}`})) as acquired`);
        if (!result[0]?.acquired) throw conflict("The allocation is being reconciled. Refresh the deletion review and retry.");
      }
      if (current.lease) {
        const key = `runtime-service-allocation:${companyId}:${current.lease.provider ?? "local"}:${current.lease.providerLeaseId ?? current.lease.id}`;
        const result = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${key})) as acquired`);
        if (!result[0]?.acquired) throw conflict("The workspace has an operation in progress. Refresh the deletion review and retry.");
      }
      // An acquisition may have committed its intent since the first review.
      // Lock allocations before services, matching receipt persistence, then
      // inspect again so deletion cannot fence an in-flight named acquisition.
      await tx.select({ id: runtimeServiceAllocations.id }).from(runtimeServiceAllocations)
        .where(and(eq(runtimeServiceAllocations.companyId, companyId), inArray(runtimeServiceAllocations.id, current.allocations.map((allocation) => allocation.id))))
        .orderBy(asc(runtimeServiceAllocations.id)).for("update");
      await tx.select({ id: runtimeServices.id }).from(runtimeServices).where(and(eq(runtimeServices.companyId, companyId), inArray(runtimeServices.id, current.services.map((service) => service.id)))).for("update");
      current = await inspect(tx, companyId, serviceId);
      if (input.confirm !== true || current.owner.id !== input.confirmedAllocationId || current.plan.planToken !== input.planToken) throw conflict("The workspace or its dependencies changed. Review the current data deletion before confirming again.");
      if (current.plan.blockers.length) throw conflict(current.plan.blockers.join(" "));
      const authorization = retentionRevision === undefined ? { kind: "operator" as const }
        : assertRuntimeServiceDataExpired(await readRuntimeServiceDataExpiration(tx, companyId, current, options.now()), retentionRevision);
      const deletionId = current.job?.id ?? randomUUID();
      if (current.job) {
        if (current.job.state !== "failed") throw conflict("Data deletion has already been requested");
        const acquired = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${`runtime-service-data-deletion:${deletionId}`})) as acquired`);
        if (!acquired[0]?.acquired) throw conflict("Data deletion is already in progress");
        await tx.update(runtimeServiceDataDeletions).set({ state: "pending", retryAt: null, error: null, updatedAt: jobUpdatedAt() }).where(eq(runtimeServiceDataDeletions.id, deletionId));
      } else {
        const target = targetSchema.parse(current.target);
        await tx.insert(runtimeServiceDataDeletions).values({ id: deletionId, companyId, allocationId: current.owner.id, serviceId, requestedByUserId: authorization.kind === "operator" ? actor.id : null, authorization, target, createdAt: options.now(), updatedAt: options.now() });
        await tx.update(runtimeServiceAllocations).set({ dataDeletionId: deletionId, updatedAt: options.now() }).where(and(eq(runtimeServiceAllocations.companyId, companyId), inArray(runtimeServiceAllocations.id, target.allocationIds)));
        await tx.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ runtimeServiceDataDeletionId: deletionId })}::jsonb`, updatedAt: options.now() })
          .where(and(eq(environmentLeases.companyId, companyId), inArray(environmentLeases.id, target.leaseIds)));
        for (const service of current.services) {
          await options.clearEnvironment?.(tx, service);
          await tx.update(runtimeServices).set({ desiredState: "deleted", state: "deleted", stopReason: "data_deletion", error: null,
            spec: { ...service.spec, env: {} }, endpoints: [], revision: service.revision + 1, updatedAt: options.now() }).where(eq(runtimeServices.id, service.id));
        }
      }
      await event(tx, companyId, serviceId, actor, "data_deletion_requested", { allocationId: current.owner.id, deletionId, inputHash, authorization }, requestKey);
    });
    return (await inspect(db, companyId, serviceId)).plan;
  }

  async function reconcile(companyId: string, deletionId: string) {
    const [candidate] = await db.select({ target: runtimeServiceDataDeletions.target }).from(runtimeServiceDataDeletions)
      .where(and(eq(runtimeServiceDataDeletions.companyId, companyId), eq(runtimeServiceDataDeletions.id, deletionId)));
    if (["local_task_workspace", "task_workspace"].includes(String(candidate?.target.kind))) return taskWorkspace.reconcile(companyId, deletionId);
    const job = await claimRuntimeServiceDataDeletion(db, companyId, deletionId, options.now);
    if (!job) return;
    try {
      const target = targetSchema.parse(job.target);
      const assertAuthorized = async (tx: Transaction) => {
        const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, target.environmentLeaseId), eq(environmentLeases.companyId, companyId)));
        if (!lease) throw new Error("The service deletion lease is unavailable");
        await lockRuntimeServiceLease(tx, lease);
        const current = await inspect(tx, companyId, job.serviceId);
        if (current.owner.id !== target.allocationId || current.allocations.some((allocation) => allocation.dataDeletionId !== deletionId) ||
            hash(current.allocations.map((allocation) => allocation.id)) !== hash(target.allocationIds) ||
            hash(current.services.map((service) => service.id)) !== hash(target.serviceIds) ||
            current.leases.some((candidate) => candidate.metadata?.runtimeServiceDataDeletionId !== deletionId) ||
            hash(current.leases.map((candidate) => candidate.id)) !== hash(target.leaseIds) ||
            current.lease?.providerLeaseId !== target.providerLeaseId || !current.dependenciesAllowDeletion) throw new Error("The data deletion ownership fence changed");
      };
      await withRuntimeServiceDataDeletionClaim(db, job, options.now, assertAuthorized);
      if (!job.providerDeletedAt) {
        if (target.providerLeaseId) {
          if (!options.executor) throw new Error("Provider data deletion is unavailable");
          await options.executor.removeProvider(companyId, deletionId, target);
        }
        await withRuntimeServiceDataDeletionClaim(db, job, options.now, async (tx) => {
          await assertAuthorized(tx);
          await tx.update(runtimeServiceDataDeletions).set({ providerDeletedAt: options.now(), updatedAt: jobUpdatedAt() }).where(eq(runtimeServiceDataDeletions.id, deletionId));
        });
      }
      for (const mirror of target.mirrors) {
        await withRuntimeServiceDataDeletionClaim(db, job, options.now, assertAuthorized);
        await removeMirror(companyId, deletionId, mirror.allocationId, mirror);
      }
      await withRuntimeServiceDataDeletionClaim(db, job, options.now, async (finish) => {
        await assertAuthorized(finish);
        await finish.update(runtimeServiceAllocations).set({ metadata: sql`${runtimeServiceAllocations.metadata} || ${JSON.stringify({ retentionReleased: true, computeState: "stopped", retentionError: null })}::jsonb`, updatedAt: options.now() })
          .where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.dataDeletionId, deletionId)));
        await finish.update(environmentLeases).set({ status: "expired", releasedAt: options.now(), cleanupStatus: "success", failureReason: null,
          metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ runtimeServiceDataDeletionId: deletionId, remoteExecutionTermination: { state: "destroyed", providerLeaseId: target.providerLeaseId } })}::jsonb`, updatedAt: options.now() })
          .where(and(eq(environmentLeases.companyId, companyId), inArray(environmentLeases.id, target.leaseIds)));
        await finish.update(runtimeServiceDataDeletions).set({ state: "deleted", error: null, retryAt: null, completedAt: options.now(), updatedAt: jobUpdatedAt() }).where(eq(runtimeServiceDataDeletions.id, deletionId));
        await event(finish, companyId, job.serviceId, { type: "system", id: "runtime-services" }, "data_deleted", { allocationId: target.allocationId, deletionId });
      });
    } catch {
      await db.transaction(async (failed) => {
        const [updated] = await failed.update(runtimeServiceDataDeletions).set({ state: "failed", error: failureMessage,
          retryAt: job.attempts < 5 ? new Date(options.now().getTime() + Math.min(300_000, 5000 * 2 ** (job.attempts - 1))) : null, updatedAt: jobUpdatedAt() })
          .where(and(eq(runtimeServiceDataDeletions.id, deletionId), eq(runtimeServiceDataDeletions.companyId, companyId),
            eq(runtimeServiceDataDeletions.state, "deleting"), eq(runtimeServiceDataDeletions.attempts, job.attempts))).returning();
        if (updated) await event(failed, companyId, job.serviceId, { type: "system", id: "runtime-services" }, "data_deletion_failed", { allocationId: job.allocationId, deletionId });
      });
    }
  }

  async function expirationTick() {
    // Fair, bounded selection. Runtime supervision and provider deletion have
    // their own queues, so an unavailable provider cannot delay Stop controls.
    const candidates = await db.select({ id: runtimeServiceAllocations.id, companyId: runtimeServiceAllocations.companyId })
      .from(runtimeServiceAllocations).innerJoin(runtimeServiceCompanyPolicies, eq(runtimeServiceCompanyPolicies.companyId, runtimeServiceAllocations.companyId))
      .where(and(isNull(runtimeServiceAllocations.dataDeletionId), sql`coalesce(${runtimeServiceAllocations.metadata}->>'retentionReleased', 'false') <> 'true'`,
        sql`${runtimeServiceCompanyPolicies.config}->>'retainedDataSeconds' IS NOT NULL`,
        sql`exists (select 1 from ${runtimeServices} where ${runtimeServices.allocationId} = ${runtimeServiceAllocations.id} and ${runtimeServices.companyId} = ${runtimeServiceAllocations.companyId})`,
        sql`(${runtimeServiceAllocations.metadata}->'dataExpiration'->>'policyRevision' IS DISTINCT FROM ${runtimeServiceCompanyPolicies.revision}::text OR
          coalesce(${runtimeServiceAllocations.metadata}->'dataExpiration'->>'checkedAt', '') < ${new Date(options.now().getTime() - 60_000).toISOString()})`))
      .orderBy(sql`coalesce(${runtimeServiceAllocations.metadata}->'dataExpiration'->>'checkedAt', '')`, asc(runtimeServiceAllocations.id)).limit(4);
    for (const candidate of candidates) {
      const [service] = await db.select({ id: runtimeServices.id }).from(runtimeServices)
        .where(and(eq(runtimeServices.companyId, candidate.companyId), eq(runtimeServices.allocationId, candidate.id))).orderBy(asc(runtimeServices.id)).limit(1);
      if (!service) continue;
      try {
        const result = await taskWorkspace.supports(candidate.companyId, service.id) ? await taskWorkspace.expiration(candidate.companyId, service.id)
          : await (async () => { const current = await inspect(db, candidate.companyId, service.id); return { current, expiration: await readRuntimeServiceDataExpiration(db, candidate.companyId, current, options.now()) }; })();
        if (result.current.job) continue;
        await db.update(runtimeServiceAllocations).set({ metadata: sql`coalesce(${runtimeServiceAllocations.metadata}, '{}'::jsonb) || ${JSON.stringify({ dataExpiration: result.expiration })}::jsonb` })
          .where(and(eq(runtimeServiceAllocations.companyId, candidate.companyId), inArray(runtimeServiceAllocations.id, result.current.allocations.map((allocation) => allocation.id)), isNull(runtimeServiceAllocations.dataDeletionId)));
        if (result.expiration.state !== "expired") continue;
        await request(candidate.companyId, service.id, { type: "system", id: "runtime-service-retention" }, {
          requestId: randomUUID(), planToken: result.current.plan.planToken, confirmedAllocationId: result.current.plan.allocationId, confirm: true,
        }, result.expiration.policyRevision);
      } catch {
        // Admission races and uncertain ownership must not delete data. Keep
        // bounded, operator-readable feedback and retry fairly on a later sweep.
        const policy = await readRuntimeServiceCompanyPolicy(db, candidate.companyId);
        await db.update(runtimeServiceAllocations).set({ metadata: sql`coalesce(${runtimeServiceAllocations.metadata}, '{}'::jsonb) || ${JSON.stringify({ dataExpiration: {
          policyRevision: policy.revision, retainedDataSeconds: policy.config.retainedDataSeconds, state: "protected", expiresAt: null, checkedAt: options.now().toISOString(),
          blockers: ["Retention could not confirm that these files are unused and owned by this workspace. Data remains protected; the dependency check will retry."],
        } })}::jsonb` }).where(and(eq(runtimeServiceAllocations.companyId, candidate.companyId), eq(runtimeServiceAllocations.id, candidate.id), isNull(runtimeServiceAllocations.dataDeletionId)));
      }
    }
  }
  async function tick() {
    const jobs = await db.select({ id: runtimeServiceDataDeletions.id, companyId: runtimeServiceDataDeletions.companyId }).from(runtimeServiceDataDeletions)
      .where(and(or(inArray(runtimeServiceDataDeletions.state, ["pending", "deleting"]), and(eq(runtimeServiceDataDeletions.state, "failed"), isNotNull(runtimeServiceDataDeletions.retryAt))),
        or(isNull(runtimeServiceDataDeletions.retryAt), sql`${runtimeServiceDataDeletions.retryAt} <= ${options.now().toISOString()}::timestamptz`)))
      .orderBy(asc(runtimeServiceDataDeletions.updatedAt)).limit(4);
    await Promise.all(jobs.map((job) => reconcile(job.companyId, job.id)));
  }
  return { review: async (companyId: string, serviceId: string) => await taskWorkspace.supports(companyId, serviceId) ? taskWorkspace.review(companyId, serviceId) : (await inspect(db, companyId, serviceId)).plan, request: (companyId: string, serviceId: string, actor: RuntimeServiceActor, input: DeleteRuntimeServiceData) => request(companyId, serviceId, actor, input), reconcile, tick, expirationTick };
}
