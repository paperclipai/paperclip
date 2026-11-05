import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
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
    providerEventAt?: Date; secondLease?: boolean } = {}) {
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
    await db.insert(environmentLeases).values(lease(leaseId));
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

  it("ignores provider work that finished before the checkpoint", async () => {
    await expect(fixture({ providerEventAt: new Date(completedAt.getTime() - 1_000) })).resolves.toBe(true);
  });
});
