import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { logger } from "../middleware/logger.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { isStandingChannelIssue } from "../services/recovery/standing-channel.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("isStandingChannelIssue", () => {
  it("returns true when executionPolicy.monitor.standingChannel is true", () => {
    expect(isStandingChannelIssue({ executionPolicy: { monitor: { standingChannel: true } } })).toBe(true);
  });

  it("returns false when standing channel is missing", () => {
    expect(isStandingChannelIssue({ executionPolicy: { monitor: { notes: "keepalive" } } })).toBe(false);
  });

  it("returns false for null issue or null policy", () => {
    expect(isStandingChannelIssue(null)).toBe(false);
    expect(isStandingChannelIssue({ executionPolicy: null })).toBe(false);
  });
});

describeEmbeddedPostgres("standing channel recovery and wake suppression", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-standing-channel-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentRuntimeState);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return { companyId, issuePrefix };
  }

  async function seedAgent(input: {
    companyId: string;
    role?: "executive" | "cto" | "ceo";
    adapterType?: string;
    status?: string;
    adapterConfig?: Record<string, unknown>;
  }) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: `Agent ${agentId.slice(0, 6)}`,
      role: input.role ?? "executive",
      status: input.status ?? "idle",
      adapterType: input.adapterType ?? "codex_local",
      adapterConfig: input.adapterConfig ?? {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedFailedAssignmentContext(input: {
    companyId: string;
    issuePrefix: string;
    assigneeAgentId: string;
    standingChannel: boolean;
    issueNumber: number;
  }) {
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.assigneeAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "failed",
      runId,
      error: "process_lost",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.assigneeAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, retryReason: "assignment_recovery" },
      finishedAt: new Date(),
      errorCode: "process_lost",
      error: "process lost",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Recover me",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: input.assigneeAgentId,
      checkoutRunId: runId,
      executionPolicy: input.standingChannel ? { monitor: { standingChannel: true } } : null,
      issueNumber: input.issueNumber,
      identifier: `${input.issuePrefix}-${input.issueNumber}`,
    });
    return { issueId, runId };
  }

  it("reconcileStrandedAssignedIssues skips standing-channel sources and does not spawn recovery", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const assigneeAgentId = await seedAgent({ companyId, adapterType: "codex_local", status: "idle" });
    await seedAgent({ companyId, role: "cto", adapterType: "codex_local", status: "idle" });
    await seedFailedAssignmentContext({
      companyId,
      issuePrefix,
      assigneeAgentId,
      standingChannel: true,
      issueNumber: 1,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(0);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
  });

  it("escalateStrandedAssignedIssue spawns recovery for non-standing sources (control)", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const assigneeAgentId = await seedAgent({ companyId, adapterType: "codex_local", status: "idle" });
    await seedAgent({ companyId, role: "cto", adapterType: "codex_local", status: "idle" });
    const { issueId, runId } = await seedFailedAssignmentContext({
      companyId,
      issuePrefix,
      assigneeAgentId,
      standingChannel: false,
      issueNumber: 1,
    });

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [latestRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) as any });
    const updated = await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "in_progress",
      latestRun,
      comment: "control",
    });
    expect(updated).not.toBeNull();

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues.length).toBeGreaterThan(0);
  });

  it("logs cooldown lookup result before spawning recovery", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const assigneeAgentId = await seedAgent({ companyId, adapterType: "codex_local", status: "idle" });
    await seedAgent({ companyId, role: "cto", adapterType: "codex_local", status: "idle" });
    const { issueId, runId } = await seedFailedAssignmentContext({
      companyId,
      issuePrefix,
      assigneeAgentId,
      standingChannel: false,
      issueNumber: 1,
    });
    const loggerInfoSpy = vi.spyOn(logger, "info");

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [latestRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) as any });
    await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "in_progress",
      latestRun,
      comment: "cooldown-log-check",
    });

    expect(
      loggerInfoSpy.mock.calls.some((call) => call[1] === "recovery: cooldown lookup result"),
    ).toBe(true);
  });

  it("suppresses issue_children_completed wake for stranded-recovery child when parent is standing channel", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const parentAgentId = await seedAgent({ companyId });
    const childAgentId = await seedAgent({ companyId });
    const parentId = randomUUID();
    const childId = randomUUID();
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: parentAgentId,
      executionPolicy: { monitor: { standingChannel: true } },
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(issues).values({
      id: childId,
      companyId,
      title: "Probe",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: childAgentId,
      parentId,
      originKind: "stranded_issue_recovery",
      originId: parentId,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });

    const app = createApp(boardActor(companyId));
    const res = await request(app).patch(`/api/issues/${childId}`).send({ status: "done" });
    expect(res.status).toBe(200);

    const wakeRequests = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, parentAgentId)));
    expect(wakeRequests.filter((row) => row.reason === "issue_children_completed")).toHaveLength(0);
  });

  it("escalateStrandedAssignedIssue short-circuits standing-channel source", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const assigneeAgentId = await seedAgent({ companyId, adapterType: "codex_local", status: "idle" });
    await seedAgent({ companyId, role: "cto", adapterType: "codex_local", status: "idle" });
    const { issueId, runId } = await seedFailedAssignmentContext({
      companyId,
      issuePrefix,
      assigneeAgentId,
      standingChannel: true,
      issueNumber: 1,
    });
    const loggerInfoSpy = vi.spyOn(logger, "info");
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [latestRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) as any });
    await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "in_progress",
      latestRun,
      comment: "standing-short-circuit",
    });

    expect(loggerInfoSpy.mock.calls.some((call) => call[1] === "recovery: skipped (standing_channel)")).toBe(true);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
  });
});
