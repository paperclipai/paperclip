import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, createDb, executionWorkspaces, heartbeatRuns, issues, pluginCompanySettings, plugins, projects } from "@paperclipai/db";
import { createPluginWorkspaceFixture } from "./helpers/plugin-workspaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { effectiveProjectWorkspacePolicy, listProjectWorkspaceProviders, resolveProjectWorkspaceProvider } from "../services/project-workspace-provider.js";
import { preparePluginWorkspace } from "../services/plugin-workspaces.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { buildExecutionWorkspaceAdapterConfig, parseIssueExecutionWorkspaceSettings, resolveEffectiveWorkspaceStrategyType, resolveExecutionWorkspaceMode } from "../services/execution-workspace-policy.js";
import { projectService } from "../services/projects.js";
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
    await db.update(projects).set({ executionWorkspacePolicy: null }).where(eq(projects.id, f.input.projectId));
    return f;
  }

  it("resolves new and existing unconfigured projects without persisting the inherited choice", async () => {
    const f = await fixture();
    const svc = projectService(db);
    const created = await svc.create(f.companyId, { name: "New project" });
    for (const projectId of [created!.id, f.input.projectId]) {
      const project = await svc.getById(projectId);
      expect(project!.workspaceProvider).toMatchObject({ source: "default", pluginId: f.pluginId });
      expect(project!.executionWorkspacePolicy).toBeNull();
    }
    expect((await svc.getById(f.input.projectId))!.workspaceProvider!.effectivePolicy).toMatchObject({
      enabled: true, defaultMode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" }, storageProviderPluginId: f.pluginId,
    });
    expect(await executionWorkspaceService(db).resolveSourceWorkspaceStrategy({ companyId: f.companyId,
      projectId: f.input.projectId, sourceWorkspaceId: f.input.projectWorkspaceId, executionWorkspacePolicy: null })).toBe("git_worktree");
    const prepared = await preparePluginWorkspace(db, f.workers, f.input);
    expect(prepared).toMatchObject({ providerType: "plugin" });
    expect(f.calls[0].operation).toMatchObject({ mode: "isolated_workspace", strategy: "git_worktree" });
  });

  it.each(["create", "import"] as const)("%s leaves an unspecified task mode inherited from the effective provider", async method => {
    const f = await fixture();
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.update(projects).set({ executionWorkspacePolicy: { enabled: true } }).where(eq(projects.id, f.input.projectId));
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
    const policy = await effectiveProjectWorkspacePolicy(db, f.companyId, { enabled: true }, true);
    const settings = parseIssueExecutionWorkspaceSettings(task.executionWorkspaceSettings);
    const mode = resolveExecutionWorkspaceMode({ projectPolicy: policy, issueSettings: settings, legacyUseProjectWorkspace: null });
    const config = buildExecutionWorkspaceAdapterConfig({ agentConfig: {}, projectPolicy: policy, issueSettings: settings, mode, legacyUseProjectWorkspace: null });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.input.agentId,
      issueId, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    await preparePluginWorkspace(db, f.workers, { ...f.input, runId: run.id, issueId, mode, strategy: resolveEffectiveWorkspaceStrategyType(mode, config) });
    expect(f.calls[0].operation).toMatchObject({ mode: "isolated_workspace", strategy: "git_worktree" });
  });

  it("pins and unpins the same effective owner without retiring its active workspace", async () => {
    const f = await fixture();
    const workspace = await preparePluginWorkspace(db, f.workers, f.input);
    const svc = projectService(db);
    expect((await svc.update(f.input.projectId, { executionWorkspacePolicy: { enabled: true, storageProviderPluginId: f.pluginId } }))!.workspaceProvider)
      .toMatchObject({ source: "project", pluginId: f.pluginId });
    expect((await svc.update(f.input.projectId, { executionWorkspacePolicy: { enabled: true } }))!.workspaceProvider)
      .toMatchObject({ source: "default", pluginId: f.pluginId });
    expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace!.id)))[0]).toEqual(workspace);
    await expect(svc.update(f.input.projectId, { executionWorkspacePolicy: { enabled: true, storageProviderPluginId: null } }))
      .rejects.toThrow("Retire managed execution workspaces");
  });

  it("preserves explicit alternatives and the explicit Core/local choice", async () => {
    const f = await fixture(), other = await createPluginWorkspaceFixture(db, f.companyId);
    const providers = await listProjectWorkspaceProviders(db, f.companyId);
    expect(resolveProjectWorkspaceProvider({ enabled: true, storageProviderPluginId: other.pluginId }, providers, true))
      .toMatchObject({ source: "project", pluginId: other.pluginId });
    const local = { enabled: true, storageProviderPluginId: null };
    await projectService(db).update(f.input.projectId, { executionWorkspacePolicy: local });
    expect((await projectService(db).getById(f.input.projectId))!.executionWorkspacePolicy).toEqual(local);
    expect(await preparePluginWorkspace(db, f.workers, f.input)).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it.each(["disabled", "uninstalled"] as const)("does not inherit an instance %s provider", async status => {
    const f = await fixture();
    await db.update(plugins).set({ status }).where(eq(plugins.id, f.pluginId));
    expect(await effectiveProjectWorkspacePolicy(db, f.companyId, null, true)).toBeNull();
  });

  it("scopes company enablement and does not borrow another company's override", async () => {
    const f = await fixture();
    const [other] = await db.insert(companies).values({ name: "Other", issuePrefix: "OTH" }).returning();
    await db.insert(pluginCompanySettings).values({ companyId: f.companyId, pluginId: f.pluginId, enabled: false });
    await db.insert(pluginCompanySettings).values({ companyId: other.id, pluginId: f.pluginId, enabled: true });
    expect(await effectiveProjectWorkspacePolicy(db, f.companyId, null, true)).toBeNull();
    expect(await effectiveProjectWorkspacePolicy(db, other.id, null, true)).toMatchObject({ storageProviderPluginId: f.pluginId });
    await expect(effectiveProjectWorkspacePolicy(db, f.companyId, { enabled: true, storageProviderPluginId: f.pluginId }, true))
      .rejects.toThrow("unavailable");
  });

  it.each(["error", "installed", "upgrade_pending", "ready"] as const)("retains the selected %s provider when its worker is unavailable", async status => {
    const f = await fixture();
    await db.update(plugins).set({ status }).where(eq(plugins.id, f.pluginId));
    expect(await effectiveProjectWorkspacePolicy(db, f.companyId, null, true)).toMatchObject({ storageProviderPluginId: f.pluginId });
    await expect(preparePluginWorkspace(db, undefined, f.input)).rejects.toThrow("unavailable");
    expect(await db.select().from(executionWorkspaces)).toHaveLength(0);
  });

  it("never falls back when a selected default is disabled during preparation", async () => {
    const f = await fixture();
    const policy = await effectiveProjectWorkspacePolicy(db, f.companyId, null, true);
    await db.insert(pluginCompanySettings).values({ companyId: f.companyId, pluginId: f.pluginId, enabled: false });
    await expect(preparePluginWorkspace(db, f.workers, { ...f.input, selectedProviderPluginId: policy!.storageProviderPluginId }))
      .rejects.toThrow("unavailable");
    expect(await db.select().from(executionWorkspaces)).toHaveLength(0);
  });

  it("reports conflicting declarations and still lets configuration select an alternative", async () => {
    const f = await fixture();
    const other = await createPluginWorkspaceFixture(db, f.companyId);
    const [plugin] = await db.select().from(plugins).where(eq(plugins.id, f.pluginId));
    await db.update(plugins).set({ manifestJson: { ...plugin.manifestJson, id: `test.${other.pluginId}` } }).where(eq(plugins.id, other.pluginId));
    await expect(preparePluginWorkspace(db, f.workers, f.input)).rejects.toThrow("Multiple workspace storage plugins");
    const project = await projectService(db).getById(f.input.projectId);
    expect(project!.workspaceProvider!.error).toContain("Select a storage provider in project configuration");
    expect(await effectiveProjectWorkspacePolicy(db, f.companyId, { enabled: true, storageProviderPluginId: f.pluginId }, true))
      .toMatchObject({ storageProviderPluginId: f.pluginId });
  });

  it.each([
    { enabled: false },
    { enabled: true, defaultMode: "shared_workspace" },
    { enabled: true, workspaceStrategy: { type: "project_primary" } },
  ])("rejects incompatible explicit settings: %j", async policy => {
    const f = await fixture();
    await expect(effectiveProjectWorkspacePolicy(db, f.companyId, policy, true)).rejects.toThrow("explicit project workspace settings");
  });

  it("preserves compatible explicit fields while supplying only missing defaults", async () => {
    const f = await fixture();
    const policy = { enabled: true, defaultMode: "operator_branch", workspaceStrategy: { type: "git_worktree", baseRef: "release", branchTemplate: "kept" } };
    expect(await effectiveProjectWorkspacePolicy(db, f.companyId, policy, true)).toEqual({ ...policy, storageProviderPluginId: f.pluginId });
    expect(await effectiveProjectWorkspacePolicy(db, f.companyId, null, false)).toEqual({ enabled: true, storageProviderPluginId: f.pluginId });
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

  it("exposes inherited selection through the normal API and round-trips overrides with company access checks", async () => {
    const f = await fixture();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", isInstanceAdmin: true }; next(); });
    app.use("/api", projectRoutes(db));
    app.use(errorHandler);
    const url = `/api/projects/${f.input.projectId}`;
    expect((await request(app).get(url)).body.workspaceProvider).toMatchObject({ source: "default", pluginId: f.pluginId });
    const patch = await request(app).patch(url).send({ executionWorkspacePolicy: { enabled: true, storageProviderPluginId: null } });
    expect(patch.status).toBe(200);
    expect(patch.body.workspaceProvider).toMatchObject({ source: "project", pluginId: null });
    const inherit = await request(app).patch(url).send({ executionWorkspacePolicy: { enabled: true } });
    expect(inherit.status).toBe(200);
    expect(inherit.body.executionWorkspacePolicy).not.toHaveProperty("storageProviderPluginId");
    expect(inherit.body.workspaceProvider).toMatchObject({ source: "default", pluginId: f.pluginId });
    const denied = express();
    denied.use((req, _res, next) => { req.actor = { type: "agent", agentId: f.input.agentId, companyId: "00000000-0000-4000-8000-000000000099" }; next(); });
    denied.use("/api", projectRoutes(db)); denied.use(errorHandler);
    expect((await request(denied).get(url)).status).toBe(404);
  });
});
