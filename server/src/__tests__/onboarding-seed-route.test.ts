import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companyOnboardingSeeds,
  goals,
  issues,
  projects,
} from "@paperclipai/db";
import { onboardingSeedRoutes } from "../routes/onboarding-seed.js";
import { logActivity } from "../services/activity-log.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

// Wrapped, not replaced: every other test here asserts the real activity row,
// so the default implementation stays the genuine one and a single test opts
// into failure with `mockRejectedValueOnce`.
vi.mock("../services/activity-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/activity-log.js")>();
  return { ...actual, logActivity: vi.fn(actual.logActivity) };
});

const SEED = {
  revision: "a".repeat(32),
  mission: "Make robotics boring enough to trust",
  agent: { name: "Ada", role: "Chief of Staff" },
  firstTask: { title: "Draft the one-page strategy", details: "One page, no more" },
};

describeEmbeddedPostgres("POST /api/companies/:companyId/onboarding-seed", () => {
  const ctx = useEmbeddedPostgres("onboarding-seed-route");

  afterEach(async () => {
    await ctx.db.delete(activityLog);
    await ctx.db.delete(companyOnboardingSeeds);
    await ctx.db.delete(issues);
    await ctx.db.delete(projects);
    await ctx.db.delete(agents);
    await ctx.db.delete(goals);
    await resetCompanyIssueFixtures(ctx.db);
  });

  async function seedCompany() {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Onboarding seed");
    return { ...seeded, app: routeApp(ctx.db, seeded.actor, onboardingSeedRoutes) };
  }

  function post(app: ReturnType<typeof routeApp>, companyId: string, body: unknown) {
    return request(app).post(`/api/companies/${companyId}/onboarding-seed`).send(body);
  }

  // Ordering, not eventual consistency: every assertion below reads the
  // database immediately after the 200 comes back, with no waiting and no
  // polling. A lazy receiver that applied the seed in the background would
  // fail here on any machine — which is the point, since Cloud gates the
  // redirect into the tenant dashboard on this response.
  it("applies the mission, the first agent and the first task before it answers", async () => {
    const { companyId, app } = await seedCompany();

    const response = await post(app, companyId, SEED);

    expect(response.status).toBe(200);
    expect(response.body.applied).toBe(true);
    expect(response.body.changed).toBe(true);
    expect(response.body.revision).toBe(SEED.revision);

    const companyGoals = await ctx.db.select().from(goals).where(eq(goals.companyId, companyId));
    expect(companyGoals).toHaveLength(1);
    expect(companyGoals[0]?.title).toBe(SEED.mission);
    expect(companyGoals[0]?.level).toBe("company");
    expect(companyGoals[0]?.status).toBe("active");

    const companyAgents = await ctx.db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(companyAgents).toHaveLength(1);
    expect(companyAgents[0]?.name).toBe("Ada");
    // The seed's free-text role is a job title; the structural role stays `ceo`.
    expect(companyAgents[0]?.title).toBe("Chief of Staff");
    expect(companyAgents[0]?.role).toBe("ceo");
    // A seeded CEO arrives with the core paperclip skills enabled. Skills only
    // reach an agent's runtime through its own desired set, and the default
    // CEO instructions assume this toolkit.
    expect(companyAgents[0]?.adapterConfig).toMatchObject({
      paperclipSkillSync: {
        desiredSkills: expect.arrayContaining([
          "paperclipai/paperclip/paperclip",
          "paperclipai/paperclip/paperclip-board",
          "paperclipai/paperclip/paperclip-converting-plans-to-tasks",
          "paperclipai/paperclip/paperclip-create-agent",
          "paperclipai/paperclip/para-memory-files",
        ]),
      },
    });

    const companyIssues = await ctx.db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(companyIssues).toHaveLength(1);
    expect(companyIssues[0]?.title).toBe(SEED.firstTask.title);
    expect(companyIssues[0]?.description).toBe(SEED.firstTask.details);
    expect(companyIssues[0]?.assigneeAgentId).toBe(companyAgents[0]?.id);
    expect(companyIssues[0]?.goalId).toBe(companyGoals[0]?.id);

    const companyProjects = await ctx.db.select().from(projects).where(eq(projects.companyId, companyId));
    expect(companyProjects).toHaveLength(1);
    expect(companyProjects[0]?.name).toBe("Onboarding");
    expect(companyIssues[0]?.projectId).toBe(companyProjects[0]?.id);

    const record = await ctx.db
      .select()
      .from(companyOnboardingSeeds)
      .where(eq(companyOnboardingSeeds.companyId, companyId));
    expect(record).toHaveLength(1);
    expect(record[0]?.revision).toBe(SEED.revision);
    expect(record[0]?.agentId).toBe(companyAgents[0]?.id);
    expect(record[0]?.issueId).toBe(companyIssues[0]?.id);
  });

  it("is idempotent per revision — a replay creates no second agent or task", async () => {
    const { companyId, app } = await seedCompany();

    const first = await post(app, companyId, SEED);
    expect(first.status).toBe(200);
    expect(first.body.changed).toBe(true);

    const replay = await post(app, companyId, SEED);
    expect(replay.status).toBe(200);
    expect(replay.body.applied).toBe(true);
    // The revision already matched, so nothing was re-applied.
    expect(replay.body.changed).toBe(false);
    expect(replay.body.agentId).toBe(first.body.agentId);
    expect(replay.body.issueId).toBe(first.body.issueId);

    expect(await ctx.db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(1);
    expect(await ctx.db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
    expect(await ctx.db.select().from(goals).where(eq(goals.companyId, companyId))).toHaveLength(1);
    expect(await ctx.db.select().from(projects).where(eq(projects.companyId, companyId))).toHaveLength(1);
  });

  it("updates in place when the customer edits their answers and the revision changes", async () => {
    const { companyId, app } = await seedCompany();

    const first = await post(app, companyId, SEED);
    expect(first.status).toBe(200);

    const revised = await post(app, companyId, {
      revision: "b".repeat(32),
      mission: "Make robotics dependable",
      agent: { name: "Grace", role: "Head of Ops" },
      firstTask: { title: "Draft the two-page strategy", details: "Two pages now" },
    });
    expect(revised.status).toBe(200);
    expect(revised.body.changed).toBe(true);
    expect(revised.body.agentId).toBe(first.body.agentId);
    expect(revised.body.issueId).toBe(first.body.issueId);

    const companyAgents = await ctx.db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(companyAgents).toHaveLength(1);
    expect(companyAgents[0]?.name).toBe("Grace");
    expect(companyAgents[0]?.title).toBe("Head of Ops");

    const companyIssues = await ctx.db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(companyIssues).toHaveLength(1);
    expect(companyIssues[0]?.title).toBe("Draft the two-page strategy");

    const companyGoals = await ctx.db.select().from(goals).where(eq(goals.companyId, companyId));
    expect(companyGoals).toHaveLength(1);
    expect(companyGoals[0]?.title).toBe("Make robotics dependable");
  });

  it("splits a multi-line mission into a goal title and description", async () => {
    const { companyId, app } = await seedCompany();

    const response = await post(app, companyId, {
      revision: "c".repeat(32),
      mission: "Make robotics boring\nBoring enough that hospitals buy it.",
    });

    expect(response.status).toBe(200);
    const companyGoals = await ctx.db.select().from(goals).where(eq(goals.companyId, companyId));
    expect(companyGoals[0]?.title).toBe("Make robotics boring");
    expect(companyGoals[0]?.description).toBe("Boring enough that hospitals buy it.");
    // No agent and no task were sent, so none were invented.
    expect(await ctx.db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
    expect(await ctx.db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
    expect(response.body.agentId).toBeNull();
    expect(response.body.issueId).toBeNull();
  });

  it("accepts a revision-only seed and records it", async () => {
    const { companyId, app } = await seedCompany();

    const response = await post(app, companyId, { revision: "d".repeat(32) });

    expect(response.status).toBe(200);
    expect(response.body.changed).toBe(true);
    const record = await ctx.db
      .select()
      .from(companyOnboardingSeeds)
      .where(eq(companyOnboardingSeeds.companyId, companyId));
    expect(record[0]?.revision).toBe("d".repeat(32));
    expect(record[0]?.mission).toBeNull();
  });

  it("logs the application once, and not again on a replay", async () => {
    const { companyId, app } = await seedCompany();

    await post(app, companyId, SEED);
    await post(app, companyId, SEED);

    const entries = await ctx.db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.onboarding_seed_applied"),
      ));
    expect(entries).toHaveLength(1);
  });

  it("rolls the whole seed back when the audit entry cannot be written", async () => {
    // The audit entry shares the seed's transaction, so a failure to write it
    // must leave nothing behind. The alternative — commit the seed and lose the
    // entry — is unrecoverable: Cloud stops retrying on a 2xx, and a later
    // replay reports `changed: false` and never logs, so the entry would be
    // permanently absent.
    const { companyId, app } = await seedCompany();

    // Injected at the module boundary, not on `ctx.db`: the audit write goes
    // through the transaction handle, so a spy on the outer connection would
    // never be reached and the test would pass for the wrong reason.
    vi.mocked(logActivity).mockRejectedValueOnce(new Error("activity log unavailable"));

    const failed = await post(app, companyId, SEED);
    expect(failed.status).toBeGreaterThanOrEqual(500);

    // Nothing committed: no seed record, so Cloud has no acknowledged revision
    // and keeps retrying, and no orphaned agent from the rolled-back attempt.
    expect(
      await ctx.db
        .select()
        .from(companyOnboardingSeeds)
        .where(eq(companyOnboardingSeeds.companyId, companyId)),
    ).toHaveLength(0);
    expect(await ctx.db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);

    // And the retry recovers completely — seed applied, entry present.
    await post(app, companyId, SEED).expect(200);
    expect(
      await ctx.db
        .select()
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "company.onboarding_seed_applied"),
        )),
    ).toHaveLength(1);
  });

  it("refuses a caller without access to the company", async () => {
    const { companyId } = await seedCompany();
    const strangerActor: BoardActor = {
      type: "board",
      source: "session",
      userId: `user-${randomUUID()}`,
      companyIds: [randomUUID()],
      memberships: [],
      isInstanceAdmin: false,
    };
    const strangerApp = routeApp(ctx.db, strangerActor, onboardingSeedRoutes);

    const response = await post(strangerApp, companyId, SEED);

    expect(response.status).toBe(403);
    expect(await ctx.db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
    expect(await ctx.db.select().from(companyOnboardingSeeds)).toHaveLength(0);
  });

  it("rejects a body missing the revision", async () => {
    const { companyId, app } = await seedCompany();

    const response = await post(app, companyId, { mission: "No revision here" });

    expect(response.status).toBe(400);
    expect(await ctx.db.select().from(companyOnboardingSeeds)).toHaveLength(0);
  });

  it("rejects seed fields past the bounds Cloud enforces before sending", async () => {
    const { companyId, app } = await seedCompany();

    const overlongMission = await post(app, companyId, {
      revision: "e".repeat(32),
      mission: "m".repeat(2001),
    });
    expect(overlongMission.status).toBe(400);

    const overlongAgentName = await post(app, companyId, {
      revision: "e".repeat(32),
      agent: { name: "n".repeat(81), role: "Chief of Staff" },
    });
    expect(overlongAgentName.status).toBe(400);

    const overlongTaskTitle = await post(app, companyId, {
      revision: "e".repeat(32),
      firstTask: { title: "t".repeat(201) },
    });
    expect(overlongTaskTitle.status).toBe(400);

    expect(await ctx.db.select().from(companyOnboardingSeeds)).toHaveLength(0);
  });

  it("never reads the seed from a trusted Cloud header", async () => {
    const { companyId, app } = await seedCompany();

    // The `x-paperclip-cloud-*` set is the trusted identity channel, derived
    // server-side. A mission planted there must be ignored entirely — only the
    // body is read.
    const response = await request(app)
      .post(`/api/companies/${companyId}/onboarding-seed`)
      .set("x-paperclip-cloud-mission", "Header-supplied mission")
      .set("x-paperclip-cloud-paperclip-company-name", "Header-supplied mission")
      .send({ revision: "f".repeat(32), mission: "Body-supplied mission" });

    expect(response.status).toBe(200);
    const companyGoals = await ctx.db.select().from(goals).where(eq(goals.companyId, companyId));
    expect(companyGoals[0]?.title).toBe("Body-supplied mission");
  });

  it("reuses an existing Onboarding project instead of creating a second one", async () => {
    const { companyId, app } = await seedCompany();
    await ctx.db.insert(projects).values({
      companyId,
      name: "Onboarding",
      status: "in_progress",
    });

    const response = await post(app, companyId, SEED);

    expect(response.status).toBe(200);
    const companyProjects = await ctx.db.select().from(projects).where(eq(projects.companyId, companyId));
    expect(companyProjects).toHaveLength(1);
    const companyIssues = await ctx.db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(companyIssues[0]?.projectId).toBe(companyProjects[0]?.id);
  });

  it("does not duplicate entities when two identical pushes race", async () => {
    const { companyId, app } = await seedCompany();

    // Cloud's reconcile runs off portfolio fetches that can overlap, so the
    // same revision can be pushed twice at once. The per-company advisory lock
    // must serialize them: without it both pass the revision check before
    // either writes the seed record and each creates a goal, an agent, a
    // project and a task.
    const [first, second] = await Promise.all([
      post(app, companyId, SEED),
      post(app, companyId, SEED),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(await ctx.db.select().from(goals).where(eq(goals.companyId, companyId))).toHaveLength(1);
    expect(await ctx.db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(1);
    expect(await ctx.db.select().from(projects).where(eq(projects.companyId, companyId))).toHaveLength(1);
    expect(await ctx.db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
    expect(await ctx.db.select().from(companyOnboardingSeeds)).toHaveLength(1);
  });

  it("refreshes a first task's assignee and goal when a later revision adds them", async () => {
    const { companyId, app } = await seedCompany();

    // First push seeds a task but no agent and no mission, so the issue is
    // created unassigned and goal-less.
    const taskOnly = await post(app, companyId, {
      revision: "1".repeat(32),
      firstTask: { title: "Draft the strategy" },
    });
    expect(taskOnly.status).toBe(200);

    const beforeIssue = (await ctx.db.select().from(issues).where(eq(issues.companyId, companyId)))[0];
    expect(beforeIssue?.assigneeAgentId).toBeNull();

    // A later revision supplies the mission and the agent. The existing task is
    // updated in place, and must pick up the newly-created assignee and goal
    // rather than reporting them on the seed record while the issue row stays
    // stale.
    const withAgent = await post(app, companyId, {
      revision: "2".repeat(32),
      mission: "Make robotics boring enough to trust",
      agent: { name: "Ada", role: "Chief of Staff" },
      firstTask: { title: "Draft the strategy" },
    });
    expect(withAgent.status).toBe(200);

    const companyIssues = await ctx.db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(companyIssues).toHaveLength(1);
    const companyAgents = await ctx.db.select().from(agents).where(eq(agents.companyId, companyId));
    const companyGoals = await ctx.db.select().from(goals).where(eq(goals.companyId, companyId));
    expect(companyIssues[0]?.assigneeAgentId).toBe(companyAgents[0]?.id);
    expect(companyIssues[0]?.goalId).toBe(companyGoals[0]?.id);
  });
});
