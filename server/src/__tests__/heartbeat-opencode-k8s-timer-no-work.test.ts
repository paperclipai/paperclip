import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
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
    `Skipping embedded Postgres opencode_k8s timer no-work tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("opencode_k8s timer no-work suppression", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-opencode-k8s-timer-no-work-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedOpencodeK8sTimerAgent(input: {
    companyId: string;
    agentId: string;
    lastHeartbeatAt: Date;
  }) {
    const issuePrefix = `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: "Staff Engineer",
      role: "engineer",
      status: "active",
      adapterType: "opencode_k8s",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
      lastHeartbeatAt: input.lastHeartbeatAt,
      createdAt: input.lastHeartbeatAt,
      updatedAt: input.lastHeartbeatAt,
    });

    return { issuePrefix };
  }

  async function saturateAgentConcurrency(input: {
    companyId: string;
    agentId: string;
    now: Date;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      lastOutputAt: new Date(),
      contextSnapshot: {
        taskKey: `issue:${randomUUID()}`,
        wakeReason: "test_busy_slot",
      },
      startedAt: input.now,
      updatedAt: input.now,
      createdAt: input.now,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId: input.companyId,
      agentId: input.agentId,
      runId,
      seq: 1,
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      message: "adapter invocation",
      payload: {},
    });
  }

  it("skips opencode_k8s timer ticks when the agent has no assigned live work", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-05-25T20:30:00.000Z");
    const heartbeat = heartbeatService(db);

    await seedOpencodeK8sTimerAgent({
      companyId,
      agentId,
      lastHeartbeatAt: new Date("2026-05-25T20:28:00.000Z"),
    });
    await saturateAgentConcurrency({ companyId, agentId, now });

    const result = await heartbeat.tickTimers(now);

    expect(result).toMatchObject({ checked: 1, enqueued: 0, skipped: 1 });

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot).toMatchObject({ wakeReason: "test_busy_slot" });

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      source: "timer",
      triggerDetail: "system",
      reason: "no_in_flight_work",
      status: "skipped",
    });

    const agent = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]);
    expect(agent?.lastHeartbeatAt?.toISOString()).toBe(now.toISOString());

    const immediateRetry = await heartbeat.tickTimers(new Date("2026-05-25T20:30:10.000Z"));
    expect(immediateRetry).toMatchObject({ checked: 1, enqueued: 0, skipped: 0 });

    const wakeupsAfterImmediateRetry = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeupsAfterImmediateRetry).toHaveLength(1);
  });

  it("queues opencode_k8s timer ticks when the agent has assigned live work", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-05-25T20:30:00.000Z");
    const heartbeat = heartbeatService(db);
    const { issuePrefix } = await seedOpencodeK8sTimerAgent({
      companyId,
      agentId,
      lastHeartbeatAt: new Date("2026-05-25T20:28:00.000Z"),
    });
    await saturateAgentConcurrency({ companyId, agentId, now });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Actionable work",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const result = await heartbeat.tickTimers(now);

    expect(result).toMatchObject({ checked: 1, enqueued: 1, skipped: 0 });

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    const timerRun = runs.find((run) => run.invocationSource === "timer");
    expect(timerRun).toMatchObject({
      invocationSource: "timer",
      triggerDetail: "system",
      status: "queued",
    });

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      source: "timer",
      reason: "heartbeat_timer",
      status: "queued",
    });
  });
});
