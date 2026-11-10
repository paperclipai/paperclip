import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { createReusableLeaseHandoff } from "../environment-lease-handoff.js";
import { retiredSourceAuthorizesNativeBackupRestore } from "./native-retired-backup-source.js";

const describeDb = recoveryPostgresSupport.supported ? describe : describe.skip;

describeDb("retired native backup source authority", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startRecoveryPostgres("retired-backup-source");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => { await database?.cleanup(); });

  const manifestSha256 = `sha256:${"b".repeat(64)}`;
  const completedAt = new Date("2026-11-05T05:02:50.000Z");

  async function fixture(options: { termination?: "destroyed" | "stopped" | null; status?: string; stampSha?: string;
    providerEventAt?: Date; secondLease?: boolean; handoffs?: number;
    handoffFault?: "missing_receipt" | "changed_receipt" | "active_predecessor" | "missing_predecessor";
    restoreHold?: "settled" | "no_marker" | "foreign_marker" | "reusable_policy" | "no_stop_receipt" | "dirty_writer" } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), sessionId = randomUUID(), runnerInstanceId = randomUUID();
    const sourceRunId = randomUUID(), currentRunId = randomUUID(), leaseId = randomUUID(), providerLeaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retired source", issuePrefix: `R${companyId.slice(0, 5)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", adapterType: "paperclip_runner" });
    for (const id of [sourceRunId, currentRunId]) await db.insert(heartbeatRuns).values({ id, companyId, agentId,
      status: id === sourceRunId ? "succeeded" : "running", runtimeMode: "native", nativeSessionId: sessionId,
      invocationSource: "assignment", triggerDetail: "system" });
    const lease = (id: string) => ({ id, companyId, heartbeatRunId: sourceRunId, provider: "daytona", providerLeaseId,
      status: options.status ?? "expired", cleanupStatus: "success", releasedAt: new Date(),
      metadata: {
        nativeHarnessBackup: { schema: "paperclip.native-harness-backup-stamp.v2", normalizedSessionId: sessionId, runnerInstanceId,
          sessionScopeSha256: "a".repeat(64), sourceProviderLeaseId: providerLeaseId, authorizedProviderLeaseId: providerLeaseId,
          manifestSha256: options.stampSha ?? manifestSha256, completedAt: completedAt.toISOString() },
        ...(options.termination === null ? {} : { remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId,
          runId: sourceRunId, leaseId: id, provider: "daytona", providerLeaseId, state: options.termination ?? "destroyed",
          confirmedAt: new Date().toISOString() } }),
      } });
    const sourceLease: ReturnType<typeof lease> & Partial<typeof environmentLeases.$inferInsert> = lease(leaseId);
    if (options.restoreHold) {
      // The exact row an older release left after a restore hold settled:
      // released, retain_on_failure, stop-and-retain receipt, hold marker.
      const hold = options.restoreHold, pluginId = randomUUID();
      const termination = sourceLease.metadata.remoteExecutionTermination!;
      Object.assign(sourceLease, { status: "released", leasePolicy: hold === "reusable_policy" ? "reuse_by_environment" : "retain_on_failure",
        acquiredAt: new Date(Date.now() - 60_000), releasedAt: new Date(Date.now() + 1_000) });
      sourceLease.metadata = { ...sourceLease.metadata, pluginId,
        ...(hold === "no_marker" ? {} : { workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1",
          runId: hold === "foreign_marker" ? randomUUID() : sourceRunId } }),
        ...(hold === "no_stop_receipt" ? {} : { sandboxStopAndRetainReceipt: { schema: "paperclip.sandbox-stop-and-retain-receipt.v1",
          requestId: randomUUID(), companyId, runId: sourceRunId, leaseId, provider: "daytona", providerLeaseId, pluginId,
          method: "environmentStopLease", confirmedAt: termination.confirmedAt } }) };
      if (hold === "dirty_writer") await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
        schema: "paperclip.native-workspace-sync/v3", state: "prepared", leaseId, providerLeaseId, workspaceId: randomUUID(),
        remoteCwd: "/work", resourceDisposition: "keep_running", descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64),
        finalHostSha256: null } } }).where(eq(heartbeatRuns.id, sourceRunId));
    }
    if (options.handoffs) {
      const environmentId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
      await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Retained session" });
      await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
        mode: "shared_workspace", strategyType: "project_primary", name: "Retained workspace" });
      const history: Array<typeof environmentLeases.$inferInsert> = [];
      for (let index = 0; index <= options.handoffs; index++) {
        const ownerRunId = index === options.handoffs ? sourceRunId : randomUUID();
        if (ownerRunId !== sourceRunId) await db.insert(heartbeatRuns).values({ id: ownerRunId, companyId, agentId,
          status: "succeeded", runtimeMode: "native", nativeSessionId: sessionId,
          invocationSource: "assignment", triggerDetail: "system" });
        const acquiredAt = new Date(completedAt.getTime() - (options.handoffs - index + 1) * 60_000);
        const row = { ...sourceLease, id: index === options.handoffs ? leaseId : randomUUID(),
          heartbeatRunId: ownerRunId, environmentId, issueId, executionWorkspaceId: workspaceId, acquiredAt,
          leasePolicy: "reuse_by_environment", metadata: { ...sourceLease.metadata, agentId },
          // Only the tip carries a settled restore hold; its predecessors retired by handoff.
          ...(options.restoreHold ? index === options.handoffs ? { leasePolicy: sourceLease.leasePolicy } : { status: "expired" } : {}) };
        if (index < options.handoffs) {
          const { nativeHarnessBackup: _backup, remoteExecutionTermination: _termination, ...metadata } = row.metadata;
          history.push({ ...row, metadata });
        } else history.push(row);
      }
      for (let index = 1; index < history.length; index++) {
        const previous = history[index - 1]!, current = history[index]!;
        const handoff = createReusableLeaseHandoff(previous as typeof environmentLeases.$inferSelect,
          current as typeof environmentLeases.$inferSelect);
        previous.releasedAt = current.acquiredAt;
        previous.metadata = { ...previous.metadata, reusableLeaseSuccessor: handoff };
        current.metadata = { ...current.metadata, reusableLeasePredecessor: handoff };
      }
      if (options.handoffFault === "missing_receipt") delete history[0]!.metadata!.reusableLeaseSuccessor;
      if (options.handoffFault === "changed_receipt") history[0]!.metadata!.reusableLeaseSuccessor = {
        ...(history[0]!.metadata!.reusableLeaseSuccessor as Record<string, unknown>), successorRunId: randomUUID() };
      if (options.handoffFault === "active_predecessor") history[0]!.status = "active";
      if (options.handoffFault === "missing_predecessor") history.shift();
      await db.insert(environmentLeases).values(history);
    } else await db.insert(environmentLeases).values(sourceLease);
    if (options.secondLease) await db.insert(environmentLeases).values(lease(randomUUID()));
    // The backup turn's own provider events precede the checkpoint.
    await db.insert(heartbeatRunEvents).values({ companyId, runId: sourceRunId, agentId, seq: 1, eventType: "turn.started",
      createdAt: new Date(completedAt.getTime() - 60_000) });
    if (options.providerEventAt) await db.insert(heartbeatRunEvents).values({ companyId, runId: currentRunId === sourceRunId
      ? sourceRunId : (await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native",
        nativeSessionId: sessionId, invocationSource: "automation", triggerDetail: "system" }).returning())[0]!.id,
      agentId, seq: 1, eventType: "session.resumed", createdAt: options.providerEventAt });
    return retiredSourceAuthorizesNativeBackupRestore(db, { companyId, currentRunId, normalizedSessionId: sessionId,
      manifest: { sourceProviderLeaseId: providerLeaseId, runnerInstanceId, normalizedSessionId: sessionId }, manifestSha256 });
  }

  it("authorizes a destroyed source lease whose stamp names the backup", async () => {
    await expect(fixture()).resolves.toBe(true);
  });

  it.each([1, 3])("authorizes a destroyed allocation after %i verified warm lease handoffs", async (handoffs) => {
    await expect(fixture({ handoffs })).resolves.toBe(true);
  });

  it.each(["missing_receipt", "changed_receipt", "active_predecessor", "missing_predecessor"] as const)(
    "fails closed for a warm lease chain with %s", async (handoffFault) => {
      await expect(fixture({ handoffs: 2, handoffFault })).resolves.toBe(false);
    });

  it.each([
    ["an unrelated owner", { secondLease: true }],
    ["a stopped source", { termination: "stopped" as const }],
    ["another checkpoint", { stampSha: `sha256:${"c".repeat(64)}` }],
    ["later provider work", { providerEventAt: new Date(completedAt.getTime() + 60_000) }],
  ])("keeps the backup restore held after warm handoffs with %s", async (_label, options) => {
    await expect(fixture({ handoffs: 2, ...options })).resolves.toBe(false);
  });

  it.each([
    ["the provider only stopped the source", { termination: "stopped" as const }],
    ["no termination receipt exists", { termination: null }],
    ["the source lease is still reusable", { status: "released" }],
    ["the stamp names another checkpoint", { stampSha: `sha256:${"c".repeat(64)}` }],
    ["provider work followed the checkpoint", { providerEventAt: new Date(completedAt.getTime() + 60_000) }],
    ["one allocation maps to two host leases", { secondLease: true }],
  ])("fails closed when %s", async (_label, options) => {
    await expect(fixture(options)).resolves.toBe(false);
  });

  // Regression, old-saved/new-resumed: an older release stopped a warm sandbox
  // under a restore hold, moved it to retain_on_failure, and never returned it
  // to reuse. Nothing can select it again, so its backup is the newest state.
  it.each([0, 2])("authorizes the backup of a settled restore hold after %i warm handoffs", async (handoffs) => {
    await expect(fixture({ termination: "stopped", restoreHold: "settled", handoffs })).resolves.toBe(true);
  });

  it.each([
    ["the hold marker is missing", { restoreHold: "no_marker" as const }],
    ["the hold marker names another run", { restoreHold: "foreign_marker" as const }],
    ["the stopped lease is still reusable", { restoreHold: "reusable_policy" as const }],
    ["no stop-and-retain receipt exists", { restoreHold: "no_stop_receipt" as const }],
    ["an unsaved writer is still bound to it", { restoreHold: "dirty_writer" as const }],
    ["the stamp names another checkpoint", { restoreHold: "settled" as const, stampSha: `sha256:${"c".repeat(64)}` }],
    ["provider work followed the checkpoint", { restoreHold: "settled" as const, providerEventAt: new Date(completedAt.getTime() + 60_000) }],
    ["one allocation maps to two host leases", { restoreHold: "settled" as const, secondLease: true }],
  ])("keeps a restore-hold backup held when %s", async (_label, options) => {
    await expect(fixture({ termination: "stopped", ...options })).resolves.toBe(false);
  });

  it("ignores provider work that finished before the checkpoint", async () => {
    await expect(fixture({ providerEventAt: new Date(completedAt.getTime() - 1_000) })).resolves.toBe(true);
  });
});
