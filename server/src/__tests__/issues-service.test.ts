import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueInboxArchives,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.list participantAgentId", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-service-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns issues an agent participated in across the supported signals", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const assignedIssueId = randomUUID();
    const createdIssueId = randomUUID();
    const commentedIssueId = randomUUID();
    const activityIssueId = randomUUID();
    const excludedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        createdByAgentId: otherAgentId,
      },
      {
        id: createdIssueId,
        companyId,
        title: "Created issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: commentedIssueId,
        companyId,
        title: "Commented issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: activityIssueId,
        companyId,
        title: "Activity issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: excludedIssueId,
        companyId,
        title: "Excluded issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
        assigneeAgentId: otherAgentId,
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentedIssueId,
      authorAgentId: agentId,
      body: "Investigating this issue.",
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: activityIssueId,
      agentId,
      details: { changed: true },
    });

    const result = await svc.list(companyId, { participantAgentId: agentId });
    const resultIds = new Set(result.map((issue) => issue.id));

    expect(resultIds).toEqual(new Set([
      assignedIssueId,
      createdIssueId,
      commentedIssueId,
      activityIssueId,
    ]));
    expect(resultIds.has(excludedIssueId)).toBe(false);
  });

  it("combines participation filtering with search", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const matchedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: matchedIssueId,
        companyId,
        title: "Invoice reconciliation",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Weekly planning",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
    ]);

    const result = await svc.list(companyId, {
      participantAgentId: agentId,
      q: "invoice",
    });

    expect(result.map((issue) => issue.id)).toEqual([matchedIssueId]);
  });

  it("hides archived inbox issues until new external activity arrives", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const otherUserId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const visibleIssueId = randomUUID();
    const archivedIssueId = randomUUID();
    const resurfacedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: visibleIssueId,
        companyId,
        title: "Visible issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: archivedIssueId,
        companyId,
        title: "Archived issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
      {
        id: resurfacedIssueId,
        companyId,
        title: "Resurfaced issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);

    await svc.archiveInbox(
      companyId,
      archivedIssueId,
      userId,
      new Date("2026-03-26T12:30:00.000Z"),
    );
    await svc.archiveInbox(
      companyId,
      resurfacedIssueId,
      userId,
      new Date("2026-03-26T13:00:00.000Z"),
    );

    await db.insert(issueComments).values({
      companyId,
      issueId: resurfacedIssueId,
      authorUserId: otherUserId,
      body: "This should bring the issue back into Mine.",
      createdAt: new Date("2026-03-26T13:30:00.000Z"),
      updatedAt: new Date("2026-03-26T13:30:00.000Z"),
    });

    const archivedFiltered = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(archivedFiltered.map((issue) => issue.id)).toEqual([
      resurfacedIssueId,
      visibleIssueId,
    ]);

    await svc.unarchiveInbox(companyId, archivedIssueId, userId);

    const afterUnarchive = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(new Set(afterUnarchive.map((issue) => issue.id))).toEqual(new Set([
      visibleIssueId,
      archivedIssueId,
      resurfacedIssueId,
    ]));
  });

  it("clears execution lock fields when issue leaves in_progress", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const assigneeRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "AssigneeAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: assigneeRunId,
      companyId,
      agentId: assigneeAgentId,
      invocationSource: "assignment",
      triggerDetail: null,
      status: "running",
      contextSnapshot: {},
    });

    for (const status of ["blocked", "todo"] as const) {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Lock cleanup (${status})`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId,
        checkoutRunId: assigneeRunId,
        executionRunId: assigneeRunId,
        executionAgentNameKey: "assigneeagent",
        executionLockedAt: new Date("2026-03-30T04:00:00.000Z"),
      });

      const updated = await svc.update(issueId, { status });
      expect(updated).toMatchObject({
        id: issueId,
        status,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      });
    }
  });

  it("clears execution lock fields when assignee changes", async () => {
    const companyId = randomUUID();
    const currentAssigneeAgentId = randomUUID();
    const nextAssigneeAgentId = randomUUID();
    const assigneeRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: currentAssigneeAgentId,
        companyId,
        name: "CurrentAssignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: nextAssigneeAgentId,
        companyId,
        name: "NextAssignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: assigneeRunId,
      companyId,
      agentId: currentAssigneeAgentId,
      invocationSource: "assignment",
      triggerDetail: null,
      status: "running",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Lock cleanup on reassignment",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: currentAssigneeAgentId,
      checkoutRunId: assigneeRunId,
      executionRunId: assigneeRunId,
      executionAgentNameKey: "currentassignee",
      executionLockedAt: new Date("2026-03-30T04:01:00.000Z"),
    });

    const updated = await svc.update(issueId, { assigneeAgentId: nextAssigneeAgentId });
    expect(updated).toMatchObject({
      id: issueId,
      status: "in_progress",
      assigneeAgentId: nextAssigneeAgentId,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
  });

  it("clears execution lock fields on release", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const issueId = randomUUID();
    const assigneeRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "AssigneeAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: assigneeRunId,
      companyId,
      agentId: assigneeAgentId,
      invocationSource: "assignment",
      triggerDetail: null,
      status: "running",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Release lock cleanup",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      checkoutRunId: assigneeRunId,
      executionRunId: assigneeRunId,
      executionAgentNameKey: "assigneeagent",
      executionLockedAt: new Date("2026-03-29T20:00:00.000Z"),
    });

    const released = await svc.release(issueId, assigneeAgentId, assigneeRunId);
    expect(released).not.toBeNull();
    expect(released).toMatchObject({
      id: issueId,
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
  });

  it("recovers stale execution lock on checkout when referenced run is terminal", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const staleRunId = randomUUID();
    const checkoutRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: staleRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: null,
        status: "succeeded",
        contextSnapshot: {},
      },
      {
        id: checkoutRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: null,
        status: "running",
        contextSnapshot: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale checkout lock",
      status: "todo",
      priority: "medium",
      executionRunId: staleRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const checkedOut = await svc.checkout(issueId, agentId, ["todo"], checkoutRunId);

    expect(checkedOut.status).toBe("in_progress");
    expect(checkedOut.assigneeAgentId).toBe(agentId);
    expect(checkedOut.checkoutRunId).toBe(checkoutRunId);
    expect(checkedOut.executionRunId).toBe(checkoutRunId);
    expect(checkedOut.executionAgentNameKey).toBeNull();
    expect(checkedOut.executionLockedAt).toBeNull();
  });

  it("keeps execution lock when checkout sees an active run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const activeExecutionRunId = randomUUID();
    const checkoutRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: activeExecutionRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: null,
        status: "running",
        contextSnapshot: {},
      },
      {
        id: checkoutRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: null,
        status: "running",
        contextSnapshot: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Active lock",
      status: "todo",
      priority: "medium",
      executionRunId: activeExecutionRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    await expect(svc.checkout(issueId, agentId, ["todo"], checkoutRunId)).rejects.toThrow("Issue checkout conflict");

    const latest = await svc.getById(issueId);
    expect(latest?.executionRunId).toBe(activeExecutionRunId);
  });

  it("does not steal issue assigned to another agent during stale lock recovery", async () => {
    const companyId = randomUUID();
    const callerAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const issueId = randomUUID();
    const staleRunId = randomUUID();
    const checkoutRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: callerAgentId,
        companyId,
        name: "Caller",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: staleRunId,
        companyId,
        agentId: assigneeAgentId,
        invocationSource: "assignment",
        triggerDetail: null,
        status: "succeeded",
        contextSnapshot: {},
      },
      {
        id: checkoutRunId,
        companyId,
        agentId: callerAgentId,
        invocationSource: "assignment",
        triggerDetail: null,
        status: "running",
        contextSnapshot: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned elsewhere",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      checkoutRunId: null,
      executionRunId: staleRunId,
      executionAgentNameKey: "assignee",
      executionLockedAt: new Date(),
    });

    await expect(svc.checkout(issueId, callerAgentId, ["todo", "in_progress"], checkoutRunId)).rejects.toThrow(
      "Issue checkout conflict",
    );

    const latest = await svc.getById(issueId);
    expect(latest?.assigneeAgentId).toBe(assigneeAgentId);
    expect(latest?.status).toBe("in_progress");
    expect(latest?.executionRunId).toBe(staleRunId);
  });

  it("keeps assignee-only release for ordinary agents, but allows CEO override", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const ordinaryAgentId = randomUUID();
    const ceoAgentId = randomUUID();
    const issueId = randomUUID();
    const assigneeRunId = randomUUID();
    const workerRunId = randomUUID();
    const ceoRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "AssigneeAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: ordinaryAgentId,
        companyId,
        name: "WorkerAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: ceoAgentId,
        companyId,
        name: "CeoAgent",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: assigneeRunId,
      companyId,
      agentId: assigneeAgentId,
      invocationSource: "assignment",
      triggerDetail: null,
      status: "running",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "CEO override release",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      checkoutRunId: assigneeRunId,
      executionRunId: assigneeRunId,
      executionAgentNameKey: "assigneeagent",
      executionLockedAt: new Date("2026-03-29T20:01:00.000Z"),
    });

    await expect(svc.release(issueId, ordinaryAgentId, workerRunId)).rejects.toMatchObject({
      status: 409,
      message: "Only assignee can release issue",
    });

    const released = await svc.release(issueId, ceoAgentId, ceoRunId, { allowAnyIssueRelease: true });
    expect(released).not.toBeNull();
    expect(released).toMatchObject({
      id: issueId,
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
  });
});
