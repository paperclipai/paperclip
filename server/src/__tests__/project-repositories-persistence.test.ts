import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, companySecrets, connectionGrants, connectionGrantMembers, toolApplications, toolConnections, createDb, projects as projectTable, userSecretDefinitions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { toolAccessService } from "../services/tool-access.js";
import { projectService } from "../services/projects.js";
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
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-repositories-");
    db = createDb(temp.connectionString);
    [companyId] = (await db.insert(companies).values({ name: "Repositories", issuePrefix: "REPO" }).returning()).map((company) => company.id);
  }, 20_000);
  afterAll(async () => { await temp?.cleanup(); });
  afterEach(() => { vi.unstubAllGlobals(); personalTokens.clear(); });

  it("creates multiple source repos atomically and persists them across reads", async () => {
    const svc = projectService(db);
    const created = await svc.createWithRepositories(companyId, { name: "Multi" }, [repo("1"), repo("2")]);
    const fetched = await svc.getById(created.id);
    expect(fetched?.workspaces.map((workspace) => workspace.repoUrl).sort()).toEqual([repo("1").url, repo("2").url]);
    expect(fetched?.workspaces.filter((workspace) => workspace.isPrimary)).toHaveLength(1);
    expect(fetched?.workspaces.every((workspace) => workspace.companyId === companyId)).toBe(true);
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
        providerTenant: { github: { managementUrl: name === "personal" ? "https://github.com/settings/installations/123" : "https://untrusted.example/settings/installations/456" } },
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
    expect(result.connections?.find(connection => connection.name === "personal")?.managementUrl).toBe("https://github.com/settings/installations/123");
    expect(result.connections?.find(connection => connection.name === "shared")?.managementUrl).toBe("https://github.com/settings/installations");
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
