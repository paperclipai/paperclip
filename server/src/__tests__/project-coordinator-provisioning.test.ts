import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { projectRoutes } from "../routes/projects.js";
import { errorHandler } from "../middleware/error-handler.js";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  companySecretBindings,
  companySecrets,
  createDb,
  heartbeatRuns,
  projects,
  type Db,
  type EmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.js";
import {
  PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV,
  isProjectCoordinatorAgentForProject,
  readProjectCoordinatorMetadata,
  projectCoordinatorService,
} from "../services/project-coordinators.js";
import { projectService } from "../services/projects.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project coordinator tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const originalTemplateAgentId = process.env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV];

describeEmbeddedPostgres("native project coordinator provisioning", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let companyCounter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-coordinator-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(() => {
    if (originalTemplateAgentId === undefined) {
      delete process.env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV];
    } else {
      process.env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV] = originalTemplateAgentId;
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    companyCounter += 1;
    return db
      .insert(companies)
      .values({ name, issuePrefix: `PC${companyCounter}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedProcessAgent(
    companyId: string,
    input: Partial<typeof agents.$inferInsert> = {},
  ) {
    return db
      .insert(agents)
      .values({
        companyId,
        name: input.name ?? "Astra template",
        role: input.role ?? "ceo",
        status: input.status ?? "idle",
        reportsTo: input.reportsTo ?? null,
        capabilities: input.capabilities ?? "Coordinate project work across the shared worker pool",
        adapterType: input.adapterType ?? "process",
        adapterConfig: input.adapterConfig ?? { command: "/usr/bin/env" },
        runtimeConfig: input.runtimeConfig ?? { heartbeat: { enabled: false, maxConcurrentRuns: 7 } },
        permissions: input.permissions ?? { canCreateAgents: false, canCreateSkills: true },
        lastHeartbeatAt: input.lastHeartbeatAt ?? null,
        spentMonthlyCents: input.spentMonthlyCents ?? 0,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", projectRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function boardFor(companyId: string): Express.Request["actor"] {
    return { type: "board", userId: "board-user", companyIds: [companyId], source: "session", isInstanceAdmin: false };
  }

  it("provisions exactly one identity through concurrent board requests", async () => {
    const company = await seedCompany("Concurrent route");
    const template = await seedProcessAgent(company.id);
    process.env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV] = template.id;
    const project = await projectService(db).create(company.id, { name: "Concurrent" });
    const app = appFor(boardFor(company.id));
    const results = await Promise.all([
      request(app).post(`/api/projects/${project.id}/coordinator`).expect(200),
      request(app).post(`/api/projects/${project.id}/coordinator`).expect(200),
    ]);
    expect(results[0].body.coordinator.id).toBe(results[1].body.coordinator.id);
    expect(results.filter((result) => result.body.created)).toHaveLength(1);
    const identities = await db.select().from(agents).where(eq(agents.companyId, company.id));
    expect(identities.filter((agent) => isProjectCoordinatorAgentForProject(agent.metadata, project.id))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id))).toEqual([]);
  });

  it("denies agent provisioning and hides projects from another company's board", async () => {
    const company = await seedCompany("Protected route");
    const otherCompany = await seedCompany("Other board");
    const template = await seedProcessAgent(company.id);
    process.env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV] = template.id;
    const project = await projectService(db).create(company.id, { name: "Protected" });
    const agentApp = appFor({ type: "agent", agentId: template.id, companyId: company.id, source: "agent_key" });
    await request(agentApp).post(`/api/projects/${project.id}/coordinator`).expect(403);
    await request(appFor(boardFor(otherCompany.id))).post(`/api/projects/${project.id}/coordinator`).expect(404);
    expect((await projectService(db).getById(project.id))?.leadAgentId).toBeNull();
    expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, company.id))).toEqual([{ id: template.id }]);
  });

  it("creates a coordinator and initial workspace through the ordinary project API without starting work", async () => {
    const company = await seedCompany("Project create route");
    const template = await seedProcessAgent(company.id);
    process.env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV] = template.id;
    const response = await request(appFor(boardFor(company.id)))
      .post(`/api/companies/${company.id}/projects`)
      .send({ name: "New delivery", workspace: { sourceType: "git_repo", repoUrl: "https://example.com/delivery.git" } })
      .expect(201);
    const project = await projectService(db).getById(response.body.id);
    const [lead] = await db.select().from(agents).where(eq(agents.id, project!.leadAgentId!));
    expect(isProjectCoordinatorAgentForProject(lead.metadata, project!.id)).toBe(true);
    expect(project!.primaryWorkspace?.repoUrl).toBe("https://example.com/delivery.git");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id))).toEqual([]);
  });

  it("atomically creates independent, scoped coordinators from raw template configuration", async () => {
    const company = await seedCompany("Coordinator Clone Co");
    const secret = await db
      .insert(companySecrets)
      .values({
        companyId: company.id,
        key: "SHARED_COORDINATOR_TOKEN",
        name: "Shared coordinator token",
      })
      .returning()
      .then((rows) => rows[0]!);
    const template = await seedProcessAgent(company.id, {
      title: "Project coordinator template",
      icon: "crown",
      status: "running",
      adapterConfig: {
        command: "/opt/astra/coordinator",
        args: ["--serve"],
        env: {
          SHARED_COORDINATOR_TOKEN: {
            type: "secret_ref",
            secretId: secret.id,
            version: "latest",
          },
          SAFE_MODE: { type: "plain", value: "true" },
        },
      },
      runtimeConfig: {
        heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 7 },
        nativeRunner: { mode: "native" },
      },
      permissions: { canCreateAgents: false, canCreateSkills: true, customPolicy: "template-only" },
      budgetMonthlyCents: 12_345,
      lastHeartbeatAt: new Date("2026-09-01T12:00:00.000Z"),
      spentMonthlyCents: 4200,
    });
    process.env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV] = template.id;

    const svc = projectService(db, {
      provisionProjectCoordinator: true,
      coordinatorActivityActor: { actorType: "user", actorId: "board-user" },
    });
    const first = await svc.create(company.id, {
      name: "Atlas",
      workspace: {
        sourceType: "git_repo",
        repoUrl: "https://example.com/atlas.git",
      },
    });
    const second = await svc.create(company.id, { name: "Borealis" });

    expect(first.leadAgentId).toBeTruthy();
    expect(second.leadAgentId).toBeTruthy();
    expect(first.leadAgentId).not.toBe(second.leadAgentId);
    expect(first.workspaces).toHaveLength(1);

    const coordinatorRows = await db.select().from(agents).where(eq(agents.companyId, company.id));
    const firstCoordinator = coordinatorRows.find((row) => row.id === first.leadAgentId)!;
    const secondCoordinator = coordinatorRows.find((row) => row.id === second.leadAgentId)!;
    expect(firstCoordinator.name).toBe("Astra - Atlas");
    expect(secondCoordinator.name).toBe("Astra - Borealis");
    expect(firstCoordinator).toMatchObject({
      role: template.role,
      reportsTo: template.reportsTo,
      adapterType: "process",
      status: "idle",
      lastHeartbeatAt: null,
      spentMonthlyCents: 0,
      permissions: template.permissions,
      metadata: {
        projectCoordinator: {
          projectId: first.id,
          templateAgentId: template.id,
        },
      },
    });
    expect(firstCoordinator.adapterConfig).toMatchObject({
      command: "/opt/astra/coordinator",
      args: ["--serve"],
      env: {
        SHARED_COORDINATOR_TOKEN: {
          type: "secret_ref",
          secretId: secret.id,
        },
        SAFE_MODE: { type: "plain", value: "true" },
        PAPERCLIP_COORDINATOR_PROJECT_ID: {
          type: "plain",
          value: first.id,
        },
      },
    });
    expect(firstCoordinator.runtimeConfig).toMatchObject({
      heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 },
      nativeRunner: { mode: "native" },
    });
    expect(isProjectCoordinatorAgentForProject(firstCoordinator.metadata, first.id)).toBe(true);
    expect(isProjectCoordinatorAgentForProject(firstCoordinator.metadata, second.id)).toBe(false);

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, company.id),
        eq(companySecretBindings.targetId, firstCoordinator.id),
      ));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ secretId: secret.id, configPath: "env.SHARED_COORDINATOR_TOKEN" });
    await expect(
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, firstCoordinator.id)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, firstCoordinator.id)),
    ).resolves.toHaveLength(0);

    const activities = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.companyId, company.id));
    expect(activities.some((entry) => entry.action === "agent.created")).toBe(true);
    expect(activities.some((entry) => entry.action === "project.coordinator_provisioned")).toBe(true);
    expect(JSON.stringify(activities)).not.toContain("/opt/astra/coordinator");
  });

  it("rolls the project and coordinator back together when the initial workspace is invalid", async () => {
    const company = await seedCompany("Coordinator Rollback Co");
    const template = await seedProcessAgent(company.id);
    process.env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV] = template.id;

    const failure = await projectService(db, { provisionProjectCoordinator: true })
      .create(company.id, {
        name: "Must Roll Back",
        workspace: { sourceType: "local_path" },
      })
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).status).toBe(422);
    await expect(db.select().from(projects).where(eq(projects.companyId, company.id))).resolves.toHaveLength(0);
    await expect(db.select().from(agents).where(eq(agents.companyId, company.id))).resolves.toHaveLength(1);
  });

  it("rolls back an inserted coordinator when final identity validation fails", async () => {
    const company = await seedCompany("Coordinator Identity Rollback Co");
    const template = await seedProcessAgent(company.id, { name: "Template" });
    await seedProcessAgent(company.id, {
      name: "Astra - Conflicted Project",
      role: "worker",
      reportsTo: template.id,
    });
    process.env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV] = template.id;

    const failure = await projectService(db, { provisionProjectCoordinator: true })
      .create(company.id, { name: "Conflicted Project" })
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).status).toBe(409);
    await expect(db.select().from(projects).where(eq(projects.companyId, company.id))).resolves.toHaveLength(0);
    const persistedAgents = await db.select().from(agents).where(eq(agents.companyId, company.id));
    expect(persistedAgents).toHaveLength(2);
    expect(
      persistedAgents.map((agent) => readProjectCoordinatorMetadata(agent.metadata)).filter(Boolean),
    ).toEqual([]);
  });

  it("fails closed on a foreign-company template without leaving a project or agent", async () => {
    const company = await seedCompany("Template Home Co");
    const otherCompany = await seedCompany("Template Foreign Co");
    const foreignTemplate = await seedProcessAgent(otherCompany.id);
    process.env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV] = foreignTemplate.id;

    const failure = await projectService(db, { provisionProjectCoordinator: true })
      .create(company.id, { name: "Rejected Project" })
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).status).toBe(422);
    await expect(db.select().from(projects).where(eq(projects.companyId, company.id))).resolves.toHaveLength(0);
    await expect(db.select().from(agents).where(eq(agents.companyId, company.id))).resolves.toHaveLength(0);
  });

  it("preserves an explicit custom lead even when the operator template setting is invalid", async () => {
    const company = await seedCompany("Explicit Lead Co");
    const customLead = await seedProcessAgent(company.id, { name: "Custom recovery lead" });
    process.env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV] = "not-a-guid";

    const created = await projectService(db, { provisionProjectCoordinator: true }).create(company.id, {
      name: "Recovery Project",
      leadAgentId: customLead.id,
    });

    expect(created.leadAgentId).toBe(customLead.id);
    const rows = await db.select().from(agents).where(eq(agents.companyId, company.id));
    expect(rows).toHaveLength(1);
  });

  it("leaves ordinary creation unchanged while the operator setting is disabled", async () => {
    const company = await seedCompany("Coordinator Disabled Co");
    delete process.env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV];

    const created = await projectService(db, { provisionProjectCoordinator: true })
      .create(company.id, { name: "Unmanaged Project" });

    expect(created.leadAgentId).toBeNull();
    await expect(db.select().from(agents).where(eq(agents.companyId, company.id))).resolves.toHaveLength(0);
  });

  it("serializes existing-project provisioning and replays the same coordinator identity", async () => {
    const company = await seedCompany("Coordinator Replay Co");
    const template = await seedProcessAgent(company.id);
    process.env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV] = template.id;
    const project = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Existing Project", leadAgentId: null })
      .returning()
      .then((rows) => rows[0]!);
    const svc = projectCoordinatorService(db);

    const results = await Promise.all([
      svc.provisionExistingProject({ projectId: project.id, companyId: company.id }),
      svc.provisionExistingProject({ projectId: project.id, companyId: company.id }),
    ]);
    const replay = await svc.provisionExistingProject({ projectId: project.id, companyId: company.id });

    expect(results[0]!.coordinator.id).toBe(results[1]!.coordinator.id);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(replay).toMatchObject({
      created: false,
      coordinator: { id: results[0]!.coordinator.id },
      project: { id: project.id, leadAgentId: results[0]!.coordinator.id },
      templateAgentId: template.id,
    });
    const coordinatorRows = (await db.select().from(agents).where(eq(agents.companyId, company.id)))
      .filter((row) => isProjectCoordinatorAgentForProject(row.metadata, project.id));
    expect(coordinatorRows).toHaveLength(1);
  });

  it("replaces the configured template identity used as an existing project's transitional lead", async () => {
    const company = await seedCompany("Coordinator Transitional Lead Co");
    const template = await seedProcessAgent(company.id);
    process.env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV] = template.id;
    const project = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Transitional Lead Project", leadAgentId: template.id })
      .returning()
      .then((rows) => rows[0]!);

    const result = await projectCoordinatorService(db).provisionExistingProject({
      projectId: project.id,
      companyId: company.id,
    });

    expect(result.created).toBe(true);
    expect(result.project.leadAgentId).toBe(result.coordinator.id);
    expect(result.coordinator.id).not.toBe(template.id);
  });

  it("rejects replacement of a different existing lead", async () => {
    const company = await seedCompany("Coordinator Lead Conflict Co");
    const template = await seedProcessAgent(company.id, { name: "Template" });
    const customLead = await seedProcessAgent(company.id, { name: "Purpose-built lead" });
    process.env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV] = template.id;
    const project = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Protected Project", leadAgentId: customLead.id })
      .returning()
      .then((rows) => rows[0]!);

    const failure = await projectCoordinatorService(db)
      .provisionExistingProject({ projectId: project.id, companyId: company.id })
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).status).toBe(409);
    const persisted = await db
      .select({ leadAgentId: projects.leadAgentId })
      .from(projects)
      .where(eq(projects.id, project.id))
      .then((rows) => rows[0]!);
    expect(persisted.leadAgentId).toBe(customLead.id);
    const coordinatorRows = (await db.select().from(agents).where(eq(agents.companyId, company.id)))
      .filter((row) => isProjectCoordinatorAgentForProject(row.metadata, project.id));
    expect(coordinatorRows).toHaveLength(0);
  });
});
