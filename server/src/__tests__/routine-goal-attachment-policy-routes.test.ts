import request from "supertest";
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, routines } from "@paperclipai/db";
import { routineRoutes } from "../routes/routines.js";
import { goalRoutes } from "../routes/goals.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/**
 * TES-2492 / docs/ops/goal-attachment-policy.md. Sibling of
 * goal-attachment-policy-routes.test.ts (TES-2386), scoped to routines: an
 * *active* routine fires forever, so one created or activated with no
 * goalId mints an unattached closed issue on every run — invisible to both
 * the daily lint and the weekly sweep (TES-2467). Gated on the same
 * `companies.requireGoalAttachment` flag so both guards ship/flip together.
 * Paused/archived routines never fire, so they are exempt — mirrors the
 * issue-side guard letting "backlog" through.
 */
describeEmbeddedPostgres("routine goal-attachment policy enforcement", () => {
  const ctx = useEmbeddedPostgres("paperclip-routine-goal-attachment-policy-");

  async function seed(requireGoalAttachment: boolean) {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Routine goal policy");
    if (requireGoalAttachment) {
      await ctx.db
        .update(companies)
        .set({ requireGoalAttachment: true })
        .where(eq(companies.id, company.companyId));
    }
    const [agent] = await ctx.db
      .insert(agents)
      .values({
        companyId: company.companyId,
        name: "Routine Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    return { ...company, agentId: agent.id };
  }

  it("does not enforce anything for a company that has not opted in", async () => {
    const seeded = await seed(false);
    const app = routeApp(ctx.db, seeded.actor, routineRoutes, goalRoutes);

    await request(app)
      .post(`/api/companies/${seeded.companyId}/routines`)
      .send({ title: "active with no goal, opted out", status: "active", assigneeAgentId: seeded.agentId })
      .expect(201);
  });

  it("rejects an active create with no goalId once the company opts in", async () => {
    const seeded = await seed(true);
    const app = routeApp(ctx.db, seeded.actor, routineRoutes, goalRoutes);

    const res = await request(app)
      .post(`/api/companies/${seeded.companyId}/routines`)
      .send({ title: "active with no goal", status: "active", assigneeAgentId: seeded.agentId })
      .expect(422);

    expect(res.body.code).toBe("goal_required");
    expect(res.body.error).toContain("docs/ops/goal-attachment-policy.md");
  });

  it("still allows a goal-less create left paused", async () => {
    const seeded = await seed(true);
    const app = routeApp(ctx.db, seeded.actor, routineRoutes, goalRoutes);

    await request(app)
      .post(`/api/companies/${seeded.companyId}/routines`)
      .send({ title: "paused with no goal", status: "paused" })
      .expect(201);
  });

  it("still allows a goal-less create that is auto-downgraded to paused for lacking an assignee", async () => {
    const seeded = await seed(true);
    const app = routeApp(ctx.db, seeded.actor, routineRoutes, goalRoutes);

    const created = await request(app)
      .post(`/api/companies/${seeded.companyId}/routines`)
      .send({ title: "defaults to active, downgraded to paused" })
      .expect(201);

    expect(created.body.status).toBe("paused");
  });

  it("allows an active create with an explicit goalId", async () => {
    const seeded = await seed(true);
    const app = routeApp(ctx.db, seeded.actor, routineRoutes, goalRoutes);
    const goal = await request(app)
      .post(`/api/companies/${seeded.companyId}/goals`)
      .send({ title: "G1 — test goal", status: "active" });
    expect([200, 201]).toContain(goal.status);

    await request(app)
      .post(`/api/companies/${seeded.companyId}/routines`)
      .send({
        title: "active with a goal",
        status: "active",
        assigneeAgentId: seeded.agentId,
        goalId: goal.body.id,
      })
      .expect(201);
  });

  it("allows an active create carrying noGoal: true", async () => {
    const seeded = await seed(true);
    const app = routeApp(ctx.db, seeded.actor, routineRoutes, goalRoutes);

    await request(app)
      .post(`/api/companies/${seeded.companyId}/routines`)
      .send({
        title: "active, deliberately goal-less",
        status: "active",
        assigneeAgentId: seeded.agentId,
        noGoal: true,
      })
      .expect(201);
  });

  it("rejects a paused -> active transition with no goalId", async () => {
    const seeded = await seed(true);
    const app = routeApp(ctx.db, seeded.actor, routineRoutes, goalRoutes);
    const created = await request(app)
      .post(`/api/companies/${seeded.companyId}/routines`)
      .send({ title: "paused, then promoted", status: "paused", assigneeAgentId: seeded.agentId })
      .expect(201);

    const res = await request(app)
      .patch(`/api/routines/${created.body.id}`)
      .send({ status: "active" })
      .expect(422);

    expect(res.body.code).toBe("goal_required");
  });

  it("allows a paused -> active transition that supplies a goalId in the same call", async () => {
    const seeded = await seed(true);
    const app = routeApp(ctx.db, seeded.actor, routineRoutes, goalRoutes);
    const goal = await request(app)
      .post(`/api/companies/${seeded.companyId}/goals`)
      .send({ title: "G1 — test goal", status: "active" });
    expect([200, 201]).toContain(goal.status);
    const created = await request(app)
      .post(`/api/companies/${seeded.companyId}/routines`)
      .send({ title: "paused, then promoted with a goal", status: "paused", assigneeAgentId: seeded.agentId })
      .expect(201);

    await request(app)
      .patch(`/api/routines/${created.body.id}`)
      .send({ status: "active", goalId: goal.body.id })
      .expect(200);
  });

  it("does not retroactively block an unrelated edit on a routine that already violates the policy", async () => {
    const seeded = await seed(true);
    const app = routeApp(ctx.db, seeded.actor, routineRoutes, goalRoutes);
    // Seeded directly, bypassing the create-time guard, to model one of the
    // paused-owner holdouts TES-2467 found already active with goalId: null
    // before this enforcement existed.
    const [grandfathered] = await ctx.db
      .insert(routines)
      .values({
        companyId: seeded.companyId,
        title: "Pre-existing violation",
        assigneeAgentId: seeded.agentId,
        status: "active",
        goalId: null,
        responsibleUserId: seeded.userId,
      })
      .returning();

    await request(app)
      .patch(`/api/routines/${grandfathered.id}`)
      .send({ title: "Pre-existing violation, retitled" })
      .expect(200);
  });
});
