import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  departments,
  projectGoals,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService } from "../services/projects.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("projectService.list department filters", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof projectService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-projects-service-");
    db = createDb(tempDb.connectionString);
    svc = projectService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectGoals);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(departments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns only projects inside the allowed department scope", async () => {
    const companyId = randomUUID();
    const engineeringId = randomUUID();
    const financeId = randomUUID();
    const engineeringProjectId = randomUUID();
    const financeProjectId = randomUUID();
    const unscopedProjectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PRJ01",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(departments).values([
      { id: engineeringId, companyId, name: "Engineering", status: "active", sortOrder: 0 },
      { id: financeId, companyId, name: "Finance", status: "active", sortOrder: 1 },
    ]);

    await db.insert(projects).values([
      {
        id: engineeringProjectId,
        companyId,
        departmentId: engineeringId,
        name: "Engineering roadmap",
        status: "planned",
      },
      {
        id: financeProjectId,
        companyId,
        departmentId: financeId,
        name: "Finance close",
        status: "planned",
      },
      {
        id: unscopedProjectId,
        companyId,
        departmentId: null,
        name: "Company initiative",
        status: "planned",
      },
    ]);

    const scoped = await svc.list(companyId, { scopeDepartmentIds: [engineeringId] });
    const explicitDepartment = await svc.list(companyId, {
      scopeDepartmentIds: [engineeringId, financeId],
      departmentId: financeId,
    });

    expect(scoped.map((project) => project.id)).toEqual([engineeringProjectId]);
    expect(explicitDepartment.map((project) => project.id)).toEqual([financeProjectId]);
  });
});
