import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issueInboxArchives,
  issues,
  projects,
  projectWorkspaces,
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

// ─── Conversation project auto-association ───────────────────────────────────

describeEmbeddedPostgres("issueService.create conversation project auto-association", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-convo-assoc-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "ceo",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedProjectWithWorkspace(companyId: string, opts?: { isPrimary?: boolean; cwd?: string }) {
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Phase 0",
      status: "active",
    });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "main",
      cwd: opts?.cwd ?? "/tmp/test-workspace",
      isPrimary: opts?.isPrimary ?? true,
    });
    return { projectId, workspaceId };
  }

  it("auto-associates a conversation issue with the company's primary project workspace", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const { projectId } = await seedProjectWithWorkspace(companyId, { isPrimary: true });

    const issue = await svc.create(companyId, {
      kind: "conversation",
      title: "Conversation: TestAgent",
      status: "blocked",
      assigneeAgentId: agentId,
      priority: "medium",
    });

    expect(issue.projectId).toBe(projectId);
  });

  it("does not override an explicitly provided projectId on a conversation", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const { projectId: autoProjectId } = await seedProjectWithWorkspace(companyId, { isPrimary: true });

    const explicitProjectId = randomUUID();
    await db.insert(projects).values({
      id: explicitProjectId,
      companyId,
      name: "Explicit Project",
      status: "active",
    });

    const issue = await svc.create(companyId, {
      kind: "conversation",
      title: "Conversation: TestAgent",
      status: "blocked",
      assigneeAgentId: agentId,
      projectId: explicitProjectId,
      priority: "medium",
    });

    expect(issue.projectId).toBe(explicitProjectId);
    expect(issue.projectId).not.toBe(autoProjectId);
  });

  it("does not auto-associate task issues — only conversations", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await seedProjectWithWorkspace(companyId, { isPrimary: true });

    const issue = await svc.create(companyId, {
      kind: "task",
      title: "Fix bug",
      status: "todo",
      assigneeAgentId: agentId,
      priority: "medium",
    });

    expect(issue.projectId).toBeNull();
  });

  it("leaves projectId null when the company has no project workspaces", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const issue = await svc.create(companyId, {
      kind: "conversation",
      title: "Conversation: TestAgent",
      status: "blocked",
      assigneeAgentId: agentId,
      priority: "medium",
    });

    expect(issue.projectId).toBeNull();
  });

  it("prefers the primary workspace when multiple projects exist", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    // Non-primary project created first
    const secondaryProjectId = randomUUID();
    const secondaryWorkspaceId = randomUUID();
    await db.insert(projects).values({
      id: secondaryProjectId,
      companyId,
      name: "Secondary",
      status: "active",
    });
    await db.insert(projectWorkspaces).values({
      id: secondaryWorkspaceId,
      companyId,
      projectId: secondaryProjectId,
      name: "secondary-ws",
      cwd: "/tmp/secondary",
      isPrimary: false,
    });

    // Primary project created after
    const { projectId: primaryProjectId } = await seedProjectWithWorkspace(companyId, {
      isPrimary: true,
      cwd: "/tmp/primary",
    });

    const issue = await svc.create(companyId, {
      kind: "conversation",
      title: "Conversation: TestAgent",
      status: "blocked",
      assigneeAgentId: agentId,
      priority: "medium",
    });

    expect(issue.projectId).toBe(primaryProjectId);
  });

  it("resolves projectWorkspaceId when conversation inherits a project", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const { projectId, workspaceId } = await seedProjectWithWorkspace(companyId, { isPrimary: true });

    const issue = await svc.create(companyId, {
      kind: "conversation",
      title: "Conversation: TestAgent",
      status: "blocked",
      assigneeAgentId: agentId,
      priority: "medium",
    });

    expect(issue.projectId).toBe(projectId);
    expect(issue.projectWorkspaceId).toBe(workspaceId);
  });
});
