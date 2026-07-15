import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, goals, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake payload goal context tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("wake payload goal context", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-goal-context-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(description: string | null) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Goal Context Co",
      description,
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedIssue(companyId: string, goalId: string | null) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "GC-1",
      title: "Goal context issue",
      status: "todo",
      priority: "medium",
      goalId,
    });
    return issueId;
  }

  it("carries the goal ancestry chain (root → leaf) and company mission in the wake payload", async () => {
    const companyId = await seedCompany("Autonomous companies for PMEs.");
    const rootGoalId = randomUUID();
    const leafGoalId = randomUUID();
    await db.insert(goals).values([
      {
        id: rootGoalId,
        companyId,
        title: "Reach $1M ARR",
        level: "company",
        status: "active",
      },
      {
        id: leafGoalId,
        companyId,
        title: "Launch self-serve onboarding",
        description: "Reduce activation time from days to minutes.",
        level: "team",
        status: "active",
        parentId: rootGoalId,
      },
    ]);
    const issueId = await seedIssue(companyId, leafGoalId);

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    expect(payload?.goalContext).toEqual({
      company: {
        name: "Goal Context Co",
        description: "Autonomous companies for PMEs.",
      },
      goals: [
        expect.objectContaining({ id: rootGoalId, title: "Reach $1M ARR", level: "company" }),
        expect.objectContaining({
          id: leafGoalId,
          title: "Launch self-serve onboarding",
          description: "Reduce activation time from days to minutes.",
        }),
      ],
    });
  });

  it("still includes company context when the issue has no goal", async () => {
    const companyId = await seedCompany(null);
    const issueId = await seedIssue(companyId, null);

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    expect(payload?.goalContext).toEqual({
      company: { name: "Goal Context Co", description: null },
      goals: [],
    });
  });

  it("terminates on goal parent cycles instead of looping", async () => {
    const companyId = await seedCompany(null);
    const goalAId = randomUUID();
    const goalBId = randomUUID();
    await db.insert(goals).values([
      { id: goalAId, companyId, title: "Goal A", level: "team", status: "active" },
      { id: goalBId, companyId, title: "Goal B", level: "team", status: "active", parentId: goalAId },
    ]);
    // Close the cycle: A → B → A.
    await db.update(goals).set({ parentId: goalBId }).where(eq(goals.id, goalAId));
    const issueId = await seedIssue(companyId, goalAId);

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    const titles = payload?.goalContext?.goals.map((goal) => goal.title) ?? [];
    expect(titles).toContain("Goal A");
    expect(titles.length).toBeLessThanOrEqual(6);
  });
});
