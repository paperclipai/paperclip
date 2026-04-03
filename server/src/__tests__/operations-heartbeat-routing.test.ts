import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
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
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
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

  it("prioritizes an active operations-assigned issue", async () => {
    const { companyId, opsAgentId, workerAgentId, issuePrefix } = await seedCompanyWithOpsAgent();

    const opsIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: opsIssueId,
        companyId,
        title: "Ops active item",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: opsAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Cross-agent stale item",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: workerAgentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target).toEqual({
      issueId: opsIssueId,
      mode: "ops_active",
      reason: "operations agent already owns an active issue",
    });
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

  it("routes generic manual heartbeat (no issue context) to company-wide recovery target", async () => {
    const { companyId, opsAgentId, workerAgentId, issuePrefix } = await seedCompanyWithOpsAgent();
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

    await db.insert(issues).values({
      id: staleIssueId,
      companyId,
      title: "Broken assigned issue requiring recovery",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: workerAgentId,
      executionRunId: staleRunId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

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

  it("returns null when there is no actionable work", async () => {
    const { companyId, opsAgentId } = await seedCompanyWithOpsAgent();

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target).toBeNull();
  });
});
