import { collectSecretRefPaths, isUuidSecretRef, parseSecretRefBindingObject, readConfigValueAtPath } from "./json-schema-secret-refs.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, lte, or, sql } from "drizzle-orm";
import { controllerProcessExited, currentControllerBootId, currentControllerProcess, readControllerProcess } from "./controller-process-identity.js";
import { companies, environments, sandboxCreationOperations, type Db } from "@paperclipai/db";
import { readEnvironmentCreationCleanupError, type PluginEnvironmentLease, type PluginEnvironmentLeaseObservation } from "@paperclipai/plugin-sdk";
import { assertEnvironmentCompanyBinding, environmentService } from "./environments.js";
import { ENVIRONMENT_CLEANUP_RETRY_MS, recoverableSandboxCreationCondition } from "./environment-cleanup-state.js";
import { logger } from "../middleware/logger.js";
import { notifyEnvironmentCleanup, writeEnvironmentCleanup } from "./environment-cleanup-notifications.js";

export type SandboxCreationOperation = typeof sandboxCreationOperations.$inferSelect;

// A live creator may still be waiting for the provider, and a provider may still
// materialize an aborted request. Absence is conclusive only after this delay.
const CREATION_SETTLE_FLOOR_MS = 30 * 60_000;
const CREATION_PROMOTION_PAGE_SIZE = 100;

/** After a restart, creation intents from an exited server cannot still be in
 * flight there. Reconcile them now instead of at the settle deadline. Absence
 * stays inconclusive until that deadline; see recoverSandboxCreations. */
async function promoteAbandonedSandboxCreations(db: Db): Promise<void> {
  const now = new Date();
  // Page past live, foreign, and unidentified creators so they cannot hide an
  // abandoned intent behind them.
  let after: string | null = null;
  for (;;) {
    const waiting: Array<Pick<SandboxCreationOperation, "id" | "metadata">> = await db
      .select({ id: sandboxCreationOperations.id, metadata: sandboxCreationOperations.metadata })
      .from(sandboxCreationOperations).where(and(
        eq(sandboxCreationOperations.state, "pending"), gt(sandboxCreationOperations.nextAttemptAt, now),
        sql`${sandboxCreationOperations.metadata}->'creationController'->>'bootId' is distinct from ${currentControllerBootId()}`,
        sql`coalesce(${sandboxCreationOperations.metadata}->>'creationControllerLost', '') <> 'true'`,
        after === null ? undefined : gt(sandboxCreationOperations.id, after),
      )).orderBy(asc(sandboxCreationOperations.id)).limit(CREATION_PROMOTION_PAGE_SIZE);
    for (const operation of waiting) {
      const controller = readControllerProcess(operation.metadata.creationController);
      if (!controller || !await controllerProcessExited(controller)) continue;
      await db.update(sandboxCreationOperations).set({ nextAttemptAt: now, updatedAt: now,
        metadata: sql`coalesce(${sandboxCreationOperations.metadata}, '{}'::jsonb) || '{"creationControllerLost":true}'::jsonb` })
        .where(and(eq(sandboxCreationOperations.id, operation.id), eq(sandboxCreationOperations.state, "pending"),
          gt(sandboxCreationOperations.nextAttemptAt, now)));
    }
    if (waiting.length < CREATION_PROMOTION_PAGE_SIZE) return;
    after = waiting[waiting.length - 1]!.id;
  }
}

function creationAbsenceInconclusive(operation: SandboxCreationOperation): boolean {
  const settleAt = Date.parse(typeof operation.metadata.creationSettleAt === "string" ? operation.metadata.creationSettleAt : "");
  return operation.metadata.creationControllerLost === true && Number.isFinite(settleAt) && Date.now() < settleAt;
}

export function recoverableTaskCreation(operation: Pick<SandboxCreationOperation, "metadata">): boolean {
  const metadata = operation.metadata;
  return metadata.runnerTaskLease === true && metadata.creationOperationVersion === 1 &&
    typeof metadata.runnerTaskCreationContextId === "string" && metadata.runnerTaskCreationContextId.length > 0 &&
    metadata.providerMetadata !== null && typeof metadata.providerMetadata === "object" && !Array.isArray(metadata.providerMetadata);
}

type CreationOwner = {
  companyId: string;
  environmentId: string;
  executionWorkspaceId?: string | null;
  issueId?: string | null;
  heartbeatRunId?: string | null;
  provider: string;
  pluginId?: string;
  driverKey: string;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  timeoutMs?: number;
  requestKey?: string;
  configSchema?: Record<string, unknown> | null;
  resolvedConfig?: Record<string, unknown>;
};

export async function createOwnedSandbox(
  db: Db, owner: CreationOwner,
  create: (identity: { id: string; runId: string }) => Promise<PluginEnvironmentLease>,
): Promise<PluginEnvironmentLease> {
  const credentialHashes: Record<string, string> = {};
  for (const path of collectSecretRefPaths(owner.configSchema)) {
    const value = readConfigValueAtPath(owner.config, path);
    if (value != null && value !== "" && !(typeof value === "string" && isUuidSecretRef(value)) && !parseSecretRefBindingObject(value)) {
      throw new Error("Sandbox creation requires saved secret references");
    }
    if (value != null && value !== "") {
      const resolved = readConfigValueAtPath(owner.resolvedConfig ?? {}, path);
      if (typeof resolved !== "string") throw new Error("Sandbox creation credential identity is unavailable");
      credentialHashes[path] = createHash("sha256").update(resolved).digest("hex");
    }
  }
  const id = randomUUID();
  const runId = owner.heartbeatRunId ?? randomUUID();
  const settleAt = new Date(Date.now() + Math.max(CREATION_SETTLE_FLOOR_MS, (owner.timeoutMs ?? 0) + 60_000));
  const creationController = await currentControllerProcess();
  const operation = await db.transaction(async tx => {
    await notifyEnvironmentCleanup(tx, { companyId: owner.companyId, runId: owner.heartbeatRunId ?? undefined });
    await assertEnvironmentCompanyBinding(tx as unknown as Db, owner.environmentId, owner.companyId);
    const [inserted] = await tx.insert(sandboxCreationOperations).values({
      id, companyId: owner.companyId, environmentId: owner.environmentId, originalEnvironmentId: owner.environmentId,
      runId, requestKey: owner.requestKey ?? "run", issueId: owner.issueId, executionWorkspaceId: owner.executionWorkspaceId,
      provider: owner.provider, pluginId: owner.pluginId, driverKey: owner.driverKey,
      config: owner.config, metadata: { ...owner.metadata, creationCredentialHashes: credentialHashes,
        creationController, creationSettleAt: settleAt.toISOString() },
      nextAttemptAt: settleAt,
    }).onConflictDoNothing().returning();
    if (inserted) return inserted;
    const [existing] = await tx.select().from(sandboxCreationOperations).where(and(
      eq(sandboxCreationOperations.companyId, owner.companyId), eq(sandboxCreationOperations.originalEnvironmentId, owner.environmentId),
      eq(sandboxCreationOperations.runId, runId), eq(sandboxCreationOperations.requestKey, owner.requestKey ?? "run"),
    ));
    if (!existing) throw new Error("Sandbox creation ownership was not recorded");
    return existing;
  });
  if (operation.id !== id) {
    if (operation.state !== "attached" || !operation.leaseId) throw new Error("Sandbox creation requires reconciliation before another attempt");
    const existing = await environmentService(db).getLeaseById(operation.leaseId);
    if (!existing || existing.status !== "active" || !existing.providerLeaseId) throw new Error("Sandbox creation has already transferred ownership");
    return { providerLeaseId: existing.providerLeaseId, expiresAt: existing.expiresAt?.toISOString(),
      metadata: { ...existing.metadata, creationOperationId: operation.id } };
  }
  try {
    const lease = await create({ id, runId });
    return { ...lease, metadata: { ...lease.metadata, creationOperationId: id } };
  } catch (error) {
    if (recoverableTaskCreation(operation)) {
      try {
        await writeEnvironmentCleanup(db, tx => tx.update(sandboxCreationOperations).set({ nextAttemptAt: new Date(), updatedAt: new Date() })
          .where(and(eq(sandboxCreationOperations.id, id), recoverableSandboxCreationCondition())),
        { companyId: operation.companyId, runId: operation.runId });
      } catch {
        logger.warn({ errorKind: "task_creation_recovery_wakeup_failed", operationId: id, companyId: operation.companyId },
          "Task creation recovery retains its saved deadline");
      }
    }
    throw error;
  }
}

/** Keep an already returned resource identity even when task attachment fails.
 * This enriches the existing owner; it never transfers or reopens ownership. */
export async function recordSandboxCreationResource(db: Db, input: {
  id: string; companyId: string; environmentId: string; providerLeaseId: string;
  providerMetadata?: Record<string, unknown>;
}): Promise<void> {
  await writeEnvironmentCleanup(db, async tx => {
    const [recorded] = await tx.update(sandboxCreationOperations).set({
      nextAttemptAt: sql`case when ${sandboxCreationOperations.state} = 'needs_reconciliation' then clock_timestamp() else ${sandboxCreationOperations.nextAttemptAt} end`,
      metadata: sql`coalesce(${sandboxCreationOperations.metadata}, '{}'::jsonb) || ${JSON.stringify({ creationProviderLeaseId: input.providerLeaseId, ...(input.providerMetadata ? { creationProviderMetadata: input.providerMetadata } : {}) })}::jsonb`,
      updatedAt: new Date(),
    }).where(and(eq(sandboxCreationOperations.id, input.id), eq(sandboxCreationOperations.companyId, input.companyId),
      eq(sandboxCreationOperations.originalEnvironmentId, input.environmentId),
      or(sql`${sandboxCreationOperations.metadata}->>'creationProviderLeaseId' is null`,
        sql`${sandboxCreationOperations.metadata}->>'creationProviderLeaseId' = ${input.providerLeaseId}`),
    )).returning({ id: sandboxCreationOperations.id });
    if (!recorded) throw new Error("Sandbox creation resource identity changed");
  }, { companyId: input.companyId });
}

export async function queueSandboxCreationCleanup(db: Db, input: {
  id: string; companyId: string; environmentId: string; providerLeaseId: string;
  providerMetadata?: Record<string, unknown>;
}): Promise<void> {
  await db.transaction(async tx => {
    await tx.select({ id: environments.id }).from(environments).where(eq(environments.id, input.environmentId)).for("update");
    const [operation] = await tx.select().from(sandboxCreationOperations).where(and(eq(sandboxCreationOperations.id, input.id),
      eq(sandboxCreationOperations.companyId, input.companyId), eq(sandboxCreationOperations.originalEnvironmentId, input.environmentId))).for("update");
    if (!operation || (operation.metadata.creationProviderLeaseId && operation.metadata.creationProviderLeaseId !== input.providerLeaseId)) {
      throw new Error("Sandbox creation cleanup ownership changed");
    }
    if (["attached", "cleanup_pending", "resolved"].includes(operation.state)) return;
    const contextId = operation.metadata.runnerTaskLease === true && typeof operation.metadata.runnerTaskCreationContextId === "string"
      ? operation.metadata.runnerTaskCreationContextId : null;
    if (operation.state !== "pending" && !(operation.state === "needs_reconciliation" && contextId &&
        operation.metadata.creationProviderLeaseId === input.providerLeaseId)) throw new Error("Sandbox creation cleanup ownership changed");
    await notifyEnvironmentCleanup(tx, { companyId: operation.companyId, runId: operation.runId });
    const lease = await environmentService(tx as unknown as Db).insertPendingCleanupLease({
      companyId: operation.companyId, environmentId: operation.originalEnvironmentId,
      heartbeatRunId: operation.runId, issueId: operation.issueId, executionWorkspaceId: operation.executionWorkspaceId,
      provider: operation.provider, providerLeaseId: input.providerLeaseId,
      metadata: { ...operation.metadata, creationOperationId: operation.id, environmentId: operation.originalEnvironmentId,
        providerMetadata: input.providerMetadata ?? operation.metadata.creationProviderMetadata ?? {}, runnerTaskRetiring: true,
        ...(contextId ? { runnerTaskStartupCleanup: { contextId, requiresPreparationStop: false } } : {}) },
      failureReason: "interrupted_task_creation",
    });
    await tx.update(sandboxCreationOperations).set({ state: "cleanup_pending", leaseId: lease.id, updatedAt: new Date(),
      metadata: { ...operation.metadata, creationProviderLeaseId: input.providerLeaseId,
        creationProviderMetadata: input.providerMetadata ?? operation.metadata.creationProviderMetadata ?? {} },
    }).where(eq(sandboxCreationOperations.id, operation.id));
  });
}

export async function recoverSandboxCreations(db: Db,
  inspect: (operation: SandboxCreationOperation) => Promise<PluginEnvironmentLeaseObservation | null>,
  onTaskRecovered?: (operation: SandboxCreationOperation) => void | Promise<void>,
): Promise<void> {
  await promoteAbandonedSandboxCreations(db);
  const due = await db.select().from(sandboxCreationOperations).where(and(
    recoverableSandboxCreationCondition(), lte(sandboxCreationOperations.nextAttemptAt, new Date()),
  )).limit(100);
  for (const candidate of due) {
    try {
      if (candidate.metadata.runnerTaskLease === true && typeof candidate.metadata.runnerTaskCreationContextId === "string" &&
          typeof candidate.metadata.creationProviderLeaseId === "string") {
        await queueSandboxCreationCleanup(db, { id: candidate.id, companyId: candidate.companyId,
          environmentId: candidate.originalEnvironmentId, providerLeaseId: candidate.metadata.creationProviderLeaseId });
        if (recoverableTaskCreation(candidate)) await onTaskRecovered?.(candidate);
        continue;
      }
      const [existingCompany] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, candidate.companyId)).limit(1);
      const observation = existingCompany ? await inspect(candidate) : null;
      if (existingCompany && recoverableTaskCreation(candidate) && observation?.creationLease) {
        const lease = observation.creationLease;
        if (typeof lease.providerLeaseId !== "string" || lease.providerLeaseId.length === 0 || lease.providerLeaseId !== observation.providerLeaseId ||
            !lease.metadata || typeof lease.metadata !== "object" || Array.isArray(lease.metadata)) {
          throw new Error("Task creation recovery returned foreign ownership");
        }
        const identity = { id: candidate.id, companyId: candidate.companyId, environmentId: candidate.originalEnvironmentId,
          providerLeaseId: lease.providerLeaseId, providerMetadata: lease.metadata };
        await recordSandboxCreationResource(db, identity);
        await queueSandboxCreationCleanup(db, identity);
        await onTaskRecovered?.(candidate);
        continue;
      }
      if (existingCompany && recoverableTaskCreation(candidate)) throw new Error("Task creation identity is not available yet");
      const cleanup = observation?.creationCleanup ? readEnvironmentCreationCleanupError({ data: {
        schema: "paperclip/environment-creation-cleanup/v1", cleanup: observation.creationCleanup,
      } }) : null;
      if (cleanup && (cleanup.companyId !== candidate.companyId || cleanup.environmentId !== candidate.originalEnvironmentId ||
        cleanup.runId !== candidate.runId || cleanup.attemptId !== candidate.id || cleanup.providerLeaseId !== observation!.providerLeaseId)) {
        throw new Error("Sandbox creation recovery returned foreign ownership");
      }
      // An early lookup after a lost creator may precede provider materialization.
      if (existingCompany && !cleanup && creationAbsenceInconclusive(candidate)) {
        throw new Error("Sandbox creation has not settled yet");
      }
      await db.transaction(async tx => {
        const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, candidate.companyId)).for("key share");
        await tx.select({ id: environments.id }).from(environments).where(eq(environments.id, candidate.originalEnvironmentId)).for("update");
        const [operation] = await tx.select().from(sandboxCreationOperations)
          .where(eq(sandboxCreationOperations.id, candidate.id)).for("update");
        if (!operation || operation.state !== "pending") return;
        await notifyEnvironmentCleanup(tx, { companyId: operation.companyId });
        if (!company || !cleanup) {
          logger.warn({ errorKind: "sandbox_creation_needs_reconciliation", operationId: operation.id, companyId: operation.companyId },
            "Sandbox creation could not be identified; operator reconciliation is required");
          await tx.update(sandboxCreationOperations).set({ state: "needs_reconciliation", updatedAt: new Date(),
            metadata: { ...operation.metadata, creationReconciliationReason: company ? "creation_identity_unavailable" : "company_deleted" },
          })
            .where(eq(sandboxCreationOperations.id, operation.id));
          return;
        }
        const lease = await environmentService(tx as unknown as Db).insertPendingCleanupLease({
          companyId: operation.companyId, environmentId: operation.originalEnvironmentId,
          provider: operation.provider, providerLeaseId: cleanup.providerLeaseId,
          metadata: { ...operation.metadata, creationOperationId: operation.id, failedCreateCleanup: cleanup },
          failureReason: "interrupted_sandbox_creation",
        });
        await tx.update(sandboxCreationOperations).set({ state: "cleanup_pending", leaseId: lease.id, updatedAt: new Date() })
          .where(eq(sandboxCreationOperations.id, operation.id));
      });
    } catch {
      const retry = await db.transaction(async tx => {
        const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, candidate.companyId)).for("key share");
        await notifyEnvironmentCleanup(tx, { companyId: candidate.companyId });
        await tx.update(sandboxCreationOperations).set(company
          ? { nextAttemptAt: new Date(Date.now() + ENVIRONMENT_CLEANUP_RETRY_MS), updatedAt: new Date() }
          : { state: "needs_reconciliation", updatedAt: new Date(),
            metadata: sql`coalesce(${sandboxCreationOperations.metadata}, '{}'::jsonb) || '{"creationReconciliationReason":"company_deleted"}'::jsonb` })
          .where(and(eq(sandboxCreationOperations.id, candidate.id), recoverableSandboxCreationCondition()));
        return Boolean(company);
      });
      logger.warn({ errorKind: retry ? "sandbox_creation_recovery_failed" : "sandbox_creation_needs_reconciliation", operationId: candidate.id, companyId: candidate.companyId },
        retry ? "Sandbox creation recovery will retry at its saved deadline" : "Sandbox creation company was deleted; operator reconciliation is required");
    }
  }
}
