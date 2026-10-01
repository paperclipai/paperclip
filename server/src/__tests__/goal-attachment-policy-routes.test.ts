import request from "supertest";
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { goalRoutes } from "../routes/goals.js";
import { issueService } from "../services/issues.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/**
 * TES-2386 / docs/ops/goal-attachment-policy.md. Server-side enforcement of a
 * company's own goal-attachment rule: a non-backlog issue needs a goalId or
 * the "no-goal" label. Gated on `companies.requireGoalAttachment` (default
 * false) because this is one company's board policy, not a platform default —
 * most companies on this instance have no G1-G6 goal system for the rule to
 * attach to.
 */
describeEmbeddedPostgres("goal-attachment policy enforcement", () => {
  const ctx = useEmbeddedPostgres("paperclip-goal-attachment-policy-");

  async function seed(requireGoalAttachment: boolean) {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Goal policy");
    if (requireGoalAttachment) {
      await ctx.db
        .update(companies)
        .set({ requireGoalAttachment: true })
        .where(eq(companies.id, company.companyId));
    }
    return company;
  }

  it("does not enforce anything for a company that has not opted in", async () => {
    const seeded = await seed(false);
    const app = routeApp(ctx.db, seeded.actor, issueRoutes, goalRoutes);

    await request(app)
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({ title: "todo with no goal, opted out", status: "todo", priority: "medium" })
      .expect(201);
  });

  it("rejects a non-backlog create with no goalId once the company opts in", async () => {
    const seeded = await seed(true);
    const app = routeApp(ctx.db, seeded.actor, issueRoutes, goalRoutes);

    const res = await request(app)
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({ title: "todo with no goal", status: "todo", priority: "medium" })
      .expect(422);

    expect(res.body.code).toBe("goal_required");
    expect(res.body.error).toContain("docs/ops/goal-attachment-policy.md");
  });

  it("still allows a goal-less create at backlog", async () => {
    const seeded = await seed(true);
    const app = routeApp(ctx.db, seeded.actor, issueRoutes, goalRoutes);

    await request(app)
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({ title: "backlog with no goal", status: "backlog", priority: "medium" })
      .expect(201);
  });

  it("allows a non-backlog create with an explicit goalId", async () => {
    const seeded = await seed(true);
    const app = routeApp(ctx.db, seeded.actor, issueRoutes, goalRoutes);
    const goal = await request(app)
      .post(`/api/companies/${seeded.companyId}/goals`)
      .send({ title: "G1 — test goal", status: "active" });
    expect([200, 201]).toContain(goal.status);

    await request(app)
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({ title: "todo with a goal", status: "todo", priority: "medium", goalId: goal.body.id })
      .expect(201);
  });

  it("allows a non-backlog create carrying the no-goal label", async () => {
    const seeded = await seed(true);
    const app = routeApp(ctx.db, seeded.actor, issueRoutes, goalRoutes);
    const label = await request(app)
      .post(`/api/companies/${seeded.companyId}/labels`)
      .send({ name: "no-goal", color: "#888888" })
      .expect(201);

    await request(app)
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({
        title: "todo with no-goal label",
        status: "todo",
        priority: "medium",
        labelIds: [label.body.id],
      })
      .expect(201);
  });

  it("rejects a backlog -> todo transition with no goalId", async () => {
    const seeded = await seed(true);
    const app = routeApp(ctx.db, seeded.actor, issueRoutes, goalRoutes);
    const created = await request(app)
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({ title: "backlog, then promoted", status: "backlog", priority: "medium" })
      .expect(201);

    const res = await request(app)
      .patch(`/api/issues/${created.body.id}`)
      .send({ status: "todo" })
      .expect(422);

    expect(res.body.code).toBe("goal_required");
  });

  it("allows a backlog -> todo transition that supplies a goalId in the same call", async () => {
    const seeded = await seed(true);
    const app = routeApp(ctx.db, seeded.actor, issueRoutes, goalRoutes);
    const goal = await request(app)
      .post(`/api/companies/${seeded.companyId}/goals`)
      .send({ title: "G1 — test goal", status: "active" });
    expect([200, 201]).toContain(goal.status);
    const created = await request(app)
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({ title: "backlog, then promoted with a goal", status: "backlog", priority: "medium" })
      .expect(201);

    await request(app)
      .patch(`/api/issues/${created.body.id}`)
      .send({ status: "todo", goalId: goal.body.id })
      .expect(200);
  });

  it("does not enforce the policy on a system-originated (non-manual) issue", async () => {
    const seeded = await seed(true);
    // System issue-creation paths (task-watchdogs.ts, pipeline automation, chat
    // channels) call the service directly with a non-"manual" originKind; the
    // public create route does not accept originKind from the request body, so
    // this exercises the same call shape those callers use.
    const created = await issueService(ctx.db).create(seeded.companyId, {
      title: "watchdog-created issue",
      status: "todo",
      priority: "medium",
      originKind: "task_watchdog",
    } as Parameters<ReturnType<typeof issueService>["create"]>[1]);

    expect(created?.id).toBeTruthy();
  });

  it("does not retroactively block an unrelated edit on an issue that already violates the policy", async () => {
    const seeded = await seed(true);
    const app = routeApp(ctx.db, seeded.actor, issueRoutes, goalRoutes);
    // Seeded directly, bypassing the create-time guard, to model a row that
    // predates this enforcement (the grandfathered case docs/ops/goal-attachment-policy.md
    // describes as "Open item").
    const [grandfathered] = await ctx.db
      .insert(issues)
      .values({
        companyId: seeded.companyId,
        issueNumber: 1,
        identifier: "GF-1",
        title: "Pre-existing violation",
        status: "todo",
        goalId: null,
      })
      .returning();

    await request(app)
      .patch(`/api/issues/${grandfathered.id}`)
      .send({ title: "Pre-existing violation, retitled" })
      .expect(200);
  });
});
