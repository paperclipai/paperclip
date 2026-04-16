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
  issueReadStates,
  issueRelations,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
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
    await db.delete(issueReadStates);
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
      name: "PrivateClip",
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
      name: "PrivateClip",
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
      name: "PrivateClip",
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

  it("includes terminal issues by default and still respects explicit status filters", async () => {
    const companyId = randomUUID();
    const openIssueId = randomUUID();
    const doneIssueId = randomUUID();
    const cancelledIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: openIssueId,
        companyId,
        title: "Open issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: doneIssueId,
        companyId,
        title: "Done issue",
        status: "done",
        priority: "medium",
      },
      {
        id: cancelledIssueId,
        companyId,
        title: "Cancelled issue",
        status: "cancelled",
        priority: "medium",
      },
    ]);

    const defaultResult = await svc.list(companyId, {});
    expect(new Set(defaultResult.map((issue) => issue.id))).toEqual(new Set([
      openIssueId,
      doneIssueId,
      cancelledIssueId,
    ]));

    const openOnlyResult = await svc.list(companyId, { status: "todo" });
    expect(openOnlyResult.map((issue) => issue.id)).toEqual([openIssueId]);
  });

  it("treats user issue updates as touch activity and status-only work as unread", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const issueId = randomUUID();
    const creatorAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: creatorAgentId,
      companyId,
      name: "CreatorAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Board-updated issue",
      status: "done",
      priority: "medium",
      createdByAgentId: creatorAgentId,
      createdAt: new Date("2026-03-26T10:00:00.000Z"),
      updatedAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { title: "Retitled", _previous: { title: "Before" } },
        createdAt: new Date("2026-03-26T10:30:00.000Z"),
      },
      {
        companyId,
        actorType: "agent",
        actorId: randomUUID(),
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { status: "done", _previous: { status: "todo" } },
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
      },
    ]);

    const touched = await svc.list(companyId, { touchedByUserId: userId });
    const touchedIssue = touched.find((issue) => issue.id === issueId);

    expect(touchedIssue).toBeDefined();
    expect(touchedIssue?.myLastTouchAt?.toISOString()).toBe("2026-03-26T10:30:00.000Z");
    expect(touchedIssue?.isUnreadForMe).toBe(true);

    const unread = await svc.list(companyId, { unreadForUserId: userId });
    expect(unread.map((issue) => issue.id)).toContain(issueId);
  });

  it("surfaces recovered successor issues when the source was touched by the board user", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const sourceIssueId = randomUUID();
    const successorIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        title: "Source issue",
        status: "blocked",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T09:00:00.000Z"),
        updatedAt: new Date("2026-03-26T09:00:00.000Z"),
      },
      {
        id: successorIssueId,
        companyId,
        title: "Successor issue",
        status: "done",
        priority: "medium",
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
    ]);

    await db.insert(issueReadStates).values({
      companyId,
      issueId: sourceIssueId,
      userId,
      lastReadAt: new Date("2026-03-26T09:30:00.000Z"),
      createdAt: new Date("2026-03-26T09:30:00.000Z"),
      updatedAt: new Date("2026-03-26T09:30:00.000Z"),
    });

    await db.insert(issueRelations).values({
      companyId,
      issueId: sourceIssueId,
      relatedIssueId: successorIssueId,
      type: "recovered_by",
      createdByUserId: userId,
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: randomUUID(),
      action: "issue.updated",
      entityType: "issue",
      entityId: successorIssueId,
      details: { status: "done", _previous: { status: "todo" } },
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    const touched = await svc.list(companyId, { touchedByUserId: userId });
    const successor = touched.find((issue) => issue.id === successorIssueId);

    expect(successor).toBeDefined();
    expect(successor?.myLastTouchAt?.toISOString()).toBe("2026-03-26T09:30:00.000Z");
    expect(successor?.isUnreadForMe).toBe(true);

    const unread = await svc.list(companyId, { unreadForUserId: userId });
    expect(unread.map((issue) => issue.id)).toContain(successorIssueId);
  });

  it("can hide blocked recovery source issues when their continuation is still open", async () => {
    const companyId = randomUUID();
    const sourceIssueId = randomUUID();
    const closedSourceIssueId = randomUUID();
    const openSuccessorIssueId = randomUUID();
    const closedSuccessorIssueId = randomUUID();
    const doneSuccessorIssueId = randomUUID();
    const plainBlockedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        title: "Blocked source issue",
        status: "blocked",
        priority: "medium",
        createdAt: new Date("2026-03-26T09:00:00.000Z"),
        updatedAt: new Date("2026-03-26T09:00:00.000Z"),
      },
      {
        id: closedSourceIssueId,
        companyId,
        title: "Blocked source issue with closed continuation",
        status: "blocked",
        priority: "medium",
        createdAt: new Date("2026-03-26T09:15:00.000Z"),
        updatedAt: new Date("2026-03-26T09:15:00.000Z"),
      },
      {
        id: openSuccessorIssueId,
        companyId,
        title: "Open continuation",
        status: "todo",
        priority: "medium",
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: closedSuccessorIssueId,
        companyId,
        title: "Closed continuation for blocked source",
        status: "done",
        priority: "medium",
        createdAt: new Date("2026-03-26T10:15:00.000Z"),
        updatedAt: new Date("2026-03-26T10:15:00.000Z"),
      },
      {
        id: doneSuccessorIssueId,
        companyId,
        title: "Closed continuation",
        status: "done",
        priority: "medium",
        createdAt: new Date("2026-03-26T10:30:00.000Z"),
        updatedAt: new Date("2026-03-26T10:30:00.000Z"),
      },
      {
        id: plainBlockedIssueId,
        companyId,
        title: "Plain blocked issue",
        status: "blocked",
        priority: "medium",
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
    ]);

    await db.insert(issueRelations).values([
      {
        companyId,
        issueId: sourceIssueId,
        relatedIssueId: openSuccessorIssueId,
        type: "recovered_by",
      },
      {
        companyId,
        issueId: closedSourceIssueId,
        relatedIssueId: closedSuccessorIssueId,
        type: "recovered_by",
      },
      {
        companyId,
        issueId: doneSuccessorIssueId,
        relatedIssueId: plainBlockedIssueId,
        type: "blocks",
      },
    ]);

    const defaultBlocked = await svc.list(companyId, { status: "blocked" });
    expect(defaultBlocked.map((issue) => issue.id)).toEqual(
      expect.arrayContaining([sourceIssueId, closedSourceIssueId, plainBlockedIssueId]),
    );

    const filteredBlocked = await svc.list(companyId, {
      status: "blocked",
      excludeRecoverySourcesWithOpenSuccessors: true,
    });
    expect(filteredBlocked.map((issue) => issue.id)).not.toContain(sourceIssueId);
    expect(filteredBlocked.map((issue) => issue.id)).toContain(closedSourceIssueId);
    expect(filteredBlocked.map((issue) => issue.id)).toContain(plainBlockedIssueId);
  });

  it("archives closed issues older than the configured window", async () => {
    const companyId = randomUUID();
    const staleDoneIssueId = randomUUID();
    const staleCancelledIssueId = randomUUID();
    const recentDoneIssueId = randomUUID();
    const openIssueId = randomUUID();
    const now = new Date("2026-04-12T12:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: staleDoneIssueId,
        companyId,
        title: "Stale done issue",
        status: "done",
        priority: "medium",
        updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        id: staleCancelledIssueId,
        companyId,
        title: "Stale cancelled issue",
        status: "cancelled",
        priority: "medium",
        updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        id: recentDoneIssueId,
        companyId,
        title: "Recent done issue",
        status: "done",
        priority: "medium",
        updatedAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        id: openIssueId,
        companyId,
        title: "Open issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);

    const result = await svc.archiveClosed(companyId, {
      olderThanDays: 14,
      now,
    });

    expect(result.archivedCount).toBe(2);
    expect(new Set(result.issueIds)).toEqual(new Set([staleDoneIssueId, staleCancelledIssueId]));

    const rows = await db
      .select({
        id: issues.id,
        hiddenAt: issues.hiddenAt,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId));

    const hiddenByIssueId = new Map(rows.map((row) => [row.id, row.hiddenAt]));
    expect(hiddenByIssueId.get(staleDoneIssueId)?.toISOString()).toBe(now.toISOString());
    expect(hiddenByIssueId.get(staleCancelledIssueId)?.toISOString()).toBe(now.toISOString());
    expect(hiddenByIssueId.get(recentDoneIssueId)).toBeNull();
    expect(hiddenByIssueId.get(openIssueId)).toBeNull();
  });

  it("accepts issue identifiers through getById", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
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
      name: "PrivateClip",
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
      name: "PrivateClip",
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
      name: "PrivateClip",
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
      name: "PrivateClip",
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
    await db.delete(issueReadStates);
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
      name: "PrivateClip",
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
      name: "PrivateClip",
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
      name: "PrivateClip",
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
    await db.delete(issueReadStates);
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
      name: "PrivateClip",
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

  it("rejects creating a blocked issue without blocker relations", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(
      svc.create(companyId, {
        title: "Broken blocked issue",
        status: "blocked",
        priority: "medium",
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("normalizes a blocked issue to todo when the last blocker is removed without an explicit status", async () => {
    const companyId = randomUUID();
    const blockerId = randomUUID();
    const blockedId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Blocked worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Real blocker",
        status: "todo",
        priority: "high",
      },
      {
        id: blockedId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);

    await svc.update(blockedId, {
      blockedByIssueIds: [blockerId],
    });

    const updated = await svc.update(blockedId, {
      blockedByIssueIds: [],
    });

    expect(updated?.status).toBe("todo");
  });

  it("keeps an explicit non-blocked status when clearing the last blocker", async () => {
    const companyId = randomUUID();
    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Real blocker",
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

    const updated = await svc.update(blockedId, {
      status: "in_review",
      blockedByIssueIds: [],
    });

    expect(updated?.status).toBe("in_review");
  });

  it("optionally includes blockedBy and blocks summaries in list results", async () => {
    const companyId = randomUUID();
    const blockerAssigneeUserId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Board approval",
        status: "in_progress",
        priority: "high",
        assigneeUserId: blockerAssigneeUserId,
      },
      {
        id: blockedId,
        companyId,
        title: "Ship the rollout",
        status: "blocked",
        priority: "medium",
      },
    ]);

    await svc.update(blockedId, {
      blockedByIssueIds: [blockerId],
    });

    const listed = await svc.list(companyId, { includeRelations: true });
    const blockedIssue = listed.find((issue) => issue.id === blockedId);
    const blockerIssue = listed.find((issue) => issue.id === blockerId);

    expect(blockedIssue?.blockedBy).toEqual([
      expect.objectContaining({
        id: blockerId,
        assigneeUserId: blockerAssigneeUserId,
      }),
    ]);
    expect(blockerIssue?.blocks).toEqual([
      expect.objectContaining({
        id: blockedId,
      }),
    ]);
  });

  it("rejects blocking cycles", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
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

  it("rejects assignee changes while an issue stays terminal", async () => {
    const companyId = randomUUID();
    const currentAssigneeId = randomUUID();
    const nextAssigneeId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: currentAssigneeId,
        companyId,
        name: "Current Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: nextAssigneeId,
        companyId,
        name: "Next Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancelled issue",
      status: "cancelled",
      priority: "medium",
      assigneeAgentId: currentAssigneeId,
    });

    await expect(
      svc.update(issueId, { assigneeAgentId: nextAssigneeId }),
    ).rejects.toMatchObject({ status: 422 });

    const persisted = await db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(persisted).toEqual({
      status: "cancelled",
      assigneeAgentId: currentAssigneeId,
    });
  });

  it("allows reassignment when reopening a terminal issue", async () => {
    const companyId = randomUUID();
    const currentAssigneeId = randomUUID();
    const nextAssigneeId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: currentAssigneeId,
        companyId,
        name: "Current Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: nextAssigneeId,
        companyId,
        name: "Next Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancelled issue",
      status: "cancelled",
      priority: "medium",
      assigneeAgentId: currentAssigneeId,
    });

    const updated = await svc.update(issueId, {
      status: "todo",
      assigneeAgentId: nextAssigneeId,
    });
    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("todo");
    expect(updated?.assigneeAgentId).toBe(nextAssigneeId);
  });

  it("only returns dependents once every blocker is done", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
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

  it("treats cancelled blockers as resolved for dependency wake readiness", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
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
      { id: blockerB, companyId, title: "Blocker B", status: "cancelled", priority: "medium" },
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
      name: "PrivateClip",
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

describeEmbeddedPostgres("issueService recovery transitions", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-recovery-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueReadStates);
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

  it("create with recovery disposition clears source ownership, links successor, and records transition truth", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const sourceIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Recovery agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Broken source issue",
      status: "in_progress",
      priority: "high",
      assigneeAgentId,
    });

    const continuation = await svc.create(companyId, {
      title: "Continuation issue",
      status: "todo",
      priority: "high",
      assigneeAgentId,
      recoveryFromIssueId: sourceIssueId,
      recoveryDisposition: "recovered_by_reissue",
    });

    const sourceIssue = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issues)
      .where(eq(issues.id, sourceIssueId))
      .then((rows) => rows[0] ?? null);
    expect(sourceIssue).toEqual(
      expect.objectContaining({
        status: "blocked",
        assigneeAgentId: null,
        assigneeUserId: null,
      }),
    );

    const relation = await db
      .select({
        issueId: issueRelations.issueId,
        relatedIssueId: issueRelations.relatedIssueId,
        type: issueRelations.type,
      })
      .from(issueRelations)
      .where(eq(issueRelations.issueId, sourceIssueId))
      .then((rows) => rows[0] ?? null);
    expect(relation).toEqual(
      expect.objectContaining({
        issueId: sourceIssueId,
        relatedIssueId: continuation.id,
        type: "recovered_by",
      }),
    );

    const transitionComment = await db
      .select({
        body: issueComments.body,
      })
      .from(issueComments)
      .where(eq(issueComments.issueId, sourceIssueId))
      .then((rows) => rows[0] ?? null);
    expect(transitionComment?.body).toContain("[issue-recovery-transition]");
    expect(transitionComment?.body).toContain(continuation.identifier ?? continuation.id);

    const sourceRelations = await svc.getRelationSummaries(sourceIssueId);
    expect(sourceRelations.recoverySuccessor).toEqual(
      expect.objectContaining({
        id: continuation.id,
        identifier: continuation.identifier,
        title: continuation.title,
        assigneeAgentId,
      }),
    );
    expect(sourceRelations.recoverySource).toBeNull();

    const continuationRelations = await svc.getRelationSummaries(continuation.id);
    expect(continuationRelations.recoverySource).toEqual(
      expect.objectContaining({
        id: sourceIssueId,
        title: "Broken source issue",
        status: "blocked",
      }),
    );
    expect(continuationRelations.recoverySuccessor).toBeNull();
  });

  it("copies inbox read and archive context from the source issue to a continuation issue", async () => {
    const companyId = randomUUID();
    const sourceIssueId = randomUUID();
    const userId = "user-1";
    const readAt = new Date("2026-03-26T09:30:00.000Z");
    const archivedAt = new Date("2026-03-26T10:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Recoverable source issue",
      status: "in_progress",
      priority: "medium",
      createdByUserId: userId,
      createdAt: new Date("2026-03-26T09:00:00.000Z"),
      updatedAt: new Date("2026-03-26T09:00:00.000Z"),
    });
    await db.insert(issueReadStates).values({
      companyId,
      issueId: sourceIssueId,
      userId,
      lastReadAt: readAt,
      createdAt: readAt,
      updatedAt: readAt,
    });
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId: sourceIssueId,
      userId,
      archivedAt,
      createdAt: archivedAt,
      updatedAt: archivedAt,
    });

    const continuation = await svc.create(companyId, {
      title: "Continuation issue",
      status: "todo",
      priority: "medium",
      recoveryFromIssueId: sourceIssueId,
      recoveryDisposition: "recovered_by_reissue",
    });

    const copiedReadState = await db
      .select({ lastReadAt: issueReadStates.lastReadAt })
      .from(issueReadStates)
      .where(eq(issueReadStates.issueId, continuation.id))
      .then((rows) => rows[0] ?? null);
    const copiedArchiveState = await db
      .select({ archivedAt: issueInboxArchives.archivedAt })
      .from(issueInboxArchives)
      .where(eq(issueInboxArchives.issueId, continuation.id))
      .then((rows) => rows[0] ?? null);

    expect(copiedReadState?.lastReadAt.toISOString()).toBe(readAt.toISOString());
    expect(copiedArchiveState?.archivedAt.toISOString()).toBe(archivedAt.toISOString());
  });

  it("update recovery with successor clears source ownership and persists transition truth", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const sourceIssueId = randomUUID();
    const successorIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Recovery agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        title: "Stuck source issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: successorIssueId,
        companyId,
        title: "Replacement issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
    ]);

    const updated = await svc.update(sourceIssueId, {
      actorAgentId: assigneeAgentId,
      recovery: {
        successorIssueId,
        disposition: "superseded",
      },
    });
    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("cancelled");
    expect(updated?.assigneeAgentId).toBeNull();
    expect(updated?.assigneeUserId).toBeNull();

    const relation = await db
      .select({
        issueId: issueRelations.issueId,
        relatedIssueId: issueRelations.relatedIssueId,
        type: issueRelations.type,
      })
      .from(issueRelations)
      .where(eq(issueRelations.issueId, sourceIssueId))
      .then((rows) => rows[0] ?? null);
    expect(relation).toEqual(
      expect.objectContaining({
        issueId: sourceIssueId,
        relatedIssueId: successorIssueId,
        type: "recovered_by",
      }),
    );

    const successor = await db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(eq(issues.id, successorIssueId))
      .then((rows) => rows[0] ?? null);

    const transitionComment = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, sourceIssueId))
      .then((rows) => rows[0] ?? null);
    expect(transitionComment?.body).toContain("[issue-recovery-transition]");
    expect(transitionComment?.body).toContain(successor?.identifier ?? successorIssueId);
  });

  it("supports asc comment pagination after an anchor comment id", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const firstCommentId = randomUUID();
    const secondCommentId = randomUUID();
    const firstCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const secondCreatedAt = new Date("2026-01-01T00:01:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Comment pagination issue",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueComments).values([
      {
        id: firstCommentId,
        companyId,
        issueId,
        body: "first",
        createdAt: firstCreatedAt,
        updatedAt: firstCreatedAt,
      },
      {
        id: secondCommentId,
        companyId,
        issueId,
        body: "second",
        createdAt: secondCreatedAt,
        updatedAt: secondCreatedAt,
      },
    ]);

    const comments = await svc.listComments(issueId, {
      afterCommentId: firstCommentId,
      order: "asc",
    });

    expect(comments.map((comment) => comment.id)).toEqual([secondCommentId]);
  });
});

describeEmbeddedPostgres("issueService.checkout queued execution handoff", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-checkout-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueReadStates);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
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

  it("lets a newer run checkout a todo issue when the only lock is a queued execution run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const queuedWakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    const actorRunId = randomUUID();
    const now = new Date("2026-04-10T21:54:53.723Z");

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CMO",
      role: "cmo",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: queuedWakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "operations_assignment",
      payload: { issueId },
      status: "queued",
      runId: queuedRunId,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values([
      {
        id: queuedRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: queuedWakeupRequestId,
        contextSnapshot: { issueId, wakeReason: "operations_assignment" },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: actorRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        wakeupRequestId: null,
        contextSnapshot: { issueId: randomUUID(), wakeReason: "operations_recovery_reissue" },
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued execution checkout conflict",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: queuedRunId,
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
      updatedAt: now,
    });

    const checkedOut = await svc.checkout(issueId, agentId, ["todo", "backlog", "blocked", "in_review"], actorRunId);

    expect(checkedOut).toEqual(expect.objectContaining({
      id: issueId,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: actorRunId,
      executionRunId: actorRunId,
    }));

    const supersededRun = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId))
      .then((rows) => rows[0] ?? null);
    expect(supersededRun).toEqual(expect.objectContaining({
      status: "cancelled",
      errorCode: "cancelled",
    }));

    const supersededWakeup = await db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, queuedWakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(supersededWakeup).toEqual(expect.objectContaining({
      status: "cancelled",
    }));
    expect(supersededWakeup?.error).toContain("superseded");
  });
});
