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
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveOperationsHeartbeatTarget } from "../services/heartbeat.ts";

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
    await db.delete(issueRelations);
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

  it("demotes fake WIP by preferring the stale in-progress issue over backlog work", async () => {
    const { companyId, opsAgentId, workerAgentId, issuePrefix } = await seedCompanyWithOpsAgent();
    const fakeWipIssueId = randomUUID();
    const backlogIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: fakeWipIssueId,
        companyId,
        title: "Checkout bug that only looks in progress",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: workerAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: backlogIssueId,
        companyId,
        title: "Ready backlog issue",
        status: "backlog",
        priority: "medium",
        assigneeAgentId: null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target).toMatchObject({
      issueId: fakeWipIssueId,
      mode: "cross_agent_recovery",
      autoReissueEligible: true,
    });
    expect(target?.reason).toContain("in_progress with no execution run");
  });

  it("reassigns wrong-specialist engineering work ahead of backlog work", async () => {
    const { companyId, opsAgentId, issuePrefix } = await seedCompanyWithOpsAgent();
    const qaAgentId = randomUUID();
    const wrongSpecialistIssueId = randomUUID();
    const backlogIssueId = randomUUID();

    await db.insert(agents).values({
      id: qaAgentId,
      companyId,
      name: "QA Specialist",
      role: "qa",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: wrongSpecialistIssueId,
        companyId,
        title: "Fix checkout cart crash in the web app",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: qaAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: backlogIssueId,
        companyId,
        title: "Ready backlog issue",
        status: "backlog",
        priority: "medium",
        assigneeAgentId: null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target).toMatchObject({
      issueId: wrongSpecialistIssueId,
      mode: "cross_agent_recovery",
      autoReissueEligible: true,
    });
    expect(target?.reason).toContain("in_progress with no execution run");
  });

  it("rebalances overloaded recovery work toward the stronger signal", async () => {
    const { companyId, opsAgentId, workerAgentId, issuePrefix } = await seedCompanyWithOpsAgent();
    const staleIssueId = randomUUID();
    const falseCompleteIssueId = randomUUID();
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
        id: staleIssueId,
        companyId,
        title: "Stale assigned issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: workerAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: falseCompleteIssueId,
        companyId,
        title: "Assigned issue with a stronger false-complete signal",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: workerAgentId,
        executionRunId: staleRunId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target).toMatchObject({
      issueId: falseCompleteIssueId,
      mode: "cross_agent_recovery",
      autoReissueEligible: true,
    });
    expect(target?.reason).toContain("run completed without completion/blocker/handoff truth");
  });

  it("can pick an operations-assigned issue when it is the highest-priority recovery target", async () => {
    const { companyId, opsAgentId, workerAgentId, issuePrefix } = await seedCompanyWithOpsAgent();

    const opsIssueId = randomUUID();
    const blockerIssueId = randomUUID();
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
        id: blockerIssueId,
        companyId,
        title: "Real blocker",
        status: "todo",
        priority: "high",
        assigneeAgentId: workerAgentId,
        issueNumber: 3,
        identifier: `${issuePrefix}-3`,
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
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: opsIssueId,
      type: "blocks",
    });

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

  it("does not prioritize an invalid blocked state with no blocker relation over ready backlog work", async () => {
    const { companyId, opsAgentId, workerAgentId, issuePrefix } = await seedCompanyWithOpsAgent();
    const invalidBlockedIssueId = randomUUID();
    const backlogIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: invalidBlockedIssueId,
        companyId,
        title: "Assigned issue wrongly marked blocked",
        status: "blocked",
        priority: "urgent",
        assigneeAgentId: workerAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        updatedAt: new Date("2026-04-15T00:00:00.000Z"),
      },
      {
        id: backlogIssueId,
        companyId,
        title: "Ready backlog issue",
        status: "backlog",
        priority: "high",
        assigneeAgentId: null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target).toMatchObject({
      issueId: backlogIssueId,
      mode: "ready_unassigned",
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

    expect(target).toMatchObject({
      issueId: backlogIssueId,
      mode: "ready_unassigned",
      reason: "no recovery target found; selected ready unassigned issue",
      autoReissueEligible: false,
    });
  });

  it("ignores fresh workflow-gated completion truth and falls back correctly", async () => {
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
        title: "Assigned issue with workflow-gated completion truth",
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
      body: [
        "DONE: Fix already verified and committed.",
        "Workflow gate: requires QA assignee before entering in_review.",
        "Missing permission: tasks:assign.",
        "Board action required.",
      ].join("\n"),
    });

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target).toMatchObject({
      issueId: backlogIssueId,
      mode: "ready_unassigned",
      reason: "no recovery target found; selected ready unassigned issue",
      autoReissueEligible: false,
    });
  });

  it("does not let incidental transcript prose suppress cross-agent recovery", async () => {
    const { companyId, opsAgentId, workerAgentId, issuePrefix } = await seedCompanyWithOpsAgent();
    const assignedIssueId = randomUUID();
    const assignedRunId = randomUUID();

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

    await db.insert(issues).values({
      id: assignedIssueId,
      companyId,
      title: "Assigned issue with transcript-style incidental wait phrases",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: workerAgentId,
      executionRunId: assignedRunId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(issueComments).values({
      companyId,
      issueId: assignedIssueId,
      authorAgentId: workerAgentId,
      body: [
        "Working on issue e2ddfdb4-3d86-4a68-b551-f214305c14c7 — Cart UX trust audit QA gate.",
        "The API still rejects patch requests because of a stale execution lock and a missing permission error from a prior session.",
        "I will inspect what should happen before entering in_review once the lock is cleared.",
      ].join("\n"),
    });

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target).toMatchObject({
      issueId: assignedIssueId,
      mode: "cross_agent_recovery",
    });
    expect(target?.reason).toContain("run completed without completion/blocker/handoff truth");
  });

  it("keeps the latest structured truth comment even when newer chatter exists", async () => {
    const { companyId, opsAgentId, workerAgentId, issuePrefix } = await seedCompanyWithOpsAgent();
    const assignedIssueId = randomUUID();
    const assignedRunId = randomUUID();
    const backlogIssueId = randomUUID();
    const truthCreatedAt = new Date();
    truthCreatedAt.setMinutes(truthCreatedAt.getMinutes() - 45);
    const chatterCreatedAt = new Date();
    chatterCreatedAt.setMinutes(chatterCreatedAt.getMinutes() - 15);

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
        title: "Assigned issue with recent workflow gate and later chatter",
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

    await db.insert(issueComments).values([
      {
        companyId,
        issueId: assignedIssueId,
        authorAgentId: workerAgentId,
        body: [
          "Workflow gate: requires QA assignee before entering in_review.",
          "Missing permission: tasks:assign.",
          "Board action required.",
        ].join("\n"),
        createdAt: truthCreatedAt,
        updatedAt: truthCreatedAt,
      },
      {
        companyId,
        issueId: assignedIssueId,
        authorAgentId: workerAgentId,
        body: "I pinged QA to take a look once assignment access is restored.",
        createdAt: chatterCreatedAt,
        updatedAt: chatterCreatedAt,
      },
    ]);

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target).toMatchObject({
      issueId: backlogIssueId,
      mode: "ready_unassigned",
      reason: "no recovery target found; selected ready unassigned issue",
      autoReissueEligible: false,
    });
  });

  it("keeps an urgent operations-owned watchdog ahead when it has the stronger recovery score", async () => {
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
        status: "in_progress",
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

    expect(target?.issueId).toBe(watchdogIssueId);
    expect(target?.mode).toBe("ops_active");
    expect(target?.reason).toContain("queue-lock/watchdog issue");
    expect(target?.reason).toContain("watchdog issue has active recovery signals");
  });

  it("resolves the top generic operations recovery target without pre-binding queue context", async () => {
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
        status: "in_progress",
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

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });
    expect(target?.issueId).toBe(watchdogIssueId);
    expect(target?.mode).toBe("ops_active");

  });

  it("keeps recurring watchdog recovery ahead absent a stronger suppressing signal", async () => {
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
        status: "in_progress",
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

    expect(target?.issueId).toBe(watchdogIssueId);
    expect(target?.mode).toBe("ops_active");
    expect(target?.reason).toContain("queue-lock/watchdog issue");
  });

  it("does not suppress a blocked watchdog that still has active recovery signals", async () => {
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
        status: "in_progress",
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

    expect(target?.issueId).toBe(watchdogIssueId);
    expect(target?.mode).toBe("ops_active");
    expect(target?.reason).toContain("watchdog issue has active recovery signals");
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

  });

  it("returns null when there is no actionable work", async () => {
    const { companyId, opsAgentId } = await seedCompanyWithOpsAgent();

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target).toBeNull();
  });

  it("does not treat user-assigned todo work as ready unassigned work", async () => {
    const { companyId, opsAgentId, issuePrefix } = await seedCompanyWithOpsAgent();
    const humanOwnedIssueId = randomUUID();

    await db.insert(issues).values({
      id: humanOwnedIssueId,
      companyId,
      title: "Board-owned follow-up remains with the human operator",
      status: "todo",
      priority: "urgent",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId: opsAgentId });

    expect(target).toBeNull();
  });
});
