import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
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
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, resolveOperationsHeartbeatTarget } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("operations heartbeat routing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-operations-heartbeat-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const activeRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]));
      if (activeRuns.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithOpsAgent() {
    const companyId = randomUUID();
    const opsAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const issuePrefix = `OPS${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Ops",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: opsAgentId,
        companyId,
        name: "Operations Agent",
        role: "operations",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Worker Agent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    return { companyId, opsAgentId, workerAgentId, issuePrefix };
  }

  it("can pick an operations-assigned issue when it is the highest-priority recovery target", async () => {
    const { companyId, opsAgentId, workerAgentId, issuePrefix } = await seedCompanyWithOpsAgent();

    const opsIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: opsIssueId,
        companyId,
        title: "Operations watchdog blocked and stale",
        status: "blocked",
        priority: "urgent",
        assigneeAgentId: opsAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Cross-agent assigned with fresh blocker truth",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: workerAgentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: otherIssueId,
      authorAgentId: workerAgentId,
      body: "Status: blocked\nWaiting on API team.",
    });

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target?.issueId).toBe(opsIssueId);
    expect(target?.mode).toBe("ops_active");
    expect(target?.reason).toContain("stale or blocked assigned work");
  });

  it("selects a cross-agent recovery issue before unassigned backlog", async () => {
    const { companyId, opsAgentId, workerAgentId, issuePrefix } = await seedCompanyWithOpsAgent();
    const staleIssueId = randomUUID();
    const staleRunId = randomUUID();
    const backlogIssueId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId: workerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "completed",
      startedAt: new Date("2026-04-01T00:00:00.000Z"),
      finishedAt: new Date("2026-04-01T00:10:00.000Z"),
      contextSnapshot: { issueId: staleIssueId },
    });

    await db.insert(issues).values([
      {
        id: staleIssueId,
        companyId,
        title: "Potential false-complete on assigned issue",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: workerAgentId,
        executionRunId: staleRunId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: backlogIssueId,
        companyId,
        title: "Ready backlog issue",
        status: "backlog",
        priority: "urgent",
        assigneeAgentId: null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target?.issueId).toBe(staleIssueId);
    expect(target?.mode).toBe("cross_agent_recovery");
    expect(target?.reason).toContain("run completed without completion/blocker/handoff truth");
  });

  it("ignores assigned issues with explicit blocker/handoff truth and falls back correctly", async () => {
    const { companyId, opsAgentId, workerAgentId, issuePrefix } = await seedCompanyWithOpsAgent();
    const assignedIssueId = randomUUID();
    const assignedRunId = randomUUID();
    const backlogIssueId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: assignedRunId,
      companyId,
      agentId: workerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "completed",
      startedAt: new Date("2026-04-01T00:00:00.000Z"),
      finishedAt: new Date("2026-04-01T00:10:00.000Z"),
      contextSnapshot: { issueId: assignedIssueId },
    });

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue with explicit blocker truth",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: workerAgentId,
        executionRunId: assignedRunId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: backlogIssueId,
        companyId,
        title: "Unassigned TODO",
        status: "backlog",
        priority: "medium",
        assigneeAgentId: null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: assignedIssueId,
      authorAgentId: workerAgentId,
      body: "Status: blocked\nWaiting on external dependency from vendor.",
    });

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target).toEqual({
      issueId: backlogIssueId,
      mode: "ready_unassigned",
      reason: "no recovery target found; selected ready unassigned issue",
    });
  });

  it("ranks stuck assigned false-complete above watchdog when it is the higher-priority recovery problem", async () => {
    const { companyId, opsAgentId, workerAgentId, issuePrefix } = await seedCompanyWithOpsAgent();
    const watchdogIssueId = randomUUID();
    const stuckAssignedIssueId = randomUUID();
    const stuckAssignedRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: stuckAssignedRunId,
      companyId,
      agentId: workerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "completed",
      startedAt: new Date("2026-04-01T00:00:00.000Z"),
      finishedAt: new Date("2026-04-01T00:10:00.000Z"),
      contextSnapshot: { issueId: stuckAssignedIssueId },
    });

    await db.insert(issues).values([
      {
        id: watchdogIssueId,
        companyId,
        title: "Queue-lock watchdog routine",
        status: "blocked",
        priority: "urgent",
        assigneeAgentId: opsAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: stuckAssignedIssueId,
        companyId,
        title: "Assigned issue with probable false completion",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: workerAgentId,
        executionRunId: stuckAssignedRunId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target?.issueId).toBe(stuckAssignedIssueId);
    expect(target?.mode).toBe("cross_agent_recovery");
    expect(target?.reason).toContain("incomplete/false-complete assigned work");
  });

  it("routes generic manual heartbeat (no issue context) to company-wide top recovery target", async () => {
    const { companyId, opsAgentId, workerAgentId, issuePrefix } = await seedCompanyWithOpsAgent();
    const watchdogIssueId = randomUUID();
    const staleIssueId = randomUUID();
    const staleRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId: workerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "completed",
      startedAt: new Date("2026-04-01T00:00:00.000Z"),
      finishedAt: new Date("2026-04-01T00:10:00.000Z"),
      contextSnapshot: { issueId: staleIssueId },
    });

    await db.insert(issues).values([
      {
        id: watchdogIssueId,
        companyId,
        title: "Queue-lock watchdog routine",
        status: "blocked",
        priority: "urgent",
        assigneeAgentId: opsAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: staleIssueId,
        companyId,
        title: "Broken assigned issue requiring recovery",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: workerAgentId,
        executionRunId: staleRunId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      opsAgentId,
      "on_demand",
      {},
      "manual",
      { actorType: "user", actorId: "board-user" },
    );

    expect(run).toBeTruthy();
    expect(run?.contextSnapshot?.issueId).toBe(staleIssueId);
    expect(run?.contextSnapshot?.wakeReason).toBe("operations_workflow_recovery");
    expect(run?.contextSnapshot?.operationsHeartbeatMode).toBe("cross_agent_recovery");
  });

  it("prefers COMA-204/205 class stuck assigned false-complete over recurring watchdog bias", async () => {
    const { companyId, opsAgentId, workerAgentId } = await seedCompanyWithOpsAgent();
    const watchdogIssueId = randomUUID();
    const coma204IssueId = randomUUID();
    const coma205IssueId = randomUUID();
    const coma204RunId = randomUUID();
    const coma205RunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      {
        id: coma204RunId,
        companyId,
        agentId: workerAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "completed",
        startedAt: new Date("2026-04-01T00:00:00.000Z"),
        finishedAt: new Date("2026-04-01T00:10:00.000Z"),
        contextSnapshot: { issueId: coma204IssueId },
      },
      {
        id: coma205RunId,
        companyId,
        agentId: workerAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "completed",
        startedAt: new Date("2026-04-01T00:20:00.000Z"),
        finishedAt: new Date("2026-04-01T00:30:00.000Z"),
        contextSnapshot: { issueId: coma205IssueId },
      },
    ]);

    await db.insert(issues).values([
      {
        id: watchdogIssueId,
        companyId,
        title: "Queue-lock watchdog recurring cleanup",
        status: "blocked",
        priority: "urgent",
        assigneeAgentId: opsAgentId,
        issueNumber: 179,
        identifier: "COMA-179",
      },
      {
        id: coma204IssueId,
        companyId,
        title: "Product trust issue: incomplete assigned follow-through",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: workerAgentId,
        executionRunId: coma204RunId,
        issueNumber: 204,
        identifier: "COMA-204",
      },
      {
        id: coma205IssueId,
        companyId,
        title: "Product trust issue: unresolved assigned deliverable",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: workerAgentId,
        executionRunId: coma205RunId,
        issueNumber: 205,
        identifier: "COMA-205",
      },
    ]);

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect([coma204IssueId, coma205IssueId]).toContain(target?.issueId);
    expect(target?.mode).toBe("cross_agent_recovery");
    expect(target?.reason).toContain("incomplete/false-complete assigned work");
  });

  it("suppresses repetitive watchdog lane after recent successful watchdog verification and prefers stuck assigned recovery", async () => {
    const { companyId, opsAgentId, workerAgentId } = await seedCompanyWithOpsAgent();
    const watchdogIssueId = randomUUID();
    const watchdogSuccessRunIdA = randomUUID();
    const watchdogSuccessRunIdB = randomUUID();
    const coma204IssueId = randomUUID();
    const coma204RunId = randomUUID();

    const now = Date.now();
    await db.insert(heartbeatRuns).values([
      {
        id: coma204RunId,
        companyId,
        agentId: workerAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "completed",
        startedAt: new Date("2026-04-01T00:00:00.000Z"),
        finishedAt: new Date("2026-04-01T00:10:00.000Z"),
        contextSnapshot: { issueId: coma204IssueId },
      },
      {
        id: watchdogSuccessRunIdA,
        companyId,
        agentId: opsAgentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "succeeded",
        startedAt: new Date(now - 40 * 60 * 1000),
        finishedAt: new Date(now - 35 * 60 * 1000),
        contextSnapshot: { issueId: watchdogIssueId },
      },
      {
        id: watchdogSuccessRunIdB,
        companyId,
        agentId: opsAgentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "completed",
        startedAt: new Date(now - 20 * 60 * 1000),
        finishedAt: new Date(now - 15 * 60 * 1000),
        contextSnapshot: { issueId: watchdogIssueId },
      },
    ]);

    await db.insert(issues).values([
      {
        id: watchdogIssueId,
        companyId,
        title: "Queue-lock watchdog recurring cleanup",
        status: "blocked",
        priority: "urgent",
        assigneeAgentId: opsAgentId,
        issueNumber: 181,
        identifier: "COMA-181",
      },
      {
        id: coma204IssueId,
        companyId,
        title: "Product trust issue: incomplete assigned follow-through",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: workerAgentId,
        executionRunId: coma204RunId,
        issueNumber: 204,
        identifier: "COMA-204",
      },
    ]);

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target?.issueId).toBe(coma204IssueId);
    expect(target?.mode).toBe("cross_agent_recovery");
    expect(target?.reason).toContain("incomplete/false-complete assigned work");
  });

  it("prefers COMA-204/205 class stuck assigned false-complete over generic audit issues", async () => {
    const { companyId, opsAgentId, workerAgentId } = await seedCompanyWithOpsAgent();
    const coma204IssueId = randomUUID();
    const coma205IssueId = randomUUID();
    const auditIssueId = randomUUID();
    const coma204RunId = randomUUID();
    const coma205RunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      {
        id: coma204RunId,
        companyId,
        agentId: workerAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "completed",
        startedAt: new Date("2026-04-01T00:00:00.000Z"),
        finishedAt: new Date("2026-04-01T00:10:00.000Z"),
        contextSnapshot: { issueId: coma204IssueId },
      },
      {
        id: coma205RunId,
        companyId,
        agentId: workerAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "completed",
        startedAt: new Date("2026-04-01T00:20:00.000Z"),
        finishedAt: new Date("2026-04-01T00:30:00.000Z"),
        contextSnapshot: { issueId: coma205IssueId },
      },
    ]);

    await db.insert(issues).values([
      {
        id: coma204IssueId,
        companyId,
        title: "Product trust issue: incomplete assigned follow-through",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: workerAgentId,
        executionRunId: coma204RunId,
        issueNumber: 204,
        identifier: "COMA-204",
      },
      {
        id: coma205IssueId,
        companyId,
        title: "Product trust issue: unresolved assigned deliverable",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: workerAgentId,
        executionRunId: coma205RunId,
        issueNumber: 205,
        identifier: "COMA-205",
      },
      {
        id: auditIssueId,
        companyId,
        title: "Audit: workflow verification sweep",
        status: "todo",
        priority: "urgent",
        assigneeAgentId: opsAgentId,
        issueNumber: 500,
        identifier: "COMA-500",
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: coma205IssueId,
      authorAgentId: workerAgentId,
      body: "Checked this quickly; needs follow-up soon.",
    });

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect([coma204IssueId, coma205IssueId]).toContain(target?.issueId);
    expect(target?.mode).toBe("cross_agent_recovery");
    expect(target?.reason).toContain("incomplete/false-complete assigned work");

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      opsAgentId,
      "on_demand",
      {},
      "manual",
      { actorType: "user", actorId: "board-user" },
    );

    expect([coma204IssueId, coma205IssueId]).toContain(run?.contextSnapshot?.issueId as string | undefined);
    expect(run?.contextSnapshot?.wakeReason).toBe("operations_workflow_recovery");
    expect(run?.contextSnapshot?.operationsHeartbeatMode).toBe("cross_agent_recovery");
  });

  it("returns null when there is no actionable work", async () => {
    const { companyId, opsAgentId } = await seedCompanyWithOpsAgent();

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target).toBeNull();
  });
});
