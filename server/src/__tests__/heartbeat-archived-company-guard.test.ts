import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
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
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
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

  async function insertInvalidOrgChainAgent() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const childId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Invalid Org Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "Terminated Manager",
        role: "cto",
        status: "terminated",
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
      },
      {
        id: childId,
        companyId,
        name: "Invalid Chain Child",
        role: "engineer",
        reportsTo: managerId,
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
      },
    ]);

    return { companyId, managerId, childId };
  }

  async function insertActiveTimerAgent(input: {
    createdAt: Date;
    lastHeartbeatAt: Date | null;
    intervalSec: number;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Timer Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: input.intervalSec,
          wakeOnDemand: true,
        },
      },
      lastHeartbeatAt: input.lastHeartbeatAt,
      createdAt: input.createdAt,
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

  it("respects heartbeat interval before enqueuing scheduler timer wakeups", async () => {
    const now = new Date("2026-06-04T00:10:00Z");
    const { agentId } = await insertActiveTimerAgent({
      createdAt: new Date("2026-06-04T00:00:00Z"),
      lastHeartbeatAt: new Date("2026-06-04T00:09:30Z"),
      intervalSec: 60,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(now);

    expect(result).toMatchObject({
      checked: 1,
      enqueued: 0,
      skipped: 0,
    });

    const runCount = await db
      .select()
      .from(heartbeatRuns)
      .then((rows) => rows.filter((row) => row.agentId === agentId).length);
    const wakeupCount = await db
      .select()
      .from(agentWakeupRequests)
      .then((rows) => rows.filter((row) => row.agentId === agentId).length);
    expect(runCount).toBe(0);
    expect(wakeupCount).toBe(0);
  });

  it("uses the scheduler as the trusted timer wakeup source after the interval elapses", async () => {
    const now = new Date("2026-06-04T00:10:00Z");
    const { agentId } = await insertActiveTimerAgent({
      createdAt: new Date("2026-06-04T00:00:00Z"),
      lastHeartbeatAt: new Date("2026-06-04T00:08:59Z"),
      intervalSec: 60,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(now);

    expect(result).toMatchObject({
      checked: 1,
      enqueued: 1,
      skipped: 0,
    });

    const wakeup = await db
      .select({
        source: agentWakeupRequests.source,
        triggerDetail: agentWakeupRequests.triggerDetail,
        reason: agentWakeupRequests.reason,
        requestedByActorType: agentWakeupRequests.requestedByActorType,
        requestedByActorId: agentWakeupRequests.requestedByActorId,
        status: agentWakeupRequests.status,
      })
      .from(agentWakeupRequests)
      .then((rows) => rows.find((row) => row.source === "timer") ?? null);
    expect(wakeup).toMatchObject({
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
      status: "claimed",
    });

    const run = await db
      .select({
        agentId: heartbeatRuns.agentId,
        invocationSource: heartbeatRuns.invocationSource,
      })
      .from(heartbeatRuns)
      .then((rows) => rows.find((row) => row.agentId === agentId) ?? null);
    expect(run).toMatchObject({ invocationSource: "timer" });
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

  it("rejects explicit user invokes for invalid-org-chain agents", async () => {
    const { childId } = await insertInvalidOrgChainAgent();

    const heartbeat = heartbeatService(db);

    await expect(heartbeat.wakeup(childId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      details: {
        reason: "manager_terminated",
        invalidOrgChain: true,
      },
    });

    const runCount = await db
      .select()
      .from(heartbeatRuns)
      .then((rows) => rows.filter((row) => row.agentId === childId).length);
    expect(runCount).toBe(0);
  });

  it("cancels existing queued runs for invalid-org-chain agents instead of starting them", async () => {
    const { companyId, childId } = await insertInvalidOrgChainAgent();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: childId,
      source: "assignment",
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: childId,
      invocationSource: "assignment",
      status: "queued",
      wakeupRequestId,
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    const run = await db
      .select({
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .then((rows) => rows.find((row) => row.status === "cancelled") ?? null);
    expect(run).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the agent is not invokable: manager_terminated",
    });

    const wakeup = await db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the agent is not invokable: manager_terminated",
    });
  });

  it("suppresses due scheduled retries for invalid-org-chain agents", async () => {
    const { companyId, childId } = await insertInvalidOrgChainAgent();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-06-04T00:10:00Z");

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: childId,
      source: "automation",
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: childId,
      invocationSource: "automation",
      status: "scheduled_retry",
      wakeupRequestId,
      scheduledRetryAt: new Date("2026-06-04T00:00:00Z"),
      scheduledRetryReason: "transient_failure",
      scheduledRetryAttempt: 1,
    });

    const heartbeat = heartbeatService(db);
    const promoted = await heartbeat.promoteDueScheduledRetries(now);

    expect(promoted).toEqual({ promoted: 0, runIds: [] });
    const run = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .then((rows) => rows[0] ?? null);
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "agent_not_invokable",
      error: "Scheduled retry suppressed because the agent is not invokable",
    });
  });
});
