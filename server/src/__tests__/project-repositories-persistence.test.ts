import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { companies, companyMemberships, companySecrets, connectionGrants, connectionGrantMembers, toolApplications, toolConnections, createDb, projects as projectTable, userSecretDefinitions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { toolAccessService } from "../services/tool-access.js";
import * as toolAccessModule from "../services/tool-access.js";
import { projectService } from "../services/projects.js";
import { projectRoutes } from "../routes/projects.js";
import { errorHandler } from "../middleware/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const personalTokens = vi.hoisted(() => new Map<string, string>());
vi.mock("../services/secrets.js", () => ({ secretService: () => ({
  resolveSecretValue: async (_companyId: string, secretId: string) => secretId,
  resolveUserSecretValue: async (_companyId: string, input: { definitionId: string }) => ({ value: personalTokens.get(input.definitionId) }),
}) }));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("project repository persistence", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  const repo = (id: string) => ({ id, fullName: `org/repo-${id}`, url: `https://github.com/org/repo-${id}`, connections: [] });
  const otherRepo = (id: string) => ({ id: `gitlab:${id}`, provider: "gitlab", fullName: `org/repo-${id}`, url: `https://gitlab.com/org/repo-${id}`, private: false, connections: [] });
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-repositories-");
    db = createDb(temp.connectionString);
    [companyId] = (await db.insert(companies).values({ name: "Repositories", issuePrefix: "REPO" }).returning()).map((company) => company.id);
  }, 20_000);
  afterAll(async () => { await temp?.cleanup(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); personalTokens.clear(); });

  it("creates multiple source repos atomically and persists them across reads", async () => {
    const svc = projectService(db);
    const created = await svc.createWithRepositories(companyId, { name: "Multi" }, [repo("1"), repo("2")]);
    const fetched = await svc.getById(created.id);
    expect(fetched?.workspaces.map((workspace) => workspace.repoUrl).sort()).toEqual([repo("1").url, repo("2").url]);
    expect(fetched?.workspaces.filter((workspace) => workspace.isPrimary)).toHaveLength(1);
    expect(fetched?.workspaces.every((workspace) => workspace.companyId === companyId)).toBe(true);
  });
  it("retains and refreshes repository visibility without replacing the workspace", async () => {
    const svc = projectService(db);
    const source = { ...repo("30"), private: true };
    const created = await svc.createWithRepositories(companyId, { name: "Visibility" }, [source]);
    expect(created.workspaces[0].metadata).toMatchObject({ repositoryProvider: "github", repositoryId: source.id, repositoryPrivate: true, repositoryUrl: source.url, githubRepositoryPrivate: true, githubRepositoryUrl: source.url });
    const updated = await svc.replaceRepositories(created.id, [{ ...source, private: false }]);
    expect(updated?.workspaces[0]).toMatchObject({ id: created.workspaces[0].id, metadata: { githubRepositoryPrivate: false, githubRepositoryUrl: source.url } });
  });
  it("persists mixed providers independently and retains local workspace settings when detaching", async () => {
    const svc = projectService(db);
    const created = await svc.createWithRepositories(companyId, { name: "Mixed providers" }, [repo("40"), otherRepo("40")]);
    const gitlabWorkspace = created.workspaces.find((workspace) => workspace.metadata?.repositoryProvider === "gitlab")!;
    await svc.updateWorkspace(created.id, gitlabWorkspace.id, { cwd: "/tmp/gitlab-project", repoRef: "main", metadata: { ...gitlabWorkspace.metadata, retained: true } });
    const updated = await svc.replaceRepositories(created.id, [repo("40")]);
    expect(updated?.workspaces).toHaveLength(2);
    expect(updated?.workspaces.find((workspace) => workspace.id === gitlabWorkspace.id)).toMatchObject({ cwd: "/tmp/gitlab-project", repoRef: "main", repoUrl: null, metadata: { retained: true } });
    expect(updated?.workspaces.find((workspace) => workspace.metadata?.repositoryProvider === "github")?.metadata).toMatchObject({ repositoryId: "40", githubRepositoryId: "40" });
  });
  it("adds/removes repos, promotes the remaining primary, and preserves legacy and local config", async () => {
    const svc = projectService(db);
    const created = await svc.createWithRepositories(companyId, { name: "Edit" }, [repo("3"), repo("4")]);
    const legacy = await svc.createWorkspace(created.id, { repoUrl: "https://git.example/legacy/repo" });
    const local = await svc.createWorkspace(created.id, { cwd: "/tmp/local-project", repoUrl: repo("5").url, metadata: { githubRepositoryId: "5", retained: true } });
    const updated = await svc.replaceRepositories(created.id, [repo("4"), repo("6")]);
    expect(updated?.workspaces.find((workspace) => workspace.id === legacy!.id)?.repoUrl).toBe("https://git.example/legacy/repo");
    expect(updated?.workspaces.find((workspace) => workspace.id === local!.id)).toMatchObject({ cwd: "/tmp/local-project", repoUrl: null, metadata: { retained: true } });
    expect(updated?.workspaces.some((workspace) => workspace.repoUrl === repo("3").url)).toBe(false);
    expect(updated?.workspaces.filter((workspace) => workspace.isPrimary)).toHaveLength(1);
    const repeated = await svc.replaceRepositories(created.id, [repo("4"), repo("6")]);
    expect(repeated?.workspaces).toHaveLength(updated!.workspaces.length);
  });
  it("handles a repo recreated at the same URL with a new GitHub identity", async () => {
    const svc = projectService(db);
    const original = repo("20");
    const created = await svc.createWithRepositories(companyId, { name: "Recreated" }, [original]);
    const updated = await svc.replaceRepositories(created.id, [{ ...original, id: "21" }]);
    expect(updated?.workspaces).toHaveLength(1);
    expect(updated?.workspaces[0]?.metadata?.githubRepositoryId).toBe("21");
  });

  it("refreshes renamed and transferred repositories without replacing workspace identity or configuration", async () => {
    const svc = projectService(db);
    const created = await svc.createWithRepositories(companyId, { name: "Renamed" }, [repo("22")]);
    const workspace = created.workspaces[0];
    await svc.updateWorkspace(created.id, workspace.id, { cwd: "/tmp/renamed-project", repoRef: "release", metadata: { ...workspace.metadata, retained: true } });
    const renamed = { ...repo("22"), fullName: "new-owner/new-name", url: "https://github.com/new-owner/new-name" };
    const updated = await svc.replaceRepositories(created.id, [renamed]);
    expect(updated?.workspaces).toHaveLength(1);
    expect(updated?.workspaces[0]).toMatchObject({ id: workspace.id, name: renamed.fullName, repoUrl: renamed.url, cwd: "/tmp/renamed-project", repoRef: "release", isPrimary: true, metadata: { githubRepositoryId: "22", retained: true } });
    expect(updated?.codebase.repoUrl).toBe(renamed.url);
  });

  it("creates projects only from repository URLs in the caller's active catalog and persists their IDs", async () => {
    const catalog = vi.fn().mockResolvedValue({ repositories: [
      { id: "201", provider: "github", fullName: "org/selected", url: "https://github.com/org/selected", private: true, connections: ["github-connection"] },
    ], connections: [{ id: "github-connection", name: "GitHub" }], connectionCount: 1, failedConnectionCount: 0 });
    vi.spyOn(toolAccessModule, "toolAccessService").mockImplementation(() => ({ listProjectRepositories: catalog } as any));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "alice", isInstanceAdmin: true }; next(); });
    app.use("/api", projectRoutes(db));
    app.use(errorHandler);

    const created = await request(app).post(`/api/companies/${companyId}/projects`).send({
      name: `Catalog project ${Date.now()}`, repositoryUrls: ["https://github.com/org/selected.git"],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(catalog).toHaveBeenCalledWith(companyId, "alice", true);
    const project = await projectService(db).getById(created.body.id);
    expect(project?.workspaces).toHaveLength(1);
    expect(project?.workspaces[0]).toMatchObject({ repoUrl: "https://github.com/org/selected", metadata: {
      repositoryProvider: "github", repositoryId: "201", githubRepositoryId: "201", repositoryPrivate: true,
    } });

    catalog.mockResolvedValueOnce({ repositories: [], connections: [], connectionCount: 0, failedConnectionCount: 0 });
    const missingName = `Unconnected project ${Date.now()}`;
    const denied = await request(app).post(`/api/companies/${companyId}/projects`).send({
      name: missingName, repositoryUrls: ["https://github.com/org/missing"],
    });
    expect(denied.status).toBe(422);
    expect(denied.body.error).toMatch(/active GitHub connection/i);
    expect(await db.select().from(projectTable).where(eq(projectTable.name, missingName))).toEqual([]);
  });

  it("requires a workspace GitHub URL to resolve to exactly one active catalog repository", async () => {
    const catalog = vi.fn().mockResolvedValue({ repositories: [
      { id: "202", provider: "github", fullName: "org/workspace", url: "https://github.com/org/workspace", private: false, connections: ["github-connection"] },
    ], connections: [{ id: "github-connection", name: "GitHub" }], connectionCount: 1, failedConnectionCount: 0 });
    vi.spyOn(toolAccessModule, "toolAccessService").mockImplementation(() => ({ listProjectRepositories: catalog } as any));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "alice", isInstanceAdmin: true }; next(); });
    app.use("/api", projectRoutes(db));
    app.use(errorHandler);

    const created = await request(app).post(`/api/companies/${companyId}/projects`).send({
      name: `Workspace catalog project ${Date.now()}`, workspace: { name: "Source", repoUrl: "https://github.com/org/workspace.git" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.workspaces?.[0] ?? (await projectService(db).getById(created.body.id))?.workspaces[0]).toMatchObject({
      metadata: { repositoryProvider: "github", repositoryId: "202", githubRepositoryId: "202" },
    });

    catalog.mockResolvedValueOnce({ repositories: [], connections: [], connectionCount: 0, failedConnectionCount: 0 });
    const denied = await request(app).post(`/api/companies/${companyId}/projects`).send({
      name: `Unconnected workspace ${Date.now()}`, workspace: { name: "Source", repoUrl: "https://github.com/org/unknown" },
    });
    expect(denied.status).toBe(422);
  });

  it("authorizes Azure DevOps workspace URLs from the active catalog and rejects missing entries", async () => {
    const repositoryId = "azure-devops:12345678-1234-1234-1234-1234567890ab";
    const repositoryUrl = "https://dev.azure.com/contoso/Platform/_git/repo";
    const catalog = vi.fn().mockResolvedValue({ repositories: [
      { id: repositoryId, provider: "azure-devops", fullName: "contoso/Platform/repo", url: repositoryUrl, private: true, connections: ["azure-connection"] },
    ], connections: [{ id: "azure-connection", name: "Azure DevOps" }], connectionCount: 1, failedConnectionCount: 0 });
    vi.spyOn(toolAccessModule, "toolAccessService").mockImplementation(() => ({ listProjectRepositories: catalog } as any));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "alice", isInstanceAdmin: true }; next(); });
    app.use("/api", projectRoutes(db));
    app.use(errorHandler);

    const created = await request(app).post(`/api/companies/${companyId}/projects`).send({
      name: `Azure workspace ${Date.now()}`, workspace: { name: "Azure source", repoUrl: repositoryUrl },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const workspace = (await projectService(db).getById(created.body.id))?.workspaces[0];
    expect(workspace).toMatchObject({ repoUrl: repositoryUrl, metadata: {
      repositoryProvider: "azure-devops", repositoryId, repositoryUrl, repositoryPrivate: true,
    } });
    expect(workspace?.metadata).not.toHaveProperty("githubRepositoryId");

    await projectService(db).updateWorkspace(created.body.id, workspace!.id, { metadata: { ...workspace!.metadata, retainedSetting: "keep" } });
    const edited = await request(app).patch(`/api/projects/${created.body.id}/workspaces/${workspace!.id}`).send({ repoUrl: repositoryUrl });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.metadata).toMatchObject({ retainedSetting: "keep", repositoryProvider: "azure-devops", repositoryId });

    catalog.mockResolvedValueOnce({ repositories: [], connections: [], connectionCount: 0, failedConnectionCount: 0 });
    const denied = await request(app).post(`/api/companies/${companyId}/projects`).send({
      name: `Unconnected Azure workspace ${Date.now()}`, workspace: { name: "Azure source", repoUrl: "https://dev.azure.com/contoso/Platform/_git/missing" },
    });
    expect(denied.status).toBe(422);
    expect(denied.body.error).toMatch(/active provider connection/i);
  });

  it("loads only usable connection grants, deduplicates repos, and reports partial provider failures", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", membershipRole: "admin" });
    const [otherCompany] = await db.insert(companies).values({ name: "Other", issuePrefix: "OTHER" }).returning();
    const tokenRepos = new Map<string, Array<{ id: number; full_name: string }>>();
    async function connection(name: string, kind: "user" | "organization", owner: string | null, audience: string[] = [], targetCompanyId = companyId, legacyCompanyCredential = false) {
      const [app] = await db.insert(toolApplications).values({ companyId: targetCompanyId, name, type: "mcp_http" }).returning();
      const definition = kind === "user" && !legacyCompanyCredential
        ? (await db.insert(userSecretDefinitions).values({ companyId: targetCompanyId, name, key: name }).returning())[0]
        : undefined;
      const [secret] = await db.insert(companySecrets).values({ companyId: targetCompanyId, name, key: name,
        scope: definition ? "user" : "company", ownerUserId: definition ? owner : null,
        userSecretDefinitionId: definition?.id }).returning();
      if (definition) personalTokens.set(definition.id, secret.id);
      const [conn] = await db.insert(toolConnections).values({ companyId: targetCompanyId, applicationId: app.id, name, uid: name, status: "active", enabled: true,
        transport: "mcp_remote", authKind: "api_key", credentialPolicy: kind === "user" ? "per_user" : "shared", config: { sourceTemplateKey: "github" } }).returning();
      const [grant] = await db.insert(connectionGrants).values({ companyId: targetCompanyId, connectionId: conn.id, kind, subjectUserId: owner,
        credentialSecretRefs: [{ secretId: secret.id, configPath: "credentials.authorization", versionSelector: "latest" }] }).returning();
      for (const subjectId of audience) await db.insert(connectionGrantMembers).values({ companyId: targetCompanyId, grantId: grant.id, subjectType: "user", subjectId });
      return secret.id;
    }
    const personal = await connection("personal", "user", "alice");
    const shared = await connection("shared", "organization", null);
    const otherPerson = await connection("other-person", "user", "bob");
    const restricted = await connection("restricted", "organization", null, ["bob"]);
    const crossCompany = await connection("cross-company", "organization", null, [], otherCompany.id);
    const broken = await connection("broken", "organization", null);
    const legacyPersonal = await connection("legacy-personal", "user", "alice", [], companyId, true);
    tokenRepos.set(personal, [{ id: 10, full_name: "org/common" }, { id: 11, full_name: "alice/private" }]);
    tokenRepos.set(shared, [{ id: 10, full_name: "org/common" }, { id: 12, full_name: "org/shared" }]);
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      if (token === broken) return new Response("secret-provider-error", { status: 503 });
      expect([otherPerson, restricted, crossCompany, legacyPersonal]).not.toContain(token);
      return Response.json(tokenRepos.get(token) ?? []);
    });
    vi.stubGlobal("fetch", request);
    const result = await toolAccessService(db).listProjectRepositories(companyId, "alice");
    expect(result.connectionCount).toBe(4);
    expect(result.failedConnectionCount).toBe(2);
    expect(result.repositories.map((repo) => repo.id).sort()).toEqual(["10", "11", "12"]);
    expect(result.repositories.find((repo) => repo.id === "10")?.connections.sort()).toEqual(["personal", "shared"]);
    expect(JSON.stringify(result)).not.toContain("secret-provider-error");
    expect(request).toHaveBeenCalledTimes(3);
    const savedConnections = await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId));
    const automatic = await toolAccessService(db).githubReadConnectionIds(companyId, "alice");
    expect(savedConnections.filter(connection => automatic.includes(connection.id)).map(connection => connection.name).sort()).toEqual(["broken", "personal", "shared"]);
    expect(await toolAccessService(db).githubReadConnectionIds(otherCompany.id, "alice")).toEqual([]);
    const ownConnection = savedConnections.find(connection => connection.name === "personal")!;
    expect(await toolAccessService(db).githubReadHeaders(companyId, ownConnection.id, "alice")).toEqual({ Authorization: `Bearer ${personal}` });
    for (const name of ["other-person", "restricted", "legacy-personal"]) {
      await expect(toolAccessService(db).githubReadHeaders(companyId, savedConnections.find(connection => connection.name === name)!.id, "alice")).rejects.toThrow(/authorization/);
    }
    await expect(toolAccessService(db).githubReadHeaders(otherCompany.id, ownConnection.id, "alice", true)).rejects.toThrow(/unavailable/);
    const sharedConnection = savedConnections.find(connection => connection.name === "shared")!;
    const [ownGrant, otherGrant] = await db.insert(connectionGrants).values([
      { companyId, connectionId: sharedConnection.id, kind: "user", subjectUserId: "alice", credentialSecretRefs: [{ secretId: personal, configPath: "credentials.authorization", versionSelector: "latest" }] },
      { companyId, connectionId: sharedConnection.id, kind: "user", subjectUserId: "bob", credentialSecretRefs: [{ secretId: otherPerson, configPath: "credentials.authorization", versionSelector: "latest" }] },
    ]).returning();
    const ids = await toolAccessService(db).githubReadGrantIds(companyId, sharedConnection.id, "alice");
    expect(ids).toHaveLength(2);
    expect(ids).toContain(ownGrant!.id);
    expect(ids).not.toContain(otherGrant!.id);
    expect(await toolAccessService(db).githubReadHeaders(companyId, sharedConnection.id, "alice", false, false, ownGrant!.id)).toEqual({ Authorization: `Bearer ${personal}` });
    await expect(toolAccessService(db).githubReadHeaders(companyId, sharedConnection.id, "alice", false, false, otherGrant!.id)).rejects.toThrow(/authorization/);
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.connectionId, ownConnection.id));
    await expect(toolAccessService(db).githubReadHeaders(companyId, ownConnection.id, "alice")).rejects.toThrow(/authorization/);
    expect(await toolAccessService(db).githubReadConnectionIds(companyId, "alice")).not.toContain(ownConnection.id);
    const revokedMembership = await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, "alice")).returning();
    expect(revokedMembership).toHaveLength(1);
    expect(await toolAccessService(db).githubReadConnectionIds(companyId, "alice")).toEqual([]);
    expect((await toolAccessService(db).listProjectRepositories(companyId, "alice")).repositories).toEqual([]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("rolls back the project if a later repository insert fails", async () => {
    const svc = projectService(db);
    await expect(svc.createWithRepositories(companyId, { name: "Rollback" }, [repo("7"), { ...repo("8"), fullName: "invalid" + String.fromCharCode(0) + "name" }])).rejects.toThrow();
    expect(await db.select().from(projectTable).where(eq(projectTable.name, "Rollback"))).toEqual([]);
  });
});
