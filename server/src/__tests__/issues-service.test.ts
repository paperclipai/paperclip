import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueRelations,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

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
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
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

  it("applies result limits to issue search", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const exactIdentifierId = randomUUID();
    const titleMatchId = randomUUID();
    const descriptionMatchId = randomUUID();

    await db.insert(issues).values([
      {
        id: exactIdentifierId,
        companyId,
        issueNumber: 42,
        identifier: "PAP-42",
        title: "Completely unrelated",
        status: "todo",
        priority: "medium",
      },
      {
        id: titleMatchId,
        companyId,
        title: "Search ranking issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: descriptionMatchId,
        companyId,
        title: "Another item",
        description: "Contains the search keyword",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, {
      q: "search",
      limit: 2,
    });

    expect(result.map((issue) => issue.id)).toEqual([titleMatchId, descriptionMatchId]);
  });

  it("ranks comment matches ahead of description-only matches", async () => {
    const companyId = randomUUID();
    const commentMatchId = randomUUID();
    const descriptionMatchId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: commentMatchId,
        companyId,
        title: "Comment match",
        status: "todo",
        priority: "medium",
      },
      {
        id: descriptionMatchId,
        companyId,
        title: "Description match",
        description: "Contains pull/3303 in the description",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentMatchId,
      body: "Reference: https://github.com/paperclipai/paperclip/pull/3303",
    });

    const result = await svc.list(companyId, {
      q: "pull/3303",
      limit: 2,
      includeRoutineExecutions: true,
    });

    expect(result.map((issue) => issue.id)).toEqual([commentMatchId, descriptionMatchId]);
  });

  it("accepts issue identifiers through getById", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1064,
      identifier: "PAP-1064",
      title: "Feedback votes error",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });

    const issue = await svc.getById("PAP-1064");

    expect(issue).toEqual(
      expect.objectContaining({
        id: issueId,
        identifier: "PAP-1064",
      }),
    );
  });

  it("returns null instead of throwing for malformed non-uuid issue refs", async () => {
    await expect(svc.getById("not-a-uuid")).resolves.toBeNull();
  });

  it("filters issues by execution workspace id", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const targetWorkspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const linkedIssueId = randomUUID();
    const otherLinkedIssueId = randomUUID();
    const unlinkedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(executionWorkspaces).values([
      {
        id: targetWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Target workspace",
        status: "active",
        providerType: "local_fs",
      },
      {
        id: otherWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Other workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values([
      {
        id: linkedIssueId,
        companyId,
        projectId,
        title: "Linked issue",
        status: "todo",
        priority: "medium",
        executionWorkspaceId: targetWorkspaceId,
      },
      {
        id: otherLinkedIssueId,
        companyId,
        projectId,
        title: "Other linked issue",
        status: "todo",
        priority: "medium",
        executionWorkspaceId: otherWorkspaceId,
      },
      {
        id: unlinkedIssueId,
        companyId,
        projectId,
        title: "Unlinked issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { executionWorkspaceId: targetWorkspaceId });

    expect(result.map((issue) => issue.id)).toEqual([linkedIssueId]);
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

    await svc.archiveInbox(companyId, archivedIssueId, userId, new Date("2026-03-26T12:30:00.000Z"));
    await svc.archiveInbox(companyId, resurfacedIssueId, userId, new Date("2026-03-26T13:00:00.000Z"));

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

  it("resurfaces archived issue when status/updatedAt changes after archiving", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const otherUserId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue with old comment then status change",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
      createdAt: new Date("2026-03-26T10:00:00.000Z"),
      updatedAt: new Date("2026-03-26T10:00:00.000Z"),
    });

    // Old external comment before archiving
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: otherUserId,
      body: "Old comment before archive",
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
      updatedAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    // Archive after seeing the comment
    await svc.archiveInbox(
      companyId,
      issueId,
      userId,
      new Date("2026-03-26T12:00:00.000Z"),
    );

    // Verify it's archived
    const afterArchive = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(afterArchive.map((i) => i.id)).not.toContain(issueId);

    // Status/work update changes updatedAt (no new comment)
    await db
      .update(issues)
      .set({
        status: "in_progress",
        updatedAt: new Date("2026-03-26T13:00:00.000Z"),
      })
      .where(eq(issues.id, issueId));

    // Should resurface because updatedAt > archivedAt
    const afterUpdate = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(afterUpdate.map((i) => i.id)).toContain(issueId);
  });

  it("sorts and exposes last activity from comments and non-local issue activity logs", async () => {
    const companyId = randomUUID();
    const olderIssueId = randomUUID();
    const commentIssueId = randomUUID();
    const activityIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: olderIssueId,
        companyId,
        title: "Older issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: commentIssueId,
        companyId,
        title: "Comment activity issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: activityIssueId,
        companyId,
        title: "Logged activity issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentIssueId,
      body: "New comment without touching issue.updatedAt",
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
      updatedAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.document_updated",
        entityType: "issue",
        entityId: activityIssueId,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
      },
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.read_marked",
        entityType: "issue",
        entityId: olderIssueId,
        createdAt: new Date("2026-03-26T13:00:00.000Z"),
      },
    ]);

    const result = await svc.list(companyId, {});

    expect(result.map((issue) => issue.id)).toEqual([
      activityIssueId,
      commentIssueId,
      olderIssueId,
    ]);
    expect(result.find((issue) => issue.id === activityIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T12:00:00.000Z",
    );
    expect(result.find((issue) => issue.id === commentIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T11:00:00.000Z",
    );
    expect(result.find((issue) => issue.id === olderIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T10:00:00.000Z",
    );
  });
});

describeEmbeddedPostgres("issueService.create workspace inheritance", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-create-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("inherits the parent issue workspace linkage when child workspace fields are omitted", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "workspace-key",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceRuntime: { profile: "agent" },
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
    });

    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "isolated_workspace",
      workspaceRuntime: { profile: "agent" },
    });
  });

  it("keeps explicit workspace fields instead of inheriting the parent linkage", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const parentProjectWorkspaceId = randomUUID();
    const parentExecutionWorkspaceId = randomUUID();
    const explicitProjectWorkspaceId = randomUUID();
    const explicitExecutionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values([
      {
        id: parentProjectWorkspaceId,
        companyId,
        projectId,
        name: "Parent workspace",
      },
      {
        id: explicitProjectWorkspaceId,
        companyId,
        projectId,
        name: "Explicit workspace",
      },
    ]);

    await db.insert(executionWorkspaces).values([
      {
        id: parentExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: parentProjectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Parent worktree",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: explicitExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: explicitProjectWorkspaceId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Explicit shared workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId: parentProjectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: parentExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
      projectWorkspaceId: explicitProjectWorkspaceId,
      executionWorkspaceId: explicitExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "shared_workspace",
      },
    });

    expect(child.projectWorkspaceId).toBe(explicitProjectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(explicitExecutionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });
  });

  it("inherits workspace linkage from an explicit source issue without creating a parent-child relationship", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "operator_branch",
      strategyType: "git_worktree",
      name: "Operator branch",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Source issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "operator_branch",
      },
    });

    const followUp = await svc.create(companyId, {
      projectId,
      title: "Follow-up issue",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
    });

    expect(followUp.parentId).toBeNull();
    expect(followUp.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(followUp.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(followUp.executionWorkspacePreference).toBe("reuse_existing");
    expect(followUp.executionWorkspaceSettings).toEqual({
      mode: "operator_branch",
    });
  });
});

describeEmbeddedPostgres("issueService blockers and dependency wake readiness", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-blockers-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists blocked-by relations and exposes both blockedBy and blocks summaries", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Blocker",
        status: "todo",
        priority: "high",
      },
      {
        id: blockedId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
      },
    ]);

    await svc.update(blockedId, {
      blockedByIssueIds: [blockerId],
    });

    const blockerRelations = await svc.getRelationSummaries(blockerId);
    const blockedRelations = await svc.getRelationSummaries(blockedId);

    expect(blockerRelations.blocks.map((relation) => relation.id)).toEqual([blockedId]);
    expect(blockedRelations.blockedBy.map((relation) => relation.id)).toEqual([blockerId]);
  });

  it("rejects blocking cycles", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueA = randomUUID();
    const issueB = randomUUID();
    await db.insert(issues).values([
      { id: issueA, companyId, title: "Issue A", status: "todo", priority: "medium" },
      { id: issueB, companyId, title: "Issue B", status: "todo", priority: "medium" },
    ]);

    await svc.update(issueA, { blockedByIssueIds: [issueB] });

    await expect(
      svc.update(issueB, { blockedByIssueIds: [issueA] }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("only returns dependents once every blocker is done", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const blockerA = randomUUID();
    const blockerB = randomUUID();
    const blockedIssueId = randomUUID();
    await db.insert(issues).values([
      { id: blockerA, companyId, title: "Blocker A", status: "done", priority: "medium" },
      { id: blockerB, companyId, title: "Blocker B", status: "todo", priority: "medium" },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);

    await svc.update(blockedIssueId, { blockedByIssueIds: [blockerA, blockerB] });

    expect(await svc.listWakeableBlockedDependents(blockerA)).toEqual([]);

    await svc.update(blockerB, { status: "done" });

    await expect(svc.listWakeableBlockedDependents(blockerA)).resolves.toEqual([
      expect.objectContaining({
        id: blockedIssueId,
        assigneeAgentId,
        blockerIssueIds: expect.arrayContaining([blockerA, blockerB]),
      }),
    ]);
  });

  it("wakes parents only when all direct children are terminal", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const parentId = randomUUID();
    const childA = randomUUID();
    const childB = randomUUID();
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: childA,
        companyId,
        parentId,
        title: "Child A",
        status: "done",
        priority: "medium",
      },
      {
        id: childB,
        companyId,
        parentId,
        title: "Child B",
        status: "blocked",
        priority: "medium",
      },
    ]);

    expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toBeNull();

    await svc.update(childB, { status: "cancelled" });

    expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toEqual({
      id: parentId,
      assigneeAgentId,
      childIssueIds: [childA, childB],
    });
  });
});
describeEmbeddedPostgres("issueService execution ownership handoffs", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-execution-locks-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`
        TRUNCATE TABLE
          activity_log,
          issue_comments,
          issue_inbox_archives,
          issues,
          heartbeat_run_events,
          heartbeat_runs,
          agent_wakeup_requests,
          agent_runtime_state,
          execution_workspaces,
          project_workspaces,
          projects,
          agents,
          companies,
          instance_settings
        RESTART IDENTITY CASCADE
      `);
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("clears stale execution ownership when review routes back to builder", async () => {
    const companyId = randomUUID();
    const staffAgentId = randomUUID();
    const builderAgentId = randomUUID();
    const staffRunId = randomUUID();
    const builderRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: staffAgentId,
        companyId,
        name: "Staff Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: builderAgentId,
        companyId,
        name: "Builder",
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
        id: staffRunId,
        companyId,
        agentId: staffAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "cancelled",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-05T15:24:00.000Z"),
        finishedAt: new Date("2026-04-05T15:24:30.000Z"),
      },
      {
        id: builderRunId,
        companyId,
        agentId: builderAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-05T15:25:00.000Z"),
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Route failed review back to Builder",
      status: "in_review",
      priority: "high",
      assigneeAgentId: staffAgentId,
      checkoutRunId: null,
      executionRunId: staffRunId,
      executionAgentNameKey: "staff-engineer",
      executionLockedAt: new Date("2026-04-05T15:24:00.000Z"),
    });

    const rerouted = await svc.update(issueId, {
      status: "todo",
      assigneeAgentId: builderAgentId,
    });

    expect(rerouted).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "todo",
        assigneeAgentId: builderAgentId,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      }),
    );

    const checkedOut = await svc.checkout(issueId, builderAgentId, ["todo"], builderRunId);

    expect(checkedOut).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_progress",
        assigneeAgentId: builderAgentId,
        checkoutRunId: builderRunId,
        executionRunId: builderRunId,
      }),
    );
  });

  it("clears execution ownership when the owning run performs the handoff itself", async () => {
    const companyId = randomUUID();
    const staffAgentId = randomUUID();
    const builderAgentId = randomUUID();
    const staffRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: staffAgentId,
        companyId,
        name: "Staff Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: builderAgentId,
        companyId,
        name: "Builder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: staffRunId,
      companyId,
      agentId: staffAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId },
      startedAt: new Date("2026-04-05T15:24:00.000Z"),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Safe handoff from reviewer to builder",
      status: "in_review",
      priority: "high",
      assigneeAgentId: staffAgentId,
      checkoutRunId: null,
      executionRunId: staffRunId,
      executionAgentNameKey: "staff-engineer",
      executionLockedAt: new Date("2026-04-05T15:24:00.000Z"),
    });

    const rerouted = await svc.update(
      issueId,
      {
        status: "todo",
        assigneeAgentId: builderAgentId,
      },
      {
        actorAgentId: staffAgentId,
        actorRunId: staffRunId,
      },
    );

    expect(rerouted).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "todo",
        assigneeAgentId: builderAgentId,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      }),
    );
  });

  it("clears execution ownership when a local board request carries the owning run id", async () => {
    const companyId = randomUUID();
    const qaAgentId = randomUUID();
    const staffAgentId = randomUUID();
    const qaRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: qaAgentId,
        companyId,
        name: "QA Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: staffAgentId,
        companyId,
        name: "Staff Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: qaRunId,
      companyId,
      agentId: qaAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId },
      startedAt: new Date("2026-04-11T14:30:00.000Z"),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "QA handoff to Staff review",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: qaAgentId,
      checkoutRunId: qaRunId,
      executionRunId: qaRunId,
      executionAgentNameKey: "qa-engineer",
      executionLockedAt: new Date("2026-04-11T14:30:00.000Z"),
    });

    const rerouted = await svc.update(
      issueId,
      {
        status: "in_review",
        assigneeAgentId: staffAgentId,
      },
      {
        actorAgentId: null,
        actorRunId: qaRunId,
      },
    );

    expect(rerouted).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_review",
        assigneeAgentId: staffAgentId,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      }),
    );
  });

  it("preserves live checkout-only ownership when update has no owning run authority", async () => {
    const companyId = randomUUID();
    const qaAgentId = randomUUID();
    const staffAgentId = randomUUID();
    const qaRunId = randomUUID();
    const staffRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: qaAgentId,
        companyId,
        name: "QA Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: staffAgentId,
        companyId,
        name: "Staff Engineer",
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
        id: qaRunId,
        companyId,
        agentId: qaAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-11T21:00:00.000Z"),
      },
      {
        id: staffRunId,
        companyId,
        agentId: staffAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-11T21:01:00.000Z"),
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Checkout-only live owner",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: qaAgentId,
      checkoutRunId: qaRunId,
      executionRunId: null,
      executionAgentNameKey: "qa-engineer",
      executionLockedAt: new Date("2026-04-11T21:00:00.000Z"),
    });

    const rerouted = await svc.update(issueId, {
      status: "in_review",
      assigneeAgentId: staffAgentId,
    });

    expect(rerouted).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_review",
        assigneeAgentId: staffAgentId,
        checkoutRunId: qaRunId,
        executionRunId: null,
        executionAgentNameKey: "qa-engineer",
      }),
    );

    await expect(svc.checkout(issueId, staffAgentId, ["in_review"], staffRunId)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("preserves execution ownership when a local board run id belongs to a different live agent", async () => {
    const companyId = randomUUID();
    const qaAgentId = randomUUID();
    const staffAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const otherRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: qaAgentId,
        companyId,
        name: "QA Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: staffAgentId,
        companyId,
        name: "Staff Engineer",
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
        name: "Builder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId: otherAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId },
      startedAt: new Date("2026-04-11T14:30:00.000Z"),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mismatched live run should stay locked",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: qaAgentId,
      checkoutRunId: otherRunId,
      executionRunId: otherRunId,
      executionAgentNameKey: "builder",
      executionLockedAt: new Date("2026-04-11T14:30:00.000Z"),
    });

    const rerouted = await svc.update(
      issueId,
      {
        status: "in_review",
        assigneeAgentId: staffAgentId,
      },
      {
        actorAgentId: null,
        actorRunId: otherRunId,
      },
    );

    expect(rerouted).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_review",
        assigneeAgentId: staffAgentId,
        checkoutRunId: otherRunId,
        executionRunId: otherRunId,
        executionAgentNameKey: "builder",
      }),
    );
  });

  it("preserves live execution ownership on reassignment without interrupt", async () => {
    const companyId = randomUUID();
    const staffAgentId = randomUUID();
    const builderAgentId = randomUUID();
    const staffRunId = randomUUID();
    const builderRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: staffAgentId,
        companyId,
        name: "Staff Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: builderAgentId,
        companyId,
        name: "Builder",
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
        id: staffRunId,
        companyId,
        agentId: staffAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-05T15:24:00.000Z"),
      },
      {
        id: builderRunId,
        companyId,
        agentId: builderAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-05T15:25:00.000Z"),
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live reassignment should keep execution lock",
      status: "in_review",
      priority: "high",
      assigneeAgentId: staffAgentId,
      checkoutRunId: null,
      executionRunId: staffRunId,
      executionAgentNameKey: "staff-engineer",
      executionLockedAt: new Date("2026-04-05T15:24:00.000Z"),
    });

    const reassigned = await svc.update(issueId, {
      status: "todo",
      assigneeAgentId: builderAgentId,
    });

    expect(reassigned).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "todo",
        assigneeAgentId: builderAgentId,
        checkoutRunId: null,
        executionRunId: staffRunId,
        executionAgentNameKey: "staff-engineer",
      }),
    );

    await expect(svc.checkout(issueId, builderAgentId, ["todo"], builderRunId)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("defers assignment wakeups while prior execution ownership is still live", async () => {
    const companyId = randomUUID();
    const staffAgentId = randomUUID();
    const builderAgentId = randomUUID();
    const staffRunId = randomUUID();
    const issueId = randomUUID();
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: staffAgentId,
        companyId,
        name: "Staff Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: builderAgentId,
        companyId,
        name: "Builder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: staffRunId,
      companyId,
      agentId: staffAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId },
      startedAt: new Date("2026-04-05T15:24:00.000Z"),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deferred wakeup on reassignment",
      status: "todo",
      priority: "high",
      assigneeAgentId: builderAgentId,
      checkoutRunId: null,
      executionRunId: staffRunId,
      executionAgentNameKey: "staff-engineer",
      executionLockedAt: new Date("2026-04-05T15:24:00.000Z"),
    });

    const wake = await heartbeat.wakeup(builderAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId },
    });

    expect(wake).toBeNull();

    const [deferred] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, builderAgentId));

    expect(deferred).toEqual(
      expect.objectContaining({
        agentId: builderAgentId,
        companyId,
        status: "deferred_issue_execution",
        reason: "issue_execution_deferred",
        runId: null,
      }),
    );

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.executionRunId).toBe(staffRunId);

    const builderRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, builderAgentId));

    expect(builderRuns).toHaveLength(0);
  });

  it("defers assignment wakeups while prior checkout-only ownership is still live", async () => {
    const companyId = randomUUID();
    const qaAgentId = randomUUID();
    const staffAgentId = randomUUID();
    const qaRunId = randomUUID();
    const issueId = randomUUID();
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: qaAgentId,
        companyId,
        name: "QA Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: staffAgentId,
        companyId,
        name: "Staff Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: qaRunId,
      companyId,
      agentId: qaAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {},
      startedAt: new Date("2026-04-11T21:00:00.000Z"),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Checkout-only reroute should defer",
      status: "in_review",
      priority: "high",
      assigneeAgentId: staffAgentId,
      checkoutRunId: qaRunId,
      executionRunId: null,
      executionAgentNameKey: "qa-engineer",
      executionLockedAt: new Date("2026-04-11T21:00:00.000Z"),
    });

    const wake = await heartbeat.wakeup(staffAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId },
    });

    expect(wake).toBeNull();

    const [deferred] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, staffAgentId));

    expect(deferred).toEqual(
      expect.objectContaining({
        agentId: staffAgentId,
        companyId,
        status: "deferred_issue_execution",
        reason: "issue_execution_deferred",
        runId: null,
      }),
    );

    const staffRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, staffAgentId));

    expect(staffRuns).toHaveLength(0);
  });

  it("promotes deferred wakeups after clearing terminal checkout ownership", async () => {
    const companyId = randomUUID();
    const qaAgentId = randomUUID();
    const staffAgentId = randomUUID();
    const qaRunId = randomUUID();
    const staffBlockerRunId = randomUUID();
    const issueId = randomUUID();
    const blockerIssueId = randomUUID();
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: qaAgentId,
        companyId,
        name: "QA Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: staffAgentId,
        companyId,
        name: "Staff Engineer",
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
        id: qaRunId,
        companyId,
        agentId: qaAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-11T21:00:00.000Z"),
      },
      {
        id: staffBlockerRunId,
        companyId,
        agentId: staffAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId: blockerIssueId },
        startedAt: new Date("2026-04-11T21:00:30.000Z"),
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deferred wakeup should promote after QA release",
      status: "in_review",
      priority: "high",
      assigneeAgentId: staffAgentId,
      checkoutRunId: qaRunId,
      executionRunId: qaRunId,
      executionAgentNameKey: "qa-engineer",
      executionLockedAt: new Date("2026-04-11T21:00:00.000Z"),
    });

    await expect(heartbeat.wakeup(staffAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId },
    })).resolves.toBeNull();

    await heartbeat.cancelRun(qaRunId);

    const [promotedWake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, staffAgentId));

    expect(promotedWake).toEqual(
      expect.objectContaining({
        status: "queued",
        reason: "issue_execution_promoted",
      }),
    );
    expect(promotedWake?.runId).toEqual(expect.any(String));

    const promotedRunId = promotedWake?.runId as string;
    const promotedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, promotedRunId))
      .then((rows) => rows[0] ?? null);

    expect(promotedRun).toEqual(
      expect.objectContaining({
        id: promotedRunId,
        agentId: staffAgentId,
        status: "queued",
      }),
    );

    const promotedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(promotedIssue).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_review",
        assigneeAgentId: staffAgentId,
        checkoutRunId: null,
        executionRunId: promotedRunId,
        executionAgentNameKey: "staff engineer",
      }),
    );

    const checkedOut = await svc.checkout(issueId, staffAgentId, ["in_review"], promotedRunId);

    expect(checkedOut).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_progress",
        assigneeAgentId: staffAgentId,
        checkoutRunId: promotedRunId,
        executionRunId: promotedRunId,
      }),
    );
  });

  it("does not clear a fresh execution owner queued between update read and write", async () => {
    const companyId = randomUUID();
    const staffAgentId = randomUUID();
    const builderAgentId = randomUUID();
    const staleStaffRunId = randomUUID();
    const freshRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: staffAgentId,
        companyId,
        name: "Staff Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: builderAgentId,
        companyId,
        name: "Builder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: staleStaffRunId,
      companyId,
      agentId: staffAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "cancelled",
      contextSnapshot: { issueId },
      startedAt: new Date("2026-04-05T15:24:00.000Z"),
      finishedAt: new Date("2026-04-05T15:24:30.000Z"),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Update should not clear a fresh execution owner",
      status: "in_review",
      priority: "high",
      assigneeAgentId: staffAgentId,
      checkoutRunId: null,
      executionRunId: staleStaffRunId,
      executionAgentNameKey: "staff-engineer",
      executionLockedAt: new Date("2026-04-05T15:24:00.000Z"),
    });

    let hookInjected = false;
    const delayedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (callback: Parameters<typeof db.transaction>[0]) => {
            if (!hookInjected) {
              hookInjected = true;
              await target.insert(heartbeatRuns).values({
                id: freshRunId,
                companyId,
                agentId: staffAgentId,
                invocationSource: "assignment",
                triggerDetail: "system",
                status: "queued",
                contextSnapshot: { issueId },
              });
              await target
                .update(issues)
                .set({
                  executionRunId: freshRunId,
                  executionAgentNameKey: "staff engineer",
                  executionLockedAt: new Date("2026-04-05T15:24:05.000Z"),
                })
                .where(eq(issues.id, issueId));
            }
            return target.transaction(callback);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;
    const delayedSvc = issueService(delayedDb);

    const updated = await delayedSvc.update(issueId, {
      status: "todo",
      assigneeAgentId: builderAgentId,
    });

    expect(updated).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "todo",
        assigneeAgentId: builderAgentId,
        checkoutRunId: null,
        executionRunId: freshRunId,
        executionAgentNameKey: "staff engineer",
      }),
    );

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.executionRunId).toBe(freshRunId);
  });

  it("clears execution ownership on release so another run can pick the issue up", async () => {
    const companyId = randomUUID();
    const originalAgentId = randomUUID();
    const nextAgentId = randomUUID();
    const originalRunId = randomUUID();
    const nextRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: originalAgentId,
        companyId,
        name: "Original Builder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: nextAgentId,
        companyId,
        name: "Next Builder",
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
        id: originalRunId,
        companyId,
        agentId: originalAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-05T15:24:00.000Z"),
      },
      {
        id: nextRunId,
        companyId,
        agentId: nextAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-05T15:25:00.000Z"),
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Released issue should not keep stale execution ownership",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: originalAgentId,
      checkoutRunId: originalRunId,
      executionRunId: originalRunId,
      executionAgentNameKey: "original-builder",
      executionLockedAt: new Date("2026-04-05T15:24:00.000Z"),
      startedAt: new Date("2026-04-05T15:24:00.000Z"),
    });

    const released = await svc.release(issueId, {
      actorAgentId: originalAgentId,
      actorRunId: originalRunId,
    });

    expect(released).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "todo",
        assigneeAgentId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      }),
    );

    const reclaimed = await svc.checkout(issueId, nextAgentId, ["todo"], nextRunId);

    expect(reclaimed).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_progress",
        assigneeAgentId: nextAgentId,
        checkoutRunId: nextRunId,
        executionRunId: nextRunId,
      }),
    );
  });

  it("allows a board user to release their own user-assigned issue", async () => {
    const companyId = randomUUID();
    const boardUserId = "local-board";
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Board-owned issue can be released",
      status: "in_progress",
      priority: "medium",
      assigneeUserId: boardUserId,
      startedAt: new Date("2026-04-06T13:00:00.000Z"),
    });

    const released = await svc.release(issueId, {
      actorUserId: boardUserId,
    });

    expect(released).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
      }),
    );
  });

  it("does not overwrite a newer reroute when the prior run releases late", async () => {
    const companyId = randomUUID();
    const originalAgentId = randomUUID();
    const nextAgentId = randomUUID();
    const originalRunId = randomUUID();
    const nextRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: originalAgentId,
        companyId,
        name: "Original Builder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: nextAgentId,
        companyId,
        name: "Next Builder",
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
        id: originalRunId,
        companyId,
        agentId: originalAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-05T15:24:00.000Z"),
      },
      {
        id: nextRunId,
        companyId,
        agentId: nextAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-05T15:25:00.000Z"),
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Late release should preserve rerouted assignee",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: originalAgentId,
      checkoutRunId: originalRunId,
      executionRunId: originalRunId,
      executionAgentNameKey: "original-builder",
      executionLockedAt: new Date("2026-04-05T15:24:00.000Z"),
      startedAt: new Date("2026-04-05T15:24:00.000Z"),
    });

    let hookInjected = false;
    const delayedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (callback: Parameters<typeof db.transaction>[0]) => {
            if (!hookInjected) {
              hookInjected = true;
              await target
                .update(issues)
                .set({
                  status: "todo",
                  assigneeAgentId: nextAgentId,
                  updatedAt: new Date("2026-04-05T15:24:05.000Z"),
                })
                .where(eq(issues.id, issueId));
            }
            return target.transaction(callback);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;
    const delayedSvc = issueService(delayedDb);

    const released = await delayedSvc.release(issueId, {
      actorAgentId: originalAgentId,
      actorRunId: originalRunId,
    });

    expect(released).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "todo",
        assigneeAgentId: nextAgentId,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      }),
    );

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "todo",
        assigneeAgentId: nextAgentId,
        checkoutRunId: null,
        executionRunId: null,
      }),
    );

    const reclaimed = await svc.checkout(issueId, nextAgentId, ["todo"], nextRunId);

    expect(reclaimed).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_progress",
        assigneeAgentId: nextAgentId,
        checkoutRunId: nextRunId,
        executionRunId: nextRunId,
      }),
    );
  });

  it("does not overwrite a newer reroute when a board user releases late", async () => {
    const companyId = randomUUID();
    const boardUserId = "local-board";
    const nextAgentId = randomUUID();
    const nextRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: nextAgentId,
      companyId,
      name: "Next Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: nextRunId,
      companyId,
      agentId: nextAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { issueId },
      startedAt: new Date("2026-04-06T13:00:10.000Z"),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Late board release should preserve rerouted assignee",
      status: "todo",
      priority: "high",
      assigneeUserId: boardUserId,
    });

    let hookInjected = false;
    const delayedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (callback: Parameters<typeof db.transaction>[0]) => {
            if (!hookInjected) {
              hookInjected = true;
              await target
                .update(issues)
                .set({
                  assigneeAgentId: nextAgentId,
                  assigneeUserId: null,
                  updatedAt: new Date("2026-04-06T13:00:05.000Z"),
                })
                .where(eq(issues.id, issueId));
            }
            return target.transaction(callback);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;
    const delayedSvc = issueService(delayedDb);

    await expect(
      delayedSvc.release(issueId, {
        actorUserId: boardUserId,
      }),
    ).rejects.toThrow("Only assignee can release issue");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "todo",
        assigneeAgentId: nextAgentId,
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
      }),
    );

    const reclaimed = await svc.checkout(issueId, nextAgentId, ["todo"], nextRunId);

    expect(reclaimed).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_progress",
        assigneeAgentId: nextAgentId,
        assigneeUserId: null,
        checkoutRunId: nextRunId,
        executionRunId: nextRunId,
      }),
    );
  });

  it("blocks board release while a foreign live run still owns checkout and execution", async () => {
    const companyId = randomUUID();
    const boardUserId = "local-board";
    const originalAgentId = randomUUID();
    const originalRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: originalAgentId,
      companyId,
      name: "Original Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: originalRunId,
      companyId,
      agentId: originalAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId },
      startedAt: new Date("2026-04-06T18:00:00.000Z"),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Board release must not clear a foreign live run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: boardUserId,
      checkoutRunId: originalRunId,
      executionRunId: originalRunId,
      executionAgentNameKey: "original-builder",
      executionLockedAt: new Date("2026-04-06T18:00:00.000Z"),
      startedAt: new Date("2026-04-06T18:00:00.000Z"),
    });

    await expect(
      svc.release(issueId, {
        actorUserId: boardUserId,
      }),
    ).rejects.toThrow("Issue still owned by active run");

    const blockedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(blockedIssue).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_progress",
        assigneeAgentId: null,
        assigneeUserId: boardUserId,
        checkoutRunId: originalRunId,
        executionRunId: originalRunId,
      }),
    );

    await db
      .update(heartbeatRuns)
      .set({
        status: "succeeded",
        finishedAt: new Date("2026-04-06T18:00:30.000Z"),
      })
      .where(eq(heartbeatRuns.id, originalRunId));

    const released = await svc.release(issueId, {
      actorUserId: boardUserId,
    });

    expect(released).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
      }),
    );
  });

  it("blocks a stale checkout holder from releasing while retry execution is owned by a newer live run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const originalRunId = randomUUID();
    const retryRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Original Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values([
      {
        id: originalRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-06T18:20:00.000Z"),
      },
      {
        id: retryRunId,
        companyId,
        agentId,
        invocationSource: "retry",
        triggerDetail: "process_loss",
        status: "queued",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-06T18:20:10.000Z"),
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry promotion must keep replacement execution owner",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: originalRunId,
      executionRunId: retryRunId,
      executionAgentNameKey: "original-builder",
      executionLockedAt: new Date("2026-04-06T18:20:10.000Z"),
      startedAt: new Date("2026-04-06T18:20:00.000Z"),
    });

    await expect(
      svc.release(issueId, {
        actorAgentId: agentId,
        actorRunId: originalRunId,
      }),
    ).rejects.toThrow("Issue still owned by active run");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_progress",
        assigneeAgentId: agentId,
        checkoutRunId: originalRunId,
        executionRunId: retryRunId,
      }),
    );
  });

  it("rejects stale late release on an in-progress reroute until the old run is terminal", async () => {
    const companyId = randomUUID();
    const originalAgentId = randomUUID();
    const nextAgentId = randomUUID();
    const originalRunId = randomUUID();
    const nextRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: originalAgentId,
        companyId,
        name: "Original Builder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: nextAgentId,
        companyId,
        name: "Next Builder",
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
        id: originalRunId,
        companyId,
        agentId: originalAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-05T15:24:00.000Z"),
      },
      {
        id: nextRunId,
        companyId,
        agentId: nextAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-05T15:25:00.000Z"),
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Late release should preserve in-progress reroute checkout ownership",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: originalAgentId,
      checkoutRunId: originalRunId,
      executionRunId: originalRunId,
      executionAgentNameKey: "original-builder",
      executionLockedAt: new Date("2026-04-05T15:24:00.000Z"),
      startedAt: new Date("2026-04-05T15:24:00.000Z"),
    });

    let hookInjected = false;
    const delayedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (callback: Parameters<typeof db.transaction>[0]) => {
            if (!hookInjected) {
              hookInjected = true;
              await target
                .update(issues)
                .set({
                  assigneeAgentId: nextAgentId,
                  updatedAt: new Date("2026-04-05T15:24:05.000Z"),
                })
                .where(eq(issues.id, issueId));
            }
            return target.transaction(callback);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;
    const delayedSvc = issueService(delayedDb);

    await expect(
      delayedSvc.release(issueId, {
        actorAgentId: originalAgentId,
        actorRunId: originalRunId,
      }),
    ).rejects.toThrow("Only assignee can release issue");

    const blockedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(blockedIssue).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_progress",
        assigneeAgentId: nextAgentId,
        checkoutRunId: originalRunId,
        executionRunId: originalRunId,
      }),
    );

    await db
      .update(heartbeatRuns)
      .set({
        status: "succeeded",
        finishedAt: new Date("2026-04-05T15:24:30.000Z"),
      })
      .where(eq(heartbeatRuns.id, originalRunId));

    await db
      .update(issues)
      .set({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: new Date("2026-04-05T15:24:30.000Z"),
      })
      .where(eq(issues.id, issueId));

    const ownership = await svc.assertCheckoutOwner(issueId, nextAgentId, nextRunId);

    expect(ownership).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_progress",
        assigneeAgentId: nextAgentId,
        checkoutRunId: nextRunId,
        adoptedFromRunId: originalRunId,
      }),
    );

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_progress",
        assigneeAgentId: nextAgentId,
        checkoutRunId: nextRunId,
        executionRunId: nextRunId,
      }),
    );
  });

  it("prefers the live execution owner over a stale checkout holder during retry promotion", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const originalRunId = randomUUID();
    const retryRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values([
      {
        id: originalRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-06T18:20:00.000Z"),
      },
      {
        id: retryRunId,
        companyId,
        agentId,
        invocationSource: "retry",
        triggerDetail: "process_loss",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-06T18:20:10.000Z"),
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry run should own split execution",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: originalRunId,
      executionRunId: retryRunId,
      executionAgentNameKey: "builder",
      executionLockedAt: new Date("2026-04-06T18:20:10.000Z"),
      startedAt: new Date("2026-04-06T18:20:00.000Z"),
    });

    await expect(svc.assertCheckoutOwner(issueId, agentId, originalRunId)).rejects.toThrow(
      "Issue run ownership conflict",
    );

    const ownership = await svc.assertCheckoutOwner(issueId, agentId, retryRunId);

    expect(ownership).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_progress",
        assigneeAgentId: agentId,
        checkoutRunId: originalRunId,
        executionRunId: retryRunId,
        adoptedFromRunId: null,
      }),
    );
  });

  it("does not adopt a stale checkout when a newer live execution owner exists", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const originalRunId = randomUUID();
    const retryRunId = randomUUID();
    const nextRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values([
      {
        id: originalRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-11T15:00:00.000Z"),
        finishedAt: new Date("2026-04-11T15:05:00.000Z"),
      },
      {
        id: retryRunId,
        companyId,
        agentId,
        invocationSource: "retry",
        triggerDetail: "process_loss",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-11T15:05:10.000Z"),
      },
      {
        id: nextRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "manual",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-11T15:06:00.000Z"),
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry execution should not be overwritten",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: originalRunId,
      executionRunId: retryRunId,
      executionAgentNameKey: "builder",
      executionLockedAt: new Date("2026-04-11T15:05:10.000Z"),
      startedAt: new Date("2026-04-11T15:00:00.000Z"),
    });

    await expect(svc.checkout(issueId, agentId, ["in_progress"], nextRunId)).rejects.toThrow(
      "Issue checkout conflict",
    );

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "in_progress",
        assigneeAgentId: agentId,
        checkoutRunId: originalRunId,
        executionRunId: retryRunId,
        executionAgentNameKey: "builder",
      }),
    );
  });
});
