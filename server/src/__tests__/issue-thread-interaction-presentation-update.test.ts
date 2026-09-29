import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues, issueThreadInteractions } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// The card the communication standard exists for: an interaction raised before a
// rule required a title and a summary, on an issue that has since closed. The
// standard requires both fields, and the only correction the API can offer is
// this write, so it has to work on a closed issue and on an answered card.
describeEmbeddedPostgres("updatePresentation against a real database", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-presentation-update-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seed a closed issue carrying one interaction, written straight to the table
   * so the row starts in exactly the state the reported cards are in: empty
   * title, empty summary, already resolved.
   */
  async function seedClosedIssueWithEmptyCard(status: "accepted" | "expired") {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Wilder Labs",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Company onboarding",
      status: "done",
      priority: "medium",
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status,
      continuationPolicy: "none",
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      createdByUserId: "local-board",
      payload: { version: 1, prompt: "How should the company start?" },
      result: { version: 1, outcome: status === "accepted" ? "accepted" : "issue_closed" },
      resolvedByUserId: "local-board",
      resolvedAt: new Date("2026-07-25T11:00:00.000Z"),
    });
    return { companyId, issueId, interactionId };
  }

  it.each(["accepted", "expired"] as const)(
    "fills in the empty title and summary of a %s card on a closed issue",
    async (status) => {
      const seeded = await seedClosedIssueWithEmptyCard(status);
      const svc = issueThreadInteractionService(db);

      const { before, after } = await svc.updatePresentation(
        { id: seeded.issueId, companyId: seeded.companyId },
        seeded.interactionId,
        {
          title: "Hire the founding team",
          summary: "Accepting hires the first two agents and closes onboarding.",
        },
      );

      expect(before).toMatchObject({ title: null, summary: null });
      expect(after).toMatchObject({
        title: "Hire the founding team",
        summary: "Accepting hires the first two agents and closes onboarding.",
      });

      // Read the row back through drizzle rather than trusting the return value,
      // so a write that never landed cannot pass as a success.
      const stored = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, seeded.interactionId))
        .then((rows) => rows[0]!);
      expect(stored).toMatchObject({
        title: "Hire the founding team",
        summary: "Accepting hires the first two agents and closes onboarding.",
      });
      // The decision record is untouched. This is the whole point of the route:
      // a card that already carries an outcome keeps it.
      expect(stored.status).toBe(status);
      expect(stored.result).toMatchObject({
        version: 1,
        outcome: status === "accepted" ? "accepted" : "issue_closed",
      });
      expect(stored.payload).toMatchObject({
        version: 1,
        prompt: "How should the company start?",
      });
    },
  );

  it("keeps the field a rewrite omits and clears the field set to null", async () => {
    const seeded = await seedClosedIssueWithEmptyCard("accepted");
    const svc = issueThreadInteractionService(db);

    await svc.updatePresentation(
      { id: seeded.issueId, companyId: seeded.companyId },
      seeded.interactionId,
      { title: "Only the title" },
    );
    const withTitle = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId))
      .then((rows) => rows[0]!);
    expect(withTitle.title).toBe("Only the title");
    expect(withTitle.summary).toBeNull();

    await svc.updatePresentation(
      { id: seeded.issueId, companyId: seeded.companyId },
      seeded.interactionId,
      { title: null },
    );
    const cleared = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId))
      .then((rows) => rows[0]!);
    expect(cleared.title).toBeNull();
  });

  it("refuses to write onto a card belonging to another issue", async () => {
    const seeded = await seedClosedIssueWithEmptyCard("accepted");
    const svc = issueThreadInteractionService(db);

    await expect(
      svc.updatePresentation(
        { id: randomUUID(), companyId: seeded.companyId },
        seeded.interactionId,
        { title: "Rewrite" },
      ),
    ).rejects.toMatchObject({ status: 404 });

    const stored = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId))
      .then((rows) => rows[0]!);
    expect(stored.title).toBeNull();
  });
});
