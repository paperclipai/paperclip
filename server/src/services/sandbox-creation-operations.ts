import { collectSecretRefPaths, isUuidSecretRef, parseSecretRefBindingObject, readConfigValueAtPath } from "./json-schema-secret-refs.js";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, lte, or, sql } from "drizzle-orm";
import { companies, environments, sandboxCreationOperations, type Db } from "@paperclipai/db";
import { readEnvironmentCreationCleanupError, type PluginEnvironmentLease, type PluginEnvironmentLeaseObservation } from "@paperclipai/plugin-sdk";
import { assertEnvironmentCompanyBinding, environmentService } from "./environments.js";
import { ENVIRONMENT_CLEANUP_RETRY_MS } from "./environment-cleanup-state.js";
import { logger } from "../middleware/logger.js";
import { notifyEnvironmentCleanup } from "./environment-cleanup-notifications.js";

export type SandboxCreationOperation = typeof sandboxCreationOperations.$inferSelect;

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
  const operation = await db.transaction(async tx => {
    await notifyEnvironmentCleanup(tx, { companyId: owner.companyId, runId: owner.heartbeatRunId ?? undefined });
    await assertEnvironmentCompanyBinding(tx as unknown as Db, owner.environmentId, owner.companyId);
    const [inserted] = await tx.insert(sandboxCreationOperations).values({
      id, companyId: owner.companyId, environmentId: owner.environmentId, originalEnvironmentId: owner.environmentId,
      runId, requestKey: owner.requestKey ?? "run", issueId: owner.issueId, executionWorkspaceId: owner.executionWorkspaceId,
      provider: owner.provider, pluginId: owner.pluginId, driverKey: owner.driverKey,
      config: owner.config, metadata: { ...owner.metadata, creationCredentialHashes: credentialHashes },
      nextAttemptAt: new Date(Date.now() + Math.max(30 * 60_000, (owner.timeoutMs ?? 0) + 60_000)),
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
  const lease = await create({ id, runId });
  return { ...lease, metadata: { ...lease.metadata, creationOperationId: id } };
}

/** Keep an already returned resource identity even when task attachment fails.
 * This enriches the existing owner; it never transfers or reopens ownership. */
export async function recordSandboxCreationResource(db: Db, input: {
  id: string; companyId: string; environmentId: string; providerLeaseId: string;
}): Promise<void> {
  const [recorded] = await db.update(sandboxCreationOperations).set({
    metadata: sql`coalesce(${sandboxCreationOperations.metadata}, '{}'::jsonb) || ${JSON.stringify({ creationProviderLeaseId: input.providerLeaseId })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(eq(sandboxCreationOperations.id, input.id), eq(sandboxCreationOperations.companyId, input.companyId),
    eq(sandboxCreationOperations.originalEnvironmentId, input.environmentId),
    or(sql`${sandboxCreationOperations.metadata}->>'creationProviderLeaseId' is null`,
      sql`${sandboxCreationOperations.metadata}->>'creationProviderLeaseId' = ${input.providerLeaseId}`),
  )).returning({ id: sandboxCreationOperations.id });
  if (!recorded) throw new Error("Sandbox creation resource identity changed");
}

export async function recoverSandboxCreations(db: Db,
  inspect: (operation: SandboxCreationOperation) => Promise<PluginEnvironmentLeaseObservation | null>,
): Promise<void> {
  const due = await db.select().from(sandboxCreationOperations).where(and(
    eq(sandboxCreationOperations.state, "pending"), lte(sandboxCreationOperations.nextAttemptAt, new Date()),
  )).limit(100);
  for (const candidate of due) {
    try {
      const [existingCompany] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, candidate.companyId)).limit(1);
      const observation = existingCompany ? await inspect(candidate) : null;
      const cleanup = observation?.creationCleanup ? readEnvironmentCreationCleanupError({ data: {
        schema: "paperclip/environment-creation-cleanup/v1", cleanup: observation.creationCleanup,
      } }) : null;
      if (cleanup && (cleanup.companyId !== candidate.companyId || cleanup.environmentId !== candidate.originalEnvironmentId ||
        cleanup.runId !== candidate.runId || cleanup.attemptId !== candidate.id || cleanup.providerLeaseId !== observation!.providerLeaseId)) {
        throw new Error("Sandbox creation recovery returned foreign ownership");
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
          .where(and(eq(sandboxCreationOperations.id, candidate.id), eq(sandboxCreationOperations.state, "pending")));
        return Boolean(company);
      });
      logger.warn({ errorKind: retry ? "sandbox_creation_recovery_failed" : "sandbox_creation_needs_reconciliation", operationId: candidate.id, companyId: candidate.companyId },
        retry ? "Sandbox creation recovery will retry at its saved deadline" : "Sandbox creation company was deleted; operator reconciliation is required");
    }
  }
}
