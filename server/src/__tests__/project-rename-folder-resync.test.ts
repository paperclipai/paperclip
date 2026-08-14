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
});
