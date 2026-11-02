import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createDb, authUsers, companyMemberships, connectionGrants, executionWorkspaces, heartbeatRuns, instanceUserRoles, issues, projectAccessMembers, projects, projectWorkspaces, resourceLifecycleEvents, toolConnectionInstalls, toolConnections } from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { ghFetch } from "../services/github-fetch.js";
import { projectRoutes } from "../routes/projects.js";
import { projectGitAuthorizationService } from "../services/project-git-authorization.js";
import { errorHandler } from "../middleware/index.js";
import { githubCredentialsFixture } from "./helpers/github-credentials-fixture.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const vault = vi.hoisted(() => ({
  resolveUserSecretValue: vi.fn(async (_company: string, input: { responsibleUserId: string }) => ({ value: `test-token-${input.responsibleUserId}` })),
  resolveSecretValue: vi.fn(async () => "test-dedicated-token"),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));
vi.mock("../services/github-fetch.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/github-fetch.js")>(),
  ghFetch: vi.fn(async () => new Response(null, { status: 404 })),
}));
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_PROJECT_GIT_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("explicit project Git authorization", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const { seed, grant, switchTo } = githubCredentialsFixture(() => db);
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-project-git-authorization-");
    db = createDb(external ?? database!.connectionString);
    await db.insert(authUsers).values(["A", "B"].map(id => ({
      id, name: id, email: `${id}@example.invalid`, createdAt: new Date(), updatedAt: new Date(),
    })));
  }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);
    async function projectAuthorizationFixture() {
      const input = await seed();
      const selected = await grant(input, "A");
      const [project] = await db.insert(projects).values({ companyId: input.companyId, name: "Authorized project" }).returning();
      const [workspace] = await db.insert(projectWorkspaces).values({ companyId: input.companyId, projectId: project.id,
        name: "Repository", repoUrl: "https://github.com/fixture/project.git" }).returning();
      await db.update(issues).set({ projectId: project.id, projectWorkspaceId: workspace.id }).where(eq(issues.id, input.issueId));
      await db.insert(toolConnectionInstalls).values({ companyId: input.companyId, connectionId: selected.connectionId, targetType: "company", targetId: input.companyId });
      const [saved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, selected.id));
      await db.update(connectionGrants).set({ providerTenant: { ...saved.providerTenant, github: { ...saved.providerTenant!.github!,
        lastAccessRefreshAt: "2020-01-01T00:00:00Z", repositories: [{ id: "1", fullName: "fixture/project", installationId: "1", private: true }] } } }).where(eq(connectionGrants.id, selected.id));
      const service = projectGitAuthorizationService(db);
      const request = { companyId: input.companyId, projectId: project.id, workspaceId: workspace.id };
      return { input, selected, project, workspace, service, request, scope: { projectId: project.id } };
    }
    it("uses explicit project consent without a task and journals consent changes", async () => {
      const f = await projectAuthorizationFixture();
      await expect(f.service.resolve(f.request, f.scope)).rejects.toThrow("Authorize this project");
      expect(await f.service.read(f.input.companyId, f.project.id, "B")).toMatchObject({ options: [] });
      await expect(f.service.set(f.input.companyId, f.project.id, "B", f.selected.id)).rejects.toThrow("own active");
      const saved = await f.service.set(f.input.companyId, f.project.id, "A", f.selected.id);
      expect(saved).toMatchObject({ grantId: f.selected.id, authorizedByUserId: "A" });
      expect(JSON.stringify(saved)).not.toContain("test-token");
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.input.runId));
      await db.update(issues).set({ responsibleUserId: "B" }).where(eq(issues.id, f.input.issueId));
      expect(await f.service.resolve(f.request, f.scope)).toBe("test-token-A");
      expect((await db.select().from(resourceLifecycleEvents).where(eq(resourceLifecycleEvents.resourceId, f.project.id))).length).toBeGreaterThan(0);
      await f.service.set(f.input.companyId, f.project.id, "A", null);
      await expect(f.service.resolve(f.request, f.scope)).rejects.toThrow("Authorize this project");
    });
    it("rechecks the consenting user's project access before background credential export", async () => {
      const f = await projectAuthorizationFixture();
      await f.service.set(f.input.companyId, f.project.id, "A", f.selected.id);
      await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, f.project.id));
      await db.insert(projectAccessMembers).values({ companyId: f.input.companyId, projectId: f.project.id, subjectType: "user", subjectId: "A" });
      expect(await f.service.resolve(f.request, f.scope)).toBe("test-token-A");
      await db.delete(projectAccessMembers).where(eq(projectAccessMembers.projectId, f.project.id));
      vault.resolveUserSecretValue.mockClear();
      await expect(f.service.resolve(f.request, f.scope)).rejects.toThrow("private");
      expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
    });
    it("rechecks current Cloud owner elevation for consent on another user's private project", async () => {
      const f = await projectAuthorizationFixture();
      await db.update(projects).set({ visibility: "private", privacyOwnerUserId: "B" }).where(eq(projects.id, f.project.id));
      vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "fixture-tenant-token");
      vi.stubEnv("PAPERCLIP_CLOUD_API_ORIGIN", "https://cloud.example.invalid");
      vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "fixture-stack");
      vi.stubEnv("PAPERCLIP_STACK_SLUG", "fixture-stack");
      const managed = (enabled: boolean) => vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", JSON.stringify({
        v: 1, mode: "cloud", catalogVersion: "test", features: { enableOwnerInstanceAdmin: enabled }, plugins: { autoInstall: [] },
      }));
      const portfolio = (role = "owner", stackSlug = "fixture-stack") => Response.json({ stacks: [{ stackSlug, role, isCurrent: true }] });
      const fetch = vi.fn(async () => portfolio());
      vi.stubGlobal("fetch", fetch); managed(true);
      try {
        const app = express(); app.use(express.json());
        app.use((req, _res, next) => { req.actor = { type: "board", source: "cloud_tenant", userId: "A",
          companyIds: [f.input.companyId], isInstanceAdmin: true }; next(); });
        app.use("/api", projectRoutes(db)); app.use(errorHandler);
        expect((await request(app).put(`/api/projects/${f.project.id}/git-authorization`).send({ grantId: f.selected.id })).status).toBe(200);
        expect(await f.service.resolve(f.request, f.scope)).toBe("test-token-A");
        const cleanup = { ...f.scope, workspaceId: f.workspace.id, operation: "remove" as const };
        expect(await f.service.resolve(f.request, cleanup)).toBe("test-token-A");
        expect(fetch).toHaveBeenCalledWith(new URL("https://cloud.example.invalid/v1/tenant/portfolio"), expect.objectContaining({
          headers: expect.objectContaining({ "x-paperclip-cloud-user-id": "A", "x-paperclip-cloud-stack-id": "fixture-stack" }),
        }));
        // Stale local roles must never replace current Cloud authority.
        await db.insert(instanceUserRoles).values({ userId: "A", role: "instance_admin" });
        for (const denied of ["role", "setting", "unavailable", "stack"] as const) {
          managed(denied !== "setting");
          fetch.mockImplementation(async () => denied === "unavailable" ? new Response(null, { status: 503 })
            : portfolio(denied === "role" ? "admin" : "owner", denied === "stack" ? "different-stack" : "fixture-stack"));
          vault.resolveUserSecretValue.mockClear();
          await expect(f.service.resolve(f.request, cleanup)).rejects.toThrow("private");
          expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
        }
        await db.insert(projectAccessMembers).values({ companyId: f.input.companyId, projectId: f.project.id, subjectType: "user", subjectId: "A" });
        fetch.mockImplementation(async () => new Response(null, { status: 503 }));
        expect(await f.service.resolve(f.request, cleanup)).toBe("test-token-A");
      } finally {
        await db.delete(instanceUserRoles).where(eq(instanceUserRoles.userId, "A"));
        vi.unstubAllGlobals(); vi.unstubAllEnvs();
      }
    });
    it("does not lend background consent to a low-trust project", async () => {
      const f = await projectAuthorizationFixture();
      await f.service.set(f.input.companyId, f.project.id, "A", f.selected.id);
      await db.update(projects).set({ executionWorkspacePolicy: { authorizationPolicy: { trustBoundary: {
        mode: LOW_TRUST_REVIEW_PRESET, companyId: f.input.companyId, projectIds: [f.project.id],
      } } } }).where(eq(projects.id, f.project.id));
      vault.resolveUserSecretValue.mockClear();
      await expect(f.service.resolve(f.request, f.scope)).rejects.toThrow("low-trust");
      expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
    });
    it("uses the connection's current repository access for sources added after project authorization", async () => {
      const f = await projectAuthorizationFixture();
      await f.service.set(f.input.companyId, f.project.id, "A", f.selected.id);
      const [workspace] = await db.insert(projectWorkspaces).values({ companyId: f.input.companyId,
        projectId: f.project.id, name: "Added repository", repoUrl: "https://github.com/fixture/added",
        metadata: { githubRepositoryUrl: "https://github.com/fixture/added", githubRepositoryPrivate: true },
      }).returning();
      const request = { ...f.request, workspaceId: workspace.id };
      vault.resolveUserSecretValue.mockClear();
      await expect(f.service.resolve(request, f.scope)).rejects.toThrow("does not include this repository");
      expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
      const [saved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.selected.id));
      await db.update(connectionGrants).set({ providerTenant: { ...saved.providerTenant, github: { ...saved.providerTenant!.github!,
        repositoryCount: 2, repositories: [...saved.providerTenant!.github!.repositories!,
          { id: "2", fullName: "fixture/added", installationId: "1", private: true }],
      } } }).where(eq(connectionGrants.id, f.selected.id));
      expect(await f.service.resolve(request, f.scope)).toBe("test-token-A");
      await db.update(connectionGrants).set({ providerTenant: saved.providerTenant }).where(eq(connectionGrants.id, f.selected.id));
      vault.resolveUserSecretValue.mockClear();
      await expect(f.service.resolve(request, f.scope)).rejects.toThrow("does not include this repository");
      expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
    });
    it("never requests credentials or requires a connection for a known public repository", async () => {
      const f = await projectAuthorizationFixture();
      await db.update(projectWorkspaces).set({ metadata: { githubRepositoryUrl: "https://github.com/fixture/project", githubRepositoryPrivate: false } }).where(eq(projectWorkspaces.id, f.workspace.id));
      await db.update(connectionGrants).set({ providerTenant: null, status: "revoked" }).where(eq(connectionGrants.id, f.selected.id));
      vi.mocked(ghFetch).mockClear(); vault.resolveUserSecretValue.mockClear();
      expect(await f.service.resolve(f.request, f.scope)).toBeNull();
      expect(ghFetch).not.toHaveBeenCalled(); expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
    });
    it.each(["inspect", "remove"] as const)("allows authorized %s after archive while denying provisioning and revoked consent", async operation => {
      const f = await projectAuthorizationFixture();
      await db.update(projectWorkspaces).set({ metadata: { githubRepositoryUrl: "https://github.com/fixture/project", githubRepositoryPrivate: true } })
        .where(eq(projectWorkspaces.id, f.workspace.id));
      await f.service.set(f.input.companyId, f.project.id, "A", f.selected.id);
      await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, f.project.id));
      const scope = { ...f.scope, workspaceId: f.workspace.id, operation };
      expect(await f.service.resolve(f.request, scope)).toBe("test-token-A");
      vault.resolveUserSecretValue.mockClear();
      for (const deniedScope of [f.scope, { ...f.scope, operation }, { ...scope, operation: "prepare" as const },
        { ...scope, workspaceId: randomUUID() }, { ...scope, runId: f.input.runId, agentId: f.input.agentId }]) {
        await expect(f.service.resolve(f.request, deniedScope)).rejects.toThrow();
      }
      await expect(f.service.set(f.input.companyId, f.project.id, "A", f.selected.id)).rejects.toThrow("Active project");
      await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, f.selected.id));
      await expect(f.service.resolve(f.request, scope)).rejects.toThrow("authorization is unavailable");
      await f.service.set(f.input.companyId, f.project.id, "A", null);
      await expect(f.service.resolve(f.request, scope)).rejects.toThrow("Authorize this project");
      expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
    });
    it.each(["revoked", "disabled"])("ignores %s private catalog entries when the current repository is public", async stale => {
      const f = await projectAuthorizationFixture();
      if (stale === "revoked") await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, f.selected.id));
      else await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, f.selected.connectionId));
      const current = await grant(f.input, "A");
      const [saved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, current.id));
      await db.update(connectionGrants).set({ providerTenant: { ...saved.providerTenant, github: { ...saved.providerTenant!.github!,
        repositories: [{ id: "1", fullName: "fixture/project", installationId: "1", private: false }] } } }).where(eq(connectionGrants.id, current.id));
      vault.resolveUserSecretValue.mockClear(); vi.mocked(ghFetch).mockClear();
      expect(await f.service.resolve(f.request, f.scope)).toBeNull();
      expect(vault.resolveUserSecretValue).not.toHaveBeenCalled(); expect(ghFetch).not.toHaveBeenCalled();
    });
    it.each([true, false])("uses refreshed catalog visibility after a repository becomes private=%s", async isPrivate => {
      const f = await projectAuthorizationFixture();
      await db.update(projectWorkspaces).set({ metadata: { githubRepositoryUrl: "https://github.com/fixture/project", githubRepositoryPrivate: !isPrivate } }).where(eq(projectWorkspaces.id, f.workspace.id));
      const [saved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.selected.id));
      await db.update(connectionGrants).set({ providerTenant: { ...saved.providerTenant, github: { ...saved.providerTenant!.github!,
        repositories: [{ id: "1", fullName: "fixture/project", installationId: "1", private: isPrivate }] } } }).where(eq(connectionGrants.id, f.selected.id));
      await f.service.set(f.input.companyId, f.project.id, "A", f.selected.id);
      expect(await f.service.resolve(f.request, f.scope)).toBe(isPrivate ? "test-token-A" : null);
    });
    it("uses repository access refresh time rather than unrelated grant updates for conflicting active catalogs", async () => {
      const f = await projectAuthorizationFixture(), current = await grant(f.input, "A");
      for (const [id, privateValue, refreshedAt] of [[f.selected.id, true, "2020-01-01T00:00:00Z"], [current.id, false, "2021-01-01T00:00:00Z"]] as const) {
        const [saved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, id));
        await db.update(connectionGrants).set({ providerTenant: { ...saved.providerTenant, github: { ...saved.providerTenant!.github!,
          lastAccessRefreshAt: refreshedAt, repositories: [{ id: "1", fullName: "fixture/project", installationId: "1", private: privateValue }] } } }).where(eq(connectionGrants.id, id));
      }
      await db.update(connectionGrants).set({ updatedAt: new Date() }).where(eq(connectionGrants.id, f.selected.id));
      expect(await f.service.resolve(f.request, f.scope)).toBeNull();
    });
    it("never lets a legacy catalog's OAuth update outrank an observed repository refresh", async () => {
      const f = await projectAuthorizationFixture(), legacy = await grant(f.input, "A");
      const [saved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, legacy.id));
      await db.update(connectionGrants).set({ updatedAt: new Date(), providerTenant: { ...saved.providerTenant, github: { ...saved.providerTenant!.github!,
        repositories: [{ id: "1", fullName: "fixture/project", installationId: "1", private: false }] } } }).where(eq(connectionGrants.id, legacy.id));
      await f.service.set(f.input.companyId, f.project.id, "A", f.selected.id);
      expect(await f.service.resolve(f.request, f.scope)).toBe("test-token-A");
    });
    it("discovers legacy URL-only public sources anonymously and defers unknown private sources", async () => {
      const f = await projectAuthorizationFixture();
      await db.update(projectWorkspaces).set({ repoUrl: "https://github.com/fixture/legacy" }).where(eq(projectWorkspaces.id, f.workspace.id));
      vi.mocked(ghFetch).mockResolvedValueOnce(Response.json({ full_name: "fixture/legacy", private: false }));
      expect(await f.service.resolve(f.request, f.scope)).toBeNull();
      const [, options] = vi.mocked(ghFetch).mock.calls.at(-1)!;
      expect(new Headers(options?.headers).has("Authorization")).toBe(false);
      await expect(f.service.resolve(f.request, f.scope)).rejects.toThrow("visibility is unavailable");
    });
    it.each(["grant", "connection", "membership", "repository", "archive"])("rechecks %s and never falls back to another grant", async change => {
      const f = await projectAuthorizationFixture();
      await f.service.set(f.input.companyId, f.project.id, "A", f.selected.id);
      await grant(f.input, "A");
      if (change === "grant") await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, f.selected.id));
      if (change === "connection") await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, f.selected.connectionId));
      if (change === "membership") await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.companyId, f.input.companyId));
      if (change === "repository") await db.update(projectWorkspaces).set({ repoUrl: "https://github.com/fixture/other" }).where(eq(projectWorkspaces.id, f.workspace.id));
      if (change === "archive") await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, f.project.id));
      vault.resolveUserSecretValue.mockClear();
      await expect(f.service.resolve(f.request, f.scope)).rejects.toThrow();
      expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
    });
    it("uses the live foreground run rather than project consent and denies mismatched scopes", async () => {
      const f = await projectAuthorizationFixture();
      await f.service.set(f.input.companyId, f.project.id, "A", f.selected.id);
      await grant(f.input, "B");
      await switchTo(f.input, "B");
      expect(await f.service.resolve(f.request, { ...f.scope, runId: f.input.runId, agentId: f.input.agentId })).toBe("test-token-B");
      for (const scope of [undefined, { projectId: randomUUID() }, { ...f.scope, workspaceId: randomUUID() }]) {
        await expect(f.service.resolve(f.request, scope)).rejects.toThrow();
      }
      await expect(f.service.resolve({ ...f.request, workspaceId: randomUUID() }, f.scope)).rejects.toThrow();
      await expect(f.service.resolve({ ...f.request, companyId: randomUUID() }, f.scope)).rejects.toThrow();
    });
    it.each(["configured", "bound"])("authorizes a %s workspace selected from another project, but not an unselected source", async selection => {
      const f = await projectAuthorizationFixture();
      const [taskProject] = await db.insert(projects).values({ companyId: f.input.companyId, name: "Task project" }).returning();
      const [bound] = selection === "bound" ? await db.insert(executionWorkspaces).values({
        companyId: f.input.companyId, projectId: f.project.id, projectWorkspaceId: f.workspace.id,
        sourceIssueId: f.input.issueId, name: "Selected workspace", mode: "isolated_workspace", strategyType: "git_worktree", status: "idle",
      }).returning() : [];
      await db.update(issues).set({ projectId: taskProject.id,
        projectWorkspaceId: selection === "configured" ? f.workspace.id : null,
        executionWorkspaceId: bound?.id ?? null,
      }).where(eq(issues.id, f.input.issueId));
      const scope = { ...f.scope, workspaceId: f.workspace.id, runId: f.input.runId, agentId: f.input.agentId };
      expect(await f.service.resolve(f.request, scope)).toBe("test-token-A");
      const [unselected] = await db.insert(projectWorkspaces).values({ companyId: f.input.companyId,
        projectId: f.project.id, name: "Unselected source", repoUrl: f.workspace.repoUrl,
      }).returning();
      vault.resolveUserSecretValue.mockClear();
      await expect(f.service.resolve({ ...f.request, workspaceId: unselected.id }, { ...scope, workspaceId: unselected.id })).rejects.toThrow();
      expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.input.runId));
      await expect(f.service.resolve(f.request, scope)).rejects.toThrow();
      expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
    });
    it.each(["", "secret://fixture", "invalid\ntoken"])("rejects invalid transient credential material", async token => {
      const f = await projectAuthorizationFixture();
      await f.service.set(f.input.companyId, f.project.id, "A", f.selected.id);
      vault.resolveUserSecretValue.mockResolvedValueOnce({ value: token });
      await expect(f.service.resolve(f.request, f.scope)).rejects.toThrow("credential unavailable");
    });
    it.each(["task", "source"])("checks access to the %s project before exporting foreground credentials", async privateProject => {
      const f = await projectAuthorizationFixture();
      const [taskProject] = await db.insert(projects).values({ companyId: f.input.companyId, name: "Task project" }).returning();
      await db.update(issues).set({ projectId: taskProject.id }).where(eq(issues.id, f.input.issueId));
      await db.update(projects).set({ visibility: "private" })
        .where(eq(projects.id, privateProject === "task" ? taskProject.id : f.project.id));
      vault.resolveUserSecretValue.mockClear();
      vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
      try {
        await expect(f.service.resolve(f.request, { ...f.scope, runId: f.input.runId, agentId: f.input.agentId })).rejects.toThrow();
        expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
      } finally { vi.unstubAllEnvs(); }
    });
    it("never lends project consent to low-trust foreground preparation", async () => {
      const f = await projectAuthorizationFixture();
      await f.service.set(f.input.companyId, f.project.id, "A", f.selected.id);
      await db.update(issues).set({ sourceTrust: { preset: LOW_TRUST_REVIEW_PRESET, disposition: "quarantined", sourceIssueId: f.input.issueId } })
        .where(eq(issues.id, f.input.issueId));
      vault.resolveUserSecretValue.mockClear();
      await expect(f.service.resolve(f.request, { ...f.scope, runId: f.input.runId, agentId: f.input.agentId })).rejects.toThrow("low-trust");
      expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
    });
    it("requires a board project writer and grant owner on the consent route", async () => {
      const f = await projectAuthorizationFixture();
      function app(userId: string, agent = false) {
        const app = express(); app.use(express.json());
        app.use((req, _res, next) => { req.actor = agent ? { type: "agent", agentId: f.input.agentId, companyId: f.input.companyId }
          : { type: "board", source: "session", userId, companyIds: [f.input.companyId], isInstanceAdmin: true }; next(); });
        app.use("/api", projectRoutes(db)); app.use(errorHandler); return app;
      }
      const url = `/api/projects/${f.project.id}/git-authorization`;
      expect((await request(app("B")).put(url).send({ grantId: f.selected.id })).status).toBe(403);
      expect((await request(app("A", true)).put(url).send({ grantId: f.selected.id })).status).toBe(403);
      expect((await request(app("A")).put(url).send({ grantId: f.selected.id })).status).toBe(200);
      const read = await request(app("A")).get(url);
      expect(read.status).toBe(200); expect(JSON.stringify(read.body)).not.toContain("test-token");
      expect((await request(app("A")).put(url).send({ grantId: null })).status).toBe(200);
    });

});
