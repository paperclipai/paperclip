import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-status reconciliation tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const GRACE_MS = 10 * 60 * 1000;
const STALE_AT = new Date(Date.now() - 30 * 60_000);
// A pid this large is never alive on macOS/Linux, so `isPidAlive` reports the
// recorded adapter process as dead and the run is not genuinely live.
const DEAD_PID = 2_147_483_646;

// Regression: an agent wrapped around a dead run must converge to `idle` under
// the watchdog, and the watchdog must serialize with dispatch (the queue path
// takes the same agents-row lock) so it can never demote a freshly dispatched
// live run to `idle`.
describeEmbeddedPostgres("reconcileStrandedAgentStatuses", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-agent-status-reconciliation-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedStrandedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "WedgedCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
      lastHeartbeatAt: STALE_AT,
      updatedAt: STALE_AT,
      createdAt: STALE_AT,
    });

    // A run row that still says `running` but whose adapter process is dead and
    // whose last activity is far past the grace window: exactly the COR-3221
    // wedge (run terminalized out of band, agent status never cleared).
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      processPid: DEAD_PID,
      startedAt: STALE_AT,
      updatedAt: STALE_AT,
      createdAt: STALE_AT,
    });

    return { companyId, agentId, runId, issuePrefix, now };
  }

  it("converges a running agent to idle and records the correction", async () => {
    const { agentId } = await seedStrandedAgent();

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAgentStatuses();

    expect(result.scanned).toBe(1);
    expect(result.reconciled).toBe(1);
    expect(result.agentIds).toEqual([agentId]);

    const [agent] = await db
      .select({ status: agents.status, errorReason: agents.errorReason })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agent).toEqual({ status: "idle", errorReason: null });

    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "agent.status_reconciled_from_stale_running"));
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({
      source: "recovery.reconcile_stranded_agent_statuses",
      previousStatus: "running",
      nextStatus: "idle",
      reason: "no_live_run",
    });
  });

  it("does not demote a run dispatched while the sweep is deciding", async () => {
    const { companyId, agentId, runId } = await seedStrandedAgent();
    const dispatchedRunId = randomUUID();

    // Simulate the queue path: it holds the agents-row lock for the whole
    // dispatch transaction and inserts its execution-path run before releasing
    // it. The holder below takes the exact same lock first, so the sweep cannot
    // read run state until dispatch has committed.
    let signalLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      signalLockAcquired = resolve;
    });
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });

    const dispatch = db.transaction(async (tx) => {
      await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, agentId))
        .for("update");
      signalLockAcquired();
      await dispatchGate;
      await tx.insert(heartbeatRuns).values({
        id: dispatchedRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        // Alive pid: this run is genuinely live, so the sweep must keep the
        // agent `running` once it observes it.
        processPid: process.pid,
        startedAt: STALE_AT,
        updatedAt: STALE_AT,
        createdAt: STALE_AT,
      });
    });

    await lockAcquired;

    const heartbeat = heartbeatService(db);
    const sweep = heartbeat.reconcileStrandedAgentStatuses();

    // Let the sweep reach (and block on) the row lock dispatch holds.
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseDispatch();
    await dispatch;

    const result = await sweep;
    expect(result.reconciled).toBe(0);

    const [agent] = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agent.status).toBe("running");

    const audit = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.action, "agent.status_reconciled_from_stale_running"));
    expect(audit).toHaveLength(0);

    // Sanity: the still-dead stale run is present and would have been
    // reconciled on its own, proving the live dispatched run is what held the
    // sweep back.
    const [staleRun] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId)));
    expect(staleRun.status).toBe("running");
  });
});
