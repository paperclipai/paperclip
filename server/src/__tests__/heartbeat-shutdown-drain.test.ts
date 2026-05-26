import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainStaleHeartbeatRunsOnShutdown } from "../services/heartbeat-shutdown-drain.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat shutdown drain tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("drainStaleHeartbeatRunsOnShutdown", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-shutdown-drain-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Producer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("returns a zero result when no live runs exist", async () => {
    const result = await drainStaleHeartbeatRunsOnShutdown(db);
    expect(result).toEqual({ runsTerminated: 0, issuesUnlocked: 0 });
  });

  it("cancels every live heartbeat run and clears the issue locks they hold", async () => {
    const { companyId, agentId } = await seed();
    const liveRunId = randomUUID();
    const queuedRunId = randomUUID();
    const retryRunId = randomUUID();
    const succeededRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: liveRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      {
        id: queuedRunId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "manual",
      },
      {
        id: retryRunId,
        companyId,
        agentId,
        status: "scheduled_retry",
        invocationSource: "manual",
      },
      {
        id: succeededRunId,
        companyId,
        agentId,
        status: "succeeded",
        invocationSource: "manual",
        finishedAt: new Date(),
      },
    ]);

    const issueWithExecutionLock = randomUUID();
    const issueWithCheckoutOnlyLock = randomUUID();
    const issueOnTerminalRun = randomUUID();
    await db.insert(issues).values([
      {
        id: issueWithExecutionLock,
        companyId,
        title: "Locked by execution",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: liveRunId,
        executionRunId: liveRunId,
        executionAgentNameKey: "producer",
        executionLockedAt: new Date(),
      },
      {
        id: issueWithCheckoutOnlyLock,
        companyId,
        title: "Locked by checkout only",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: queuedRunId,
        executionRunId: null,
      },
      {
        id: issueOnTerminalRun,
        companyId,
        title: "Already terminal",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: succeededRunId,
        executionRunId: succeededRunId,
      },
    ]);

    const result = await drainStaleHeartbeatRunsOnShutdown(db);
    expect(result).toEqual({ runsTerminated: 3, issuesUnlocked: 2 });

    const liveCount = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"))
      .then((rows) => rows.length);
    expect(liveCount).toBe(0);

    const cancelledRow = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, liveRunId))
      .then((rows) => rows[0]);
    expect(cancelledRow?.status).toBe("cancelled");
    expect(cancelledRow?.errorCode).toBe("server_shutdown_stale_lock_cleanup");
    expect(cancelledRow?.finishedAt).not.toBeNull();

    const executionLockedRow = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueWithExecutionLock))
      .then((rows) => rows[0]);
    expect(executionLockedRow).toEqual({
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const checkoutOnlyRow = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueWithCheckoutOnlyLock))
      .then((rows) => rows[0]);
    expect(checkoutOnlyRow).toEqual({ checkoutRunId: null, executionRunId: null });

    const terminalRow = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueOnTerminalRun))
      .then((rows) => rows[0]);
    expect(terminalRow).toEqual({
      checkoutRunId: succeededRunId,
      executionRunId: succeededRunId,
    });
  });
});
