import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clientProjects,
  clients,
  companies,
  createDb,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService } from "../services/projects.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("projectService linked clients", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof projectService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const companyId = randomUUID();
  const projectId = randomUUID();
  const activeClientId = randomUUID();
  const inactiveClientId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-projects-service-clients-");
    db = createDb(tempDb.connectionString);
    svc = projectService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Project Client Co",
      issuePrefix: "PCC",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Delivery Project",
      status: "in_progress",
    });
  }, 20_000);

  afterEach(async () => {
    await db.delete(clientProjects);
    await db.delete(clients);
  });

  afterAll(async () => {
    await db.delete(projects);
    await db.delete(companies);
    await tempDb?.cleanup();
  });

  it("includes only active linked clients on project detail and list payloads", async () => {
    await db.insert(clients).values([
      {
        id: activeClientId,
        companyId,
        name: "Acme",
        status: "active",
        metadata: { cnpj: "12.345.678/0001-00" },
      },
      {
        id: inactiveClientId,
        companyId,
        name: "Dormant",
        status: "inactive",
      },
    ]);

    await db.insert(clientProjects).values([
      {
        id: randomUUID(),
        companyId,
        clientId: activeClientId,
        projectId,
        status: "active",
        description: "Primary delivery contact",
        tags: ["react", "api"],
      },
      {
        id: randomUUID(),
        companyId,
        clientId: inactiveClientId,
        projectId,
        status: "active",
      },
    ]);

    const detail = await svc.getById(projectId);
    const list = await svc.list(companyId);

    expect(detail?.clients).toHaveLength(1);
    expect(detail?.clients[0]).toMatchObject({
      clientId: activeClientId,
      name: "Acme",
      relationshipDescription: "Primary delivery contact",
      relationshipTags: ["react", "api"],
    });

    expect(list[0]?.clients).toHaveLength(1);
    expect(list[0]?.clients[0]?.clientId).toBe(activeClientId);
  });
});
