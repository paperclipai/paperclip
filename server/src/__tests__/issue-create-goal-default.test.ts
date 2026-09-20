import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { goals } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/**
 * TES-2147. Tesla Lock Sound's goal topology is one achieved company-level goal
 * (the legacy "Launch MVP") plus active goals created through the API, which
 * default to level "task". The company-level tier of getDefaultCompanyGoal
 * therefore saw only the achieved goal, and its status-blind fallback attached
 * it to every issue created without an explicit goalId.
 */
describeEmbeddedPostgres("issue create goal default", () => {
  // No per-test reset: every test seeds its own company, and every lookup under
  // test is company-scoped. Deleting goals between tests would fight the
  // issues -> goals foreign key for no isolation benefit.
  const ctx = useEmbeddedPostgres("paperclip-issue-create-goal-default-");

  async function seed() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Goal default");
    const achievedId = randomUUID();
    await ctx.db.insert(goals).values({
      id: achievedId,
      companyId: company.companyId,
      title: "Launch Tesla Lock Sound MVP",
      level: "company",
      status: "achieved",
      createdAt: new Date("2026-03-14"),
    });
    await ctx.db.insert(goals).values(
      ["G1 — Organic Discovery", "G4 — Platform Reliability", "G6 — Agent Ops"].map((title) => ({
        id: randomUUID(),
        companyId: company.companyId,
        title,
        level: "task",
        status: "active",
        createdAt: new Date("2026-04-22"),
      })),
    );
    return { ...company, achievedId };
  }

  it("leaves goalId null instead of attaching to the achieved legacy goal", async () => {
    const seeded = await seed();
    const app = routeApp(ctx.db, seeded.actor, issueRoutes);

    const created = await request(app)
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({ title: "Issue created with no goalId", priority: "medium" })
      .expect(201);

    expect(created.body.goalId ?? null).toBeNull();

    const fetched = await request(app)
      .get(`/api/issues/${created.body.id}`)
      .expect(200);

    expect(fetched.body.goalId ?? null).toBeNull();
    expect(fetched.body.goalId).not.toBe(seeded.achievedId);
  });

  it("still honours an explicitly supplied goalId", async () => {
    const seeded = await seed();
    const app = routeApp(ctx.db, seeded.actor, issueRoutes);
    const [activeGoal] = await ctx.db
      .select()
      .from(goals)
      .where(eq(goals.status, "active"));

    const created = await request(app)
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({ title: "Explicit goal", priority: "medium", goalId: activeGoal.id })
      .expect(201);

    expect(created.body.goalId).toBe(activeGoal.id);
  });
});
