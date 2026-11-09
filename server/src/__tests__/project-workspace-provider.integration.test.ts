import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, createDb, executionWorkspaces, heartbeatRuns, issues, pluginCompanySettings, plugins, projects } from "@paperclipai/db";
import { createPluginWorkspaceFixture } from "./helpers/plugin-workspaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { effectiveProjectWorkspacePolicy, listProjectWorkspaceProviders, resolveProjectWorkspaceProvider, sourcelessProjectWorkspacePolicy } from "../services/project-workspace-provider.js";
import { preparePluginWorkspace } from "../services/plugin-workspaces.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { buildExecutionWorkspaceAdapterConfig, parseIssueExecutionWorkspaceSettings, resolveEffectiveWorkspaceStrategyType, resolveExecutionWorkspaceMode } from "../services/execution-workspace-policy.js";
import { ensurePersonalPrivateProject, projectService } from "../services/projects.js";
import { projectRoutes } from "../routes/projects.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("installed project workspace defaults", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("project-provider-defaults");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => { await db.execute(sql`truncate companies, plugins cascade`); });

  async function fixture() {
    const f = await createPluginWorkspaceFixture(db);
    const [plugin] = await db.select().from(plugins).where(eq(plugins.id, f.pluginId));
    await db.update(plugins).set({ manifestJson: { ...plugin.manifestJson, workspaceProvider: {
      ...plugin.manifestJson.workspaceProvider!, defaultForProjects: { mode: "isolated_workspace", strategy: "git_worktree" },
    } } }).where(eq(plugins.id, f.pluginId));
    return f;
  }

  it("attaches a new project to the installed default and leaves existing projects where they are", async () => {
    const f = await fixture();
    await db.update(projects).set({ executionWorkspacePolicy: null }).where(eq(projects.id, f.input.projectId));
    const svc = projectService(db);
    const created = await svc.create(f.companyId, { name: "New project" });
    expect(created.executionWorkspacePolicy).toMatchObject({ enabled: true, storageProviderPluginId: f.pluginId });
    expect(created.workspaceProvider).toMatchObject({ source: "project", pluginId: f.pluginId });
    const existing = await svc.getById(f.input.projectId);
    expect(existing!.executionWorkspacePolicy).toBeNull();
    expect(existing!.workspaceProvider).toMatchObject({ source: "core", pluginId: null });
    expect(await effectiveProjectWorkspacePolicy(db, f.companyId, null, true)).toBeNull();
    expect(await preparePluginWorkspace(db, f.workers, { ...f.input, selectedProviderPluginId: null })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it("creates a project on Core storage when no default is installed, and keeps it there after one arrives", async () => {
    const f = await createPluginWorkspaceFixture(db);
    const svc = projectService(db);
    const created = await svc.create(f.companyId, { name: "Before the provider" });
    expect(created.executionWorkspacePolicy).toBeNull();
    const [plugin] = await db.select().from(plugins).where(eq(plugins.id, f.pluginId));
    await db.update(plugins).set({ manifestJson: { ...plugin.manifestJson, workspaceProvider: {
      ...plugin.manifestJson.workspaceProvider!, defaultForProjects: { mode: "isolated_workspace", strategy: "git_worktree" },
    } } }).where(eq(plugins.id, f.pluginId));
    expect((await svc.getById(created.id))!.workspaceProvider).toMatchObject({ source: "core", pluginId: null });
  });

  it("keeps an explicit creation choice", async () => {
    const f = await fixture();
    const other = await createPluginWorkspaceFixture(db, f.companyId);
    const svc = projectService(db);
    expect((await svc.create(f.companyId, { name: "Local", executionWorkspacePolicy: { enabled: true, storageProviderPluginId: null } })).workspaceProvider)
      .toMatchObject({ source: "project", pluginId: null });
    expect((await svc.create(f.companyId, { name: "Other", executionWorkspacePolicy: { enabled: true, storageProviderPluginId: other.pluginId } })).workspaceProvider)
      .toMatchObject({ source: "project", pluginId: other.pluginId });
  });

  it("keeps a personal project on the installed default", async () => {
    const f = await fixture();
    const project = await ensurePersonalPrivateProject(db, f.companyId, "user-one");
    expect(project.executionWorkspacePolicy).toMatchObject({ storageProviderPluginId: f.pluginId });
  });

  it.each(["create", "import"] as const)("%s leaves an unspecified task mode inherited from the effective provider", async method => {
    const f = await fixture();
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    let issueId: string;
    if (method === "create") {
      const created = await issueService(db).create(f.companyId, { title: "Use inherited storage", projectId: f.input.projectId, assigneeAgentId: f.input.agentId });
      issueId = created.id;
    } else {
      issueId = randomUUID();
      await issueService(db).importIssues(f.companyId, [{ id: issueId, ref: "inherited", title: "Import inherited storage", projectId: f.input.projectId,
        projectWorkspaceId: null, description: null, assigneeAgentId: f.input.agentId, status: "todo", priority: "medium", billingCode: null,
        assigneeAdapterOverrides: null, executionWorkspaceSettings: null, labelIds: [], monitorNotes: null, monitorScheduledBy: null }]);
    }
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task.executionWorkspaceSettings?.mode).toBeUndefined();
    const policy = await effectiveProjectWorkspacePolicy(db, f.companyId, { enabled: true, storageProviderPluginId: f.pluginId }, true);
    const settings = parseIssueExecutionWorkspaceSettings(task.executionWorkspaceSettings);
    const mode = resolveExecutionWorkspaceMode({ projectPolicy: policy, issueSettings: settings, legacyUseProjectWorkspace: null });
    const config = buildExecutionWorkspaceAdapterConfig({ agentConfig: {}, projectPolicy: policy, issueSettings: settings, mode, legacyUseProjectWorkspace: null });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.input.agentId,
      issueId, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    await preparePluginWorkspace(db, f.workers, { ...f.input, runId: run.id, issueId, mode, strategy: resolveEffectiveWorkspaceStrategyType(mode, config) });
    expect(f.calls[0].operation).toMatchObject({ mode: "isolated_workspace", strategy: "git_worktree" });
  });

  it("keeps a plugin-backed project attached through every policy update", async () => {
    const f = await fixture();
    const other = await createPluginWorkspaceFixture(db, f.companyId);
    const workspace = await preparePluginWorkspace(db, f.workers, f.input);
    const svc = projectService(db);
    const kept = await svc.update(f.input.projectId, { executionWorkspacePolicy: { enabled: true, sharedWorkspaceConcurrency: "serialize" } });
    expect(kept!.executionWorkspacePolicy).toMatchObject({ storageProviderPluginId: f.pluginId, sharedWorkspaceConcurrency: "serialize" });
    expect((await svc.update(f.input.projectId, { executionWorkspacePolicy: null }))!.workspaceProvider).toMatchObject({ source: "project", pluginId: f.pluginId });
    for (const storageProviderPluginId of [null, other.pluginId]) {
      await expect(svc.update(f.input.projectId, { executionWorkspacePolicy: { enabled: true, storageProviderPluginId } }))
        .rejects.toThrow("stays attached");
    }
    expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace!.id)))[0]).toEqual(workspace);
  });

  it("lets a Core project move to a storage plugin, and then keeps it there", async () => {
    const f = await fixture();
    await db.update(projects).set({ executionWorkspacePolicy: null }).where(eq(projects.id, f.input.projectId));
    const svc = projectService(db);
    expect((await svc.update(f.input.projectId, { executionWorkspacePolicy: { enabled: true, storageProviderPluginId: f.pluginId } }))!.workspaceProvider)
      .toMatchObject({ source: "project", pluginId: f.pluginId });
    await expect(svc.update(f.input.projectId, { executionWorkspacePolicy: { enabled: true, storageProviderPluginId: null } })).rejects.toThrow("stays attached");
  });

  it("preserves explicit alternatives and the explicit Core/local choice", async () => {
    const f = await fixture(), other = await createPluginWorkspaceFixture(db, f.companyId);
    const providers = await listProjectWorkspaceProviders(db, f.companyId);
    expect(resolveProjectWorkspaceProvider({ enabled: true, storageProviderPluginId: other.pluginId }, providers, true))
      .toMatchObject({ source: "project", pluginId: other.pluginId });
    const local = { enabled: true, storageProviderPluginId: null };
    await db.update(projects).set({ executionWorkspacePolicy: local }).where(eq(projects.id, f.input.projectId));
    expect((await projectService(db).getById(f.input.projectId))!.executionWorkspacePolicy).toEqual(local);
    expect(await preparePluginWorkspace(db, f.workers, { ...f.input, selectedProviderPluginId: null })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it.each(["disabled", "uninstalled"] as const)("does not attach a new project to an instance %s provider", async status => {
    const f = await fixture();
    await db.update(plugins).set({ status }).where(eq(plugins.id, f.pluginId));
    expect((await projectService(db).create(f.companyId, { name: "New project" })).executionWorkspacePolicy).toBeNull();
  });

  it("scopes company enablement and does not borrow another company's override", async () => {
    const f = await fixture();
    const [other] = await db.insert(companies).values({ name: "Other", issuePrefix: "OTH" }).returning();
    await db.insert(pluginCompanySettings).values({ companyId: f.companyId, pluginId: f.pluginId, enabled: false });
    await db.insert(pluginCompanySettings).values({ companyId: other.id, pluginId: f.pluginId, enabled: true });
    const svc = projectService(db);
    expect((await svc.create(f.companyId, { name: "Disabled here" })).executionWorkspacePolicy).toBeNull();
    expect((await svc.create(other.id, { name: "Enabled here" })).executionWorkspacePolicy).toMatchObject({ storageProviderPluginId: f.pluginId });
    await expect(effectiveProjectWorkspacePolicy(db, f.companyId, { enabled: true, storageProviderPluginId: f.pluginId }, true))
      .rejects.toThrow("unavailable");
  });

  it.each(["error", "installed", "upgrade_pending", "ready"] as const)("retains the selected %s provider when its worker is unavailable", async status => {
    const f = await fixture();
    await db.update(plugins).set({ status }).where(eq(plugins.id, f.pluginId));
    expect(await effectiveProjectWorkspacePolicy(db, f.companyId, { enabled: true, storageProviderPluginId: f.pluginId }, true)).toMatchObject({ storageProviderPluginId: f.pluginId });
    await expect(preparePluginWorkspace(db, undefined, f.input)).rejects.toThrow("unavailable");
    expect(await db.select().from(executionWorkspaces)).toHaveLength(0);
  });

  it("never falls back when the attached provider is disabled during preparation", async () => {
    const f = await fixture();
    const policy = await effectiveProjectWorkspacePolicy(db, f.companyId, { enabled: true, storageProviderPluginId: f.pluginId }, true);
    await db.insert(pluginCompanySettings).values({ companyId: f.companyId, pluginId: f.pluginId, enabled: false });
    await expect(preparePluginWorkspace(db, f.workers, { ...f.input, selectedProviderPluginId: policy!.storageProviderPluginId }))
      .rejects.toThrow("unavailable");
    expect(await db.select().from(executionWorkspaces)).toHaveLength(0);
  });

  it("asks for a choice when creating a project with conflicting defaults, and leaves existing projects working", async () => {
    const f = await fixture();
    const other = await createPluginWorkspaceFixture(db, f.companyId);
    const [plugin] = await db.select().from(plugins).where(eq(plugins.id, f.pluginId));
    await db.update(plugins).set({ manifestJson: { ...plugin.manifestJson, id: `test.${other.pluginId}` } }).where(eq(plugins.id, other.pluginId));
    const svc = projectService(db);
    await expect(svc.create(f.companyId, { name: "Ambiguous" })).rejects.toThrow("Multiple workspace storage plugins");
    expect((await svc.create(f.companyId, { name: "Chosen", executionWorkspacePolicy: { enabled: true, storageProviderPluginId: f.pluginId } })).workspaceProvider)
      .toMatchObject({ pluginId: f.pluginId, error: null });
    expect((await svc.getById(f.input.projectId))!.workspaceProvider).toMatchObject({ pluginId: f.pluginId, error: null });
  });

  it.each([
    { enabled: false },
    { enabled: true, defaultMode: "shared_workspace" },
    { enabled: true, workspaceStrategy: { type: "project_primary" } },
  ])("rejects incompatible explicit settings: %j", async policy => {
    const f = await fixture();
    await expect(effectiveProjectWorkspacePolicy(db, f.companyId, { ...policy, storageProviderPluginId: f.pluginId }, true)).rejects.toThrow("explicit project workspace settings");
  });

  it("ignores saved storage for a project with no source", () => {
    const pluginId = randomUUID();
    expect(sourcelessProjectWorkspacePolicy(null)).toBeNull();
    expect(sourcelessProjectWorkspacePolicy({ enabled: true, storageProviderPluginId: pluginId })).toBeNull();
    expect(sourcelessProjectWorkspacePolicy({ enabled: false, storageProviderPluginId: null })).toBeNull();
    expect(sourcelessProjectWorkspacePolicy({ enabled: true })).toEqual({ enabled: true });
    expect(sourcelessProjectWorkspacePolicy({ enabled: true, defaultMode: "isolated_workspace", storageProviderPluginId: pluginId }))
      .toEqual({ enabled: true, defaultMode: "isolated_workspace" });
  });

  it("preserves compatible explicit fields while supplying only missing defaults", async () => {
    const f = await fixture();
    const policy = { enabled: true, defaultMode: "operator_branch", storageProviderPluginId: f.pluginId, workspaceStrategy: { type: "git_worktree", baseRef: "release", branchTemplate: "kept" } };
    expect(await effectiveProjectWorkspacePolicy(db, f.companyId, policy, true)).toEqual(policy);
    expect(await effectiveProjectWorkspacePolicy(db, f.companyId, { enabled: true, storageProviderPluginId: f.pluginId }, false)).toEqual({ enabled: true, storageProviderPluginId: f.pluginId });
  });

  it("retains both plugin and local workspace ownership when defaults change", async () => {
    const f = await fixture();
    const workspace = await preparePluginWorkspace(db, f.workers, f.input);
    await db.update(projects).set({ executionWorkspacePolicy: { enabled: true, storageProviderPluginId: null } }).where(eq(projects.id, f.input.projectId));
    expect(await preparePluginWorkspace(db, f.workers, { ...f.input, existingWorkspaceId: workspace!.id })).toMatchObject({ id: workspace!.id });
    await db.update(plugins).set({ status: "error" }).where(eq(plugins.id, f.pluginId));
    await expect(preparePluginWorkspace(db, f.workers, { ...f.input, existingWorkspaceId: workspace!.id })).rejects.toThrow("unavailable");
    const [local] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: f.input.projectId,
      projectWorkspaceId: f.input.projectWorkspaceId, mode: "shared_workspace", strategyType: "project_primary", name: "Retained local", providerType: "local_fs", cwd: "/fixture/kept" }).returning();
    await db.update(projects).set({ executionWorkspacePolicy: null }).where(eq(projects.id, f.input.projectId));
    expect(await preparePluginWorkspace(db, f.workers, { ...f.input, existingWorkspaceId: local.id })).toBeNull();
    expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, local.id)))[0]).toEqual(local);
  });

  it("exposes attachment through the normal API with company access checks", async () => {
    const f = await fixture();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", isInstanceAdmin: true }; next(); });
    app.use("/api", projectRoutes(db));
    app.use(errorHandler);
    const url = `/api/projects/${f.input.projectId}`;
    expect((await request(app).get(url)).body.workspaceProvider).toMatchObject({ source: "project", pluginId: f.pluginId });
    const patch = await request(app).patch(url).send({ executionWorkspacePolicy: { enabled: true, storageProviderPluginId: null } });
    expect(patch.status).toBe(409);
    const kept = await request(app).patch(url).send({ executionWorkspacePolicy: { enabled: true } });
    expect(kept.status).toBe(200);
    expect(kept.body.executionWorkspacePolicy).toMatchObject({ storageProviderPluginId: f.pluginId });
    const denied = express();
    denied.use((req, _res, next) => { req.actor = { type: "agent", agentId: f.input.agentId, companyId: "00000000-0000-4000-8000-000000000099" }; next(); });
    denied.use("/api", projectRoutes(db)); denied.use(errorHandler);
    expect((await request(denied).get(url)).status).toBe(404);
  });
});
