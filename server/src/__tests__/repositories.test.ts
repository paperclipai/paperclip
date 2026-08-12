import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
  LOW_TRUST_REVIEW_PRESET,
  createProjectSchema,
  createProjectWorkspaceSchema,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { repositoryRoutes } from "../routes/repositories.js";
import { projectService } from "../services/projects.js";
import {
  authorizeRepositoryCloneCredentialRequest,
  repositoryAccessService,
} from "../services/repository-access.js";
import {
  repositoryConnectionService,
  repositoryProviderRegistry,
  type RepositoryProviderAdapter,
} from "../services/repository-connections.js";
import {
  normalizeRepositoryLocator,
  sanitizeRepositoryProviderError,
  sanitizeRepositoryProviderMetadata,
} from "../services/repository-normalization.js";
import { repositoryService, toRepositoryContext } from "../services/repositories.js";

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

function createApp(
  db: ReturnType<typeof createDb>,
  companyId: string,
  actor: Express.Request["actor"] = boardActor(companyId),
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

describe("repository normalization", () => {
  it("normalizes common remotes and rejects credential-bearing URLs", () => {
    expect(normalizeRepositoryLocator("git@GitHub.com:PaperclipAI/Paperclip.git")).toMatchObject({
      host: "github.com",
      owner: "PaperclipAI",
      name: "Paperclip",
      webUrl: "https://github.com/PaperclipAI/Paperclip",
    });
    expect(normalizeRepositoryLocator("ssh://git@GitHub.com/PaperclipAI/Paperclip.git")).toMatchObject({
      cloneUrl: "ssh://git@github.com/PaperclipAI/Paperclip.git",
      host: "github.com",
    });
    expect(() => normalizeRepositoryLocator("https://user:secret@github.com/acme/repo.git"))
      .toThrow("must not contain embedded credentials");
    expect(() => normalizeRepositoryLocator("https://github.com/acme/repo.git?token=secret"))
      .toThrow("must not contain query parameters");
  });

  it("removes sensitive provider metadata recursively", () => {
    expect(sanitizeRepositoryProviderMetadata({
      account: { login: "acme", accessToken: "secret" },
      private_key: "secret",
      installationId: "123",
    })).toEqual({ account: { login: "acme" }, installationId: "123" });
    expect(sanitizeRepositoryProviderError("Authorization: Bearer super-secret"))
      .toBe("Authorization: [redacted]");
  });

  it("omits credential-bearing legacy locators from agent context", () => {
    expect(toRepositoryContext({
      id: "legacy-repository",
      provider: "manual",
      host: "github.com",
      owner: "acme",
      name: "legacy",
      state: "active",
      unavailableReason: null,
      cloneUrl: "https://user:secret@github.com/acme/legacy.git",
      webUrl: "https://user:secret@github.com/acme/legacy",
      defaultBranch: "main",
    })).toMatchObject({ cloneUrl: null, webUrl: null });
  });

  it("accepts repository ids as project hints and repository-backed workspace inputs", () => {
    const repositoryId = randomUUID();
    expect(createProjectSchema.safeParse({ name: "Cross-repo", repositoryIds: [repositoryId] }).success)
      .toBe(true);
    expect(createProjectWorkspaceSchema.safeParse({ repositoryId }).success).toBe(true);
  });
});

describeEmbeddedPostgres("repository services and routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const unregisterProviders: Array<() => void> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-repositories-");
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
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyA = await db.insert(companies).values({
      name: "Repository Company A",
      issuePrefix: `RA${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const companyB = await db.insert(companies).values({
      name: "Repository Company B",
      issuePrefix: `RB${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const [projectOne, projectTwo, foreignProject] = await db.insert(projects).values([
      { companyId: companyA.id, name: "One" },
      { companyId: companyA.id, name: "Two" },
      { companyId: companyB.id, name: "Foreign" },
    ]).returning();
    const [agent, foreignAgent] = await db.insert(agents).values([
      { companyId: companyA.id, name: "Agent A", role: "engineer" },
      { companyId: companyB.id, name: "Agent B", role: "engineer" },
    ]).returning();
    const companyARepositories = repositoryService(db);
    const repository = (await companyARepositories.createManual(companyA.id, {
      cloneUrl: "https://github.com/acme/shared.git",
      visibility: "private",
    })).repository;
    const foreignRepository = (await companyARepositories.createManual(companyB.id, {
      cloneUrl: "https://github.com/acme/shared.git",
      visibility: "private",
    })).repository;
    return {
      companyA,
      companyB,
      projectOne: projectOne!,
      projectTwo: projectTwo!,
      foreignProject: foreignProject!,
      agent: agent!,
      foreignAgent: foreignAgent!,
      repository,
      foreignRepository,
    };
  }

  it("unions direct and authoritative project sources and removes only the requested source", async () => {
    const seeded = await seed();
    const access = repositoryAccessService(db);
    expect(await access.listEffectiveRepositories({
      companyId: seeded.companyA.id,
      agentId: seeded.agent.id,
      canAccessProject: async () => true,
    })).toEqual([]);

    const firstAttach = await access.attachProjectRepository({
      companyId: seeded.companyA.id,
      projectId: seeded.projectOne.id,
      repositoryId: seeded.repository.id,
      displayOrder: 0,
    });
    const duplicateAttach = await access.attachProjectRepository({
      companyId: seeded.companyA.id,
      projectId: seeded.projectOne.id,
      repositoryId: seeded.repository.id,
      displayOrder: 0,
    });
    await access.attachProjectRepository({
      companyId: seeded.companyA.id,
      projectId: seeded.projectTwo.id,
      repositoryId: seeded.repository.id,
      displayOrder: 1,
    });
    const firstGrant = await access.grantAgentRepository({
      companyId: seeded.companyA.id,
      agentId: seeded.agent.id,
      repositoryId: seeded.repository.id,
    });
    const duplicateGrant = await access.grantAgentRepository({
      companyId: seeded.companyA.id,
      agentId: seeded.agent.id,
      repositoryId: seeded.repository.id,
    });
    expect(firstAttach?.created).toBe(true);
    expect(duplicateAttach?.created).toBe(false);
    expect(firstGrant?.created).toBe(true);
    expect(duplicateGrant?.created).toBe(false);
    expect(await db.select().from(projectWorkspaces)).toEqual([]);

    const authorizedProjectIds: string[] = [];
    const onlyProjectOne = await access.listEffectiveRepositories({
      companyId: seeded.companyA.id,
      agentId: seeded.agent.id,
      canAccessProject: async (project) => {
        authorizedProjectIds.push(project.id);
        return project.id === seeded.projectOne.id;
      },
    });
    expect(authorizedProjectIds.sort()).toEqual([seeded.projectOne.id, seeded.projectTwo.id].sort());
    expect(onlyProjectOne).toHaveLength(1);
    expect(onlyProjectOne?.[0]).toMatchObject({
      repository: { id: seeded.repository.id },
      sources: { direct: true, projects: [{ id: seeded.projectOne.id, name: "One" }] },
    });

    await access.detachProjectRepository(seeded.companyA.id, seeded.projectOne.id, seeded.repository.id);
    await access.revokeAgentRepository(seeded.companyA.id, seeded.agent.id, seeded.repository.id);
    const lastProjectSource = await access.listEffectiveRepositories({
      companyId: seeded.companyA.id,
      agentId: seeded.agent.id,
      canAccessProject: async () => true,
    });
    expect(lastProjectSource?.[0]).toMatchObject({
      sources: { direct: false, projects: [{ id: seeded.projectTwo.id, name: "Two" }] },
    });

    await access.detachProjectRepository(seeded.companyA.id, seeded.projectTwo.id, seeded.repository.id);
    expect(await access.listEffectiveRepositories({
      companyId: seeded.companyA.id,
      agentId: seeded.agent.id,
      canAccessProject: async () => true,
    })).toEqual([]);
  });

  it("re-authorizes clone credential requests after access is revoked", async () => {
    const seeded = await seed();
    const access = repositoryAccessService(db);
    await access.grantAgentRepository({
      companyId: seeded.companyA.id,
      agentId: seeded.agent.id,
      repositoryId: seeded.repository.id,
    });
    expect(await authorizeRepositoryCloneCredentialRequest(db, {
      companyId: seeded.companyA.id,
      agentId: seeded.agent.id,
      repositoryId: seeded.repository.id,
      canAccessProject: async () => true,
    })).toMatchObject({ repository: { id: seeded.repository.id } });

    await access.revokeAgentRepository(seeded.companyA.id, seeded.agent.id, seeded.repository.id);
    expect(await authorizeRepositoryCloneCredentialRequest(db, {
      companyId: seeded.companyA.id,
      agentId: seeded.agent.id,
      repositoryId: seeded.repository.id,
      canAccessProject: async () => true,
    })).toBeNull();
  });

  it("uses the authoritative project resolver for effective-access routes", async () => {
    const seeded = await seed();
    await repositoryAccessService(db).attachProjectRepository({
      companyId: seeded.companyA.id,
      projectId: seeded.projectOne.id,
      repositoryId: seeded.repository.id,
      displayOrder: 0,
    });
    const otherRepository = (await repositoryService(db).createManual(seeded.companyA.id, {
      cloneUrl: "https://github.com/acme/denied.git",
      visibility: "private",
    })).repository;
    await repositoryAccessService(db).attachProjectRepository({
      companyId: seeded.companyA.id,
      projectId: seeded.projectTwo.id,
      repositoryId: otherRepository.id,
      displayOrder: 0,
    });
    await db.update(agents).set({
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            projectIds: [seeded.projectOne.id],
          },
        },
      },
    }).where(eq(agents.id, seeded.agent.id));

    const app = createApp(db, seeded.companyA.id, {
      type: "agent",
      agentId: seeded.agent.id,
      companyId: seeded.companyA.id,
      source: "agent_key",
    });
    const response = await request(app)
      .get(`/api/agents/${seeded.agent.id}/repositories?effective=true`);
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      repository: { id: seeded.repository.id },
      sources: { projects: [{ id: seeded.projectOne.id }] },
    });
  });

  it("updates project repository hints atomically without rewriting retained attribution", async () => {
    const seeded = await seed();
    const service = projectService(db);
    const secondRepository = (await repositoryService(db).createManual(seeded.companyA.id, {
      cloneUrl: "https://github.com/acme/second.git",
      visibility: "private",
    })).repository;
    const project = await service.create(seeded.companyA.id, {
      name: "Transactional hints",
      repositoryIds: [seeded.repository.id, secondRepository.id, seeded.repository.id],
      repositoryAttribution: { createdByUserId: "creator" },
    });
    expect(project.repositoryHints.map((repository) => repository.id)).toEqual([
      seeded.repository.id,
      secondRepository.id,
    ]);
    const initialLinks = await db
      .select()
      .from(projectRepositories)
      .where(eq(projectRepositories.projectId, project.id));
    expect(initialLinks).toHaveLength(2);
    const firstLink = initialLinks.find((link) => link.repositoryId === seeded.repository.id)!;

    await service.update(project.id, {
      repositoryIds: [secondRepository.id, seeded.repository.id],
      repositoryAttribution: { createdByUserId: "updater" },
    });
    const reorderedLinks = await db
      .select()
      .from(projectRepositories)
      .where(eq(projectRepositories.projectId, project.id));
    expect(reorderedLinks.find((link) => link.repositoryId === seeded.repository.id)).toMatchObject({
      id: firstLink.id,
      displayOrder: 1,
      createdByUserId: "creator",
    });

    await expect(service.update(project.id, {
      name: "Must roll back",
      repositoryIds: [seeded.foreignRepository.id],
    })).rejects.toMatchObject({ status: 422 });
    expect(await service.getById(project.id)).toMatchObject({ name: "Transactional hints" });
    expect(await repositoryAccessService(db).listProjectRepositories(seeded.companyA.id, project.id))
      .toHaveLength(2);
  });

  it("returns source-aware project hints and agent grants for repository detail", async () => {
    const seeded = await seed();
    const access = repositoryAccessService(db);
    await access.attachProjectRepository({
      companyId: seeded.companyA.id,
      projectId: seeded.projectOne.id,
      repositoryId: seeded.repository.id,
      displayOrder: 0,
    });
    await access.grantAgentRepository({
      companyId: seeded.companyA.id,
      agentId: seeded.agent.id,
      repositoryId: seeded.repository.id,
    });

    const response = await request(createApp(db, seeded.companyA.id))
      .get(`/api/repositories/${seeded.repository.id}/relationships`);
    expect(response.status).toBe(200);
    expect(response.body.projects).toEqual([
      { id: seeded.projectOne.id, name: "One", displayOrder: 0 },
    ]);
    expect(response.body.agents).toEqual([
      expect.objectContaining({
        id: seeded.agent.id,
        sources: {
          direct: true,
          projects: [{ id: seeded.projectOne.id, name: "One" }],
        },
      }),
    ]);
  });

  it("fails closed for cross-company UUIDs and archived repositories", async () => {
    const seeded = await seed();
    const access = repositoryAccessService(db);
    expect(await access.attachProjectRepository({
      companyId: seeded.companyA.id,
      projectId: seeded.projectOne.id,
      repositoryId: seeded.foreignRepository.id,
      displayOrder: 0,
    })).toBeNull();
    expect(await access.grantAgentRepository({
      companyId: seeded.companyA.id,
      agentId: seeded.agent.id,
      repositoryId: seeded.foreignRepository.id,
    })).toBeNull();

    await repositoryService(db).archive(seeded.companyA.id, seeded.repository.id);
    await expect(access.attachProjectRepository({
      companyId: seeded.companyA.id,
      projectId: seeded.projectOne.id,
      repositoryId: seeded.repository.id,
      displayOrder: 0,
    })).rejects.toMatchObject({ status: 409 });

    const app = createApp(db, seeded.companyA.id);
    const response = await request(app)
      .put(`/api/projects/${seeded.projectOne.id}/repositories/${seeded.foreignRepository.id}`)
      .send({ displayOrder: 0 });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Repository not found" });

    const [connection] = await db.insert(repositoryConnections).values({
      companyId: seeded.companyA.id,
      provider: "test_provider",
      host: "git.example.com",
    }).returning();
    const { repository: providerRepository } = await repositoryService(db).upsertProviderRepository(
      seeded.companyA.id,
      connection!.id,
      "test_provider",
      {
        providerRepositoryId: "provider-repo-archived",
        cloneUrl: "https://git.example.com/acme/archived.git",
      },
    );
    await repositoryService(db).archive(seeded.companyA.id, providerRepository.id);
    await repositoryService(db).upsertProviderRepository(
      seeded.companyA.id,
      connection!.id,
      "test_provider",
      {
        providerRepositoryId: "provider-repo-archived",
        cloneUrl: "https://git.example.com/acme/archived-renamed.git",
      },
    );
    expect(await repositoryService(db).getById(providerRepository.id)).toMatchObject({
      state: "archived",
      name: "archived-renamed",
    });
  });

  it("keeps repository-backed workspace compatibility without changing the primary checkout", async () => {
    const seeded = await seed();
    const projectsService = projectService(db);
    const repositoryWorkspace = await projectsService.createWorkspace(seeded.projectOne.id, {
      name: "Repository checkout",
      sourceType: "git_repo",
      repositoryId: seeded.repository.id,
    });
    expect(repositoryWorkspace).toMatchObject({
      repositoryId: seeded.repository.id,
      repoUrl: "https://github.com/acme/shared.git",
      isPrimary: true,
    });
    const localWorkspace = await projectsService.createWorkspace(seeded.projectOne.id, {
      name: "Local primary",
      sourceType: "local_path",
      cwd: "/workspace/local-primary",
      isPrimary: true,
    });
    expect(localWorkspace?.isPrimary).toBe(true);

    await repositoryAccessService(db).attachProjectRepository({
      companyId: seeded.companyA.id,
      projectId: seeded.projectOne.id,
      repositoryId: seeded.repository.id,
      displayOrder: 0,
    });
    const afterHint = await projectsService.getById(seeded.projectOne.id);
    expect(afterHint?.primaryWorkspace?.id).toBe(localWorkspace?.id);
    expect(afterHint?.workspaces).toHaveLength(2);

    await repositoryService(db).update(seeded.companyA.id, seeded.repository.id, {
      cloneUrl: "https://github.com/acme/renamed.git",
    });
    const refreshed = await projectsService.listWorkspaces(seeded.projectOne.id);
    expect(refreshed.find((workspace) => workspace.id === repositoryWorkspace?.id)).toMatchObject({
      repositoryId: seeded.repository.id,
      repoUrl: "https://github.com/acme/renamed.git",
    });
    expect(refreshed.find((workspace) => workspace.id === localWorkspace?.id)?.isPrimary).toBe(true);

    await repositoryService(db).archive(seeded.companyA.id, seeded.repository.id);
    expect(await projectsService.updateWorkspace(seeded.projectOne.id, repositoryWorkspace!.id, {
      name: "Archived repository checkout",
    })).toMatchObject({
      repositoryId: seeded.repository.id,
      name: "Archived repository checkout",
    });
  });

  it("keeps repositories and relationships stable across sync/disconnect failures", async () => {
    const seeded = await seed();
    const provider: RepositoryProviderAdapter = {
      provider: "test_provider",
      sync: async () => ({
        cursor: "cursor-1",
        repositories: [
          {
            providerRepositoryId: "provider-repo-1",
            cloneUrl: "https://git.example.com/acme/provider-repo-renamed.git",
            visibility: "private",
          },
          {
            providerRepositoryId: "provider-repo-not-imported",
            cloneUrl: "https://git.example.com/acme/not-imported.git",
            visibility: "private",
          },
        ],
      }),
      disconnect: async () => {},
    };
    unregisterProviders.push(repositoryProviderRegistry.register(provider));
    const connections = repositoryConnectionService(db);
    const created = await connections.create(seeded.companyA.id, {
      provider: "test_provider",
      host: "git.example.com",
      installationId: "installation-1",
      accountId: "account-1",
      accountName: "Acme",
    });
    const duplicate = await connections.create(seeded.companyA.id, {
      provider: "test_provider",
      host: "git.example.com",
      installationId: "installation-1",
      accountId: "account-1",
      accountName: "Acme",
    });
    expect(created.created).toBe(true);
    expect(duplicate.created).toBe(false);

    const { repository: providerRepository } = await repositoryService(db).upsertProviderRepository(
      seeded.companyA.id,
      created.connection.id,
      provider.provider,
      {
        providerRepositoryId: "provider-repo-1",
        cloneUrl: "https://git.example.com/acme/provider-repo.git",
        visibility: "private",
      },
    );
    const synced = await connections.sync(seeded.companyA.id, created.connection.id);
    expect(synced?.repositories).toHaveLength(1);
    expect(synced?.repositories[0]).toMatchObject({
      id: providerRepository.id,
      name: "provider-repo-renamed",
    });
    expect((await repositoryService(db).list(seeded.companyA.id)).map((repository) => repository.name))
      .not.toContain("not-imported");
    await repositoryAccessService(db).attachProjectRepository({
      companyId: seeded.companyA.id,
      projectId: seeded.projectOne.id,
      repositoryId: providerRepository.id,
      displayOrder: 0,
    });
    expect((await connections.sync(seeded.companyA.id, created.connection.id))?.repositories[0]?.id)
      .toBe(providerRepository.id);

    const failingProvider: RepositoryProviderAdapter = {
      provider: "test_provider",
      sync: async () => {
        throw new Error("sync failed at https://secret-token@git.example.com/?token=secret");
      },
      disconnect: async () => {
        throw new Error("disconnect failed token=secret");
      },
    };
    unregisterProviders.push(repositoryProviderRegistry.register(failingProvider));
    await expect(connections.sync(seeded.companyA.id, created.connection.id)).rejects.toMatchObject({ status: 422 });
    const failedSync = await connections.getById(created.connection.id);
    expect(failedSync).toMatchObject({ status: "error", syncStatus: "failed" });
    expect(failedSync?.syncError).not.toContain("secret-token");
    expect(failedSync?.syncError).not.toContain("token=secret");
    expect((await repositoryService(db).getById(providerRepository.id))?.state).toBe("active");

    await expect(connections.disconnect(seeded.companyA.id, created.connection.id)).rejects.toMatchObject({ status: 422 });
    expect((await repositoryService(db).getById(providerRepository.id))?.state).toBe("active");
    expect(await repositoryAccessService(db).listProjectRepositories(seeded.companyA.id, seeded.projectOne.id))
      .toHaveLength(1);

    unregisterProviders.push(repositoryProviderRegistry.register(provider));
    const disconnected = await connections.disconnect(seeded.companyA.id, created.connection.id);
    expect(disconnected?.connection.status).toBe("disconnected");
    expect((await repositoryService(db).getById(providerRepository.id))?.state).toBe("unavailable");
    expect(await repositoryAccessService(db).listProjectRepositories(seeded.companyA.id, seeded.projectOne.id))
      .toHaveLength(1);
    await expect(connections.sync(seeded.companyA.id, created.connection.id)).rejects.toMatchObject({ status: 409 });
  });
});
