import { guardRuntimeServiceMutations, withRuntimeServiceMutation } from "../task-admission.js";
import { runtimeServiceDataExpirationView } from "./retention-expiry.js";
import { remoteRuntimeServiceProcessOwner } from "./remote-process-handoff.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import {
  activityLog, agents, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues,
  runtimeServiceAllocations, runtimeServiceCompanyPolicies, runtimeServiceDataDeletions, runtimeServiceEvents, runtimeServices, runtimeServiceTaskWorkspaces, type Db,
} from "@paperclipai/db";
import {
  effectiveRuntimeServicePolicy, resolveRuntimeServicePolicy, type CreateRuntimeService, type RuntimeService,
  type RuntimeServiceAction, type RuntimeServiceDesiredState, type RuntimeServicePolicy, type RegisterRuntimeService,
} from "@paperclipai/shared";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../../errors.js";
import type { RuntimeServiceProcessRef, RuntimeServiceProvider, RuntimeServiceProviderContext } from "./provider.js";
import { RuntimeServiceFault, runtimeServiceFailureMessage } from "./fault.js";
import { assertRuntimeServiceLeaseDataAvailable, lockRuntimeServiceEnvironment, lockRuntimeServiceLease, lockRuntimeServiceWorkspace } from "./retention.js";
import { assertLocalPathDataAvailable, assertTaskWorkspaceDataAvailable, lockTaskWorkspaceDataAdmission } from "./workspace-data-fence.js";
import { assertServiceEnvironmentCompany, type RuntimeServiceAllocationRequest } from "./provisioning.js";
import { assertRuntimeServiceCapacity, createRuntimeServiceCompanyPolicyStore, lockRuntimeServiceCompany, readRuntimeServiceCompanyPolicy, reservesRunningCapacity } from "./company-policy.js";
import type { RuntimeServiceWorkKind } from "./controller.js";
import { attachRuntimeServiceTaskWorkspace, detachRuntimeServiceTaskWorkspace } from "./task-workspace.js";
import { createRuntimeServiceStorageStore, emptyRuntimeServiceStorage } from "./storage.js";
import { createRuntimeServiceDataDeletionStore, runtimeServiceDataDeletionView } from "./data-deletion.js";
import { createRuntimeServiceControllerOwnership, type RuntimeServiceControllerOwnership } from "./controller-ownership.js";

type Row = typeof runtimeServices.$inferSelect;
type Allocation = typeof runtimeServiceAllocations.$inferSelect;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type RuntimeServiceActor = { type: "board" | "agent" | "system"; id: string; runId?: string | null };
const SYSTEM: RuntimeServiceActor = { type: "system", id: "runtime-services" };
const CONTROL_LEASE_MS = 60_000;

export interface RuntimeServicePlacement {
  provider: string;
  cwd: string;
  reuseKey: string;
  environmentLeaseId?: string | null;
  executionWorkspaceId?: string | null;
  metadata?: Record<string, unknown>;
  ownedEnvironment?: RuntimeServiceAllocationRequest;
}

function digest(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
    : input && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : input;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function processRef(row: Row, includeRetired = false): RuntimeServiceProcessRef | null {
  return row.processRef && (includeRetired || !row.processRef.retired) && typeof row.processRef.generation === "string"
    ? row.processRef as RuntimeServiceProcessRef : null;
}

export function runtimeServiceView(row: Row, allocation: Allocation, companyPolicy?: Awaited<ReturnType<typeof readRuntimeServiceCompanyPolicy>>, taskWorkspaceIssueId?: string | null, deletion?: typeof runtimeServiceDataDeletions.$inferSelect | null): RuntimeService {
  return {
    id: row.id, companyId: row.companyId, name: row.name, purpose: row.purpose as RuntimeService["purpose"],
    provider: allocation.provider, allocationId: row.allocationId, issueId: row.issueId,
    storageUsage: allocation.storageUsage ?? emptyRuntimeServiceStorage, dataDeletion: runtimeServiceDataDeletionView(deletion),
    startedByRunId: row.startedByRunId, createdByAgentId: row.createdByAgentId,
    executionWorkspaceId: allocation.executionWorkspaceId,
    taskWorkspace: taskWorkspaceIssueId ? { issueId: taskWorkspaceIssueId } : null,
    canAttachTaskWorkspace: row.state !== "deleted" && !allocation.dataDeletionId && !taskWorkspaceIssueId && allocation.provider === "daytona" && !allocation.executionWorkspaceId &&
      Boolean(allocation.metadata.allocationRequest && allocation.metadata.provisionedAt && !allocation.metadata.provisioningError && allocation.metadata.retentionReleased !== true),
    retention: {
      expiration: runtimeServiceDataExpirationView(allocation.metadata, companyPolicy),
      state: allocation.dataDeletionId ? allocation.metadata.retentionReleased === true ? "released" : "deleting" : allocation.metadata.retentionError ? "failed" : allocation.metadata.retentionVerifiedAt || allocation.provider === "local" ? "retained" : "pending",
      error: allocation.metadata.retentionError ? "Service data retention could not be verified. Check the provider connection before cleaning up its environment." : null,
      compute: ["running", "retained", "stopped"].includes(String(allocation.metadata.computeState)) ? allocation.metadata.computeState as "running" | "retained" | "stopped" : "unknown",
    },
    state: row.state as RuntimeService["state"], desiredState: row.desiredState as RuntimeServiceDesiredState,
    revision: row.revision, policy: row.policy, endpoints: row.endpoints,
    ...(row.processHandoff ? { handoff: { mode: "relaunch" as const, phase: row.processHandoff.phase } } : {}),
    ...(companyPolicy ? { effectivePolicy: effectiveRuntimeServicePolicy(row.policy, companyPolicy.config), companyPolicyRevision: companyPolicy.revision, companyMaxRunningSeconds: companyPolicy.config.maxRunningSeconds } : {}),
    lastActivityAt: row.lastActivityAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null,
    previewActivity: { lastSignalAt: row.previewLastSignalAt?.toISOString() ?? null },
    stoppedAt: row.stoppedAt?.toISOString() ?? null, restartCount: row.restartCount,
    error: row.error, stopReason: row.stopReason, detailPath: `/runtime-services/${row.id}`,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

async function audit(tx: Transaction, row: Row, actor: RuntimeServiceActor, kind: string, details: Record<string, unknown> = {}, requestKey?: string) {
  await tx.insert(runtimeServiceEvents).values({ companyId: row.companyId, serviceId: row.id, actor, kind, revision: row.revision, details, requestKey });
  await tx.insert(activityLog).values({
    companyId: row.companyId, actorType: actor.type === "board" ? "user" : actor.type,
    actorId: actor.id, agentId: actor.type === "agent" ? actor.id : null,
    runId: actor.runId ?? null, action: `runtime_service.${kind}`, entityType: "runtime_service", entityId: row.id,
    details: { ...details, issueId: details.issueId ?? row.issueId, revision: row.revision },
  });
}

export function createRuntimeServiceManager(db: Db, options: {
  providers: RuntimeServiceProvider[];
  resolveEnvironment?: (row: Row, allocation: Allocation) => Promise<{ env: Record<string, string>; secrets: string[] }>;
  persistEnvironment?: (tx: Transaction, row: Row, actor: RuntimeServiceActor) => Promise<void>;
  prepareAllocation?: (companyId: string, allocationId: string) => Promise<void>;
  dataDeletionExecutor?: Parameters<typeof createRuntimeServiceDataDeletionStore>[1]["executor"];
  exposeEndpoint?: (row: Row, endpoint: { name: string; port: number }) => Promise<{ url: string; verifiedAt: string | null; error?: string | null }>;
  clock?: () => Date;
  controllerOwnership?: RuntimeServiceControllerOwnership;
}) {
  const providers = new Map(options.providers.map((provider) => [provider.key, provider]));
  const now = options.clock ?? (() => new Date());
  const controllerOwnership = options.controllerOwnership ?? createRuntimeServiceControllerOwnership();
  let controllerRecovery: Promise<void> | undefined;
  let controllerRecoveryAt = -Infinity;
  const storage = createRuntimeServiceStorageStore(db, providers, now);
  const dataDeletion = createRuntimeServiceDataDeletionStore(db, { now, executor: options.dataDeletionExecutor,
    clearEnvironment: (tx, row) => options.persistEnvironment?.(tx, { ...row, spec: { ...row.spec, env: {} } }, SYSTEM) ?? Promise.resolve() });
  const companyPolicies = createRuntimeServiceCompanyPolicyStore(db, { now, auditStop: (tx, row, actor) => audit(tx, row, actor, "company_limit_stop", { reason: row.stopReason }) });

  async function reconciliationCandidates(kind: RuntimeServiceWorkKind, limit: number, excludedIds: string[] = []) {
    await recoverDeadControllers();
    if (kind === "retain") {
      const retainedProviders = [...providers.values()].filter((provider) => provider.retainAllocation).map((provider) => provider.key);
      if (!retainedProviders.length) return [];
      return db.select({ id: runtimeServiceAllocations.id, companyId: runtimeServiceAllocations.companyId }).from(runtimeServiceAllocations)
        .where(and(inArray(runtimeServiceAllocations.provider, retainedProviders), isNull(runtimeServiceAllocations.dataDeletionId), sql`coalesce(${runtimeServiceAllocations.metadata}->>'retentionReleased', 'false') <> 'true'`,
          excludedIds.length ? notInArray(runtimeServiceAllocations.id, excludedIds) : undefined,
          or(sql`${runtimeServiceAllocations.metadata}->>'reconciledAt' IS NULL`, lt(runtimeServiceAllocations.updatedAt, new Date(now().getTime() - 60_000)))))
        .orderBy(asc(runtimeServiceAllocations.updatedAt), asc(runtimeServiceAllocations.id)).limit(limit);
    }
    return db.select({ id: runtimeServices.id, companyId: runtimeServices.companyId }).from(runtimeServices)
      .where(and(
        kind === "stop" ? eq(runtimeServices.state, "stopping")
          : and(eq(runtimeServices.desiredState, "running"), kind === "start" ? inArray(runtimeServices.state, ["pending", "starting"]) : or(
            inArray(runtimeServices.state, ["ready", "unhealthy"]),
            and(eq(runtimeServices.state, "failed"), sql`${runtimeServices.startedAt} IS NOT NULL`, or(
              sql`${now().toISOString()}::timestamptz >= ${runtimeServices.startedAt} + (${runtimeServices.policy}->>'maxRunningSeconds')::int * interval '1 second'`,
              sql`exists (select 1 from ${runtimeServiceCompanyPolicies} where ${runtimeServiceCompanyPolicies.companyId} = ${runtimeServices.companyId} and ${now().toISOString()}::timestamptz >= ${runtimeServices.startedAt} + (${runtimeServiceCompanyPolicies.config}->>'maxRunningSeconds')::int * interval '1 second')`,
            )),
          )),
        excludedIds.length ? notInArray(runtimeServices.id, excludedIds) : undefined,
        or(isNull(runtimeServices.controllerId), lt(runtimeServices.controllerExpiresAt, now())),
      )).orderBy(asc(runtimeServices.updatedAt), asc(runtimeServices.id)).limit(limit);
  }

  async function recoverDeadControllers() {
    if (controllerRecovery) return controllerRecovery;
    if (now().getTime() - controllerRecoveryAt < 2_000) return;
    controllerRecoveryAt = now().getTime();
    controllerRecovery = (async () => {
      const prefix = await controllerOwnership.prefix();
      if (!prefix) return;
      const claims = await db.select({ id: runtimeServices.id, companyId: runtimeServices.companyId,
        controllerId: runtimeServices.controllerId, expiresAt: runtimeServices.controllerExpiresAt }).from(runtimeServices)
        .innerJoin(runtimeServiceAllocations, and(eq(runtimeServiceAllocations.id, runtimeServices.allocationId), eq(runtimeServiceAllocations.companyId, runtimeServices.companyId)))
        // Remote provider requests may still be executing after their caller
        // dies; those leases need provider-side fencing before early recovery.
        .where(and(eq(runtimeServiceAllocations.provider, "local"), sql`${runtimeServices.controllerId} LIKE ${`${prefix}%`}`, gt(runtimeServices.controllerExpiresAt, now())))
        .orderBy(asc(runtimeServices.controllerExpiresAt), asc(runtimeServices.id)).limit(64);
      for (const claim of claims) {
        if (!claim.controllerId || !claim.expiresAt || !await controllerOwnership.isDead(claim.controllerId)) continue;
        // Never erase a successor's claim or a lease changed during inspection.
        await db.update(runtimeServices).set({ controllerId: null, controllerExpiresAt: null })
          .where(and(eq(runtimeServices.id, claim.id), eq(runtimeServices.companyId, claim.companyId),
            eq(runtimeServices.controllerId, claim.controllerId), eq(runtimeServices.controllerExpiresAt, claim.expiresAt)));
      }
    })().finally(() => { controllerRecovery = undefined; });
    return controllerRecovery;
  }

  async function getRecord(companyId: string, serviceId: string) {
    const [result] = await db.select({ service: runtimeServices, allocation: runtimeServiceAllocations, dataDeletion: runtimeServiceDataDeletions })
      .from(runtimeServices).innerJoin(runtimeServiceAllocations, and(
        eq(runtimeServiceAllocations.id, runtimeServices.allocationId), eq(runtimeServiceAllocations.companyId, runtimeServices.companyId),
      )).leftJoin(runtimeServiceDataDeletions, and(eq(runtimeServiceDataDeletions.id, runtimeServiceAllocations.dataDeletionId), eq(runtimeServiceDataDeletions.companyId, runtimeServices.companyId)))
      .where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.id, serviceId)));
    if (!result) throw notFound("Service not found");
    return result;
  }

  async function checkReferences(tx: Transaction, companyId: string, input: CreateRuntimeService, placement: RuntimeServicePlacement, actor: RuntimeServiceActor) {
    if (placement.provider === "local") {
      await lockTaskWorkspaceDataAdmission(tx);
      await assertLocalPathDataAvailable(tx, placement.cwd);
    }
    if (placement.executionWorkspaceId) await assertTaskWorkspaceDataAvailable(tx, companyId, placement.executionWorkspaceId);
    if (placement.ownedEnvironment) {
      if (actor.type !== "board") throw forbidden("Only an operator can allocate a service outside an active run");
      const requested = placement.ownedEnvironment;
      await lockRuntimeServiceEnvironment(tx, requested.environmentId);
      const [environment] = await tx.select().from(environments).where(eq(environments.id, requested.environmentId)).for("update");
      if (!environment || environment.status !== "active" || environment.driver !== "sandbox") throw conflict("The selected service environment is unavailable");
      await assertServiceEnvironmentCompany(tx, companyId, requested.environmentId);
      if (digest(environment.config) !== digest(requested.baseConfig)) throw conflict("The environment configuration changed; retry service creation");
    }
    if (input.issueId && !(await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, companyId))))[0]) throw notFound("Task not found");
    if (actor.type === "agent" && !(await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, actor.id), eq(agents.companyId, companyId))))[0]) throw notFound("Agent not found");
    if (actor.runId) {
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.companyId, companyId)));
      if (!run || actor.type !== "agent" || run.agentId !== actor.id) throw notFound("Run not found");
    }
    if (placement.environmentLeaseId) {
      let [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, placement.environmentLeaseId), eq(environmentLeases.companyId, companyId)));
      if (!lease) throw notFound("Environment lease not found");
      if (lease.environmentId) {
        await lockRuntimeServiceEnvironment(tx, lease.environmentId);
        if (!(await tx.select({ id: environments.id }).from(environments).where(eq(environments.id, lease.environmentId)))[0]) throw conflict("The service environment was removed");
      }
      await lockRuntimeServiceLease(tx, lease);
      await assertRuntimeServiceLeaseDataAvailable(tx, lease);
      [lease] = await tx.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)).for("update");
      if (!lease || !["active", "retained", "released"].includes(lease.status)) throw conflict("Environment is being cleaned up; it cannot accept a service");
      if ((lease.metadata?.remoteExecutionTermination as { state?: string } | undefined)?.state === "destroyed") throw conflict("The service environment was deleted; retained state must be recovered before starting a service");
    }
    if (placement.executionWorkspaceId) {
      await lockRuntimeServiceWorkspace(tx, companyId, placement.executionWorkspaceId);
      const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, placement.executionWorkspaceId), eq(executionWorkspaces.companyId, companyId))).for("update");
      if (!workspace) throw notFound("Workspace not found");
      if (workspace.closedAt || ["closed", "archived", "cleanup_failed"].includes(workspace.status)) throw conflict("Workspace is closed or being cleaned up; reopen it before creating a service");
    }
  }

  async function registrationOwner(companyId: string, actor: RuntimeServiceActor, placement: RuntimeServicePlacement, reader: Pick<Db, "select"> = db) {
    if (actor.type !== "agent" || !actor.runId || !placement.environmentLeaseId) throw forbidden("Existing process registration requires an authenticated active agent run");
    const [run] = await reader.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, actor.id), eq(heartbeatRuns.status, "running")));
    const [lease] = await reader.select().from(environmentLeases).where(and(eq(environmentLeases.id, placement.environmentLeaseId), eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, actor.runId), eq(environmentLeases.status, "active")));
    const boundary = lease?.metadata?.runtimeServiceBoundary as { provider?: unknown; workspaceRoot?: unknown } | undefined;
    if (placement.provider === "daytona") {
      try {
        const remote = remoteRuntimeServiceProcessOwner(lease, run);
        return { pid: remote.process.pid, startedAt: run!.processStartedAt!.toISOString(), workspaceRoot: remote.workspaceRoot, remote, remoteScope: lease!.metadata?.runtimeServiceRunScope };
      } catch (error) {
        if (error instanceof RuntimeServiceFault) throw unprocessable(error.message);
        throw error;
      }
    }
    // Host PIDs must never be interpreted as sandbox PIDs (or vice versa).
    if (placement.provider !== "local" || boundary?.provider !== "local" || typeof boundary.workspaceRoot !== "string") throw unprocessable(new RuntimeServiceFault("registration_unavailable").message);
    if (!run?.processPid || !run.processStartedAt) throw unprocessable(new RuntimeServiceFault("process_ownership_unverified").message);
    return { pid: run.processPid, startedAt: run.processStartedAt.toISOString(), workspaceRoot: boundary.workspaceRoot };
  }

  async function create(companyId: string, actor: RuntimeServiceActor, input: CreateRuntimeService, placement: RuntimeServicePlacement, sourcePid?: number) {
    if (!providers.has(placement.provider)) throw unprocessable("This service provider is unavailable");
    const creationKey = `${actor.type}:${actor.id}:${input.requestId}`;
    // Lease rows change between runs even when the physical allocation and
    // execution boundary are identical. They are provenance, not request identity.
    const inputHash = digest({ input, ...(sourcePid === undefined ? {} : { sourcePid }), placement: {
      provider: placement.provider, cwd: placement.cwd, reuseKey: placement.reuseKey,
      executionWorkspaceId: placement.executionWorkspaceId ?? null, metadata: placement.metadata ?? {},
    } });
    async function priorRegistration() {
      const [prior] = await db.select().from(runtimeServices).where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.creationKey, creationKey)));
      if (!prior) return null;
      const [event] = await db.select().from(runtimeServiceEvents).where(and(eq(runtimeServiceEvents.serviceId, prior.id), eq(runtimeServiceEvents.kind, "created")));
      if (event?.details.inputHash !== inputHash) throw conflict("This request ID was already used for a different service");
      return get(companyId, prior.id);
    }
    let captured: { key: string; receipt: Record<string, unknown> } | undefined;
    let capturedOwner: Awaited<ReturnType<typeof registrationOwner>> | undefined;
    if (sourcePid !== undefined) {
      // The original may already be gone after an accepted/lost response.
      const prior = await priorRegistration();
      if (prior) return prior;
      const provider = providers.get(placement.provider)!;
      if (!provider.captureExistingProcess || !provider.stopExistingProcess) throw unprocessable(new RuntimeServiceFault("registration_unavailable").message);
      try {
        capturedOwner = await registrationOwner(companyId, actor, placement);
        captured = await provider.captureExistingProcess({ pid: sourcePid, owner: capturedOwner, cwd: placement.cwd, workspaceRoot: capturedOwner.workspaceRoot, environmentLeaseId: placement.environmentLeaseId,
          authority: { companyId, runId: actor.runId! } });
      } catch (error) {
        // Another copy of this request may have committed while capture ran.
        const prior = await priorRegistration();
        if (prior) return prior;
        if (error instanceof HttpError) throw error;
        throw unprocessable(error instanceof RuntimeServiceFault ? error.message : new RuntimeServiceFault("process_ownership_unverified").message);
      }
    }
    const handoffKey = captured ? digest({ provider: placement.provider, key: captured.key }) : undefined;
    const id = await db.transaction(async (tx) => {
      await lockRuntimeServiceCompany(tx, companyId);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${companyId + creationKey}))`);
      const [prior] = await tx.select().from(runtimeServices).where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.creationKey, creationKey)));
      if (prior) {
        const [event] = await tx.select().from(runtimeServiceEvents).where(and(eq(runtimeServiceEvents.serviceId, prior.id), eq(runtimeServiceEvents.kind, "created")));
        if (event?.details.inputHash !== inputHash) throw conflict("This request ID was already used for a different service");
        return prior.id;
      }
      if (captured) {
        const currentOwner = await registrationOwner(companyId, actor, placement, tx);
        if (digest(currentOwner) !== digest(capturedOwner)) throw unprocessable(new RuntimeServiceFault("process_ownership_unverified").message);
        const [existing] = await tx.select({ id: runtimeServices.id }).from(runtimeServices).where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.processHandoffKey, handoffKey!)));
        if (existing) throw conflict("This command is already registered. Inspect the existing service instead.", { serviceId: existing.id });
      }
      const [existingAllocation] = await tx.select().from(runtimeServiceAllocations).where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.reuseKey, placement.reuseKey)));
      if (existingAllocation?.metadata.retentionReleased === true || existingAllocation?.dataDeletionId) throw conflict("This allocation was released or is being deleted; choose a new workspace");
      const companyPolicy = await assertRuntimeServiceCapacity(tx, companyId, { running: input.start, allocation: !existingAllocation });
      await checkReferences(tx, companyId, input, placement, actor);
      const placementIdentity = digest({ metadata: placement.metadata ?? {}, executionWorkspaceId: placement.executionWorkspaceId ?? null });
      let reservedLeaseId = placement.environmentLeaseId;
      if (placement.ownedEnvironment) {
        const [lease] = await tx.insert(environmentLeases).values({ companyId, environmentId: placement.ownedEnvironment.environmentId,
          issueId: input.issueId, executionWorkspaceId: placement.executionWorkspaceId, provider: placement.provider,
          status: "retained", leasePolicy: "reuse_by_environment", metadata: { serviceAllocationPending: true },
        }).returning();
        reservedLeaseId = lease!.id;
      }
      await tx.insert(runtimeServiceAllocations).values({
        companyId, provider: placement.provider, reuseKey: placement.reuseKey, cwd: placement.cwd,
        executionWorkspaceId: placement.executionWorkspaceId, environmentLeaseId: reservedLeaseId, metadata: { ...placement.metadata, placementIdentity },
      }).onConflictDoNothing({ target: [runtimeServiceAllocations.companyId, runtimeServiceAllocations.reuseKey] });
      const [allocation] = await tx.select().from(runtimeServiceAllocations).where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.reuseKey, placement.reuseKey))).for("update");
      if (!allocation || allocation.provider !== placement.provider || allocation.cwd !== placement.cwd || allocation.metadata.placementIdentity !== placementIdentity) throw conflict("Service allocation identity changed");
      if (allocation.environmentLeaseId !== (reservedLeaseId ?? null)) {
        // A subsequent run gets a new lease on the same physical allocation.
        // Keep the service's durable lease, but prove the incoming claim names
        // the same environment/provider/worker before reusing its files.
        const leases = allocation.environmentLeaseId && placement.environmentLeaseId
          ? await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, companyId), inArray(environmentLeases.id, [allocation.environmentLeaseId, placement.environmentLeaseId]))) : [];
        const oldLease = leases.find((lease) => lease.id === allocation.environmentLeaseId);
        const newLease = leases.find((lease) => lease.id === placement.environmentLeaseId);
        const same = oldLease && newLease && oldLease.environmentId === newLease.environmentId && oldLease.provider === newLease.provider
          && (allocation.provider === "local" || (oldLease.providerLeaseId && oldLease.providerLeaseId === newLease.providerLeaseId && oldLease.metadata?.pluginId === newLease.metadata?.pluginId))
          && ["active", "retained", "released"].includes(oldLease.status);
        if (!same) throw conflict("Service allocation identity changed");
      }
      const [row] = await tx.insert(runtimeServices).values({
        companyId, allocationId: allocation.id, name: input.name, purpose: input.purpose,
        issueId: input.issueId, startedByRunId: actor.runId, createdByAgentId: actor.type === "agent" ? actor.id : null,
        createdByUserId: actor.type === "board" ? actor.id : null, creationKey,
        ...(captured ? { processHandoffKey: handoffKey, processHandoff: { version: 1 as const, sourceRunId: actor.runId!, phase: "pending" as const, receipt: captured.receipt }, startedAt: now() } : {}),
        spec: { command: input.command, cwd: placement.cwd, env: input.env, endpoints: input.endpoints },
        policy: resolveRuntimeServicePolicy(input.purpose, { idleSeconds: input.purpose === "preview" ? companyPolicy.previewIdleSeconds : companyPolicy.workerIdleSeconds, ...input.policy }),
        state: input.start ? "pending" : "stopped", desiredState: input.start ? "running" : "stopped", lastActivityAt: now(),
      }).returning();
      await options.persistEnvironment?.(tx, row!, actor);
      await audit(tx, row!, actor, "created", { inputHash, ...(captured ? { handoff: "relaunch", sourceRunId: actor.runId } : {}) }, creationKey);
      return row!.id;
    });
    const record = await getRecord(companyId, id);
    if (!record.allocation.metadata.allocationRequest) await reconcileAllocation(companyId, record.allocation.id);
    return get(companyId, id);
  }

  async function get(companyId: string, id: string) {
    const { service, allocation, dataDeletion: deletion } = await getRecord(companyId, id);
    const [binding] = await db.select({ issueId: runtimeServiceTaskWorkspaces.issueId }).from(runtimeServiceTaskWorkspaces)
      .where(and(eq(runtimeServiceTaskWorkspaces.companyId, companyId), eq(runtimeServiceTaskWorkspaces.allocationId, allocation.id)));
    return runtimeServiceView(service, allocation, await readRuntimeServiceCompanyPolicy(db, companyId), binding?.issueId, deletion);
  }

  async function mutate(companyId: string, id: string, actor: RuntimeServiceActor, requestId: string, expectedRevision: number, kind: string, input: unknown, patch: (row: Row, tx: Transaction) => Partial<typeof runtimeServices.$inferInsert> | Promise<Partial<typeof runtimeServices.$inferInsert>>, options: { allowDeleted?: boolean; auditDetails?: Record<string, unknown>; expectedPolicy?: RuntimeServicePolicy } = {}) {
    await db.transaction(async (tx) => {
      await lockRuntimeServiceCompany(tx, companyId);
      const [row] = await tx.select().from(runtimeServices).where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.id, id))).for("update");
      if (!row) throw notFound("Service not found");
      const requestKey = `${actor.type}:${actor.id}:${requestId}`;
      const inputHash = digest({ kind, input });
      const [prior] = await tx.select().from(runtimeServiceEvents).where(and(eq(runtimeServiceEvents.serviceId, id), eq(runtimeServiceEvents.requestKey, requestKey)));
      if (prior) {
        if (prior.details.inputHash !== inputHash) throw conflict("This request ID was already used for a different action");
        return;
      }
      const [allocation] = await tx.select({ deletionId: runtimeServiceAllocations.dataDeletionId }).from(runtimeServiceAllocations)
        .where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.id, row.allocationId)));
      if (allocation?.deletionId) throw conflict("This workspace is being deleted or has been deleted; service changes are unavailable");
      if (row.revision < expectedRevision || (options.expectedPolicy
        ? digest(row.policy) !== digest(options.expectedPolicy)
        : row.revision !== expectedRevision)) {
        throw conflict(options.expectedPolicy ? "Service lifetime changed; load the current lifetime before retrying" : "Service changed; refresh before retrying", { revision: row.revision });
      }
      if (row.state === "deleted" && !options.allowDeleted) throw conflict("This service was deleted");
      const [next] = await tx.update(runtimeServices).set({ ...await patch(row, tx), revision: row.revision + 1, updatedAt: now() }).where(eq(runtimeServices.id, id)).returning();
      await audit(tx, next!, actor, kind, { ...options.auditDetails, inputHash }, requestKey);
    });
    return get(companyId, id);
  }

  async function control(companyId: string, id: string, actor: RuntimeServiceActor, input: { requestId: string; expectedRevision: number; action: RuntimeServiceAction }) {
    return mutate(companyId, id, actor, input.requestId, input.expectedRevision, input.action, { action: input.action }, async (row, tx) => {
      const desiredState = ({ start: "running", restart: "running", stop: "stopped", sleep: "sleeping", delete: "deleted" } as const)[input.action];
      if (desiredState === "running") await assertRuntimeServiceCapacity(tx, companyId, { running: true, alreadyReserved: reservesRunningCapacity(row) });
      const restarting = input.action === "restart" || (input.action === "start" && row.state === "failed");
      return {
        desiredState, state: desiredState === "running" ? (row.state === "ready" && !restarting ? "ready" : "pending") : "stopping",
        stopReason: restarting ? "restart_requested" : desiredState === "running" ? null : input.action === "sleep" ? "idle" : "manual",
        ...(desiredState === "running" ? { restartCount: 0, retryAt: null, error: null, lastActivityAt: now() } : {}),
      };
    });
  }

  async function context(row: Row, allocation: Allocation, forLaunch = false): Promise<RuntimeServiceProviderContext> {
    const process = processRef(row, true);
    if (!process) throw new Error("Missing service generation");
    // Inspection, termination, and saved logs must still work after a secret
    // expires or access to a launch credential is revoked.
    const resolved = !forLaunch ? { env: {}, secrets: [] } : options.resolveEnvironment ? await options.resolveEnvironment(row, allocation) : {
      env: Object.fromEntries(Object.entries(row.spec.env).map(([key, binding]) => {
        if (binding.type !== "plain") throw new Error("Secret resolution is unavailable for this service");
        return [key, binding.value];
      })), secrets: [],
    };
    return { companyId: row.companyId, serviceId: row.id, allocationId: allocation.id, environmentLeaseId: allocation.environmentLeaseId, allocationMetadata: allocation.metadata, spec: row.spec, process, ...resolved };
  }

  async function reconcileAllocation(companyId: string, allocationId: string) {
    const [fenced] = await db.select({ deletionId: runtimeServiceAllocations.dataDeletionId }).from(runtimeServiceAllocations)
      .where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.id, allocationId)));
    if (fenced?.deletionId) return;
    try { await options.prepareAllocation?.(companyId, allocationId); }
    catch {
      await db.update(runtimeServiceAllocations).set({ metadata: sql`jsonb_set(${runtimeServiceAllocations.metadata}, '{retentionError}', 'true'::jsonb)`, updatedAt: now() })
        .where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.id, allocationId)));
      return;
    }
    await db.transaction(async (tx) => {
      const lock = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${`runtime-service-retention:${allocationId}`})) as acquired`);
      if (!lock[0]?.acquired) return;
      const [allocation] = await tx.select().from(runtimeServiceAllocations).where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.id, allocationId)));
      if (!allocation || allocation.dataDeletionId || allocation.metadata.retentionReleased === true) return;
      // A saved, never-started service reserves identity without renting compute.
      if (allocation.metadata.allocationRequest && !allocation.metadata.provisionedAt) return;
      const provider = providers.get(allocation.provider);
      if (!provider?.retainAllocation) return;
      const services = await tx.select().from(runtimeServices).where(and(eq(runtimeServices.allocationId, allocationId), eq(runtimeServices.companyId, companyId)));
      const row = services[0];
      if (!row) return;
      const ctx = await context({ ...row, processRef: row.processRef ?? { generation: row.id } }, allocation);
      try {
        // Retained data is independent of service/process state, including a
        // stopped service that has never launched. The host's allocation lock
        // serializes these calls with run admission and provider teardown.
        await provider.retainAllocation(ctx);
        const live = services.some((service) => service.desiredState === "running" || Boolean(processRef(service)) || service.processHandoff?.phase === "pending");
        const computeState = live ? "retained" : provider.releaseCompute ? await provider.releaseCompute(ctx) : "retained";
        await tx.update(runtimeServiceAllocations).set({
          metadata: { ...allocation.metadata, retentionVerifiedAt: now().toISOString(), retentionError: null, computeState, reconciledAt: now().toISOString() }, updatedAt: now(),
        }).where(eq(runtimeServiceAllocations.id, allocationId));
      } catch {
        await tx.update(runtimeServiceAllocations).set({ metadata: { ...allocation.metadata, retentionError: true, reconciledAt: now().toISOString() }, updatedAt: now() }).where(eq(runtimeServiceAllocations.id, allocationId));
      }
    });
  }

  async function reconcile(companyId: string, id: string) {
    const controllerId = await controllerOwnership.claimId();
    const [claimed] = await db.update(runtimeServices).set({ controllerId, controllerExpiresAt: new Date(now().getTime() + CONTROL_LEASE_MS) })
      .where(and(eq(runtimeServices.id, id), eq(runtimeServices.companyId, companyId), or(isNull(runtimeServices.controllerId), lt(runtimeServices.controllerExpiresAt, now())))).returning();
    if (!claimed) return;
    const renew = setInterval(() => {
      void db.update(runtimeServices).set({ controllerExpiresAt: new Date(now().getTime() + CONTROL_LEASE_MS) })
        .where(and(eq(runtimeServices.id, id), eq(runtimeServices.controllerId, controllerId))).catch(() => {});
    }, CONTROL_LEASE_MS / 3);
    renew.unref();
    let observingProvider = false;
    let stoppingProvider = false;
    let expectedFailureRevision = claimed.revision;
    async function change(patch: Partial<typeof runtimeServices.$inferInsert>, kind: string, expectedRevision?: number) {
      return db.transaction(async (tx) => {
        const [row] = await tx.update(runtimeServices).set({ ...patch, revision: sql`${runtimeServices.revision} + 1`, updatedAt: now() })
          .where(and(eq(runtimeServices.id, id), eq(runtimeServices.controllerId, controllerId), expectedRevision === undefined ? undefined : eq(runtimeServices.revision, expectedRevision))).returning();
        if (row) {
          if (row.state === "deleted") await options.persistEnvironment?.(tx, { ...row, spec: { ...row.spec, env: {} } }, SYSTEM);
          await audit(tx, row, SYSTEM, kind);
        }
        return row;
      });
    }
    try {
      let { service: row, allocation } = await getRecord(companyId, id);
      if (allocation.dataDeletionId) return;
      expectedFailureRevision = row.revision;
      if (row.desiredState === "running" && allocation.metadata.allocationRequest && !allocation.metadata.provisionedAt) {
        await options.prepareAllocation?.(companyId, allocation.id);
        ({ service: row, allocation } = await getRecord(companyId, id));
        expectedFailureRevision = row.revision;
      }
      if (row.desiredState === "running" && allocation.metadata.provisioningError) {
        throw new RuntimeServiceFault(allocation.metadata.provisioningError === "retention_unavailable" ? "retention_unavailable" : "launch_unavailable");
      }
      const provider = providers.get(allocation.provider);
      if (!provider) throw new Error("Service provider is unavailable");
      if (row.state === "deleted") return;
      if (row.desiredState === "running" && row.startedAt) {
        const time = now().getTime();
        const companyPolicy = await readRuntimeServiceCompanyPolicy(db, companyId);
        const policy = effectiveRuntimeServicePolicy(row.policy, companyPolicy.config);
        const maxExpired = policy.maxRunningSeconds !== null && time - row.startedAt.getTime() >= policy.maxRunningSeconds * 1000;
        const companyExpired = companyPolicy.config.maxRunningSeconds !== null && time - row.startedAt.getTime() >= companyPolicy.config.maxRunningSeconds * 1000;
        const held = row.policy.keepRunningUntil !== null && Date.parse(row.policy.keepRunningUntil) > time;
        const idle = row.policy.idleSeconds !== null && !held && time - row.lastActivityAt.getTime() >= row.policy.idleSeconds * 1000;
        if (maxExpired || idle) {
          const next = await change({ desiredState: maxExpired ? "stopped" : "sleeping", state: "stopping", stopReason: maxExpired ? (companyExpired ? "company_maximum_lifetime" : "maximum_lifetime") : "idle" }, "policy_stop", row.revision);
          if (!next) return;
          row = next;
        }
      }
      if (row.processHandoff?.phase === "pending") {
        if (!provider.stopExistingProcess) throw new RuntimeServiceFault("registration_unavailable");
        stoppingProvider = true;
        await provider.stopExistingProcess(row.processHandoff.receipt, { companyId, serviceId: row.id });
        stoppingProvider = false;
        // Confirmed physical termination remains true even if a Stop or policy
        // update changed the desired state while this handoff was in progress.
        const next = await change({ processHandoff: { ...row.processHandoff, phase: "stopped" } }, "process_handoff_stopped");
        if (!next) return;
        row = next;
        expectedFailureRevision = row.revision;
      }
      if (row.desiredState !== "running" || row.stopReason === "restart_requested") {
        expectedFailureRevision = row.revision;
        if (processRef(row)) {
          stoppingProvider = true;
          await provider.stop(await context(row, allocation));
          stoppingProvider = false;
        }
        const next = await change({
          processRef: row.processRef ? { ...row.processRef, retired: true } : null,
          endpoints: row.endpoints.map((endpoint) => ({ ...endpoint, health: "pending", status: "pending" })),
          state: row.desiredState === "running" ? "pending" : row.stopReason === "resource_configuration" && row.desiredState === "stopped" ? "failed" : row.desiredState,
          stoppedAt: now(), startedAt: null, error: row.stopReason === "resource_configuration" ? new RuntimeServiceFault("resource_configuration_mismatch").message : null,
          stopReason: row.stopReason === "restart_requested" ? null : row.stopReason,
        }, "process_stopped", row.revision);
        if (!next) return;
        if (next.desiredState !== "running") {
          await reconcileAllocation(companyId, allocation.id);
          return;
        }
        row = next;
      }
      if (row.state === "failed" || (row.retryAt && row.retryAt > now())) return;
      if (provider.retainAllocation && (!allocation.metadata.retentionVerifiedAt || allocation.metadata.retentionError)) {
        await reconcileAllocation(companyId, allocation.id);
        allocation = (await getRecord(companyId, id)).allocation;
        if (!allocation.metadata.retentionVerifiedAt || allocation.metadata.retentionError) throw new RuntimeServiceFault("retention_unavailable");
      }
      if (!processRef(row)) {
        const next = await change({ processRef: { generation: randomUUID(), launchedAt: now().toISOString() }, state: "starting", startedAt: row.startedAt ?? now() }, "starting", row.revision);
        if (!next) return;
        row = next;
      }
      expectedFailureRevision = row.revision;
      let ctx = await context(row, allocation);
      observingProvider = true;
      let observation = await provider.inspect(ctx);
      observingProvider = false;
      if (observation.state === "missing") {
        const ref = await provider.start(await context(row, allocation, true));
        const next = await change({ processRef: ref }, "process_started");
        if (!next) return;
        row = next;
        expectedFailureRevision = row.revision;
        // A stop received during launch remains authoritative and is reconciled next.
        if (row.desiredState !== "running" || row.stopReason === "restart_requested") return;
        ctx = { ...ctx, process: ref };
        observingProvider = true;
        observation = await provider.inspect(ctx);
        observingProvider = false;
      }
      // A controller can die after the durable supervisor starts but before its
      // receipt is saved here. Recover that identity before making any further
      // decisions, including failing closed if its receipt later disappears.
      if (observation.processRef) {
        if (observation.processRef.generation !== ctx.process.generation) throw new RuntimeServiceFault("supervisor_lost");
        const recovered = { ...ctx.process, ...observation.processRef };
        if (digest(recovered) !== digest(ctx.process)) {
          const next = await change({ processRef: recovered }, "process_recovered", row.revision);
          if (!next) return;
          row = next;
          expectedFailureRevision = row.revision;
          ctx = { ...ctx, process: recovered };
        }
      }
      if (observation.state !== "running") {
        await provider.stop(ctx);
        const retry = row.restartCount < row.policy.restartAttempts;
        await change({
          processRef: { ...ctx.process, retired: true }, state: retry ? "pending" : "failed", restartCount: row.restartCount + (retry ? 1 : 0),
          retryAt: retry ? new Date(now().getTime() + 1000 * 2 ** row.restartCount) : null,
          error: retry ? "Service exited; retrying" : "Service stopped after exhausting automatic restart attempts",
        }, retry ? "retry_scheduled" : "failed", row.revision);
        return;
      }
      const healthy = observation.endpoints.length === row.spec.endpoints.length && observation.endpoints.every((endpoint) => endpoint.healthy);
      const launchedAt = typeof ctx.process.launchedAt === "string" ? Date.parse(ctx.process.launchedAt) : row.startedAt?.getTime();
      const expired = launchedAt !== undefined && now().getTime() - launchedAt > row.policy.readinessTimeoutSeconds * 1000;
      const state = healthy ? "ready" : ctx.process.readyAt ? "unhealthy" : expired ? "failed" : "starting";
      if (state === "failed") await provider.stop(ctx);
      const endpoints = await Promise.all(observation.endpoints.map(async (endpoint): Promise<RuntimeService["endpoints"][number]> => {
        const result: RuntimeService["endpoints"][number] = {
          name: endpoint.name, port: endpoint.port, health: endpoint.healthy ? "ready" : "pending",
          url: null, status: "pending", error: null, verifiedAt: null,
        };
        if (!options.exposeEndpoint) return { ...result, status: "failed", error: "Preview exposure is not configured for this instance" };
        try {
          const exposure = await options.exposeEndpoint(row, endpoint);
          return { ...result, ...exposure, status: exposure.error ? "failed" : endpoint.healthy && exposure.verifiedAt ? "ready" : "pending" };
        } catch {
          // Exposure failure must not kill a healthy application or conceal why
          // its URL is unavailable. Provider tokens never enter this response.
          return { ...result, status: "failed", error: "Preview exposure is unavailable; retry after checking the provider connection" };
        }
      }));
      if (state !== row.state || row.retryAt || (healthy && !ctx.process.readyAt) || digest(endpoints.map(({ verifiedAt: _verified, ...endpoint }) => endpoint)) !== digest(row.endpoints.map(({ verifiedAt: _verified, ...endpoint }) => endpoint))) {
        await change({
          state, endpoints, retryAt: null,
          ...(healthy && row.processHandoff?.phase === "stopped" ? { processHandoff: { ...row.processHandoff, phase: "complete" as const } } : {}),
          ...(healthy && !ctx.process.readyAt ? { processRef: { ...ctx.process, readyAt: now().toISOString() } } : {}),
          error: state === "failed" ? "Service did not become ready before its startup deadline" : state === "unhealthy" ? "Service is not responding to health checks" : null,
        }, state, row.revision);
      }
    } catch (error) {
      // Provider details may contain credentials. Keep diagnostics in the bounded,
      // redacted provider log and expose a stable control-plane error here.
      if (error instanceof RuntimeServiceFault && error.code === "resource_configuration_mismatch") {
        // A configuration violation is a deliberate policy stop, not a crash.
        // Keep the generation until termination is confirmed; allocation
        // reconciliation still respects other services and active agents.
        await change({ desiredState: "stopped", state: "stopping", stopReason: "resource_configuration", error: error.message,
          retryAt: null, endpoints: [] }, "resource_configuration_stop", expectedFailureRevision);
      } else if (observingProvider && !(error instanceof RuntimeServiceFault)) {
        // A transport timeout does not establish that a process died. Keep the
        // same generation and retry observation rather than launch a duplicate.
        await change({ state: "unhealthy", retryAt: new Date(now().getTime() + 5000), error: "Service status is temporarily unavailable. Paperclip will check again." }, "observation_unavailable", expectedFailureRevision);
      } else {
        await change({ state: "failed", error: `${stoppingProvider ? "Stop could not be confirmed; this service still reserves capacity. " : ""}${runtimeServiceFailureMessage(error)}` }, "failed", expectedFailureRevision);
      }
    } finally {
      clearInterval(renew);
      await db.update(runtimeServices).set({ controllerId: null, controllerExpiresAt: null, updatedAt: now() })
        .where(and(eq(runtimeServices.id, id), eq(runtimeServices.controllerId, controllerId)));
    }
  }

  return guardRuntimeServiceMutations({
    create, get, getRecord, control, reconcile, reconcileAllocation, reconciliationCandidates,
    async attachTask(companyId: string, id: string, actor: RuntimeServiceActor, input: { requestId: string; expectedRevision: number; issueId: string }) {
      if (actor.type !== "board") throw forbidden("An operator must attach a service workspace to a task");
      return mutate(companyId, id, actor, input.requestId, input.expectedRevision, "task_attached", { issueId: input.issueId }, async (service, tx) => {
        await attachRuntimeServiceTaskWorkspace(tx, { companyId, service, issueId: input.issueId, actorId: actor.id });
        return { issueId: input.issueId };
      });
    },
    async detachTask(companyId: string, id: string, actor: RuntimeServiceActor, input: { requestId: string; expectedRevision: number; issueId: string }) {
      if (actor.type !== "board") throw forbidden("An operator must detach a service workspace from a task");
      return mutate(companyId, id, actor, input.requestId, input.expectedRevision, "task_detached", { issueId: input.issueId }, async (service, tx) => {
        await detachRuntimeServiceTaskWorkspace(tx, { companyId, service, issueId: input.issueId });
        return { issueId: service.issueId === input.issueId ? null : service.issueId };
      }, { allowDeleted: true, auditDetails: { issueId: input.issueId } });
    },
    companyPolicy: companyPolicies.get, updateCompanyPolicy: companyPolicies.update,
    async register(companyId: string, actor: RuntimeServiceActor, input: RegisterRuntimeService, placement: RuntimeServicePlacement) {
      const { sourcePid, ...spec } = input;
      return create(companyId, actor, spec, placement, sourcePid);
    },
    /** Server-private upstream only. Never serialize credentials into a service view. */
    async upstream(companyId: string, id: string, endpointName: string) {
      const { service, allocation } = await getRecord(companyId, id);
      if (service.desiredState !== "running" || !processRef(service)) throw unprocessable("Service is not running");
      if (!service.spec.endpoints.some((endpoint) => endpoint.name === endpointName)) throw notFound("Endpoint not found");
      const provider = providers.get(allocation.provider);
      if (!provider?.upstream) throw unprocessable("Provider does not support preview routing");
      return provider.upstream(await context(service, allocation), endpointName);
    },
    async previewActivity(companyId: string, id: string, visible: boolean) {
      await db.update(runtimeServices).set({ previewLastSignalAt: now(), ...(visible ? { lastActivityAt: now() } : {}) })
        .where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.id, id), eq(runtimeServices.desiredState, "running")));
    },
    storageTick: storage.tick,
    dataDeletionReview: dataDeletion.review,
    deleteData: dataDeletion.request,
    reconcileDataDeletion: dataDeletion.reconcile,
    dataDeletionTick: dataDeletion.tick,
    dataExpirationTick: dataDeletion.expirationTick,
    async storage(companyId: string, id: string) {
      const { allocation } = await getRecord(companyId, id);
      return storage.view(companyId, allocation.id);
    },
    async refreshStorage(companyId: string, id: string) {
      const { allocation } = await getRecord(companyId, id);
      return storage.refresh(companyId, allocation.id);
    },
    async list(companyId: string, issueId?: string) {
      const rows = await db.select({ service: runtimeServices, allocation: runtimeServiceAllocations, taskWorkspace: runtimeServiceTaskWorkspaces, deletion: runtimeServiceDataDeletions }).from(runtimeServices)
        .innerJoin(runtimeServiceAllocations, and(eq(runtimeServiceAllocations.id, runtimeServices.allocationId), eq(runtimeServiceAllocations.companyId, runtimeServices.companyId)))
        .leftJoin(runtimeServiceTaskWorkspaces, and(eq(runtimeServiceTaskWorkspaces.companyId, companyId), eq(runtimeServiceTaskWorkspaces.allocationId, runtimeServiceAllocations.id)))
        .leftJoin(runtimeServiceDataDeletions, and(eq(runtimeServiceDataDeletions.companyId, companyId), eq(runtimeServiceDataDeletions.id, runtimeServiceAllocations.dataDeletionId)))
        .where(and(eq(runtimeServices.companyId, companyId), issueId ? eq(runtimeServices.issueId, issueId) : undefined))
        .orderBy(asc(runtimeServices.createdAt)).limit(500);
      const companyPolicy = await readRuntimeServiceCompanyPolicy(db, companyId);
      return rows.filter(({ service, deletion }) => service.state !== "deleted" || (deletion && deletion.state !== "deleted")).map(({ service, allocation, taskWorkspace, deletion }) => runtimeServiceView(service, allocation, companyPolicy, taskWorkspace?.issueId, deletion));
    },
    async updatePolicy(companyId: string, id: string, actor: RuntimeServiceActor, input: { requestId: string; expectedRevision: number; expectedPolicy?: RuntimeServicePolicy; policy: Partial<RuntimeServicePolicy> }) {
      return mutate(companyId, id, actor, input.requestId, input.expectedRevision, "policy_changed",
        input.expectedPolicy ? { policy: input.policy, expectedPolicy: input.expectedPolicy } : input.policy,
        (row) => ({ policy: resolveRuntimeServicePolicy(row.purpose as "preview" | "worker", { ...row.policy, ...input.policy }) }),
        { expectedPolicy: input.expectedPolicy });
    },
    async updateEnvironment(companyId: string, id: string, actor: RuntimeServiceActor, input: { requestId: string; expectedRevision: number; env: CreateRuntimeService["env"] }) {
      if (actor.type !== "board") throw forbidden("An operator must authorize service environment changes");
      return mutate(companyId, id, actor, input.requestId, input.expectedRevision, "environment_changed", input.env, async (row, tx) => {
        if (row.desiredState === "running" || processRef(row)) throw conflict("Stop the service before changing its environment");
        if (row.spec.endpoints.some((endpoint) => endpoint.portEnv in input.env)) throw unprocessable("An allocated port cannot also have an environment binding");
        const spec = { ...row.spec, env: input.env };
        await options.persistEnvironment?.(tx, { ...row, spec }, actor);
        return { spec, error: null };
      });
    },
    async activity(companyId: string, id: string, visible: boolean) {
      if (!visible) return;
      await db.update(runtimeServices).set({ lastActivityAt: now() }).where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.id, id), eq(runtimeServices.desiredState, "running")));
    },
    async wake(companyId: string, id: string) {
      const current = await get(companyId, id);
      if (current.desiredState !== "sleeping") return current;
      await withRuntimeServiceMutation(() => db.transaction(async (tx) => {
        await lockRuntimeServiceCompany(tx, companyId);
        const [row] = await tx.select().from(runtimeServices).where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.id, id))).for("update");
        if (!row) throw notFound("Service not found");
        if (row.desiredState !== "sleeping") return;
        const [allocation] = await tx.select({ deletionId: runtimeServiceAllocations.dataDeletionId }).from(runtimeServiceAllocations).where(eq(runtimeServiceAllocations.id, row.allocationId));
        if (allocation?.deletionId) throw conflict("This workspace cannot wake after data deletion was requested");
        await assertRuntimeServiceCapacity(tx, companyId, { running: true, alreadyReserved: reservesRunningCapacity(row) });
        const [next] = await tx.update(runtimeServices).set({ desiredState: "running", state: "pending", stopReason: null, restartCount: 0, retryAt: null, error: null, lastActivityAt: now(), revision: row.revision + 1, updatedAt: now() }).where(eq(runtimeServices.id, id)).returning();
        await audit(tx, next!, SYSTEM, "preview_wake");
      }));
      return get(companyId, id);
    },
    async logs(companyId: string, id: string, limitBytes = 64 * 1024) {
      const { service, allocation } = await getRecord(companyId, id);
      const provider = providers.get(allocation.provider);
      if (!provider || !processRef(service, true)) return "";
      return provider.logs(await context(service, allocation), limitBytes);
    },
    async tick() {
      // Awaitable one-shot sweep for recovery tools. The application uses the
      // independently bounded controller queues for continuous reconciliation.
      for (const kind of ["stop", "observe", "start", "retain"] as const) {
        const candidates = await reconciliationCandidates(kind, kind === "retain" ? 50 : 100);
        for (let offset = 0; offset < candidates.length; offset += 8) {
          const outcomes = await Promise.allSettled(candidates.slice(offset, offset + 8).map((candidate) =>
            kind === "retain" ? reconcileAllocation(candidate.companyId, candidate.id) : reconcile(candidate.companyId, candidate.id)));
          const failed = outcomes.find((outcome) => outcome.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        }
      }
    },
  });
}

export type RuntimeServiceManager = ReturnType<typeof createRuntimeServiceManager>;
