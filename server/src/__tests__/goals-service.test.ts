import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, goals, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { GOAL_LINKED_ISSUES_PREVIEW_LIMIT, goalService } from "../services/goals.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres goal service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("goalService.getByIdWithLinkedIssues", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof goalService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-goals-service-");
    db = createDb(tempDb.connectionString);
    svc = goalService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns a capped linked issue preview with the total visible issue count", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Goal with many issues",
      level: "company",
      status: "active",
    });

    const visibleIssueCount = GOAL_LINKED_ISSUES_PREVIEW_LIMIT + 5;
    await db.insert(issues).values([
      ...Array.from({ length: visibleIssueCount }, (_, index) => ({
        id: randomUUID(),
        companyId,
        goalId,
        title: `Linked issue ${index + 1}`,
        status: "todo" as const,
        priority: "medium" as const,
        updatedAt: new Date(Date.UTC(2026, 4, 1, 12, index)),
      })),
      {
        id: randomUUID(),
        companyId,
        goalId,
        title: "Hidden linked issue",
        status: "todo",
        priority: "medium",
        hiddenAt: new Date("2026-05-01T00:00:00Z"),
      },
    ]);

    const goal = await svc.getByIdWithLinkedIssues(goalId);

    expect(goal?.linkedIssues).toHaveLength(GOAL_LINKED_ISSUES_PREVIEW_LIMIT);
    expect(goal?.linkedIssueIdentifiers).toHaveLength(GOAL_LINKED_ISSUES_PREVIEW_LIMIT);
    expect(goal?.linkedIssueCount).toBe(visibleIssueCount);
    expect(goal).not.toHaveProperty("recentIssues");
  });
});
