import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, applyPendingMigrations, closeRegisteredClients, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../../__tests__/helpers/external-test-database.js";
import { createAgentLifecycle, configureAgentLifecycle } from "../../../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../../../services/agent-lifecycle-driver.js";
import { agentExecutionsHaveStopped } from "../../../services/agent-execution-stop.js";
import { PROCESS_START_REQUESTED } from "../../../services/native-local-process-stop.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_AGENT_LIFECYCLE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("legacy startup cancellation stop proof", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (external) { await applyPendingMigrations(external); db = createDb(external); }
    else { database = await startEmbeddedPostgresTestDatabase("paperclip-startup-cancel-stop-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterAll(async () => { if (external) await closeRegisteredClients(external); else await database?.cleanup(); });

  // A conversation adapter run that the startup fence cancelled after its claim
  // and before adapter dispatch, for example because the task changed owner.
  async function fixture(adapterType = "claude_local", executionStage = "settled") {
    const id = randomUUID();
    const [company] = await db.insert(companies).values({ name: "Startup cancel", issuePrefix: `S${id.slice(0, 7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "CLI agent",
      adapterType, status: "idle", lifecycleState: "ready" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "cancelled", invocationSource: "on_demand", errorCode: "continuation_task_ownership_changed",
      error: "continuation_task_ownership_changed", runtimeMode: "legacy", executionStage,
      startedAt: new Date("2000-01-01T00:00:00Z"), finishedAt: new Date("2000-01-01T00:00:01Z"),
      runnerProfileJson: { adapterDispatch: { adapterType } },
      resultJson: {
        stopReason: "cancelled",
        cancellation: { source: "control_plane", expected: true, initiator: { type: "system" },
          reason: "continuation_task_ownership_changed", recordedAt: "2000-01-01T00:00:01Z" },
        startupCancellation: { requestedAt: "2000-01-01T00:00:01Z", beforeNativeSelection: false },
      },
    }).returning();
    return { agent, run };
  }

  it.each([["claude_local", "settled"], ["opencode_local", "settled"], ["claude_local", "preparing"]])(
    "finishes a pause after a %s run cancelled before dispatch at %s", async (adapterType, stage) => {
      const { agent } = await fixture(adapterType, stage);
      expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
      const work = configureAgentLifecycle(db, {
        requiredPluginIds: async () => [], runPlugin: async () => "complete",
        runHost: createLifecycleDriver(db, {} as never).runHost,
      });
      try {
        await createAgentLifecycle(db).pauseAgent(agent.id);
        await work.process(agent.id);
        const [paused] = await db.select().from(agents).where(eq(agents.id, agent.id));
        expect(paused).toMatchObject({ status: "paused", lifecycleState: "paused" });
      } finally { await work.stop(); }
    },
  );

  it.each(["adapter.invoke", PROCESS_START_REQUESTED, "session.started", "provider.event", "tool.execution.started", "source_event"])(
    "keeps the stop pending when the run recorded a %s event", async eventType => {
      const { agent, run } = await fixture();
      await db.insert(heartbeatRunEvents).values({ companyId: run.companyId, agentId: agent.id, runId: run.id,
        seq: 1, eventType, ...(eventType === "source_event" ? { sourceEventId: "provider-event" } : {}) });
      expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    },
  );

  it.each([
    { provider: "local", status: "released", cleanupStatus: "success", releasedAt: new Date(0) },
    { provider: "ssh", status: "expired", releasedAt: new Date(0), providerLeaseId: "ssh://agent@host:22/work" },
  ])("keeps the stop pending when the run acquired an environment lease: %j", async lease => {
    const { agent, run } = await fixture();
    await db.insert(environmentLeases).values({ companyId: run.companyId, heartbeatRunId: run.id, ...lease });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
  });

  it.each([
    { resultJson: { stopReason: "cancelled" } },
    { resultJson: { startupCancellation: { beforeNativeSelection: false } } },
    { resultJson: { startupCancellation: { requestedAt: "2000-01-01T00:00:01Z" }, executionCancellation: { state: "requested" } } },
    { executionStage: "dispatching" }, { executionStage: null }, { runtimeMode: "native" },
    { runtimeModeResolvedAt: new Date("2000-01-01T00:00:00Z") },
    { processStartedAt: new Date("2000-01-01T00:00:00Z") },
    { nativeSessionId: randomUUID() }, { sessionIdAfter: "provider-session" },
    { controllerLeaseExpiresAt: new Date("2099-01-01T00:00:00Z") },
    { runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" }, remoteWorkspace: {} } },
    { runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" }, nativeExecutionInput: {} } },
  ])("keeps the stop pending for contradictory run evidence: %j", async patch => {
    const { agent, run } = await fixture();
    await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, run.id));
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
  });
});
