import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clients,
  clientProjects,
  companies,
  createDb,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { clientService } from "../services/clients.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres client service tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("clientService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof clientService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const companyId = randomUUID();
  const projectId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-clients-service-");
    db = createDb(tempDb.connectionString);
    svc = clientService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test Project",
      status: "active",
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

  it("creates a client", async () => {
    const client = await svc.create(companyId, {
      name: "Acme Corp",
      email: "acme@example.com",
      cnpj: "12.345.678/0001-00",
    });
    expect(client).toBeDefined();
    expect(client!.name).toBe("Acme Corp");
    expect(client!.email).toBe("acme@example.com");
    expect(client!.cnpj).toBe("12.345.678/0001-00");
    expect(client!.companyId).toBe(companyId);
    expect(client!.status).toBe("active");
  });

  it("lists clients ordered by name", async () => {
    await svc.create(companyId, { name: "Zeta Corp" });
    await svc.create(companyId, { name: "Alpha Inc" });

    const result = await svc.list(companyId);
    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.data[0]!.name).toBe("Alpha Inc");
    expect(result.data[1]!.name).toBe("Zeta Corp");
  });

  it("supports pagination with limit and offset", async () => {
    await svc.create(companyId, { name: "A Corp" });
    await svc.create(companyId, { name: "B Corp" });
    await svc.create(companyId, { name: "C Corp" });

    const page1 = await svc.list(companyId, { limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(3);
    expect(page1.data[0]!.name).toBe("A Corp");

    const page2 = await svc.list(companyId, { limit: 2, offset: 2 });
    expect(page2.data).toHaveLength(1);
    expect(page2.total).toBe(3);
    expect(page2.data[0]!.name).toBe("C Corp");
  });

  it("gets a client by id", async () => {
    const created = await svc.create(companyId, { name: "ById Corp" });
    const found = await svc.getById(created!.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("ById Corp");
  });

  it("returns null for nonexistent client", async () => {
    const found = await svc.getById(randomUUID());
    expect(found).toBeNull();
  });

  it("updates a client", async () => {
    const created = await svc.create(companyId, { name: "Old Name" });
    const updated = await svc.update(created!.id, { name: "New Name", email: "new@example.com" });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe("New Name");
    expect(updated!.email).toBe("new@example.com");
  });

  it("removes a client and cascades to client_projects", async () => {
    const client = await svc.create(companyId, { name: "To Delete" });
    await svc.createProject(companyId, {
      clientId: client!.id,
      projectId,
    });

    const projectsBefore = await svc.listProjects(client!.id);
    expect(projectsBefore).toHaveLength(1);

    await svc.remove(client!.id);

    const found = await svc.getById(client!.id);
    expect(found).toBeNull();

    const projectsAfter = await svc.listProjects(client!.id);
    expect(projectsAfter).toHaveLength(0);
  });

  it("creates and lists a client project with joined project name", async () => {
    const client = await svc.create(companyId, { name: "Link Test" });
    await svc.createProject(companyId, {
      clientId: client!.id,
      projectId,
      projectType: "consultoria",
      billingType: "monthly",
      amountCents: 50000,
      tags: ["python", "sql"],
    });

    const linked = await svc.listProjects(client!.id);
    expect(linked).toHaveLength(1);
    expect(linked[0]!.projectName).toBe("Test Project");
    expect(linked[0]!.projectType).toBe("consultoria");
    expect(linked[0]!.billingType).toBe("monthly");
    expect(linked[0]!.amountCents).toBe(50000);
    expect(linked[0]!.tags).toEqual(["python", "sql"]);
  });

  it("updates a client project", async () => {
    const client = await svc.create(companyId, { name: "Update Link" });
    const cp = await svc.createProject(companyId, {
      clientId: client!.id,
      projectId,
      billingType: "monthly",
    });

    const updated = await svc.updateProject(cp!.id, { billingType: "one_time", amountCents: 10000 });
    expect(updated).toBeDefined();
    expect(updated!.billingType).toBe("one_time");
    expect(updated!.amountCents).toBe(10000);
  });

  it("removes a client project", async () => {
    const client = await svc.create(companyId, { name: "Unlink Test" });
    const cp = await svc.createProject(companyId, {
      clientId: client!.id,
      projectId,
    });

    await svc.removeProject(cp!.id);
    const linked = await svc.listProjects(client!.id);
    expect(linked).toHaveLength(0);
  });
});
