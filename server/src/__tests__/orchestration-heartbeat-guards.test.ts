import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
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
import {
  HEARTBEAT_SKIP_ON_DEMAND_BARE_WAKE,
  HEARTBEAT_SKIP_TIMER_NO_ASSIGNED_ISSUE,
  RUN_CANCEL_ISSUE_CANCELLED_WHILE_RUNNING,
  RUN_FINALIZE_ISSUE_CLOSED_DONE,
} from "../services/orchestration-invariants.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping orchestration heartbeat guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("orchestration heartbeat guards (007 / 010)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orch-guards-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithAgent(input: { agentRole: string; heartbeatEnabled: boolean }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Orch test co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TimerAgent",
      role: input.agentRole,
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: input.heartbeatEnabled,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    return { companyId, agentId, issuePrefix };
  }

  it("timer wakeup skips when agent has no runnable assigned issue (HB-007)", async () => {
    const { agentId } = await seedCompanyWithAgent({ agentRole: "cto", heartbeatEnabled: true });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "test",
      contextSnapshot: { wakeSource: "timer" },
    });

    expect(run).toBeNull();

    const skip = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0]);
    expect(skip?.reason).toBe(HEARTBEAT_SKIP_TIMER_NO_ASSIGNED_ISSUE);
  });

  it("on_demand wakeup skips when reason is set but issueId is absent (HB-010 bare wake)", async () => {
    const { agentId } = await seedCompanyWithAgent({ agentRole: "engineer", heartbeatEnabled: false });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "模块探查任务 ROU-9",
      requestedByActorType: "user",
      requestedByActorId: "board",
      contextSnapshot: { triggeredBy: "board" },
    });

    expect(run).toBeNull();

    const skip = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0]);
    expect(skip?.reason).toBe(HEARTBEAT_SKIP_ON_DEMAND_BARE_WAKE);
  });

  it("reconcileRunningRunsForClosedIssues finalizes running heartbeat tied to done issue", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyWithAgent({
      agentRole: "engineer",
      heartbeatEnabled: false,
    });
    const issueId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-05-16T12:00:00.000Z");

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Closed work",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: now,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      updatedAt: now,
      createdAt: now,
    });

    const heartbeat = heartbeatService(db);
    const out = await heartbeat.reconcileRunningRunsForClosedIssues({ limit: 10 });
    expect(out.reconciled).toBe(1);

    const row = await db
      .select({
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("succeeded");
    expect(row?.error).toBeNull();
    const resultJson =
      row?.resultJson && typeof row.resultJson === "object" && !Array.isArray(row.resultJson)
        ? (row.resultJson as Record<string, unknown>)
        : {};
    expect(resultJson.issueClosedFinalizeNote).toBe(RUN_FINALIZE_ISSUE_CLOSED_DONE);
    expect(resultJson.stopReason).toBe("completed");
  });

  it("reconcileRunningRunsForClosedIssues skips when child process is still alive", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyWithAgent({
      agentRole: "engineer",
      heartbeatEnabled: false,
    });
    const issueId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-05-16T12:00:00.000Z");

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Closed work",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: now,
      processPid: process.pid,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      updatedAt: now,
      createdAt: now,
    });

    const heartbeat = heartbeatService(db);
    const out = await heartbeat.reconcileRunningRunsForClosedIssues({ limit: 10 });
    expect(out.reconciled).toBe(0);
    expect(out.skipped).toBe(1);

    const row = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("running");
  });

  it("reconcileRunningRunsForClosedIssues cancels running heartbeat tied to cancelled issue", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyWithAgent({
      agentRole: "engineer",
      heartbeatEnabled: false,
    });
    const issueId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-05-16T12:00:00.000Z");

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancelled work",
      status: "cancelled",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: now,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      updatedAt: now,
      createdAt: now,
    });

    const heartbeat = heartbeatService(db);
    const out = await heartbeat.reconcileRunningRunsForClosedIssues({ limit: 10 });
    expect(out.reconciled).toBe(1);

    const row = await db
      .select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("cancelled");
    expect(row?.error).toBe(RUN_CANCEL_ISSUE_CANCELLED_WHILE_RUNNING);
  });
});
