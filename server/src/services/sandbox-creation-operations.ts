import { collectSecretRefPaths, isUuidSecretRef, parseSecretRefBindingObject, readConfigValueAtPath } from "./json-schema-secret-refs.js";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { environments, sandboxCreationOperations, type Db } from "@paperclipai/db";
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

export async function recoverSandboxCreations(db: Db,
  inspect: (operation: SandboxCreationOperation) => Promise<PluginEnvironmentLeaseObservation | null>,
): Promise<void> {
  const due = await db.select().from(sandboxCreationOperations).where(and(
    eq(sandboxCreationOperations.state, "pending"), lte(sandboxCreationOperations.nextAttemptAt, new Date()),
  )).limit(100);
  for (const candidate of due) {
    try {
      const observation = await inspect(candidate);
      const cleanup = observation?.creationCleanup ? readEnvironmentCreationCleanupError({ data: {
        schema: "paperclip/environment-creation-cleanup/v1", cleanup: observation.creationCleanup,
      } }) : null;
      if (cleanup && (cleanup.companyId !== candidate.companyId || cleanup.environmentId !== candidate.originalEnvironmentId ||
        cleanup.runId !== candidate.runId || cleanup.attemptId !== candidate.id || cleanup.providerLeaseId !== observation!.providerLeaseId)) {
        throw new Error("Sandbox creation recovery returned foreign ownership");
      }
      await db.transaction(async tx => {
        await tx.select({ id: environments.id }).from(environments).where(eq(environments.id, candidate.originalEnvironmentId)).for("update");
        const [operation] = await tx.select().from(sandboxCreationOperations)
          .where(eq(sandboxCreationOperations.id, candidate.id)).for("update");
        if (!operation || operation.state !== "pending") return;
        await notifyEnvironmentCleanup(tx, { companyId: operation.companyId });
        if (!cleanup) {
          logger.warn({ errorKind: "sandbox_creation_needs_reconciliation", operationId: operation.id, companyId: operation.companyId },
            "Sandbox creation could not be identified; operator reconciliation is required");
          await tx.update(sandboxCreationOperations).set({ state: "needs_reconciliation", updatedAt: new Date() })
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
      await db.transaction(async tx => {
        await notifyEnvironmentCleanup(tx, { companyId: candidate.companyId });
        await tx.update(sandboxCreationOperations).set({ nextAttemptAt: new Date(Date.now() + ENVIRONMENT_CLEANUP_RETRY_MS), updatedAt: new Date() })
          .where(and(eq(sandboxCreationOperations.id, candidate.id), eq(sandboxCreationOperations.state, "pending")));
      });
      logger.warn({ errorKind: "sandbox_creation_recovery_failed", operationId: candidate.id, companyId: candidate.companyId },
        "Sandbox creation recovery will retry at its saved deadline");
    }
  }
}
