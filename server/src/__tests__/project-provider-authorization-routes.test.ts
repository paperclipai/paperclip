import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  projects,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  userSecretDefinitions,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("project provider authorization routes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-project-provider-auth-routes-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  }, 60_000);

  function boardActor(companyId: string, userId = "alice", role = "admin"): Express.Request["actor"] {
    return { type: "board", userId, source: "session", isInstanceAdmin: false,
      companyIds: [companyId], memberships: [{ companyId, membershipRole: role, status: "active" }] };
  }
  function agentActor(companyId: string): Express.Request["actor"] {
    return { type: "agent", companyId, agentId: randomUUID(), source: "agent_jwt" };
  }
  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", projectRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const [company, otherCompany] = await db.insert(companies).values([
      { id: companyId, name: `Company ${companyId}`, issuePrefix: companyId.slice(0, 8) },
      { id: otherCompanyId, name: `Other ${otherCompanyId}`, issuePrefix: otherCompanyId.slice(0, 8) },
    ]).returning();
    const [project, otherProject] = await db.insert(projects).values([
      { companyId, name: `Project ${companyId}` }, { companyId: otherCompanyId, name: `Other project ${otherCompanyId}` },
    ]).returning();
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: "alice", membershipRole: "admin", status: "active" },
      { companyId, principalType: "user", principalId: "viewer", membershipRole: "viewer", status: "active" },
      { companyId: otherCompanyId, principalType: "user", principalId: "alice", membershipRole: "admin", status: "active" },
    ]);

    const marker = randomUUID();
    const [application] = await db.insert(toolApplications).values({ companyId, name: `Azure ${marker}`, type: "rest_api",
      applicationKey: `azure-devops-${marker}` }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id,
      name: `Azure ${marker}`, uid: `azure-${marker}`, transport: "rest_api", authKind: "api_key", status: "active", enabled: true,
      credentialPolicy: "per_user", config: { sourceTemplateKey: "azure-devops", connectionMethodKey: "pat",
        url: "https://dev.azure.com", methodConfig: { organization: "contoso" } } }).returning();
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: connection.id, targetType: "company", targetId: companyId });
    const [definition] = await db.insert(userSecretDefinitions).values({ companyId, name: `Azure PAT ${marker}`, key: `azure-pat-${marker}` }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId, name: `Azure PAT ${marker}`, key: `azure-pat-${marker}`,
      scope: "user", ownerUserId: "alice", userSecretDefinitionId: definition.id }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId: connection.id, kind: "user", subjectUserId: "alice", status: "active",
      credentialSecretRefs: [{ secretId: secret.id, configPath: "credentials.authorization", versionSelector: "latest" }] }).returning();
    return { companyId: company.id, otherCompanyId: otherCompany.id, projectId: project.id, otherProjectId: otherProject.id, grantId: grant.id };
  }

  it("allows board reads and writes, and returns the selected grant without secret values", async () => {
    const input = await seed();
    const app = appFor(boardActor(input.companyId));
    const path = `/api/projects/${input.projectId}/git-authorizations/azure-devops/contoso`;

    const read = await request(app).get(path);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ provider: "azure-devops", scopeKey: "contoso", grantId: null });
    expect(read.body.options).toContainEqual({ grantId: input.grantId, connectionName: expect.any(String), organization: "contoso" });

    const write = await request(app).put(path).send({ grantId: input.grantId });
    expect(write.status).toBe(200);
    expect(write.body).toMatchObject({ grantId: input.grantId, authorizedByUserId: "alice" });
    expect(JSON.stringify(write.body)).not.toContain("Azure PAT");
  });

  it("rejects agent access for both read and write", async () => {
    const input = await seed();
    const app = appFor(agentActor(input.companyId));
    const path = `/api/projects/${input.projectId}/git-authorizations/azure-devops/contoso`;
    await request(app).get(path).expect(403);
    await request(app).put(path).send({ grantId: null }).expect(403);
  });

  it("keeps company and project isolation when reading or selecting a grant", async () => {
    const input = await seed();
    const app = appFor(boardActor(input.companyId));
    await request(app).get(`/api/projects/${input.otherProjectId}/git-authorizations/azure-devops/contoso`).expect(404);
    await request(app).put(`/api/projects/${input.projectId}/git-authorizations/azure-devops/contoso`)
      .send({ grantId: input.grantId }).expect(200);
    await request(app).put(`/api/projects/${input.projectId}/git-authorizations/azure-devops/fabrikam`)
      .send({ grantId: input.grantId }).expect(403);
  });

  it("enforces project write rights while allowing a viewer to read", async () => {
    const input = await seed();
    const app = appFor(boardActor(input.companyId, "viewer", "viewer"));
    await request(app).get(`/api/projects/${input.projectId}/git-authorizations/azure-devops/contoso`).expect(200);
    await request(app).put(`/api/projects/${input.projectId}/git-authorizations/azure-devops/contoso`)
      .send({ grantId: null }).expect(403);
  });

  it("rejects malformed write bodies and unsupported or invalid provider scopes", async () => {
    const input = await seed();
    const app = appFor(boardActor(input.companyId));
    const base = `/api/projects/${input.projectId}/git-authorizations`;
    await request(app).put(`${base}/azure-devops/contoso`).send({ grantId: "not-a-uuid" }).expect(400);
    await request(app).put(`${base}/azure-devops/contoso`).send({ grantId: null, extra: true }).expect(400);
    await request(app).get(`${base}/github/contoso`).expect(422);
    await request(app).get(`${base}/azure-devops/invalid%20scope`).expect(422);
  });
});
