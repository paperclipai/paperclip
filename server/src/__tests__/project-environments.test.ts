import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, authUsers, companyMemberships, builtInManagedResources, companies, createDb, environments, instanceSettings, plugins, projects, userCompanyPreferences } from "@paperclipai/db";
import { projectEnvironmentOptions, resolveProjectEnvironment } from "../services/project-environments.js";
import { assertProjectStorageEnvironment, projectStorageForEnvironment } from "../services/project-workspace-provider.js";
import { environmentRunOrchestrator } from "../services/environment-run-orchestrator.js";
import { environmentService } from "../services/environments.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { applyDefaultIsolatedExecutionWorkspacePolicy, gateProjectExecutionWorkspacePolicy, parseProjectExecutionWorkspacePolicy, resolveExecutionWorkspaceMode, buildExecutionWorkspaceAdapterConfig, resolveEffectiveWorkspaceStrategyType } from "../services/execution-workspace-policy.js";
import { projectService } from "../services/projects.js";
import { preparePluginWorkspace } from "../services/plugin-workspaces.js";
import { projectRoutes } from "../routes/projects.js";
import { errorHandler } from "../middleware/index.js";
import { createPluginWorkspaceFixture } from "./helpers/plugin-workspaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("project environment compatibility", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("project-environments");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => { await db.execute(sql`truncate companies, plugins, environments, instance_settings cascade`); });

  async function fixture() {
    const f = await createPluginWorkspaceFixture(db);
    const [plugin] = await db.select().from(plugins).where(eq(plugins.id, f.pluginId));
    plugin.manifestJson = { ...plugin.manifestJson,
      capabilities: [...plugin.manifestJson.capabilities, "environment.drivers.register"],
      environmentDrivers: [{ driverKey: "tasks", supportsTasks: true, displayName: "Computers", configSchema: { type: "object", properties: {} } }],
      workspaceProvider: { ...plugin.manifestJson.workspaceProvider!, defaultForProjects: { mode: "isolated_workspace", strategy: "git_worktree" } },
    };
    await db.update(plugins).set({ manifestJson: plugin.manifestJson }).where(eq(plugins.id, plugin.id));
    const [computer, local, sandbox, ssh] = await db.insert(environments).values([
      { name: "Computers", driver: "plugin", config: { pluginKey: plugin.pluginKey, driverKey: "tasks", driverConfig: {} } },
      { name: "Local", driver: "local" },
      { name: "Sandbox", driver: "sandbox", config: { provider: "daytona" } },
      { name: "Build host", driver: "ssh", config: { host: "build.example.com" } },
    ]).returning();
    await db.insert(instanceSettings).values({ defaultEnvironmentId: sandbox.id });
    return { ...f, plugin, computer, local, sandbox, ssh };
  }

  it("groups by repository storage, across driver types and provider configurations", async () => {
    const f = await fixture();
    const [otherComputer] = await db.insert(environments).values({ name: "Other computers", driver: "plugin",
      config: { ...f.computer.config, driverConfig: { profile: "other" } } }).returning();
    const [otherSandbox] = await db.insert(environments).values({ name: "Other sandbox", driver: "sandbox", config: { provider: "modal" } }).returning();
    const options = await projectEnvironmentOptions(db, f.companyId);
    expect(options.error).toBeNull();
    expect(options.defaultEnvironmentId).toBe(f.sandbox.id);
    expect(options.groups).toHaveLength(2);
    expect(options.groups.find(group => group.storageProviderPluginId === null)?.environments.map(value => value.id).sort())
      .toEqual([f.local.id, f.sandbox.id, f.ssh.id, otherSandbox.id].sort());
    expect(options.groups.find(group => group.storageProviderPluginId === f.pluginId)?.environments.map(value => value.id).sort())
      .toEqual([f.computer.id, otherComputer.id].sort());
    expect(JSON.stringify(options)).not.toContain("driverConfig");
    expect(JSON.stringify(options)).not.toContain("build.example.com");
  });

  it("does not equate two plugin drivers with different storage owners", async () => {
    const f = await fixture();
    const other = await createPluginWorkspaceFixture(db, f.companyId);
    await db.update(plugins).set({ manifestJson: { ...f.plugin.manifestJson, id: `test.${other.pluginId}` } }).where(eq(plugins.id, other.pluginId));
    await db.insert(environments).values({ name: "Separate computers", driver: "plugin", config: { pluginKey: `test.${other.pluginId}`, driverKey: "tasks" } });
    expect((await projectEnvironmentOptions(db, f.companyId)).groups).toHaveLength(3);
    expect(projectStorageForEnvironment({ driver: "plugin", config: { pluginKey: f.plugin.pluginKey, driverKey: "unknown" } }, [f.plugin])).toBeNull();
    expect(projectStorageForEnvironment({ driver: "sandbox", config: { provider: "fake" } }, [f.plugin])).toBeNull();
  });

  it("uses the creating agent, the user's primary agent, then the instance default", async () => {
    const f = await fixture();
    await db.update(agents).set({ defaultEnvironmentId: f.computer.id }).where(eq(agents.id, f.input.agentId));
    await db.insert(userCompanyPreferences).values({ companyId: f.companyId, userId: "person", primaryAgentId: f.input.agentId });
    expect((await projectEnvironmentOptions(db, f.companyId)).defaultEnvironmentId).toBe(f.sandbox.id);
    expect((await projectEnvironmentOptions(db, f.companyId, { userId: "person" })).defaultEnvironmentId).toBe(f.computer.id);
    expect((await projectEnvironmentOptions(db, f.companyId, { agentId: f.input.agentId })).defaultEnvironmentId).toBe(f.computer.id);
    expect(await resolveProjectEnvironment(db, f.companyId, null)).toEqual({ environmentId: f.sandbox.id, executionWorkspacePolicy: null });
    expect(await resolveProjectEnvironment(db, f.companyId, null, { userId: "person" })).toMatchObject({ executionWorkspacePolicy: { storageProviderPluginId: f.pluginId } });
    await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, f.input.agentId));
    expect((await projectEnvironmentOptions(db, f.companyId, { userId: "person" })).defaultEnvironmentId).toBe(f.sandbox.id);
    await db.update(instanceSettings).set({ defaultEnvironmentId: null });
    expect((await projectEnvironmentOptions(db, f.companyId)).defaultEnvironmentId).toBe(f.local.id);
  });

  it("pins the selected storage, preserves explicit API choices, and rejects conflicting choices", async () => {
    const f = await fixture();
    const svc = projectService(db);
    const sandboxProject = await svc.createWithRepositories(f.companyId, { name: "Sandbox project" }, [
      { id: "42", fullName: "example/repo", url: "https://github.com/example/repo", connections: [] },
    ]);
    expect(sandboxProject.workspaceProvider?.pluginId).toBeNull();
    const computerProject = await svc.create(f.companyId, { name: "Computer project" }, { environmentId: f.computer.id });
    expect(computerProject.workspaceProvider?.pluginId).toBe(f.pluginId);
    const explicit = { enabled: true, storageProviderPluginId: null };
    expect(await resolveProjectEnvironment(db, f.companyId, explicit)).toEqual({ environmentId: null, executionWorkspacePolicy: explicit });
    await expect(resolveProjectEnvironment(db, f.companyId, explicit, { environmentId: f.computer.id })).rejects.toMatchObject({ status: 409 });
    await db.update(instanceSettings).set({ defaultEnvironmentId: f.computer.id });
    expect((await svc.getById(sandboxProject.id))?.workspaceProvider?.pluginId).toBeNull();
  });

  it("keeps environment changes on one project and snapshots creation defaults", async () => {
    const f = await fixture();
    const svc = projectService(db);
    const first = await svc.create(f.companyId, { name: "First project" });
    const second = await svc.create(f.companyId, { name: "Second project" });
    expect(first.environmentId).toBe(f.sandbox.id);
    expect(second.environmentId).toBe(f.sandbox.id);
    await svc.update(first.id, { environmentId: f.ssh.id, expectedStorageProviderPluginId: null });
    await db.update(instanceSettings).set({ defaultEnvironmentId: f.local.id });
    expect((await svc.getById(first.id))?.environmentId).toBe(f.ssh.id);
    expect((await svc.getById(second.id))?.environmentId).toBe(f.sandbox.id);
    expect((await svc.getById(first.id))?.executionWorkspacePolicy).toBeNull();
    expect((await db.select().from(agents).where(eq(agents.id, f.input.agentId)))[0].defaultEnvironmentId).toBeNull();
    expect((await environmentService(db).getDeleteBlastRadius(f.ssh.id))?.staticReferences.projectSelectionCount).toBe(1);
    expect(await svc.clearExecutionWorkspaceEnvironmentSelection(f.companyId, f.ssh.id)).toBe(1);
    expect((await svc.getById(first.id))?.environmentId).toBeNull();
    expect((await svc.getById(second.id))?.environmentId).toBe(f.sandbox.id);
  });

  it.each([{ enabled: true }, null])("preserves the storage owner before validating a combined environment/policy edit (%j)", async policy => {
    const f = await fixture();
    const svc = projectService(db);
    const project = await svc.create(f.companyId, { name: "Managed project" }, { environmentId: f.computer.id });
    await expect(svc.update(project.id, { environmentId: f.local.id, executionWorkspacePolicy: policy }))
      .rejects.toMatchObject({ status: 409 });
    const saved = await svc.getById(project.id);
    expect(saved?.environmentId).toBe(f.computer.id);
    expect(saved?.executionWorkspacePolicy?.storageProviderPluginId).toBe(f.pluginId);
  });

  it.each([false, true])("migrates a saved legacy project selection without changing its checkout policy (uppercase=%s)", async uppercase => {
    const f = await fixture();
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0464_project_environment.sql", import.meta.url), "utf8");
    const project = await projectService(db).create(f.companyId, { name: "Existing project" });
    const [target] = await db.insert(environments).values({ id: "abcdefab-cdef-4abc-8def-abcdefabcdef", name: "Legacy target", driver: "ssh", config: { host: "legacy.example.test" } }).returning();
    await expect(db.transaction(async tx => {
      await tx.update(projects).set({ executionWorkspacePolicy: { enabled: false, environmentId: uppercase ? target.id.toUpperCase() : target.id } }).where(eq(projects.id, project.id));
      await tx.execute(sql`alter table projects drop column environment_id`);
      for (const statement of migration.split("--> statement-breakpoint").filter(value => value.trim())) {
        await tx.execute(sql.raw(statement));
      }
      const [saved] = await tx.select().from(projects).where(eq(projects.id, project.id));
      expect(saved.environmentId).toBe(target.id);
      expect(saved.executionWorkspacePolicy).toEqual({ enabled: false });
      throw new Error("rollback migration fixture");
    })).rejects.toThrow("rollback migration fixture");
  });

  it("accepts legacy project policy environment edits without changing other projects", async () => {
    const f = await fixture();
    const svc = projectService(db);
    const first = await svc.create(f.companyId, { name: "Legacy editor" });
    const second = await svc.create(f.companyId, { name: "Other project" });
    const saved = await svc.update(first.id, { executionWorkspacePolicy: { enabled: false, environmentId: f.ssh.id.toUpperCase() } });
    expect(saved?.environmentId).toBe(f.ssh.id);
    expect(saved?.executionWorkspacePolicy).toEqual({ enabled: false });
    expect((await svc.getById(second.id))?.environmentId).toBe(f.sandbox.id);
  });

  it("preserves inherited task isolation when checking the observed core storage owner", async () => {
    const f = await fixture();
    const { experimental: settings } = await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true, enableIsolatedWorkspacesByDefault: true });
    const project = await projectService(db).createWithRepositories(f.companyId, { name: "Inherited isolation" }, [
      { id: "42", fullName: "example/repo", url: "https://github.com/example/repo", connections: [] },
    ], { environmentId: f.sandbox.id, expectedStorageProviderPluginId: null });
    expect(project.executionWorkspacePolicy).toBeNull();
    const projectPolicy = applyDefaultIsolatedExecutionWorkspacePolicy({
      projectPolicy: gateProjectExecutionWorkspacePolicy(parseProjectExecutionWorkspacePolicy(project.executionWorkspacePolicy), settings.enableIsolatedWorkspaces),
      defaultIsolatedWorkspacesEnabled: settings.enableIsolatedWorkspacesByDefault,
      hasProjectWorkspace: project.workspaces.length > 0,
    });
    const mode = resolveExecutionWorkspaceMode({ projectPolicy, issueSettings: null, legacyUseProjectWorkspace: null });
    const config = buildExecutionWorkspaceAdapterConfig({ agentConfig: {}, projectPolicy, issueSettings: null, mode, legacyUseProjectWorkspace: null });
    expect(mode).toBe("isolated_workspace");
    expect(resolveEffectiveWorkspaceStrategyType(mode, config)).toBe("git_worktree");
  });

  it("fails before a provider operation when managed storage cannot serve the selected environment", async () => {
    const f = await fixture();
    expect(() => assertProjectStorageEnvironment(f.plugin, { ...f.sandbox, driver: "sandbox" })).toThrow('does not support the environment "Sandbox"');
    await expect(preparePluginWorkspace(db, f.workers, { ...f.input, environment: { ...f.sandbox, driver: "sandbox" } }))
      .rejects.toMatchObject({ status: 409, details: { code: "project_environment_incompatible", retryable: false } });
    expect(f.calls).toHaveLength(0);
    expect(() => assertProjectStorageEnvironment(f.plugin, { ...f.computer, driver: "plugin" })).not.toThrow();
  });

  it("excludes archived, company-inaccessible, and disabled plugin environments", async () => {
    const f = await fixture();
    const [otherCompany] = await db.insert(companies).values({ name: "Other", issuePrefix: "OTHER" }).returning();
    await db.insert(builtInManagedResources).values({ companyId: otherCompany.id, bundleKey: "test", resourceKind: "environment",
      resourceKey: "environment", resourceId: f.ssh.id, stockVersion: "1", stockHash: "test" });
    await expect(environmentRunOrchestrator(db).resolveEnvironment({ companyId: f.companyId, selectedEnvironmentId: f.ssh.id,
      localEnvironmentId: f.local.id })).rejects.toMatchObject({ status: 403, details: { code: "environment_company_mismatch" } });

    await db.update(environments).set({ status: "archived" }).where(eq(environments.id, f.local.id));
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, f.pluginId));
    const options = await projectEnvironmentOptions(db, f.companyId);
    expect(options.groups.flatMap(group => group.environments).map(value => value.id)).toEqual([f.sandbox.id]);
    for (const environmentId of [f.local.id, f.ssh.id, f.computer.id, randomUUID()]) {
      await expect(resolveProjectEnvironment(db, f.companyId, null, { environmentId })).rejects.toMatchObject({ status: 409 });
    }
  });

  it("keeps a cold worker's storage identity, but refuses an archived default", async () => {
    const f = await fixture();
    await db.update(instanceSettings).set({ defaultEnvironmentId: f.computer.id });
    await db.update(plugins).set({ status: "error" }).where(eq(plugins.id, f.pluginId));
    expect(await resolveProjectEnvironment(db, f.companyId, null)).toMatchObject({ executionWorkspacePolicy: { storageProviderPluginId: f.pluginId } });
    await db.update(environments).set({ status: "archived" }).where(eq(environments.id, f.computer.id));
    expect((await projectEnvironmentOptions(db, f.companyId)).error).toBeTruthy();
    await expect(resolveProjectEnvironment(db, f.companyId, null)).rejects.toMatchObject({ status: 409 });
  });

  it.each(["instance", "primary"] as const)("creates repository-free private tasks despite an archived %s default", async source => {
    const f = await fixture();
    const userId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Person", email: `${userId}@example.com`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "operator" });
    await db.update(environments).set({ status: "archived" }).where(eq(environments.id, f.computer.id));
    if (source === "instance") await db.update(instanceSettings).set({ defaultEnvironmentId: f.computer.id });
    else {
      await db.update(agents).set({ defaultEnvironmentId: f.computer.id }).where(eq(agents.id, f.input.agentId));
      await db.insert(userCompanyPreferences).values({ companyId: f.companyId, userId, primaryAgentId: f.input.agentId });
    }
    const task = await issueService(db).create(f.companyId, { title: "Private note", visibility: "private", createdByUserId: userId });
    expect(task.visibility).toBe("private");
    const project = await projectService(db).getById(task.projectId!);
    expect(project?.name).toBe("My private tasks");
    expect(project?.executionWorkspacePolicy).toBeNull();
    expect(project?.workspaces).toEqual([]);
  });

  it("honors managed-only and forced Kubernetes execution policy", async () => {
    const f = await fixture();
    await db.update(environments).set({ metadata: { managedByPaperclip: true, managedKubernetesSandbox: true } }).where(eq(environments.id, f.sandbox.id));
    await db.update(instanceSettings).set({ defaultEnvironmentId: f.local.id, experimental: { enableManagedSandboxOnly: true } });
    const managed = await projectEnvironmentOptions(db, f.companyId);
    expect(managed.defaultEnvironmentId).toBe(f.sandbox.id);
    expect(managed.groups.flatMap(group => group.environments).map(value => value.id)).not.toContain(f.local.id);
    await db.update(instanceSettings).set({ general: { executionMode: "kubernetes" } });
    const forced = await projectEnvironmentOptions(db, f.companyId);
    expect(forced.groups).toEqual([{ storageProviderPluginId: null, environments: [{ id: f.sandbox.id, name: f.sandbox.name }] }]);
    await expect(resolveProjectEnvironment(db, f.companyId, null, { environmentId: f.computer.id })).rejects.toMatchObject({ status: 409 });
  });

  it("exposes safe groups and saves a validated choice through the normal API", async () => {
    const f = await fixture();
    function app(actor: Express.Request["actor"]) {
      const result = express(); result.use(express.json());
      result.use((req, _res, next) => { req.actor = actor; next(); });
      result.use("/api", projectRoutes(db)); result.use(errorHandler); return result;
    }
    await db.insert(authUsers).values({ id: "person", name: "Person", email: "person@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: "person", status: "active", membershipRole: "member" });
    const board = app({ type: "board", userId: "person", source: "session", companyIds: [f.companyId] });
    const url = `/api/companies/${f.companyId}`;
    const options = await request(board).get(`${url}/project-environments`);
    expect(options.status).toBe(200);
    expect(options.body.groups).toHaveLength(2);
    const created = await request(board).post(`${url}/projects`).send({ name: "Selected", environmentId: f.computer.id });
    expect(created.status).toBe(201);
    expect(created.body.executionWorkspacePolicy).toMatchObject({ storageProviderPluginId: f.pluginId });
    expect(created.body.environmentId).toBe(f.computer.id);
    const first = await request(board).post(`${url}/projects`).send({ name: "First core project" });
    const second = await request(board).post(`${url}/projects`).send({ name: "Second core project" });
    const updateUrl = `/api/projects/${first.body.id}`;
    const saved = await request(board).patch(updateUrl).send({ environmentId: f.ssh.id, expectedStorageProviderPluginId: null });
    expect(saved.status).toBe(200);
    expect(saved.body.environmentId).toBe(f.ssh.id);
    expect((await request(board).get(`/api/projects/${second.body.id}`)).body.environmentId).toBe(f.sandbox.id);
    expect((await db.select().from(instanceSettings))[0].defaultEnvironmentId).toBe(f.sandbox.id);
    expect((await request(app({ type: "none" })).patch(updateUrl).send({ environmentId: f.local.id })).status).toBe(404);
    expect((await request(app({ type: "agent", agentId: f.input.agentId, companyId: randomUUID() }))
      .patch(updateUrl).send({ environmentId: f.local.id })).status).toBe(404);
    expect((await request(board).patch(updateUrl).send({ environmentId: f.computer.id, expectedStorageProviderPluginId: null })).status).toBe(409);
    expect((await projectService(db).getById(first.body.id))?.environmentId).toBe(f.ssh.id);
    const denied = app({ type: "agent", agentId: f.input.agentId, companyId: randomUUID() });
    expect((await request(denied).get(`${url}/project-environments`)).status).toBe(403);
    expect((await request(app({ type: "none" })).get(`${url}/project-environments`)).status).toBe(401);
    const agent = app({ type: "agent", agentId: f.input.agentId, companyId: f.companyId });
    expect((await request(agent).get(`${url}/project-environments`)).status).toBe(200);
    await db.update(environments).set({ driver: "plugin", config: f.computer.config }).where(eq(environments.id, f.ssh.id));
    const changed = await request(board).post(`${url}/projects`).send({ name: "Changed storage", environmentId: f.ssh.id,
      expectedStorageProviderPluginId: null });
    expect(changed.status).toBe(409);
    expect(changed.body.details.code).toBe("project_environment_incompatible");
    const invalid = await request(board).post(`${url}/projects`).send({ name: "Invalid", environmentId: randomUUID() });
    expect(invalid.status).toBe(409);
  });
});
