import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  goals,
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
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres last-activity-at tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

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

async function readLastActivityAt(
  db: ReturnType<typeof createDb>,
  issueId: string,
): Promise<Date> {
  const [row] = await db
    .select({ lastActivityAt: issues.lastActivityAt })
    .from(issues)
    .where(eq(issues.id, issueId));
  if (!row) throw new Error(`issue ${issueId} not found`);
  return row.lastActivityAt;
}

describeEmbeddedPostgres("issues.last_activity_at materialized column", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-last-activity-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("initializes last_activity_at from updated_at on insert", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueId = randomUUID();
    const historicalUpdatedAt = new Date("2026-01-15T10:00:00.000Z");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Historical issue",
      status: "todo",
      priority: "medium",
      createdAt: historicalUpdatedAt,
      updatedAt: historicalUpdatedAt,
    });

    const stored = await readLastActivityAt(db, issueId);
    expect(stored.toISOString()).toBe(historicalUpdatedAt.toISOString());
  });

  it("bumps last_activity_at when updated_at advances on issue update", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueId = randomUUID();
    const t0 = new Date("2026-02-01T10:00:00.000Z");
    const t1 = new Date("2026-02-01T15:30:00.000Z");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Body update test",
      status: "todo",
      priority: "medium",
      createdAt: t0,
      updatedAt: t0,
    });

    expect((await readLastActivityAt(db, issueId)).toISOString()).toBe(t0.toISOString());

    await db
      .update(issues)
      .set({ description: "now with body", updatedAt: t1 })
      .where(eq(issues.id, issueId));

    expect((await readLastActivityAt(db, issueId)).toISOString()).toBe(t1.toISOString());
  });

  it("bumps last_activity_at when a comment is inserted directly via DB", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueId = randomUUID();
    const t0 = new Date("2026-02-01T10:00:00.000Z");
    const tComment = new Date("2026-02-01T12:00:00.000Z");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Comment bump test",
      status: "todo",
      priority: "medium",
      createdAt: t0,
      updatedAt: t0,
    });

    expect((await readLastActivityAt(db, issueId)).toISOString()).toBe(t0.toISOString());

    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: "user-other",
      body: "hello",
      createdAt: tComment,
      updatedAt: tComment,
    });

    expect((await readLastActivityAt(db, issueId)).toISOString()).toBe(tComment.toISOString());
  });

  it("does not bump last_activity_at when a read-state row is inserted or updated", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueId = randomUUID();
    const t0 = new Date("2026-02-01T10:00:00.000Z");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Read state should not bump activity",
      status: "todo",
      priority: "medium",
      createdAt: t0,
      updatedAt: t0,
    });

    const beforeRead = await readLastActivityAt(db, issueId);

    await svc.markRead(companyId, issueId, "user-1", new Date("2026-03-01T08:00:00.000Z"));
    const afterRead = await readLastActivityAt(db, issueId);
    expect(afterRead.toISOString()).toBe(beforeRead.toISOString());

    // A subsequent markRead (which performs an upsert / update) must also not bump.
    await svc.markRead(companyId, issueId, "user-1", new Date("2026-03-02T09:00:00.000Z"));
    const afterSecondRead = await readLastActivityAt(db, issueId);
    expect(afterSecondRead.toISOString()).toBe(beforeRead.toISOString());
  });

  it("does not bump last_activity_at on comment delete", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueId = randomUUID();
    const t0 = new Date("2026-02-01T10:00:00.000Z");
    const tComment = new Date("2026-02-01T11:00:00.000Z");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Comment delete test",
      status: "todo",
      priority: "medium",
      createdAt: t0,
      updatedAt: t0,
    });

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorUserId: "user-other",
      body: "hi",
      createdAt: tComment,
      updatedAt: tComment,
    });

    expect((await readLastActivityAt(db, issueId)).toISOString()).toBe(tComment.toISOString());

    await db.delete(issueComments).where(eq(issueComments.issueId, issueId));

    // last_activity_at is "monotonic" — once bumped by an inserted comment we
    // don't roll it back when the comment is deleted (nor would the old
    // implementation, which used MAX over still-present comments).
    const after = await readLastActivityAt(db, issueId);
    expect(after.toISOString()).toBe(tComment.toISOString());
  });
});

describeEmbeddedPostgres("inboxVisibleForUserCondition with materialized column", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-inbox-visible-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("resurfaces an archived issue when a new comment lands after the archive timestamp", async () => {
    const companyId = randomUUID();
    const userId = "user-1";

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
      title: "Archived but resurfaced",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
      createdAt: new Date("2026-04-01T09:00:00.000Z"),
      updatedAt: new Date("2026-04-01T09:00:00.000Z"),
    });

    await svc.archiveInbox(
      companyId,
      issueId,
      userId,
      new Date("2026-04-01T10:00:00.000Z"),
    );

    const beforeNewComment = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(beforeNewComment.map((row) => row.id)).not.toContain(issueId);

    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: "user-2",
      body: "ping",
      createdAt: new Date("2026-04-01T11:00:00.000Z"),
      updatedAt: new Date("2026-04-01T11:00:00.000Z"),
    });

    const afterNewComment = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(afterNewComment.map((row) => row.id)).toContain(issueId);
  });

  it("keeps an archived issue hidden when no new activity has occurred", async () => {
    const companyId = randomUUID();
    const userId = "user-1";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const archivedIssueId = randomUUID();
    const visibleIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: archivedIssueId,
        companyId,
        title: "Archived, no follow-up",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-04-01T09:00:00.000Z"),
        updatedAt: new Date("2026-04-01T09:00:00.000Z"),
      },
      {
        id: visibleIssueId,
        companyId,
        title: "Never archived",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-04-01T09:00:00.000Z"),
        updatedAt: new Date("2026-04-01T09:00:00.000Z"),
      },
    ]);

    await svc.archiveInbox(
      companyId,
      archivedIssueId,
      userId,
      new Date("2026-04-01T10:00:00.000Z"),
    );

    const visible = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    const visibleIds = visible.map((row) => row.id);
    expect(visibleIds).toContain(visibleIssueId);
    expect(visibleIds).not.toContain(archivedIssueId);
  });
});
