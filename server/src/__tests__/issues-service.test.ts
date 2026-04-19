import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  instanceSettings,
  issueChecklistItems,
  issueComments,
  issueInboxArchives,
  issueLinks,
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

async function ensureIssueChecklistItemsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_checklist_items" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "title" text NOT NULL,
      "position" integer NOT NULL DEFAULT 0,
      "completed_at" timestamptz,
      "completed_by_agent_id" uuid,
      "completed_by_user_id" text,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_by_run_id" uuid,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function ensureIssueLinksTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_links" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "url" text NOT NULL,
      "title" text,
      "position" integer NOT NULL DEFAULT 0,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_by_run_id" uuid,
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
    await ensureIssueChecklistItemsTable(db);
    await ensureIssueLinksTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueLinks);
    await db.delete(issueChecklistItems);
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

  it("persists due dates through create, list, get, and update", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const created = await svc.create(companyId, {
      title: "Due date issue",
      status: "todo",
      priority: "medium",
      dueDate: "2026-05-01",
    });

    expect(created.dueDate).toBe("2026-05-01");

    const listed = await svc.list(companyId);
    expect(listed[0]?.dueDate).toBe("2026-05-01");

    const fetched = await svc.getById(created.id);
    expect(fetched?.dueDate).toBe("2026-05-01");

    const updated = await svc.update(created.id, { dueDate: null });
    expect(updated?.dueDate).toBeNull();
  });

  it("filters issues by exact due date and inclusive due date ranges", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(issues).values([
      {
        companyId,
        title: "April 19",
        status: "todo",
        priority: "medium",
        dueDate: "2026-04-19",
      },
      {
        companyId,
        title: "April 20",
        status: "todo",
        priority: "medium",
        dueDate: "2026-04-20",
      },
      {
        companyId,
        title: "April 25",
        status: "todo",
        priority: "medium",
        dueDate: "2026-04-25",
      },
      {
        companyId,
        title: "Undated",
        status: "todo",
        priority: "medium",
      },
      {
        companyId: otherCompanyId,
        title: "Other company",
        status: "todo",
        priority: "medium",
        dueDate: "2026-04-19",
      },
    ]);

    const exact = await svc.list(companyId, { dueDate: "2026-04-19" });
    expect(exact.map((issue) => issue.title)).toEqual(["April 19"]);

    const range = await svc.list(companyId, { dueFrom: "2026-04-20", dueTo: "2026-04-25" });
    expect(new Set(range.map((issue) => issue.title))).toEqual(new Set(["April 20", "April 25"]));
  });

  it("appends created issues and status changes to each board column", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const firstTodo = await svc.create(companyId, {
      title: "First todo",
      status: "todo",
      priority: "medium",
    });
    const secondTodo = await svc.create(companyId, {
      title: "Second todo",
      status: "todo",
      priority: "medium",
    });
    const backlog = await svc.create(companyId, {
      title: "Backlog task",
      status: "backlog",
      priority: "medium",
    });

    expect(firstTodo.boardPosition).toBe(0);
    expect(secondTodo.boardPosition).toBe(1);
    expect(backlog.boardPosition).toBe(0);

    const moved = await svc.update(backlog.id, { status: "todo" });
    expect(moved?.boardPosition).toBe(2);

    const todoRows = await db
      .select({ id: issues.id, boardPosition: issues.boardPosition })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.status, "todo")))
      .orderBy(asc(issues.boardPosition), asc(issues.id));

    expect(todoRows).toEqual([
      { id: firstTodo.id, boardPosition: 0 },
      { id: secondTodo.id, boardPosition: 1 },
      { id: backlog.id, boardPosition: 2 },
    ]);
  });

  it("reorders issues within and across board columns", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const first = await svc.create(companyId, {
      title: "First",
      status: "todo",
      priority: "medium",
    });
    const second = await svc.create(companyId, {
      title: "Second",
      status: "todo",
      priority: "medium",
    });
    const third = await svc.create(companyId, {
      title: "Third",
      status: "todo",
      priority: "medium",
    });

    const reordered = await svc.reorder(third.id, { status: "todo", beforeIssueId: second.id });
    expect(reordered).toEqual(expect.objectContaining({
      id: third.id,
      status: "todo",
      boardPosition: 1,
    }));

    const todoAfterSameColumnMove = await db
      .select({ id: issues.id, boardPosition: issues.boardPosition })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.status, "todo")))
      .orderBy(asc(issues.boardPosition), asc(issues.id));

    expect(todoAfterSameColumnMove).toEqual([
      { id: first.id, boardPosition: 0 },
      { id: third.id, boardPosition: 1 },
      { id: second.id, boardPosition: 2 },
    ]);

    const moved = await svc.reorder(third.id, { status: "blocked", beforeIssueId: null });
    expect(moved).toEqual(expect.objectContaining({
      id: third.id,
      status: "blocked",
      boardPosition: 0,
    }));

    const todoAfterCrossColumnMove = await db
      .select({ id: issues.id, boardPosition: issues.boardPosition })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.status, "todo")))
      .orderBy(asc(issues.boardPosition), asc(issues.id));
    const blockedAfterCrossColumnMove = await db
      .select({ id: issues.id, boardPosition: issues.boardPosition })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked")))
      .orderBy(asc(issues.boardPosition), asc(issues.id));

    expect(todoAfterCrossColumnMove).toEqual([
      { id: first.id, boardPosition: 0 },
      { id: second.id, boardPosition: 1 },
    ]);
    expect(blockedAfterCrossColumnMove).toEqual([
      { id: third.id, boardPosition: 0 },
    ]);
  });

  it("rejects reorder anchors from another status or company", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    const todo = await svc.create(companyId, {
      title: "Todo",
      status: "todo",
      priority: "medium",
    });
    const blocked = await svc.create(companyId, {
      title: "Blocked",
      status: "blocked",
      priority: "medium",
    });
    const otherCompanyTodo = await svc.create(otherCompanyId, {
      title: "Other company todo",
      status: "todo",
      priority: "medium",
    });

    await expect(svc.reorder(todo.id, { status: "todo", beforeIssueId: blocked.id }))
      .rejects.toThrow("Before issue must be in the target status");
    await expect(svc.reorder(todo.id, { status: "todo", beforeIssueId: otherCompanyTodo.id }))
      .rejects.toThrow("Before issue must belong to the same company");
  });

  it("creates, completes, reopens, and deletes issue checklist items", async () => {
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
      name: "Checklist Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const issue = await svc.create(companyId, {
      title: "Checklist issue",
      status: "todo",
      priority: "medium",
    });

    const created = await svc.createChecklistItem(
      issue,
      { title: "Write tests" },
      { userId: "user-1" },
    );
    expect(created).toEqual(expect.objectContaining({
      issueId: issue.id,
      title: "Write tests",
      position: 0,
      createdByUserId: "user-1",
    }));

    const listed = await svc.listChecklistItems(issue.id);
    expect(listed.map((item) => item.title)).toEqual(["Write tests"]);

    const completed = await svc.updateChecklistItem(created.id, { completed: true }, { agentId });
    expect(completed?.completedAt).toBeInstanceOf(Date);
    expect(completed?.completedByAgentId).toBe(agentId);

    const reopened = await svc.updateChecklistItem(created.id, { completed: false }, { userId: "user-1" });
    expect(reopened?.completedAt).toBeNull();
    expect(reopened?.completedByAgentId).toBeNull();
    expect(reopened?.completedByUserId).toBeNull();

    const removed = await svc.deleteChecklistItem(created.id);
    expect(removed?.id).toBe(created.id);
    await expect(svc.listChecklistItems(issue.id)).resolves.toEqual([]);
  });

  it("creates, updates, and deletes issue links", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issue = await svc.create(companyId, {
      title: "Linked issue",
      status: "todo",
      priority: "medium",
    });

    const created = await svc.createLink(
      issue,
      { url: "https://example.com/spec", title: "Spec" },
      { userId: "user-1" },
    );
    expect(created).toEqual(expect.objectContaining({
      issueId: issue.id,
      url: "https://example.com/spec",
      title: "Spec",
      position: 0,
      createdByUserId: "user-1",
    }));

    const listed = await svc.listLinks(issue.id);
    expect(listed.map((link) => link.url)).toEqual(["https://example.com/spec"]);

    const updated = await svc.updateLink(created.id, { title: "Updated spec" });
    expect(updated?.title).toBe("Updated spec");

    const removed = await svc.deleteLink(created.id);
    expect(removed?.id).toBe(created.id);
    await expect(svc.listLinks(issue.id)).resolves.toEqual([]);
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

    const wakeableParent = await svc.getWakeableParentAfterChildCompletion(parentId);
    expect(wakeableParent).toEqual(expect.objectContaining({
      id: parentId,
      assigneeAgentId,
    }));
    expect(wakeableParent?.childIssueIds).toHaveLength(2);
    expect(new Set(wakeableParent?.childIssueIds)).toEqual(new Set([childA, childB]));
  });

  it("auto-assigns new issues to the project lead when no assignee is provided", async () => {
    const companyId = randomUUID();
    const ceoAgentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ceoAgentId,
      companyId,
      name: "CEO",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Mission Control",
      status: "in_progress",
      leadAgentId: ceoAgentId,
    });

    const created = await svc.create(companyId, {
      projectId,
      title: "Investigate intake",
      status: "in_progress",
      priority: "medium",
    });

    expect(created.projectId).toBe(projectId);
    expect(created.assigneeAgentId).toBe(ceoAgentId);
  });

  it("keeps an explicit assignee instead of overwriting with the project lead", async () => {
    const companyId = randomUUID();
    const ceoAgentId = randomUUID();
    const engineerAgentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ceoAgentId,
        companyId,
        name: "CEO",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: engineerAgentId,
        companyId,
        name: "Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Mission Control",
      status: "in_progress",
      leadAgentId: ceoAgentId,
    });

    const created = await svc.create(companyId, {
      projectId,
      title: "Handle explicit assignee",
      status: "todo",
      priority: "medium",
      assigneeAgentId: engineerAgentId,
    });

    expect(created.assigneeAgentId).toBe(engineerAgentId);
  });

  it("leaves issues unassigned when the project has no lead", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Mission Control",
      status: "planned",
      leadAgentId: null,
    });

    const created = await svc.create(companyId, {
      projectId,
      title: "Stay unassigned",
      status: "todo",
      priority: "medium",
    });

    expect(created.assigneeAgentId).toBeNull();
    expect(created.assigneeUserId).toBeNull();
  });
});

describeEmbeddedPostgres("issueService comment normalization", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-comments-");
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

  async function createTestIssue() {
    const companyId = randomUUID();
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
      title: "Normalize comment body",
      status: "todo",
      priority: "medium",
    });

    return { issueId };
  }

  it("stores normal markdown comments unchanged", async () => {
    const { issueId } = await createTestIssue();
    const body = "## Update\n\n- Item one";

    const comment = await svc.addComment(issueId, body, {});
    const stored = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.id, comment.id))
      .then((rows) => rows[0] ?? null);

    expect(comment.body).toBe(body);
    expect(stored?.body).toBe(body);
  });

  it("decodes obviously JSON-escaped markdown before storing it", async () => {
    const { issueId } = await createTestIssue();
    const body = "## Update\\n\\n- Item one";

    const comment = await svc.addComment(issueId, body, {});
    const stored = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.id, comment.id))
      .then((rows) => rows[0] ?? null);

    expect(comment.body).toBe("## Update\n\n- Item one");
    expect(stored?.body).toBe("## Update\n\n- Item one");
  });

  it("leaves ordinary backslash text unchanged", async () => {
    const { issueId } = await createTestIssue();
    const body = String.raw`Windows path C:\new-folder\tools`;

    const comment = await svc.addComment(issueId, body, {});
    const stored = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.id, comment.id))
      .then((rows) => rows[0] ?? null);

    expect(comment.body).toBe(body);
    expect(stored?.body).toBe(body);
  });
});
