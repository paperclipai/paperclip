import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  feedbackVotes,
  financeEvents,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";

// Regression gate for migration 0095 (issue-delete FK cascade).
//
// Upstream `DELETE /issues/:id` issues a raw `delete(issues)` and relies on the DB to
// clear child rows. Seven tables with an `issue_id` FK had NO `onDelete` action
// (Postgres default NO ACTION = RESTRICT): issue_comments, issue_read_states,
// issue_inbox_archives, issue_thread_interactions, feedback_votes (these are child data
// → cascade), and cost_events + finance_events (financial audit, nullable issue_id →
// set null, preserving the event). Before 0095, an issue that had ANY comment / read-state
// / etc. could NOT be deleted — the delete aborted with FK error 23503 (the 500 the
// dry-run hit). This gate seeds those tables and asserts a raw `DELETE FROM issues`
// succeeds AND clears (cascade) / nulls (financial) them. It FAILS (23503) if the schema
// cascade is ever dropped — independent of the route code.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue-delete cascade tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue delete cascade (migration 0095)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-delete-cascade-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    const leftover = await db.select({ id: companies.id }).from(companies);
    for (const row of leftover) {
      await companyService(db).remove(row.id);
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("raw DELETE FROM issues cascades child rows and nulls financial-event links", async () => {
    const company = await companyService(db).create({ name: "Issue Cascade Probe" });
    const cid = company.id;

    const [issue] = await db
      .insert(issues)
      .values({ companyId: cid, title: "probe issue" })
      .returning({ id: issues.id });
    const issueId = issue.id;

    // Seed the five CASCADE tables (child data, notNull issue_id).
    await db.insert(issueComments).values({ companyId: cid, issueId, body: "hi" });
    await db.insert(issueReadStates).values({ companyId: cid, issueId, userId: "u1" });
    await db.insert(issueInboxArchives).values({ companyId: cid, issueId, userId: "u1" });
    await db
      .insert(issueThreadInteractions)
      .values({ companyId: cid, issueId, kind: "comment", payload: {} as never });
    await db.insert(feedbackVotes).values({
      companyId: cid,
      issueId,
      targetType: "comment",
      targetId: "t1",
      authorUserId: "u1",
      vote: "up",
    });
    // Seed a SET-NULL table (financial audit, nullable issue_id) — the row must survive
    // the issue delete with issue_id nulled, NOT be deleted.
    const [fin] = await db
      .insert(financeEvents)
      .values({
        companyId: cid,
        issueId,
        eventKind: "charge",
        biller: "test",
        amountCents: 100,
        occurredAt: new Date(),
      })
      .returning({ id: financeEvents.id });

    // The actual gate: a RAW delete (what the route does) must NOT abort on FK 23503.
    await expect(
      db.execute(sql`DELETE FROM issues WHERE id = ${issueId}`),
    ).resolves.toBeTruthy();

    // CASCADE tables: zero rows left.
    for (const [name, rows] of [
      ["issue_comments", await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, issueId))],
      ["issue_read_states", await db.select({ id: issueReadStates.id }).from(issueReadStates).where(eq(issueReadStates.issueId, issueId))],
      ["issue_inbox_archives", await db.select({ id: issueInboxArchives.id }).from(issueInboxArchives).where(eq(issueInboxArchives.issueId, issueId))],
      ["issue_thread_interactions", await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId))],
      ["feedback_votes", await db.select({ id: feedbackVotes.id }).from(feedbackVotes).where(eq(feedbackVotes.issueId, issueId))],
    ] as const) {
      expect(rows, `${name} should be cascade-cleared`).toHaveLength(0);
    }

    // SET-NULL table: the financial event survives with issue_id nulled.
    const [survived] = await db
      .select({ id: financeEvents.id, issueId: financeEvents.issueId })
      .from(financeEvents)
      .where(eq(financeEvents.id, fin.id));
    expect(survived, "finance_events row must survive the issue delete").toBeTruthy();
    expect(survived.issueId, "finance_events.issue_id must be nulled, not deleted").toBeNull();
  });
});
