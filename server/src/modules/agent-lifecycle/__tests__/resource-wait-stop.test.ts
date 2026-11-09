import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, applyPendingMigrations, closeRegisteredClients, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../../__tests__/helpers/external-test-database.js";
import { createAgentLifecycle, configureAgentLifecycle } from "../../../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../../../services/agent-lifecycle-driver.js";
import { agentExecutionsHaveStopped } from "../../../services/agent-execution-stop.js";
import { canRetryStoppedRun } from "../../../services/cancelled-native-startup.js";
import { legacyExecutionNeedsReconciliation } from "../../../services/legacy-execution-recovery.js";
import { legacyControllerBootId } from "../../../services/legacy-controller-lease.js";
import { PROCESS_START_REQUESTED } from "../../../services/native-local-process-stop.js";
import { remoteTerminationReceipt } from "../../../services/remote-execution-termination.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_AGENT_LIFECYCLE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("pre-dispatch resource wait stop proof", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (external) { await applyPendingMigrations(external); db = createDb(external); }
    else { database = await startEmbeddedPostgresTestDatabase("paperclip-resource-wait-stop-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterAll(async () => { if (external) await closeRegisteredClients(external); else await database?.cleanup(); });

  async function fixture(errorCode = "workspace_busy", executionStage = "preparing") {
    const id = randomUUID();
    const [company] = await db.insert(companies).values({ name: "Resource wait", issuePrefix: `W${id.slice(0, 7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Migrated agent",
      adapterType: "paperclip_runner", status: "idle", lifecycleState: "ready" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "cancelled", invocationSource: "on_demand", errorCode, runtimeMode: "legacy", executionStage,
      startedAt: new Date("2000-01-01T00:00:00Z"), finishedAt: new Date("2000-01-01T00:00:01Z"),
      controllerBootId: legacyControllerBootId, controllerLeaseExpiresAt: new Date("2000-01-01T00:01:00Z"),
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      resultJson: {
        executionRecovery: { kind: errorCode === "workspace_busy" ? "workspace_wait" : "ai_connection_wait", providerWorkStarted: false },
        cancellation: { source: "control_plane", expected: true, initiator: { type: "system" },
          reason: "Waiting for a resource", recordedAt: "2000-01-01T00:00:01Z" },
      },
    }).returning();
    return { agent, run };
  }

  it.each(["workspace_busy", "ai_connection_busy", "ai_connection_pool_exhausted", "provider_limit_wait"].flatMap(errorCode =>
    ["preparing", "settled"].map(stage => [errorCode, stage])))("finishes a pause after a %s wait at %s", async (errorCode, stage) => {
    const { agent, run } = await fixture(errorCode, stage);
    const work = configureAgentLifecycle(db, {
      requiredPluginIds: async () => [], runPlugin: async () => "complete",
      runHost: createLifecycleDriver(db, {} as never).runHost,
    });
    try {
      expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
      expect(await canRetryStoppedRun(db, run)).toBe(true);
      await createAgentLifecycle(db).pauseAgent(agent.id);
      await work.process(agent.id);
      const [paused] = await db.select().from(agents).where(eq(agents.id, agent.id));
      expect(paused).toMatchObject({ status: "paused", lifecycleState: "paused", lifecycleHolds: ["manual"] });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id)))).toHaveLength(1);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("cancelled");
    } finally { await work.stop(); }
  });

  it.each([
    { resultJson: {} },
    { resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: true } } },
    { resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } },
    { errorCode: "cancelled" }, { executionStage: "dispatching" }, { executionStage: null },
    { runtimeMode: "native" }, { runtimeModeResolvedAt: new Date("2000-01-01T00:00:00Z") },
    { processPid: process.pid }, { processStartedAt: new Date("2000-01-01T00:00:00Z") },
    { nativeSessionId: randomUUID() }, { nativeIssueId: randomUUID() }, { sessionIdAfter: "provider-session" },
    { controllerLeaseExpiresAt: new Date("2099-01-01T00:00:00Z") },
    { runnerProfileJson: { nativeExecutionInput: {} } }, { runnerProfileJson: { remoteWorkspace: {} } },
    { runnerProfileJson: { nativeWorkspaceSync: {} } },
  ])("rejects contradictory run evidence: %j", async patch => {
    const { agent, run } = await fixture();
    await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, run.id));
    const [changed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(await canRetryStoppedRun(db, changed)).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
  });

  it.each(["restore_unsafe_archive", "restore_lock_timeout"])("preserves an outstanding %s workspace obligation", async workspaceRestoreFailure => {
    const { agent, run } = await fixture();
    const [changed] = await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, workspaceRestoreFailure,
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1" } } }).where(eq(heartbeatRuns.id, run.id)).returning();
    expect(await canRetryStoppedRun(db, changed)).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
  });

  it.each(["adapter.invoke", PROCESS_START_REQUESTED, "session.started", "provider.event", "tool.execution.started", "source_event"])(
    "retains a wait with a recorded %s event", async eventType => {
      const { agent, run } = await fixture();
      await db.insert(heartbeatRunEvents).values({ companyId: run.companyId, agentId: agent.id, runId: run.id,
        seq: 1, eventType, ...(eventType === "source_event" ? { sourceEventId: "provider-event" } : {}) });
      expect(await canRetryStoppedRun(db, run)).toBe(false);
      expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    },
  );

  it.each([
    { provider: "local", status: "active" },
    { provider: "local", status: "pending_cleanup", releasedAt: new Date(0) },
    { provider: "local", status: "released", cleanupStatus: "failed", releasedAt: new Date(0) },
    { provider: "local", status: "released", cleanupStatus: "success", releasedAt: new Date(0), metadata: { pendingCleanupInFlight: true } },
    { provider: "ssh", status: "released", cleanupStatus: "success", releasedAt: new Date(0), providerLeaseId: "synthetic-lease" },
  ])("requires resource cleanup proof: %j", async lease => {
    const { agent, run } = await fixture();
    await db.insert(environmentLeases).values({ companyId: run.companyId, heartbeatRunId: run.id, ...lease });
    expect(await canRetryStoppedRun(db, run)).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
  });

  it("rejects a native coordinator even without a current owner", async () => {
    const { agent, run } = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: run.companyId, title: "Native ownership" }).returning();
    const [changed] = await db.update(heartbeatRuns).set({ nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, run.id)).returning();
    await db.insert(nativeRunFinalizations).values({ companyId: run.companyId, runId: run.id, issueId: issue.id, phase: "observed" });
    expect(await canRetryStoppedRun(db, changed)).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
  });

  it("accepts a remote resource only after its exact termination receipt is saved", async () => {
    const { agent, run } = await fixture();
    const [lease] = await db.insert(environmentLeases).values({ companyId: run.companyId, heartbeatRunId: run.id,
      provider: "ssh", providerLeaseId: "synthetic-remote", status: "released", releasedAt: new Date(0), cleanupStatus: "success" }).returning();
    expect(await canRetryStoppedRun(db, run)).toBe(false);
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination:
      remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, lease.id));
    expect(await canRetryStoppedRun(db, run)).toBe(true);
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
  });

  it("does not mistake an unproven HTTP dispatch for a resource wait", async () => {
    const { agent, run } = await fixture("cancelled", "dispatching");
    const [changed] = await db.update(heartbeatRuns).set({ resultJson: null,
      runnerProfileJson: { adapterDispatch: { adapterType: "http" } } }).where(eq(heartbeatRuns.id, run.id)).returning();
    expect(await canRetryStoppedRun(db, changed)).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
  });
});
