import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, folders, projects as projectsTable } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService } from "../services/projects.js";
import { folderService } from "../services/folders.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project rename resync tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regression test for #11099: renaming a project left its system-managed
// skill folder (systemKey `project:<id>`) on the old name and slug forever.
describeEmbeddedPostgres("project rename resyncs its skill folder", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let prefixCounter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-rename-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(folders);
    await db.delete(projectsTable);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    prefixCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name: "Resync Co", issuePrefix: `RSC${prefixCounter}` })
      .returning();
    return company.id;
  }

  it("renames the project's skill folder's name and slug when the project is renamed", async () => {
    const companyId = await seedCompany();
    const projects = projectService(db);
    const folderSvc = folderService(db);

    const project = await projects.create(companyId, { name: "Example Project" });
    const folder = await folderSvc.ensureProjectFolder(companyId, project.id, project.name);
    expect(folder).toMatchObject({ name: "Example Project", slug: "example-project" });

    const renamed = await projects.update(project.id, { name: "Renamed Example" });
    expect(renamed?.name).toBe("Renamed Example");

    const resynced = await folderSvc.getFolder(companyId, folder.id);
    expect(resynced).toMatchObject({ name: "Renamed Example", slug: "renamed-example" });
  });

  it("resyncs the folder on the next ensureProjectFolder call even without an explicit rename call", async () => {
    const companyId = await seedCompany();
    const folderSvc = folderService(db);

    const folder = await folderSvc.ensureProjectFolder(companyId, "project-1", "Example Project");
    expect(folder).toMatchObject({ name: "Example Project", slug: "example-project" });

    const rescanned = await folderSvc.ensureProjectFolder(companyId, "project-1", "Renamed Example");
    expect(rescanned).toMatchObject({
      id: folder.id,
      name: "Renamed Example",
      slug: "renamed-example",
    });
  });

  it("does not create a folder for a project that never had one", async () => {
    const companyId = await seedCompany();
    const folderSvc = folderService(db);

    const result = await folderSvc.renameProjectFolder(companyId, "project-without-folder", "New Name");
    expect(result).toBeNull();
  });

  it("keeps a collision-resolved slug stable across repeated resyncs (#11365)", async () => {
    const companyId = await seedCompany();
    const folderSvc = folderService(db);

    const sibling = await folderSvc.ensureProjectFolder(companyId, "project-sibling", "Zeta");
    expect(sibling).toMatchObject({ name: "Zeta", slug: "zeta" });

    await folderSvc.ensureProjectFolder(companyId, "project-renamed", "Other Name");

    const firstResync = await folderSvc.renameProjectFolder(companyId, "project-renamed", "Zeta");
    expect(firstResync?.name).toBe("Zeta");
    expect(firstResync?.slug).not.toBe("zeta");
    expect(firstResync?.slug?.startsWith("zeta-")).toBe(true);

    const secondResync = await folderSvc.renameProjectFolder(companyId, "project-renamed", "Zeta");
    expect(secondResync?.slug).toBe(firstResync?.slug);

    const thirdResync = await folderSvc.renameProjectFolder(companyId, "project-renamed", "Zeta");
    expect(thirdResync?.slug).toBe(firstResync?.slug);
  });

  it("converges instead of drifting when two renamed projects both target the same slug", async () => {
    const companyId = await seedCompany();
    const folderSvc = folderService(db);

    await folderSvc.ensureProjectFolder(companyId, "project-a", "Alpha");
    await folderSvc.ensureProjectFolder(companyId, "project-b", "Beta");

    // Both projects are renamed to the same desired name, so one keeps the
    // clean slug and the other must resolve a stable, deterministic suffix.
    const firstA = await folderSvc.renameProjectFolder(companyId, "project-a", "Zeta");
    const firstB = await folderSvc.renameProjectFolder(companyId, "project-b", "Zeta");
    expect(firstA?.slug).toBe("zeta");
    expect(firstB?.slug).not.toBe("zeta");
    expect(firstB?.slug?.startsWith("zeta-")).toBe(true);

    // Repeated rescans, in either processing order, must not change either
    // project's resolved slug: no drift, no flip-flopping which project holds
    // the clean slug.
    for (let i = 0; i < 3; i += 1) {
      const rescanB = await folderSvc.renameProjectFolder(companyId, "project-b", "Zeta");
      const rescanA = await folderSvc.renameProjectFolder(companyId, "project-a", "Zeta");
      expect(rescanA?.slug).toBe(firstA?.slug);
      expect(rescanB?.slug).toBe(firstB?.slug);
    }
  });
});
