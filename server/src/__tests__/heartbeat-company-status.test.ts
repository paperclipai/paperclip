import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  projects,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat company-status guards", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-company-status-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(routines);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(input: {
    companyStatus: "active" | "paused" | "archived";
    heartbeatEnabled?: boolean;
    queuedRun?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Comandero",
      issuePrefix,
      status: input.companyStatus,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "COO",
      role: "coo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: input.heartbeatEnabled ?? true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    if (input.queuedRun) {
      const wakeupRequestId = randomUUID();
      const runId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "timer",
        triggerDetail: "system",
        reason: "heartbeat_timer",
        payload: {},
        status: "queued",
        runId,
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "timer",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId,
        contextSnapshot: {},
      });
    }

    return { companyId, agentId };
  }

  it("does not queue timer work for archived companies", async () => {
    const { companyId, agentId } = await seedAgent({
      companyStatus: "archived",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(new Date(Date.now() + 120_000));

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));

    expect(runs).toHaveLength(0);
    expect(wakeups).toHaveLength(0);
  });

  it("does not queue timer work or skip rows for paused companies", async () => {
    const { companyId, agentId } = await seedAgent({
      companyStatus: "paused",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(new Date(Date.now() + 120_000));

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));

    expect(runs).toHaveLength(0);
    expect(wakeups).toHaveLength(0);
  });

  it("cancels archived-company queued runs during queued-run recovery", async () => {
    const { companyId, agentId } = await seedAgent({
      companyStatus: "archived",
      queuedRun: true,
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)))
      .then((rows) => rows[0] ?? null);
    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)))
      .then((rows) => rows[0] ?? null);

    expect(run?.status).toBe("cancelled");
    expect(run?.error).toContain("archived");
    expect(wakeup?.status).toBe("cancelled");
  });

  it("cancels queued runs bound to paused routine issues during queued-run recovery", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const routineId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Comandero",
      issuePrefix,
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QA and Release Engineer",
      role: "qa",
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

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "App",
      status: "in_progress",
    });

    await db.insert(routines).values({
      id: routineId,
      companyId,
      projectId,
      title: "Cart trust audit",
      description: "Eliminate any source of doubt",
      assigneeAgentId: agentId,
      priority: "medium",
      status: "paused",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Paused routine issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      originKind: "routine_execution",
      originId: routineId,
      originRunId: randomUUID(),
      routineBoundRunId: randomUUID(),
      routineIssueRole: "canonical",
      executionRunId: runId,
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    const [run, wakeup, issue] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null),
      db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.error).toContain("Routine is paused");
    expect(wakeup?.status).toBe("cancelled");
    expect(issue?.executionRunId).toBeNull();
  });
});
