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
});

describeEmbeddedPostgres("issueService checkout/execution lock lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-service-locks-");
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

  it("clears executionRunId when issue leaves in_progress", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

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
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      startedAt: new Date(),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue lock",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: runId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const updated = await svc.update(issueId, { status: "blocked" });

    expect(updated?.status).toBe("blocked");
    expect(updated?.checkoutRunId).toBeNull();
    expect(updated?.executionRunId).toBeNull();
    expect(updated?.executionAgentNameKey).toBeNull();
    expect(updated?.executionLockedAt).toBeNull();
  });

  it("clears executionRunId on release", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

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
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      startedAt: new Date(),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Release lock",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const released = await svc.release(issueId);

    expect(released?.status).toBe("todo");
    expect(released?.assigneeAgentId).toBeNull();
    expect(released?.checkoutRunId).toBeNull();
    expect(released?.executionRunId).toBeNull();
    expect(released?.executionAgentNameKey).toBeNull();
    expect(released?.executionLockedAt).toBeNull();
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
        status: "succeeded",
        startedAt: new Date(),
      },
      {
        id: checkoutRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
        startedAt: new Date(),
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
        status: "running",
        startedAt: new Date(),
      },
      {
        id: checkoutRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
        startedAt: new Date(),
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
        status: "succeeded",
        startedAt: new Date(),
      },
      {
        id: checkoutRunId,
        companyId,
        agentId: callerAgentId,
        invocationSource: "assignment",
        status: "running",
        startedAt: new Date(),
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

  it("allows release override when assignee override is enabled", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const managerAgentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

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
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: managerAgentId,
        companyId,
        name: "Manager",
        role: "manager",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: { canCreateAgents: true },
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: assigneeAgentId,
      invocationSource: "assignment",
      status: "running",
      startedAt: new Date(),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Release override lock",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "assignee",
      executionLockedAt: new Date(),
    });

    const released = await svc.release(issueId, managerAgentId, "manager-run", { allowAssigneeOverride: true });

    expect(released?.status).toBe("todo");
    expect(released?.assigneeAgentId).toBeNull();
    expect(released?.checkoutRunId).toBeNull();
    expect(released?.executionRunId).toBeNull();
    expect(released?.executionAgentNameKey).toBeNull();
    expect(released?.executionLockedAt).toBeNull();
  });
});
