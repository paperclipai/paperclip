import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRepositoryGrants,
  agents,
  companies,
  createDb,
  projectRepositories,
  projectWorkspaces,
  projects,
  repositories,
  repositoryConnections,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { repositoryRoutes } from "../routes/repositories.js";
import { repositoryAccessService } from "../services/repository-access.js";
import { repositoryProviderRegistry } from "../services/repository-connections.js";
import { FakeRepositoryProvider } from "../services/repository-providers/fake-provider.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "repository-admin",
    source: "session",
    isInstanceAdmin: true,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
  };
}

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, runId: null, source: "agent_jwt" };
}

function createApp(
  db: ReturnType<typeof createDb>,
  actor: Express.Request["actor"],
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", repositoryRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("repository connection flow (GitHub-style provider)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const unregisterProviders: Array<() => void> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-repo-flow-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (const unregister of unregisterProviders.splice(0).reverse()) unregister();
    await db.delete(activityLog);
    await db.delete(agentRepositoryGrants);
    await db.delete(projectRepositories);
    await db.delete(projectWorkspaces);
    await db.delete(repositories);
    await db.delete(repositoryConnections);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const company = await db.insert(companies).values({
      name: "Flow Company",
      issuePrefix: `FL${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    return company;
  }

  function registerFakeProvider(installationId = "inst-1") {
    const provider = new FakeRepositoryProvider({ provider: "fake", host: "fake.example.com", pageSize: 2 });
    provider.setInstallation({
      installationId,
      accountId: "acct-1",
      accountName: "acme",
      repositories: [
        { providerRepositoryId: "1", owner: "acme", name: "alpha" },
        { providerRepositoryId: "2", owner: "acme", name: "beta" },
        { providerRepositoryId: "3", owner: "acme", name: "gamma" },
      ],
    });
    unregisterProviders.push(repositoryProviderRegistry.register(provider.connector()));
    return { provider, installationId };
  }

  it("runs install -> callback -> discover -> import end to end", async () => {
    const company = await seedCompany();
    const { provider, installationId } = registerFakeProvider();
    const app = createApp(db, boardActor(company.id));

    const install = await request(app)
      .post(`/api/companies/${company.id}/repository-connections/fake/install`)
      .send({});
    expect(install.status).toBe(201);
    expect(install.body.installUrl).toContain("state=");
    const state = install.body.state as string;

    const callback = await request(app)
      .post(`/api/companies/${company.id}/repository-connections/fake/callback`)
      .send({ state, installationId });
    expect(callback.status).toBe(201);
    expect(callback.body.connection).toMatchObject({ provider: "fake", installationId, accountName: "acme" });
    expect(callback.body.repositories).toEqual([]);
    const connectionId = callback.body.connection.id as string;

    // Discovery is paginated and marks nothing imported yet.
    const page1 = await request(app).get(`/api/repository-connections/${connectionId}/discover?pageSize=2`);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).not.toBeNull();
    expect(page1.body.items.every((item: { imported: boolean }) => item.imported === false)).toBe(true);

    // Partial multi-select import: one valid id + one unknown id.
    const importResp = await request(app)
      .post(`/api/repository-connections/${connectionId}/import`)
      .send({ providerRepositoryIds: ["1", "does-not-exist"] });
    expect(importResp.status).toBe(201);
    expect(importResp.body.imported).toBe(1);
    expect(importResp.body.skipped).toEqual(["does-not-exist"]);
    const importedRepositoryId = importResp.body.repositories[0].id as string;

    // Import creates reusable repository objects only; no projects/grants/workspaces.
    expect(await db.select().from(projectRepositories)).toEqual([]);
    expect(await db.select().from(agentRepositoryGrants)).toEqual([]);
    expect(await db.select().from(projectWorkspaces)).toEqual([]);

    // Re-discovery now flags the imported repository.
    const rediscover = await request(app).get(`/api/repository-connections/${connectionId}/discover?query=alpha`);
    expect(rediscover.body.items).toHaveLength(1);
    expect(rediscover.body.items[0]).toMatchObject({ imported: true, importedRepositoryId });

    // Idempotent re-import does not duplicate.
    const reimport = await request(app)
      .post(`/api/repository-connections/${connectionId}/import`)
      .send({ providerRepositoryIds: ["1"] });
    expect(reimport.status).toBe(200);
    expect(reimport.body.imported).toBe(0);
    expect(reimport.body.repositories[0].id).toBe(importedRepositoryId);
    expect(await db.select().from(repositories)).toHaveLength(1);

    // A second installation sees the provider identity as already imported.
    // Importing it directly remains idempotent and must not move catalog
    // ownership to the new connection or over-report newly created rows.
    const secondInstallationId = "inst-2";
    provider.setInstallation({
      installationId: secondInstallationId,
      accountId: "acct-2",
      accountName: "acme-secondary",
      repositories: [{ providerRepositoryId: "1", owner: "acme", name: "alpha" }],
    });
    const secondInstall = await request(app)
      .post(`/api/companies/${company.id}/repository-connections/fake/install`)
      .send({});
    const secondCallback = await request(app)
      .post(`/api/companies/${company.id}/repository-connections/fake/callback`)
      .send({ state: secondInstall.body.state, installationId: secondInstallationId });
    const secondConnectionId = secondCallback.body.connection.id as string;

    const secondDiscovery = await request(app)
      .get(`/api/repository-connections/${secondConnectionId}/discover?query=alpha`);
    expect(secondDiscovery.body.items[0]).toMatchObject({
      imported: true,
      importedRepositoryId,
    });

    const secondImport = await request(app)
      .post(`/api/repository-connections/${secondConnectionId}/import`)
      .send({ providerRepositoryIds: ["1"] });
    expect(secondImport.status).toBe(200);
    expect(secondImport.body.imported).toBe(0);
    expect(secondImport.body.repositories[0].id).toBe(importedRepositoryId);
    expect(await db.select().from(repositories)).toEqual([
      expect.objectContaining({ id: importedRepositoryId, connectionId }),
    ]);
  });

  it("rejects a tampered callback state", async () => {
    const company = await seedCompany();
    const { installationId } = registerFakeProvider();
    const app = createApp(db, boardActor(company.id));
    const install = await request(app)
      .post(`/api/companies/${company.id}/repository-connections/fake/install`)
      .send({});
    const callback = await request(app)
      .post(`/api/companies/${company.id}/repository-connections/fake/callback`)
      .send({ state: `${install.body.state}tampered`, installationId });
    expect(callback.status).toBe(422);
  });

  it("returns 422 when the provider is not registered", async () => {
    const company = await seedCompany();
    const app = createApp(db, boardActor(company.id));
    const install = await request(app)
      .post(`/api/companies/${company.id}/repository-connections/github/install`)
      .send({});
    expect(install.status).toBe(422);
  });

  it("advertises only providers that are actually registered", async () => {
    const company = await seedCompany();
    const app = createApp(db, boardActor(company.id));

    const before = await request(app).get(`/api/companies/${company.id}/repository-providers`);
    expect(before.status).toBe(200);
    expect(before.body.providers).toEqual([]);

    registerFakeProvider();
    const during = await request(app).get(`/api/companies/${company.id}/repository-providers`);
    expect(during.body.providers).toHaveLength(1);
    expect(during.body.providers[0]).toMatchObject({
      provider: "fake",
      host: "fake.example.com",
      supportsDiscovery: true,
    });

    // Unregistering is what a plugin unload does; the capability listing must
    // follow immediately so core UI stops offering the provider.
    for (const unregister of unregisterProviders.splice(0).reverse()) unregister();
    const after = await request(app).get(`/api/companies/${company.id}/repository-providers`);
    expect(after.body.providers).toEqual([]);
  });

  async function importOneRepository(companyId: string) {
    const { installationId } = registerFakeProvider();
    const app = createApp(db, boardActor(companyId));
    const install = await request(app).post(`/api/companies/${companyId}/repository-connections/fake/install`).send({});
    const callback = await request(app)
      .post(`/api/companies/${companyId}/repository-connections/fake/callback`)
      .send({ state: install.body.state, installationId });
    const connectionId = callback.body.connection.id as string;
    const importResp = await request(app)
      .post(`/api/repository-connections/${connectionId}/import`)
      .send({ providerRepositoryIds: ["1"] });
    return { app, repositoryId: importResp.body.repositories[0].id as string };
  }

  it("authorizes clone-credential resolution through the effective-access resolver", async () => {
    const company = await seedCompany();
    const { app: boardApp, repositoryId } = await importOneRepository(company.id);

    // Board actor within the company is authorized.
    const boardResolve = await request(boardApp).post(`/api/repositories/${repositoryId}/clone-credential`).send({});
    expect(boardResolve.status).toBe(200);
    expect(boardResolve.body.authenticatedCloneUrl).toContain(boardResolve.body.token);
    expect(boardResolve.headers["cache-control"]).toBe("no-store");

    // The audit record must not contain the token.
    const auditRows = await db.select().from(activityLog);
    expect(JSON.stringify(auditRows)).not.toContain(boardResolve.body.token);
    expect(auditRows.some((row) => row.action === "repository.clone_credential_resolved")).toBe(true);

    const agent = await db.insert(agents).values({ companyId: company.id, name: "Runner", role: "engineer" })
      .returning().then((rows) => rows[0]!);

    // An agent without any access source is forbidden.
    const deniedApp = createApp(db, agentActor(company.id, agent.id));
    const denied = await request(deniedApp).post(`/api/repositories/${repositoryId}/clone-credential`).send({});
    expect(denied.status).toBe(403);

    // Granting a direct repository access authorizes the agent.
    await repositoryAccessService(db).grantAgentRepository({
      companyId: company.id,
      agentId: agent.id,
      repositoryId,
    });
    const allowed = await request(deniedApp).post(`/api/repositories/${repositoryId}/clone-credential`).send({});
    expect(allowed.status).toBe(200);
    expect(allowed.body.expiresAt).toBeTruthy();
  });
});
