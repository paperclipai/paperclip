import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres archived-company heartbeat guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat archived-company guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-archived-company-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertArchivedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Archived Co",
      status: "archived",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Archived Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  it("does not iterate archived-company agents in tickTimers", async () => {
    const { agentId } = await insertArchivedAgent();

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(new Date("2026-06-04T00:10:00Z"));

    expect(result).toMatchObject({
      checked: 0,
      enqueued: 0,
      skipped: 0,
    });

    const runCount = await db
      .select()
      .from(heartbeatRuns)
      .then((rows) => rows.filter((row) => row.agentId === agentId).length);
    expect(runCount).toBe(0);
  });

  it("skips background wakeups for non-active companies with a company.inactive reason", async () => {
    const { agentId } = await insertArchivedAgent();

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: randomUUID(), commentId: randomUUID() },
      requestedByActorType: "system",
      requestedByActorId: "comment_wake",
    });

    expect(run).toBeNull();

    const wakeup = await db
      .select({
        agentId: agentWakeupRequests.agentId,
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .then((rows) => rows.find((row) => row.agentId === agentId) ?? null);

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "company.inactive",
      error: "Wake suppressed because company status is archived",
    });
  });

  it("does not advance issue monitors for archived companies", async () => {
    const { companyId, agentId } = await insertArchivedAgent();
    const issueId = randomUUID();
    const monitorScheduledAt = new Date("2026-06-04T00:00:00Z");

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Archived-company monitor issue",
      status: "in_progress",
      assigneeAgentId: agentId,
      monitorNextCheckAt: monitorScheduledAt,
      monitorAttemptCount: 0,
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.tickTimers(new Date("2026-06-04T00:10:00Z"));

    const row = await db
      .select({
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
        monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
        monitorAttemptCount: issues.monitorAttemptCount,
      })
      .from(issues)
      .then((rows) => rows[0] ?? null);

    expect(row?.monitorWakeRequestedAt).toBeNull();
    expect(row?.monitorLastTriggeredAt).toBeNull();
    expect(row?.monitorAttemptCount).toBe(0);
    expect(row?.monitorNextCheckAt?.getTime()).toBe(monitorScheduledAt.getTime());
  });

  it("does not resume queued runs for archived companies", async () => {
    const { companyId, agentId } = await insertArchivedAgent();
    const runId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      status: "queued",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    const status = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .then((rows) => rows[0]?.status ?? null);
    expect(status).toBe("queued");
  });

  it("rejects explicit user invokes for non-active companies", async () => {
    const { agentId } = await insertArchivedAgent();

    const heartbeat = heartbeatService(db);

    await expect(heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      details: { status: "archived" },
    });

    const runCount = await db
      .select()
      .from(heartbeatRuns)
      .then((rows) => rows.filter((row) => row.agentId === agentId).length);
    expect(runCount).toBe(0);
  });
});
