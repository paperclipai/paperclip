import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, applyPendingMigrations, closeRegisteredClients, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../../__tests__/helpers/external-test-database.js";
import { createAgentLifecycle, configureAgentLifecycle } from "../../../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../../../services/agent-lifecycle-driver.js";
import { agentExecutionStopBlocker, agentExecutionsHaveStopped } from "../../../services/agent-execution-stop.js";
import { isSettledCancelledLegacyPreparation } from "../../../services/settled-legacy-preparation-stop-proof.js";
import { PROCESS_START_REQUESTED } from "../../../services/native-local-process-stop.js";
import { remoteTerminationReceipt } from "../../../services/remote-execution-termination.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_AGENT_LIFECYCLE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("settled cancelled legacy preparation stop proof", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (external) { await applyPendingMigrations(external); db = createDb(external); }
    else { database = await startEmbeddedPostgresTestDatabase("paperclip-settled-legacy-stop-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterAll(async () => { if (external) await closeRegisteredClients(external); else await database?.cleanup(); });

  async function fixture(overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const id = randomUUID();
    const [company] = await db.insert(companies).values({ name: "Settled legacy", issuePrefix: `S${id.slice(0, 7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Conversation agent",
      adapterType: "claude_local", status: "idle", lifecycleState: "ready" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "cancelled", invocationSource: "on_demand", errorCode: "issue_reassigned", error: "Cancelled before issue reassignment",
      runtimeMode: "legacy", executionStage: "settled",
      startedAt: new Date("2000-01-01T00:00:00Z"), finishedAt: new Date("2000-01-01T00:00:01Z"),
      runtimeModeResolvedAt: new Date("2000-01-01T00:00:00.500Z"),
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      resultJson: {
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false, preparationSettledAt: "2000-01-01T00:00:01.300Z" },
        executionCancellation: { state: "requested", requestedAt: "2000-01-01T00:00:00.900Z" },
        cancellation: { source: "control_plane", expected: true, initiator: { type: "system" },
          reason: "Cancelled before issue reassignment", recordedAt: "2000-01-01T00:00:01Z" },
      },
      ...overrides,
    }).returning();
    return { agent, run };
  }

  it("finishes a pause when the owning executor settled the cancelled preparation", async () => {
    const { agent, run } = await fixture();
    expect(await isSettledCancelledLegacyPreparation(db, run, undefined)).toBe(true);
    expect(await agentExecutionStopBlocker(db, [agent.id])).toBeNull();
    const work = configureAgentLifecycle(db, {
      requiredPluginIds: async () => [], runPlugin: async () => "complete",
      runHost: createLifecycleDriver(db, {} as never).runHost,
    });
    try {
      await createAgentLifecycle(db).pauseAgent(agent.id);
      await work.process(agent.id);
      const [paused] = await db.select().from(agents).where(eq(agents.id, agent.id));
      expect(paused).toMatchObject({ status: "paused", lifecycleState: "paused", lifecycleHolds: ["manual"] });
      expect((paused.lifecycleOperation as Record<string, unknown> | null)?.pendingReason).toBeUndefined();
      const [same] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(same.resultJson).toEqual(run.resultJson);
    } finally { await work.stop(); }
  });

  it("holds the pause for the same run without the executor's settle receipt", async () => {
    const { agent, run } = await fixture();
    const { executionRecovery: _receipt, ...withoutReceipt } = run.resultJson as Record<string, unknown>;
    await db.update(heartbeatRuns).set({ resultJson: withoutReceipt }).where(eq(heartbeatRuns.id, run.id));
    expect(await agentExecutionStopBlocker(db, [agent.id])).toBe("legacy_stop_unproven");
  });

  it.each([
    { resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } },
    { resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true, preparationSettledAt: "2000-01-01T00:00:01.300Z" } } },
    { resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false, preparationSettledAt: "2000-01-01T00:00:01.300Z" } } },
    { resultJson: { cancellation: { source: "unknown", expected: false, initiator: { type: "system" }, reason: "lost", recordedAt: "2000-01-01T00:00:01Z" } } },
    { resultJson: { workspaceRestoreFailure: "restore_unsafe_archive" } },
    { resultJson: { workspaceRestoreFailure: "restore_lock_timeout", workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1" } } },
    { runnerProfileJson: { nativeExecutionInput: {} } }, { runnerProfileJson: { remoteWorkspace: {} } },
    { runnerProfileJson: { nativeWorkspaceSync: {} } }, { runnerProfileJson: { sessionCheckpoint: {} } },
    { runnerProfileJson: { nativeWorkspaceFinalizationOwner: {} } },
    { processPid: process.pid }, { processStartedAt: new Date("2000-01-01T00:00:00Z") },
    { sessionIdAfter: "provider-session" }, { nativeSessionId: randomUUID() }, { nativeIssueId: randomUUID() },
    { controllerLeaseExpiresAt: new Date("2099-01-01T00:00:00Z") },
    { runtimeMode: "native" }, { status: "failed" }, { finishedAt: null },
  ])("rejects contradictory run evidence: %j", async patch => {
    const { agent, run } = await fixture();
    const merged = "resultJson" in patch ? { resultJson: { ...(run.resultJson as Record<string, unknown>), ...patch.resultJson } }
      : "runnerProfileJson" in patch ? { runnerProfileJson: { ...(run.runnerProfileJson as Record<string, unknown>), ...patch.runnerProfileJson } }
      : patch;
    await db.update(heartbeatRuns).set(merged as Partial<typeof heartbeatRuns.$inferInsert>).where(eq(heartbeatRuns.id, run.id));
    const [changed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(await isSettledCancelledLegacyPreparation(db, changed, undefined)).toBe(false);
    const filesOwed = typeof changed.resultJson?.workspaceRestoreFailure === "string";
    if (changed.status === "cancelled" && changed.runtimeMode === "legacy" && !filesOwed) {
      expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    }
  });

  it.each(["adapter.invoke", PROCESS_START_REQUESTED, "session.started", "provider.event", "tool.execution.started", "source_event"])(
    "rejects the receipt once a %s event proves execution", async eventType => {
      const { agent, run } = await fixture();
      await db.insert(heartbeatRunEvents).values({ companyId: run.companyId, agentId: agent.id, runId: run.id,
        seq: 1, eventType, ...(eventType === "source_event" ? { sourceEventId: "provider-event" } : {}) });
      expect(await isSettledCancelledLegacyPreparation(db, run, undefined)).toBe(false);
      expect(await agentExecutionStopBlocker(db, [agent.id])).toBe("legacy_stop_unproven");
    },
  );

  it("ignores a harmless lifecycle event", async () => {
    const { agent, run } = await fixture();
    await db.insert(heartbeatRunEvents).values({ companyId: run.companyId, agentId: agent.id, runId: run.id,
      seq: 1, eventType: "lifecycle", stream: "system", message: "run cancelled" });
    expect(await agentExecutionStopBlocker(db, [agent.id])).toBeNull();
  });

  it.each([
    { provider: "local", status: "active" },
    { provider: "local", status: "pending_cleanup", releasedAt: new Date(0) },
    { provider: "local", status: "released", cleanupStatus: "failed", releasedAt: new Date(0) },
    { provider: "local", status: "released", cleanupStatus: "success", releasedAt: new Date(0), metadata: { pendingCleanupInFlight: true } },
    { provider: "ssh", status: "released", cleanupStatus: "success", releasedAt: new Date(0), providerLeaseId: "synthetic-lease" },
  ])("requires resource cleanup proof: %j", async lease => {
    const { agent, run } = await fixture();
    await db.insert(environmentLeases).values({ companyId: run.companyId, heartbeatRunId: run.id, ...lease });
    expect(await isSettledCancelledLegacyPreparation(db, run, undefined)).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
  });

  it("accepts a released local lease", async () => {
    const { agent, run } = await fixture();
    await db.insert(environmentLeases).values({ companyId: run.companyId, heartbeatRunId: run.id,
      provider: "local", status: "released", releasedAt: new Date(0), cleanupStatus: "success" });
    expect(await isSettledCancelledLegacyPreparation(db, run, undefined)).toBe(true);
    expect(await agentExecutionStopBlocker(db, [agent.id])).toBeNull();
  });

  it("accepts a remote lease only after its exact termination receipt is saved", async () => {
    const { agent, run } = await fixture();
    const [remote] = await db.insert(environmentLeases).values({ companyId: run.companyId, heartbeatRunId: run.id,
      provider: "ssh", providerLeaseId: "synthetic-remote", status: "released", releasedAt: new Date(0), cleanupStatus: "success" }).returning();
    expect(await isSettledCancelledLegacyPreparation(db, run, undefined)).toBe(false);
    expect(await agentExecutionStopBlocker(db, [agent.id])).toBe("remote_stop_unconfirmed");
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination:
      remoteTerminationReceipt(remote, { providerLeaseId: remote.providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, remote.id));
    expect(await isSettledCancelledLegacyPreparation(db, run, undefined)).toBe(true);
    expect(await agentExecutionStopBlocker(db, [agent.id])).toBeNull();
  });

  it("rejects a native coordinator even without a current owner", async () => {
    const { agent, run } = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: run.companyId, title: "Native ownership" }).returning();
    const [changed] = await db.update(heartbeatRuns).set({ nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, run.id)).returning();
    const [coordinator] = await db.insert(nativeRunFinalizations).values({ companyId: run.companyId, runId: run.id, issueId: issue.id, phase: "observed" }).returning();
    expect(await isSettledCancelledLegacyPreparation(db, changed, coordinator)).toBe(false);
    expect(await isSettledCancelledLegacyPreparation(db, { ...changed, nativeIssueId: null }, undefined)).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
  });
});
