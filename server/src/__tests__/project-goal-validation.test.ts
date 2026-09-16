import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  goals,
  projectGoals,
  projects as projectsTable,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.js";
import { projectService } from "../services/projects.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project goal validation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A project's goals must exist and belong to the same company. Before this
// validation, a nonexistent goal id died at the projects.goal_id foreign key
// as an opaque 500 (observed live 2026-09-03, retried four times by the
// caller), and a goal from another company linked silently — the foreign key
// proves existence, not ownership.
describeEmbeddedPostgres("project goal validation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let prefixCounter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-goal-validation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectGoals);
    await db.delete(projectsTable);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string): Promise<string> {
    prefixCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: `GV${prefixCounter}` })
      .returning();
    return company.id;
  }

  async function seedGoal(companyId: string, title: string): Promise<string> {
    const [goal] = await db
      .insert(goals)
      .values({ companyId, title, level: "task", status: "active" })
      .returning();
    return goal.id;
  }

  function expectUnprocessable(error: unknown, unknownGoalId: string) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(422);
    expect((error as Error).message).toContain(unknownGoalId);
  }

  it("creates and links a project to a goal of the same company", async () => {
    const companyId = await seedCompany("Valid Co");
    const goalId = await seedGoal(companyId, "Ship it");
    const projects = projectService(db);

    const created = await projects.create(companyId, { name: "Rocket", goalIds: [goalId] });
    expect(created.goalIds).toEqual([goalId]);
  });

  it("rejects a create whose goal id does not exist, before any insert", async () => {
    const companyId = await seedCompany("Missing Goal Co");
    const projects = projectService(db);
    const ghost = "db7da378-99a6-43ea-964f-000000000000";

    const failure = await projects
      .create(companyId, { name: "Rocket", goalIds: [ghost] })
      .then(() => null, (error: unknown) => error);
    expectUnprocessable(failure, ghost);

    const rows = await db.select({ id: projectsTable.id }).from(projectsTable);
    expect(rows).toHaveLength(0);
  });

  it("rejects the legacy single goalId field the same way", async () => {
    const companyId = await seedCompany("Legacy Field Co");
    const projects = projectService(db);
    const ghost = "db7da378-99a6-43ea-964f-111111111111";

    const failure = await projects
      .create(companyId, { name: "Rocket", goalId: ghost })
      .then(() => null, (error: unknown) => error);
    expectUnprocessable(failure, ghost);
  });

  it("rejects another company's goal on create — the FK only proves existence", async () => {
    const companyId = await seedCompany("Home Co");
    const otherCompanyId = await seedCompany("Other Co");
    const foreignGoalId = await seedGoal(otherCompanyId, "Not yours");
    const projects = projectService(db);

    const failure = await projects
      .create(companyId, { name: "Rocket", goalIds: [foreignGoalId] })
      .then(() => null, (error: unknown) => error);
    expectUnprocessable(failure, foreignGoalId);
  });

  it("ignores the legacy goalId when an explicit empty goalIds list wins resolution", async () => {
    // goalIds and goalId may arrive together; the resolved set (goalIds
    // first) is canonical for persistence too. Before this rule, an empty
    // list skipped validation while the raw legacy id was still written —
    // unvalidated, and unchecked for ownership.
    const companyId = await seedCompany("Conflicting Fields Co");
    const otherCompanyId = await seedCompany("Conflicting Other Co");
    const foreignGoalId = await seedGoal(otherCompanyId, "Should not link");
    const projects = projectService(db);

    const created = await projects.create(companyId, {
      name: "Rocket",
      goalIds: [],
      goalId: foreignGoalId,
    });
    expect(created.goalIds).toEqual([]);

    const [row] = await db
      .select({ goalId: projectsTable.goalId })
      .from(projectsTable)
      .where(eq(projectsTable.id, created.id));
    expect(row.goalId).toBeNull();
  });

  it("rejects an update to an unknown or foreign goal and leaves links unchanged", async () => {
    const companyId = await seedCompany("Update Co");
    const otherCompanyId = await seedCompany("Update Other Co");
    const goodGoalId = await seedGoal(companyId, "Good goal");
    const foreignGoalId = await seedGoal(otherCompanyId, "Foreign goal");
    const projects = projectService(db);

    const created = await projects.create(companyId, { name: "Rocket", goalIds: [goodGoalId] });

    const failure = await projects
      .update(created.id, { goalIds: [foreignGoalId] })
      .then(() => null, (error: unknown) => error);
    expectUnprocessable(failure, foreignGoalId);

    const fetched = await projects.getById(created.id);
    expect(fetched?.goalIds).toEqual([goodGoalId]);
  });
});
