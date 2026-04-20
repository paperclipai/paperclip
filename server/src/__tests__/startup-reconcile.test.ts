import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  reconcileStuckRunsOnStartup,
  RECONCILE_GRACE_MS,
} from "../services/startup-reconcile.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres startup-reconcile tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("reconcileStuckRunsOnStartup", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-startup-reconcile-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(overrides?: { agentStatus?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Corp",
      issuePrefix: `TC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent",
      role: "engineer",
      status: overrides?.agentStatus ?? "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  it("marks a stuck running heartbeat_run as failed and resets the agent to idle", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = randomUUID();
    const staleStartedAt = new Date(Date.now() - RECONCILE_GRACE_MS - 5_000);

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      startedAt: staleStartedAt,
    });

    const result = await reconcileStuckRunsOnStartup(db);

    expect(result.heartbeatRunsReset).toBe(1);
    expect(result.agentsReset).toBe(1);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Reconciled on server start — process lost");
    expect(run.finishedAt).not.toBeNull();
    expect(run.exitCode).toBeNull();

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("idle");
  });

  it("marks a stuck run with NULL started_at as failed", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      startedAt: null,
    });

    const result = await reconcileStuckRunsOnStartup(db);

    expect(result.heartbeatRunsReset).toBe(1);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.status).toBe("failed");
  });

  it("does NOT touch a recently started running run within the grace window", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = randomUUID();
    const recentStartedAt = new Date(Date.now() - RECONCILE_GRACE_MS / 2);

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      startedAt: recentStartedAt,
    });

    const result = await reconcileStuckRunsOnStartup(db);

    expect(result.heartbeatRunsReset).toBe(0);
    // agent still has an active run, should not be reset
    expect(result.agentsReset).toBe(0);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.status).toBe("running");

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("running");
  });

  it("does NOT reset an agent that still has a queued run after reconciliation", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();

    // One stale running run — will be failed
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      startedAt: new Date(Date.now() - RECONCILE_GRACE_MS - 5_000),
    });

    // One still-queued run — agent should not be demoted to idle
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "queued",
      startedAt: null,
    });

    const result = await reconcileStuckRunsOnStartup(db);

    expect(result.heartbeatRunsReset).toBe(1);
    expect(result.agentsReset).toBe(0);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("running");
  });

  it("is idempotent — calling twice produces no additional changes on the second call", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      startedAt: new Date(Date.now() - RECONCILE_GRACE_MS - 5_000),
    });

    const first = await reconcileStuckRunsOnStartup(db);
    expect(first.heartbeatRunsReset).toBe(1);
    expect(first.agentsReset).toBe(1);

    const second = await reconcileStuckRunsOnStartup(db);
    expect(second.heartbeatRunsReset).toBe(0);
    expect(second.agentsReset).toBe(0);
  });

  it("leaves failed/completed runs and idle agents untouched", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentStatus: "idle" });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "failed",
      startedAt: new Date(Date.now() - RECONCILE_GRACE_MS - 10_000),
      error: "some previous error",
    });

    const result = await reconcileStuckRunsOnStartup(db);

    expect(result.heartbeatRunsReset).toBe(0);
    expect(result.agentsReset).toBe(0);
  });
});
