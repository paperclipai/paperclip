import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, applyPendingMigrations, authUsers, companies, companyMemberships, createDb, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { preserveNativeFailedWorkspace } from "./native-failed-workspace-recovery.js";
import { NativeWorkspaceFinalizationBusyError } from "./native-workspace-finalization-ownership.js";
import type { NativeRestartRecoveryClaim } from "./native-restart-recovery.js";

describe("failed restart-claim preparation whose own claim lease lapsed", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_LAPSED_CLAIM_TEST_DATABASE_URL");
    if (external) {
      await applyPendingMigrations(external);
      db = createDb(external, { maxConnections: 4 });
      return;
    }
    temporary = await startEmbeddedPostgresTestDatabase("lapsed-restart-claim-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  afterEach(async () => {
    await db.transaction(async tx => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate companies cascade`);
    });
  });

  async function seed(leaseExpiresAt: Date) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(),
      leaseId = randomUUID(), providerLeaseId = randomUUID(), userId = randomUUID();
    const leaseOwner = `native-recovery:${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.test`, emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Lapsed claim", issuePrefix: `LC${companyId.replaceAll("-", "").slice(0, 6)}`,
      defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "running", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Remote work", status: "in_progress", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      scopeKind: "issue", runtimeMode: "native", status: "running", nativePhase: "observed", contextSnapshot: { issueId },
      runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
        descriptorSha256: "d".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
        workspaceId: randomUUID(), leaseId, providerLeaseId, remoteCwd: "/work", resourceDisposition: "destroy" } },
    }).returning();
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", leaseOwner,
      leaseExpiresAt, controllerGeneration: 3, attempt: 1 });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: runId, provider: "daytona",
      providerLeaseId, status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" } });
    const claim = { kind: "bootstrap_incomplete", runId, leaseOwner, controllerGeneration: 3, providerAttempt: 1 } as NativeRestartRecoveryClaim;
    return { run, runId, claim };
  }

  it("settles the failed preparation when only its own claim lease lapsed", async () => {
    const f = await seed(new Date(Date.now() - 60_000));
    const retained = await preserveNativeFailedWorkspace(db, f.run, { allowPreterminal: true, restartRecovery: f.claim });
    expect(retained).toMatchObject({ id: f.runId, nativePhase: "terminal_failure" });
    const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(owner).toMatchObject({ phase: "terminal_failure", leaseOwner: null, recoveryState: "blocked" });
  });

  it.each([
    { label: "another owner took the lapsed claim", change: { leaseOwner: "native-recovery:successor" } },
    { label: "a newer generation reclaimed it", change: { controllerGeneration: 4 } },
  ])("still defers when $label", async ({ change }) => {
    const f = await seed(new Date(Date.now() - 60_000));
    await db.update(nativeRunFinalizations).set({ ...change, leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    await expect(preserveNativeFailedWorkspace(db, f.run, { allowPreterminal: true, restartRecovery: f.claim }))
      .rejects.toBeInstanceOf(NativeWorkspaceFinalizationBusyError);
    const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(owner.phase).toBe("observed");
  });
});
