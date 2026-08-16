import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueStatusEvents, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("issue_status_events trigger (TSMC-20879)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-status-events-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(status: string) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `T-${issueId.slice(0, 6)}`,
      title: "status event test",
      status,
      priority: "medium",
    });
    return { companyId, issueId };
  }

  async function events(issueId: string) {
    return db
      .select()
      .from(issueStatusEvents)
      .where(eq(issueStatusEvents.issueId, issueId))
      .orderBy(issueStatusEvents.createdAt);
  }

  it("records the creation event with a null from_status", async () => {
    const { issueId } = await seedIssue("todo");
    const rows = await events(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0].fromStatus).toBeNull();
    expect(rows[0].toStatus).toBe("todo");
  });

  it("records every status transition, from any writer", async () => {
    const { issueId } = await seedIssue("todo");
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    const rows = await events(issueId);
    expect(rows.map((r) => `${r.fromStatus}->${r.toStatus}`)).toEqual([
      "null->todo",
      "todo->in_progress",
      "in_progress->done",
    ]);
    expect(rows[1].fromStatus).toBe("todo");
    expect(rows[2].toStatus).toBe("done");
  });

  it("writes nothing for a non-status update", async () => {
    const { issueId } = await seedIssue("todo");
    await db.update(issues).set({ title: "renamed" }).where(eq(issues.id, issueId));
    const rows = await events(issueId);
    expect(rows).toHaveLength(1);
  });

  it("same-status update writes nothing (IS DISTINCT FROM guard)", async () => {
    const { issueId } = await seedIssue("todo");
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    const rows = await events(issueId);
    expect(rows).toHaveLength(1);
  });

  it("digest-style aggregation counts transitions per to_status", async () => {
    const { companyId, issueId } = await seedIssue("todo");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    const rows = await db
      .select()
      .from(issueStatusEvents)
      .where(and(eq(issueStatusEvents.companyId, companyId), eq(issueStatusEvents.toStatus, "done")));
    expect(rows).toHaveLength(1);
  });
});
