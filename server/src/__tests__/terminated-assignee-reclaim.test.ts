import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { routineRoutes } from "../routes/routines.js";
import { agentService } from "../services/agents.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Assigning an issue wakes the new assignee. The wake starts a background run
// that outlives this file and then writes to the embedded Postgres after the
// database stops, which fails the whole test file with an unhandled error. This
// suite checks ownership rules, not wake delivery, so make the wake a no-op.
vi.mock("../services/heartbeat.js", async () => {
  const actual = await vi.importActual<typeof import("../services/heartbeat.js")>("../services/heartbeat.js");
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup: async () => null,
    }),
  };
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminated-assignee reclaim tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * Regression coverage for the "terminated agent parks work forever" hole:
 * an issue or routine still pointing at a terminated agent answered
 * `403 Issue is outside this actor's authorization boundary` on PATCH and
 * `409 Issue checkout conflict` on checkout (with `checkoutRunId` and
 * `executionRunId` both null), so nobody in the company could reclaim it.
 */
describeEmbeddedPostgres("reclaiming work owned by a terminated agent", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const boardUserId = "board-user-terminated-assignee";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminated-assignee-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    tempDb = null;
  });

  function boardActor(companyId: string) {
    return {
      type: "board",
      userId: boardUserId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      source: "session",
      isInstanceAdmin: false,
    };
  }

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null }));
    app.use("/api", routineRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Terminated assignee ${companyId}`,
      issuePrefix: `T${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: boardUserId,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: boardUserId,
      membershipRole: "owner",
      grantedByUserId: null,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: overrides.title ?? "Work parked by a terminated agent",
      status: overrides.status ?? "todo",
      priority: "medium",
      assigneeAgentId: overrides.assigneeAgentId,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    return id;
  }

  async function seedRunningRun(companyId: string, agentId: string, sourceIssueId?: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: sourceIssueId ? { issueId: sourceIssueId } : {},
    });
    return runId;
  }

  /** Company with a terminated agent plus a live agent that should be able to reclaim its work. */
  async function seedTerminatedOwner() {
    const companyId = await seedCompany();
    const deadAgentId = await seedAgent(companyId, "Terminated VP of Engineering");
    const liveAgentId = await seedAgent(companyId, "Software Engineer");
    return { companyId, deadAgentId, liveAgentId };
  }

  it("lets another agent check out an issue whose assignee was terminated", async () => {
    const { companyId, deadAgentId, liveAgentId } = await seedTerminatedOwner();
    const issueId = await seedIssue(companyId, { assigneeAgentId: deadAgentId, status: "todo" });
    await agentService(db).terminate(deadAgentId);

    const runId = await seedRunningRun(companyId, liveAgentId);
    const app = createApp({
      type: "agent",
      agentId: liveAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: liveAgentId, expectedStatuses: ["todo", "backlog", "blocked", "in_review"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.assigneeAgentId).toBe(liveAgentId);
    expect(res.body.status).toBe("in_progress");

    // The release of the dead assignee is an ownership change with no actor
    // request behind it, so it must leave an audit trail.
    const [audit] = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.terminated_assignee_released"));
    expect(audit?.action).toBe("issue.terminated_assignee_released");
    expect((audit?.details as Record<string, unknown>)?.previousAssigneeAgentId).toBe(deadAgentId);
  });

  it("lets another agent mutate an in_progress issue left behind by a terminated assignee", async () => {
    const { companyId, deadAgentId, liveAgentId } = await seedTerminatedOwner();
    // Mirrors the stuck production row: in_progress, but no run holds it.
    const issueId = await seedIssue(companyId, { assigneeAgentId: deadAgentId, status: "in_progress" });
    await agentService(db).terminate(deadAgentId);

    // The reclaiming agent acts from its own checked-out task, so the run has a
    // source issue and the cross-issue influence cap can attribute the write.
    const sourceIssueId = await seedIssue(companyId, {
      title: "Reclaim the parked task",
      assigneeAgentId: liveAgentId,
      status: "in_progress",
    });
    const runId = await seedRunningRun(companyId, liveAgentId, sourceIssueId);
    const app = createApp({
      type: "agent",
      agentId: liveAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: liveAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.assigneeAgentId).toBe(liveAgentId);
  });

  it("keeps another agent's live issue protected", async () => {
    const { companyId, deadAgentId, liveAgentId } = await seedTerminatedOwner();
    const issueId = await seedIssue(companyId, { assigneeAgentId: deadAgentId, status: "in_progress" });
    const ownerRunId = await seedRunningRun(companyId, deadAgentId);
    await db.update(issues).set({ checkoutRunId: ownerRunId, executionRunId: ownerRunId }).where(eq(issues.id, issueId));

    const runId = await seedRunningRun(companyId, liveAgentId);
    const app = createApp({
      type: "agent",
      agentId: liveAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: liveAgentId, expectedStatuses: ["todo", "in_progress"] });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [row] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, issueId));
    expect(row?.assigneeAgentId).toBe(deadAgentId);
  });

  it("lets another agent take over a routine owned by a terminated agent", async () => {
    const { companyId, deadAgentId, liveAgentId } = await seedTerminatedOwner();
    const boardApp = createApp(boardActor(companyId));
    const created = await request(boardApp)
      .post(`/api/companies/${companyId}/routines`)
      .send({ title: "Weekly Sentry review", assigneeAgentId: deadAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const routineId = created.body.id as string;

    await agentService(db).terminate(deadAgentId);

    const runId = await seedRunningRun(companyId, liveAgentId);
    const agentApp = createApp({
      type: "agent",
      agentId: liveAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const paused = await request(agentApp).patch(`/api/routines/${routineId}`).send({ status: "paused" });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);

    const reassigned = await request(agentApp)
      .patch(`/api/routines/${routineId}`)
      .send({ assigneeAgentId: liveAgentId });
    expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(200);

    const [row] = await db
      .select({ assigneeAgentId: routines.assigneeAgentId, status: routines.status })
      .from(routines)
      .where(eq(routines.id, routineId));
    expect(row?.assigneeAgentId).toBe(liveAgentId);
    expect(row?.status).toBe("paused");
  });

  it("still refuses routine management when the assignee is alive", async () => {
    const { companyId, deadAgentId, liveAgentId } = await seedTerminatedOwner();
    const boardApp = createApp(boardActor(companyId));
    const created = await request(boardApp)
      .post(`/api/companies/${companyId}/routines`)
      .send({ title: "Weekly Sentry review", assigneeAgentId: deadAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const runId = await seedRunningRun(companyId, liveAgentId);
    const agentApp = createApp({
      type: "agent",
      agentId: liveAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const res = await request(agentApp)
      .patch(`/api/routines/${created.body.id}`)
      .send({ status: "paused" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agents can only manage routines assigned to themselves");
  });
});
