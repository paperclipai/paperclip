import { setTimeout as delay } from "node:timers/promises";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { environmentTaskOperationSchema, environmentTaskResultSchema, type PluginEnvironmentTaskOperation, type PluginEnvironmentTaskResult } from "@paperclipai/plugin-sdk";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { lockSourceRecoveryCoordinators } from "./native-runtime/native-source-recovery-ownership.js";
import type { PluginTaskDescription } from "./environment-task-runtime.js";

type OwnershipOperation = Extract<PluginEnvironmentTaskOperation, { kind: "ensure_ownership" }>;
type OwnershipResult = Extract<PluginEnvironmentTaskResult, { kind: "ownership" }>;
type Lease = typeof environmentLeases.$inferSelect;
type OwnershipClaim = {
  sourceLeaseId: string;
  targetLeaseId: string;
  operation: OwnershipOperation;
};

export function unlaunchedPortableTaskLease() {
  const { metadata } = environmentLeases;
  const unlaunched = and(
    eq(environmentLeases.status, "active"), isNull(environmentLeases.releasedAt), isNull(environmentLeases.cleanupStatus),
    isNotNull(environmentLeases.providerLeaseId),
    or(isNull(environmentLeases.expiresAt), sql`${environmentLeases.expiresAt} > clock_timestamp()`),
    sql`${metadata}->>'driver' = 'plugin' and ${metadata}->>'runnerTaskLease' = 'true'
      and jsonb_typeof(${metadata}->'portableTaskPreviousLeaseId') = 'string'
      and not (${metadata} ?| array['portableTaskSuccessor', 'runnerTaskIdentity', 'runnerTaskStartup', 'runnerTaskStartupCleanup'])
      and coalesce(${metadata}->>'runnerTaskDispatched', 'false') = 'false'
      and coalesce(${metadata}->>'runnerTaskRetiring', 'false') = 'false'`,
  )!;
  return sql<boolean>`case when ${unlaunched} then not exists (select 1 from environment_leases other
    where other.company_id = ${environmentLeases.companyId} and other.heartbeat_run_id = ${environmentLeases.heartbeatRunId}
      and other.status = 'active' and other.id <> ${environmentLeases.id}) else false end`;
}

export function portableTaskPreparationLeaseId(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "issueId" | "agentId">) {
  return sql<string | null>`(${db.select({ id: environmentLeases.id }).from(issues).innerJoin(environmentLeases, and(
    eq(environmentLeases.companyId, issues.companyId), eq(environmentLeases.issueId, issues.id),
    eq(environmentLeases.heartbeatRunId, issues.executionRunId),
  )).where(and(eq(issues.companyId, run.companyId), run.issueId ? eq(issues.id, run.issueId) : sql`false`,
    eq(issues.executionRunId, run.id), eq(issues.assigneeAgentId, run.agentId), eq(issues.status, "in_progress"),
    sql`${environmentLeases.metadata}->>'agentId' = ${run.agentId}`, unlaunchedPortableTaskLease()))})`;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export class PluginTaskOwnershipPendingError extends Error {
  constructor() {
    super("native_portable_task_ownership_pending");
  }
}

function unavailable(): never {
  throw new Error("native_portable_task_ownership_unverified");
}

function leaseGeneration(lease: Lease) {
  return object(lease.metadata?.providerMetadata).ownershipGeneration;
}

function readOperation(source: Lease, target: Lease, policy: OwnershipOperation["policy"]): OwnershipOperation {
  const identity = object(source.metadata?.runnerTaskIdentity);
  const operation = environmentTaskOperationSchema.safeParse({
    kind: "ensure_ownership", operationId: target.id, sourceTaskId: source.providerLeaseId,
    sourceGeneration: leaseGeneration(source), targetGeneration: leaseGeneration(target), policy,
    identity: {
      runnerInstanceId: identity.runnerId, environmentLeaseId: identity.leaseId,
      runId: identity.runId, normalizedSessionId: identity.sessionId,
      turnId: identity.turnId, itemId: identity.itemId,
    },
  });
  return operation.success && operation.data.kind === "ensure_ownership" ? operation.data : unavailable();
}

async function ownershipClaim(db: Db, input: {
  companyId: string;
  sourceLeaseId: string;
  targetLeaseId: string;
  policy: OwnershipOperation["policy"];
}, ready?: OwnershipResult): Promise<OwnershipClaim> {
  const { companyId, sourceLeaseId, targetLeaseId, policy } = input;
  if (sourceLeaseId === targetLeaseId) return unavailable();
  return db.transaction(async tx => {
    const scope = and(eq(environmentLeases.companyId, companyId), inArray(environmentLeases.id, [sourceLeaseId, targetLeaseId]));
    const initial = await tx.select().from(environmentLeases).where(scope);
    const sourceRunId = initial.find(lease => lease.id === sourceLeaseId)?.heartbeatRunId;
    const targetRunId = initial.find(lease => lease.id === targetLeaseId)?.heartbeatRunId;
    const issueId = initial.find(lease => lease.id === sourceLeaseId)?.issueId;
    if (!sourceRunId || !targetRunId || sourceRunId === targetRunId || !issueId) return unavailable();
    const owners = await lockSourceRecoveryCoordinators(tx, companyId, [sourceRunId, targetRunId]);
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).for("update", { noWait: true });
    const leases = await tx.select().from(environmentLeases).where(scope).orderBy(asc(environmentLeases.id)).for("update");
    const source = leases.find(lease => lease.id === sourceLeaseId);
    const target = leases.find(lease => lease.id === targetLeaseId);
    const runs = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
      inArray(heartbeatRuns.id, [sourceRunId, targetRunId])));
    const prior = runs.find(run => run.id === sourceRunId);
    const current = runs.find(run => run.id === targetRunId);
    const sourceOwner = owners.find(owner => owner.runId === sourceRunId);
    if (!source || !target || source.heartbeatRunId !== sourceRunId || target.heartbeatRunId !== targetRunId ||
        !source.provider?.startsWith("plugin:") || source.provider !== target.provider ||
        !source.providerLeaseId || !target.providerLeaseId || source.providerLeaseId === target.providerLeaseId ||
        !source.environmentId || source.environmentId !== target.environmentId ||
        source.issueId !== issueId || target.issueId !== issueId || source.executionWorkspaceId !== target.executionWorkspaceId ||
        source.metadata?.driver !== "plugin" || target.metadata?.driver !== "plugin" ||
        typeof source.metadata.pluginId !== "string" || source.metadata.pluginId !== target.metadata.pluginId ||
        typeof source.metadata.driverKey !== "string" || source.metadata.driverKey !== target.metadata.driverKey ||
        source.metadata.runnerTaskLease !== true || target.metadata.runnerTaskLease !== true ||
        source.metadata.runnerTaskRetiring === true || source.metadata.reusableLeaseSuccessor !== undefined ||
        source.metadata.runnerTaskSourceConsumer !== undefined ||
        !["retained", "released", "expired"].includes(source.status) ||
        target.status !== "active" || target.releasedAt || target.metadata.runnerTaskRetiring === true ||
        target.expiresAt && target.expiresAt.getTime() <= Date.now() ||
        prior?.status !== "succeeded" || prior.nativeIssueId !== issueId ||
        sourceOwner?.phase !== "committed" || !sourceOwner.resultId || sourceOwner.leaseOwner ||
        current?.status !== "running" || current.scopeKind !== "issue" || current.issueId !== issueId ||
        current.nativeIssueId !== null && current.nativeIssueId !== issueId || current.resultJson?.nativeCancellation ||
        prior.agentId !== current.agentId || issue?.executionRunId !== targetRunId || issue.assigneeAgentId !== current.agentId ||
        issue.status !== "in_progress") return unavailable();

    const operation = readOperation(source, target, policy);
    if (operation.identity.runId !== prior.id || operation.identity.normalizedSessionId !== prior.nativeSessionId ||
        current.nativeSessionId !== null && current.nativeSessionId !== prior.nativeSessionId) return unavailable();
    const claim = { sourceLeaseId, targetLeaseId, operation };
    const existing = [source.metadata.portableTaskSuccessor, target.metadata.portableTaskPredecessor];
    if (existing.some(saved => saved !== undefined && nativeSha256(saved) !== nativeSha256(claim)) ||
        (existing[0] === undefined) !== (existing[1] === undefined)) return unavailable();
    if (ready && (existing[0] === undefined || ready.taskId !== target.providerLeaseId ||
        ready.operationId !== operation.operationId || ready.targetGeneration !== operation.targetGeneration ||
        ready.status !== "ready")) return unavailable();
    if (!ready && existing[0] === undefined) {
      await tx.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ portableTaskSuccessor: claim })}::jsonb` })
        .where(eq(environmentLeases.id, sourceLeaseId));
      await tx.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ portableTaskPredecessor: claim })}::jsonb` })
        .where(eq(environmentLeases.id, targetLeaseId));
    } else if (ready && target.metadata.portableTaskOwnershipReady === true &&
        (target.metadata.portableTaskCheckpointUnavailable === true) !== (ready.checkpointUnavailable === true)) {
      return unavailable();
    } else if (ready && target.metadata.portableTaskOwnershipReady !== true) {
      await tx.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({
        portableTaskOwnershipReady: true, ...(ready.checkpointUnavailable ? { portableTaskCheckpointUnavailable: true }
          : { runnerTaskAccountIdentity: source.metadata.runnerTaskAccountIdentity }),
      })}::jsonb` })
        .where(eq(environmentLeases.id, targetLeaseId));
    }
    return claim;
  });
}

export async function reconcilePluginTaskOwnership(db: Db, input: Parameters<typeof ownershipClaim>[1],
  dispatch: (operation: OwnershipOperation) => Promise<PluginEnvironmentTaskResult>): Promise<OwnershipResult> {
  try {
    const claim = await ownershipClaim(db, input);
    const result = await dispatch(claim.operation);
    if (result.kind !== "ownership" || result.operationId !== claim.operation.operationId ||
        result.targetGeneration !== claim.operation.targetGeneration) return unavailable();
    if (result.status === "ready") await ownershipClaim(db, input, result);
    return result;
  } catch (error) {
    if ((object(object(error).cause).code ?? object(error).code) === "55P03") throw new PluginTaskOwnershipPendingError();
    throw error;
  }
}

export function assertPluginTaskOwnershipDispatch(lease: Lease, operation: OwnershipOperation) {
  const claim = object(lease.metadata?.portableTaskPredecessor);
  if (claim.targetLeaseId !== lease.id || claim.operation === undefined ||
      operation.targetGeneration !== leaseGeneration(lease) ||
      nativeSha256(claim.operation) !== nativeSha256(operation)) return unavailable();
}

/** Reconcile the declared predecessor before admitting the task on this lease. */
export async function reconcilePluginTaskAdmission(db: Db, lease: Lease,
  dispatch: (operation: OwnershipOperation) => Promise<PluginEnvironmentTaskResult>, signal?: AbortSignal): Promise<void> {
  let sourceLeaseId = lease.metadata?.portableTaskPreviousLeaseId;
  let policy: OwnershipOperation["policy"] = "ordinary";
  if (lease.metadata?.portableTaskPredecessor !== undefined) {
    const claim = object(lease.metadata.portableTaskPredecessor);
    const operation = environmentTaskOperationSchema.safeParse(claim.operation);
    if (!operation.success || operation.data.kind !== "ensure_ownership") return unavailable();
    assertPluginTaskOwnershipDispatch(lease, operation.data);
    sourceLeaseId = claim.sourceLeaseId;
    policy = operation.data.policy;
  }
  if (typeof sourceLeaseId !== "string") return unavailable();
  const request = { companyId: lease.companyId, sourceLeaseId, targetLeaseId: lease.id, policy };
  let backoffMs = 250;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const result = await reconcilePluginTaskOwnership(db, request, dispatch);
      if (result.status === "ready") {
        signal?.throwIfAborted();
        return;
      }
    } catch (error) {
      if (!(error instanceof PluginTaskOwnershipPendingError)) throw error;
    }
    if (!signal) throw new PluginTaskOwnershipPendingError();
    await delay(backoffMs, undefined, { signal });
    backoffMs = Math.min(backoffMs * 2, 5_000);
  }
}

export async function readPortableTaskReseed(db: Db, input: {
  companyId: string;
  runId: string;
  lease: Pick<Lease, "id" | "metadata">;
  description?: PluginTaskDescription;
  runnerTask: (operation: { kind: "describe" }) => Promise<unknown>;
}): Promise<{ description: PluginTaskDescription; reseed: { previousSessionId: string | null } | null } | null> {
  if (!input.lease.metadata?.portableTaskPreviousLeaseId) return null;
  const readCurrent = async () => (await db.select({
    metadata: environmentLeases.metadata, providerLeaseId: environmentLeases.providerLeaseId,
  }).from(environmentLeases).where(and(eq(environmentLeases.id, input.lease.id), eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.heartbeatRunId, input.runId))))[0];

  let description = input.description;
  let current = description ? await readCurrent() : undefined;
  if (!description || current?.providerLeaseId !== description.taskId || current.metadata?.portableTaskOwnershipReady !== true) {
    const result = environmentTaskResultSchema.parse(await input.runnerTask({ kind: "describe" }));
    if (result.kind !== "description") throw new Error("Plugin Runner description unavailable");
    description = result;
    current = await readCurrent();
  }
  if (current?.providerLeaseId !== description.taskId || current.metadata?.portableTaskOwnershipReady !== true) return unavailable();
  if (current.metadata.portableTaskCheckpointUnavailable !== true) return { description, reseed: null };

  const predecessor = object(current.metadata.portableTaskPredecessor);
  const identity = object(object(predecessor.operation).identity);
  const sessionId = identity.normalizedSessionId;
  return { description, reseed: { previousSessionId: typeof sessionId === "string" && sessionId.trim() ? sessionId : null } };
}

async function readReadyPortableTaskClaim(db: Db, companyId: string, targetLeaseId: string) {
  const [target] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, companyId),
    eq(environmentLeases.id, targetLeaseId)));
  if (!target?.metadata?.portableTaskPredecessor) return undefined;
  if (target.metadata.portableTaskCheckpointUnavailable === true) return undefined;
  const claim = object(target.metadata.portableTaskPredecessor);
  const operation = environmentTaskOperationSchema.safeParse(claim.operation);
  if (target.status !== "active" || target.releasedAt || target.metadata.portableTaskOwnershipReady !== true ||
      target.metadata.portableTaskSuccessor !== undefined || target.metadata.runnerTaskRetiring === true ||
      target.expiresAt && target.expiresAt.getTime() <= Date.now() ||
      !operation.success || operation.data.kind !== "ensure_ownership" ||
      typeof claim.sourceLeaseId !== "string") return unavailable();
  assertPluginTaskOwnershipDispatch(target, operation.data);
  const [source] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, companyId),
    eq(environmentLeases.id, claim.sourceLeaseId)));
  if (!source || source.provider !== target.provider || source.providerLeaseId !== operation.data.sourceTaskId ||
      leaseGeneration(source) !== operation.data.sourceGeneration ||
      nativeSha256(source.metadata?.portableTaskSuccessor ?? null) !== nativeSha256(claim)) return unavailable();
  return { source, target, operation: operation.data };
}

function matchesAttachedPortableTaskIdentity(
  target: Lease, identity: Record<string, unknown>, runId: string,
) {
  const saved = object(target.metadata?.runnerTaskIdentity);
  const attached = {
    runnerInstanceId: saved.runnerId, environmentLeaseId: saved.leaseId,
    runId: saved.runId, normalizedSessionId: saved.sessionId, turnId: saved.turnId, itemId: saved.itemId,
  };
  return target.heartbeatRunId === runId && identity.runId === runId &&
    Object.entries(attached).every(([key, value]) => typeof value === "string" && value.length > 0 && identity[key] === value);
}

function matchesPortableLineage(source: OwnershipOperation["identity"], identity: Record<string, unknown>) {
  return source.environmentLeaseId === identity.environmentLeaseId && source.runnerInstanceId === identity.runnerInstanceId &&
    source.normalizedSessionId === identity.normalizedSessionId;
}

export async function assertAttachedPortableTask(db: Db, input: {
  companyId: string; leaseId: string; taskId: string; runId: string; identity: Record<string, unknown>;
}) {
  const claim = await readReadyPortableTaskClaim(db, input.companyId, input.leaseId);
  if (!claim || claim.target.providerLeaseId !== input.taskId ||
      !matchesAttachedPortableTaskIdentity(claim.target, input.identity, input.runId) ||
      !matchesPortableLineage(claim.operation.identity, input.identity)) return unavailable();
}

export async function readyPortableTaskSource(db: Db, companyId: string, targetLeaseId: string, identity: unknown,
  scope: { attachedRunId?: string; selectedSessionId?: string; accountIdentity?: string } = {}) {
  const claim = await readReadyPortableTaskClaim(db, companyId, targetLeaseId);
  if (!claim) return undefined;
  const { source, target, operation } = claim;
  if ("accountIdentity" in scope && (!scope.accountIdentity || source.metadata?.runnerTaskAccountIdentity !== scope.accountIdentity))
    return unavailable();
  const candidate = object(identity);
  const { attachedRunId, selectedSessionId } = scope;
  if (selectedSessionId && selectedSessionId !== operation.identity.normalizedSessionId) {
    if (!attachedRunId || target.heartbeatRunId !== attachedRunId) return unavailable();
    const [admitted] = await db.select({ lease: environmentLeases, unlaunched: unlaunchedPortableTaskLease() })
      .from(environmentLeases).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId),
        eq(heartbeatRuns.companyId, environmentLeases.companyId)))
      .innerJoin(issues, and(eq(issues.id, environmentLeases.issueId), eq(issues.companyId, environmentLeases.companyId)))
      .where(and(eq(environmentLeases.id, targetLeaseId), eq(environmentLeases.companyId, companyId),
        eq(environmentLeases.providerLeaseId, target.providerLeaseId!),
        sql`${environmentLeases.metadata}->'portableTaskPredecessor' = ${JSON.stringify(target.metadata?.portableTaskPredecessor)}::jsonb`,
        eq(heartbeatRuns.id, attachedRunId), eq(heartbeatRuns.status, "running"),
        sql`${heartbeatRuns.resultJson}->'nativeCancellation' is null`, eq(heartbeatRuns.nativeSessionId, selectedSessionId),
        sql`${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'session'->>'normalizedSessionId' = ${selectedSessionId}`,
        eq(heartbeatRuns.nativeIssueId, issues.id), eq(issues.executionRunId, heartbeatRuns.id),
        eq(issues.assigneeAgentId, heartbeatRuns.agentId), eq(issues.status, "in_progress")));
    if (!admitted) return unavailable();
    if (identity == null && admitted.unlaunched) return undefined;
    if (admitted.lease.metadata?.runnerTaskDispatched === true &&
        candidate.normalizedSessionId === selectedSessionId && candidate.environmentLeaseId === target.id &&
        matchesAttachedPortableTaskIdentity(admitted.lease, candidate, attachedRunId)) return undefined;
    return unavailable();
  }
  if (attachedRunId && target.heartbeatRunId === attachedRunId && candidate.runId === attachedRunId) {
    if (matchesAttachedPortableTaskIdentity(target, candidate, attachedRunId) &&
        matchesPortableLineage(operation.identity, candidate)) return undefined;
    return unavailable();
  }
  if (Object.entries(operation.identity).some(([key, value]) => candidate[key] !== value)) return unavailable();
  return { taskId: operation.sourceTaskId, identity: operation.identity };
}
