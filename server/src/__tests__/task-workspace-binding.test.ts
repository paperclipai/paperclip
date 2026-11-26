import { findNativeChatWorkspaceScope } from "../services/native-runtime/native-chat-workspace.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { assertGitSensitiveAdapterWorkspaceValid, createHeartbeatWorkspaceResolver } from "../services/heartbeat/workspaces.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { taskWorkspaceRoutes } from "../routes/task-workspaces.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agents, authUsers, companies, companyMemberships, completionContracts, createDb, environmentLeases, executionWorkspaceRepositories, executionWorkspaceRepositoryAccess, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, workspaceOperations, principalPermissionGrants, projects, projectWorkspaces } from "@paperclipai/db";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { authorizationService, canActorReadExecutionWorkspace } from "../services/authorization.js";
import { assertChatExecutionDefaultsAccess } from "../services/chat-execution-defaults.js";
import { assertTaskWorkspaceAccess } from "../services/task-workspace-source-access.js";
import { deleteCompany } from "../services/company-deletion.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("task-owned workspace bindings", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-task-workspace-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Task files", issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Write a report" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId: null, sourceIssueId: issueId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Task files", cwd: `/tmp/task-${issueId}` });
    return { companyId, issueId, workspaceId, actor: { type: "board" as const, source: "local_implicit" as const, isInstanceAdmin: true } };
  }

  it("persists a projectless binding, preserves it on project edits, and lists it in overview", async () => {
    const f = await fixture(), svc = executionWorkspaceService(db);
    await svc.bindTaskWorkspace(f.companyId, f.issueId, f.workspaceId);
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Reports" });
    const updated = await issueService(db).update(f.issueId, { projectId });
    expect(updated?.executionWorkspaceId).toBe(f.workspaceId);
    const view = await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor);
    expect(view.workspace?.projectId).toBeNull();
    expect(view.workspace?.cwd).toBe(`/tmp/task-${f.issueId}`);
    expect(view.bindingRevision).toBe(1);
    const overview = await svc.listOverview(f.companyId, { limit: 20, offset: 0 });
    expect(overview.items).toEqual(expect.arrayContaining([expect.objectContaining({ workspaceId: f.workspaceId, projectId: null })]));
  });

  it.each(["replace", "clear"] as const)("retains unbound task privacy and old root ownership when an update %ss its source", async action => {
    const f = await fixture(), service = executionWorkspaceService(db);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-update-provenance-"));
    try {
      const oldCwd = path.join(root, "old"), newCwd = path.join(root, "new");
      await fs.mkdir(oldCwd);
      await fs.mkdir(newCwd);
      await fs.writeFile(path.join(oldCwd, "private.txt"), "Retained old files");
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Original source policy" }).returning();
      const [ancestor, replacement] = await db.insert(issues).values([
        { companyId: f.companyId, title: "Earlier private source" },
        { companyId: f.companyId, title: "Replacement task" },
      ]).returning();
      await db.update(executionWorkspaces).set({ sourceIssueId: ancestor.id })
        .where(eq(executionWorkspaces.id, f.workspaceId));
      await db.update(executionWorkspaces).set({ cwd: oldCwd, projectId: project.id, sourceIssueId: f.issueId })
        .where(eq(executionWorkspaces.id, f.workspaceId));
      const changed = await service.update(f.workspaceId, { cwd: newCwd, projectId: null,
        sourceIssueId: action === "replace" ? replacement.id : null,
        metadata: { label: "replacement metadata", _issuePrivacySources: {} },
      });
      expect(changed).toMatchObject({ cwd: newCwd, projectId: null, metadata: {
        label: "replacement metadata", _issuePrivacySources: { [ancestor.id]: true, [f.issueId]: true },
      } });
      const retained = await db.select().from(executionWorkspaceRepositoryAccess)
        .where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
      expect(retained.map(entry => ({ kind: entry.kind, scopeId: entry.scopeId, cwd: entry.canonicalCwd })))
        .toEqual(expect.arrayContaining([
          { kind: "source", scopeId: f.workspaceId, cwd: await fs.realpath(oldCwd) },
          { kind: "project_source", scopeId: project.id, cwd: await fs.realpath(oldCwd) },
        ]));
      expect(retained.every(entry => ["source", "project_source", "shared_project_source"].includes(entry.kind))).toBe(true);
      expect(await fs.readFile(path.join(oldCwd, "private.txt"), "utf8")).toBe("Retained old files");
      expect(await service.update(f.workspaceId, { metadata: null })).toMatchObject({
        metadata: { _issuePrivacySources: { [ancestor.id]: true, [f.issueId]: true } },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back a source update when existing root provenance cannot be verified", async () => {
    const f = await fixture(), service = executionWorkspaceService(db);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-update-invalid-root-"));
    try {
      const oldCwd = path.join(root, "not-a-directory");
      await fs.writeFile(oldCwd, "Unverifiable former root");
      await db.update(executionWorkspaces).set({ cwd: oldCwd, metadata: { label: "original" } })
        .where(eq(executionWorkspaces.id, f.workspaceId));
      const [before] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
      await expect(service.update(f.workspaceId, { cwd: path.join(root, "new"), sourceIssueId: null, metadata: null }))
        .rejects.toThrow("Workspace files cannot be detached from unverifiable provenance");
      const [after] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
      expect(after).toEqual(before);
      expect(await db.select().from(executionWorkspaceRepositoryAccess)
        .where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["explicit", "channel"] as const)("persists the canonical null binding for a %s task-directory selection", async (source) => {
    const f = await fixture(), settings = instanceSettingsService(db), previous = await settings.getExperimental();
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    try {
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Legacy source" }).returning();
      const [workspace] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id,
        name: "Legacy folder", cwd: "/tmp/legacy-folder" }).returning();
      const created = await issueService(db).create(f.companyId, {
        title: "Use a new task folder", projectId: project.id,
        projectWorkspaceId: workspace.id, executionWorkspaceId: f.workspaceId,
        executionWorkspacePreference: "reuse_existing", executionWorkspaceSettings: { mode: "isolated_workspace" },
        workspaceSelection: { kind: "task_directory" }, workspaceSelectionSource: source, workspaceSelectionActor: f.actor,
      });
      const [stored] = await db.select().from(issues).where(eq(issues.id, created.id));
      expect(stored).toMatchObject({ projectId: project.id, projectWorkspaceId: null, executionWorkspaceId: null,
        executionWorkspacePreference: null, executionWorkspaceSettings: { mode: "shared_workspace" },
        workspaceSelection: { selection: { kind: "task_directory" }, source } });
      expect((await executionWorkspaceService(db).inspectTaskWorkspace(f.companyId, created.id, f.actor)).workspace).toBeNull();
    } finally {
      await settings.updateExperimental({ enableIsolatedWorkspaces: previous.enableIsolatedWorkspaces });
    }
  });

  it.each(["create", "createChild"] as const)("inherits a parent task folder through %s with isolated workspaces disabled", async (entryPoint) => {
    const f = await fixture(), settings = instanceSettingsService(db), previous = await settings.getExperimental();
    await settings.updateExperimental({ enableIsolatedWorkspaces: false });
    try {
      await executionWorkspaceService(db).bindTaskWorkspace(f.companyId, f.issueId, f.workspaceId);
      const tasks = issueService(db);
      const input = { title: "Continue parent work", workspaceSelectionActor: f.actor,
        workspaceSelection: { kind: "task_directory" as const }, workspaceSelectionSource: "channel" as const };
      const child = entryPoint === "create"
        ? await tasks.create(f.companyId, { ...input, parentId: f.issueId })
        : (await tasks.createChild(f.issueId, input)).issue;
      expect(child).toMatchObject({ parentId: f.issueId, projectId: null, executionWorkspaceId: f.workspaceId,
        executionWorkspacePreference: "reuse_existing" });
      const view = await executionWorkspaceService(db).inspectTaskWorkspace(f.companyId, child.id, f.actor);
      expect(view.workspace).toMatchObject({ id: f.workspaceId, cwd: `/tmp/task-${f.issueId}` });
      const explicit = await tasks.create(f.companyId, { ...input, title: "Explicit separate folder", parentId: f.issueId,
        workspaceSelectionSource: "explicit" });
      expect(explicit.executionWorkspaceId).toBeNull();
    } finally {
      await settings.updateExperimental({ enableIsolatedWorkspaces: previous.enableIsolatedWorkspaces });
    }
  });

  it.each([
    { entryPoint: "create", parentSource: "task_directory" },
    { entryPoint: "createChild", parentSource: "task_directory" },
    { entryPoint: "create", parentSource: "configured_source" },
    { entryPoint: "createChild", parentSource: "configured_source" },
  ] as const)("honors a child's explicit source through $entryPoint over its parent's $parentSource binding", async ({ entryPoint, parentSource }) => {
    const f = await fixture(), tasks = issueService(db), workspaces = executionWorkspaceService(db);
    const [sourceProject] = await db.insert(projects).values({ companyId: f.companyId, name: "Filesystem sources" }).returning();
    const [parentConfigured, childConfigured] = await db.insert(projectWorkspaces).values([
      { companyId: f.companyId, projectId: sourceProject.id, name: "Parent files", cwd: `/tmp/parent-${f.issueId}` },
      { companyId: f.companyId, projectId: sourceProject.id, name: "Child files", cwd: `/tmp/child-${f.issueId}` },
    ]).returning();
    if (parentSource === "configured_source") {
      await db.update(executionWorkspaces).set({ projectId: sourceProject.id, projectWorkspaceId: parentConfigured.id })
        .where(eq(executionWorkspaces.id, f.workspaceId));
    }
    await workspaces.bindTaskWorkspace(f.companyId, f.issueId, f.workspaceId);
    const parentBefore = await workspaces.inspectTaskWorkspace(f.companyId, f.issueId, f.actor);
    const input = { title: "Use child-specific files", projectWorkspaceId: childConfigured.id, workspaceSelectionActor: f.actor };
    const child = entryPoint === "create"
      ? await tasks.create(f.companyId, { ...input, parentId: f.issueId })
      : (await tasks.createChild(f.issueId, input)).issue;
    expect(child).toMatchObject({ parentId: f.issueId, projectId: null, projectWorkspaceId: childConfigured.id,
      executionWorkspaceId: null, executionWorkspacePreference: null });
    expect((await workspaces.inspectTaskWorkspace(f.companyId, child.id, f.actor)).workspace).toBeNull();
    const parentAfter = await workspaces.inspectTaskWorkspace(f.companyId, f.issueId, f.actor);
    expect(parentAfter.workspace).toEqual(parentBefore.workspace);
    expect(parentAfter.bindingRevision).toBe(parentBefore.bindingRevision);
  });

  it.each(["create", "createChild", "strategy_only"] as const)("preserves an explicit null source through %s while applying organizational defaults", async entryPoint => {
    const f = await fixture(), tasks = issueService(db), workspaces = executionWorkspaceService(db);
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Organizational defaults" }).returning();
    const [defaultSource, parentSource] = await db.insert(projectWorkspaces).values([
      { companyId: f.companyId, projectId: project.id, name: "Default files", cwd: `/tmp/default-${f.issueId}`, isPrimary: true },
      { companyId: f.companyId, projectId: project.id, name: "Parent files", cwd: `/tmp/parent-${f.issueId}` },
    ]).returning();
    await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issueId));
    await db.update(executionWorkspaces).set({ projectId: project.id, projectWorkspaceId: parentSource.id })
      .where(eq(executionWorkspaces.id, f.workspaceId));
    await workspaces.bindTaskWorkspace(f.companyId, f.issueId, f.workspaceId);
    const input = { title: "Clear parent workspace choice", projectWorkspaceId: null, workspaceSelectionActor: f.actor };
    const child = entryPoint === "create"
      ? await tasks.create(f.companyId, { ...input, parentId: f.issueId })
      : (await tasks.createChild(f.issueId, { ...input,
          ...(entryPoint === "strategy_only" ? { executionWorkspaceInheritanceMode: "strategy_only" as const } : {}),
        })).issue;
    expect(child).toMatchObject({ projectId: project.id, projectWorkspaceId: defaultSource.id,
      executionWorkspaceId: null, executionWorkspacePreference: null, workspaceSelection: null });
    expect((await workspaces.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).workspace)
      .toMatchObject({ id: f.workspaceId, projectWorkspaceId: parentSource.id });
  });

  it.each(["explicit", "channel", "inherited", "legacy"] as const)("keeps a reused task folder's null source authoritative for %s creation", async (source) => {
    const f = await fixture(), svc = executionWorkspaceService(db), tasks = issueService(db);
    const settings = instanceSettingsService(db), previous = await settings.getExperimental();
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    try {
      await svc.bindTaskWorkspace(f.companyId, f.issueId, f.workspaceId);
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Organization with unrelated source" }).returning();
      const [projectWorkspace] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id,
        name: "Unrelated repository", cwd: "/tmp/unrelated-source", isPrimary: true }).returning();
      let parentId: string | undefined;
      if (source === "inherited") {
        const [parent] = await db.insert(issues).values({ companyId: f.companyId, projectId: project.id,
          title: "Parent sharing task files", executionWorkspaceId: f.workspaceId }).returning();
        parentId = parent.id;
      }
      const created = await tasks.create(f.companyId, {
        title: "Reuse files under an organizational project", projectId: project.id, parentId,
        workspaceSelectionActor: f.actor,
        ...(source === "legacy"
          ? { executionWorkspaceId: f.workspaceId, projectWorkspaceId: projectWorkspace.id, executionWorkspacePreference: "reuse_existing" }
          : source === "inherited" ? {}
            : { workspaceSelection: { kind: "existing" as const, workspaceId: f.workspaceId }, workspaceSelectionSource: source }),
      });
      expect(created).toMatchObject({ projectId: project.id, executionWorkspaceId: f.workspaceId, projectWorkspaceId: null });
      const [original] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(original).toMatchObject({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: f.workspaceId });
      const { workspace } = await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor);
      expect(workspace).toMatchObject({ projectId: null, projectWorkspaceId: null, cwd: `/tmp/task-${f.issueId}` });
      for (const task of [created, original]) {
        await expect(assertGitSensitiveAdapterWorkspaceValid({
          adapterType: "codex_local", agentId: randomUUID(), issue: task,
          resolvedWorkspace: { cwd: workspace!.cwd!, source: "task_session", projectId: null, workspaceId: null,
            repoUrl: null, repoRef: null, workspaceHints: [], warnings: [] },
          executionWorkspace: { cwd: workspace!.cwd!, baseCwd: workspace!.cwd!, source: "task_session", projectId: null,
            workspaceId: null, repoUrl: null, repoRef: null, strategy: "project_primary", branchName: null,
            worktreePath: null, warnings: [], created: false, branchCreatedByRuntime: false },
          persistedExecutionWorkspace: workspace, executionTarget: { kind: "local" },
        })).resolves.toBeUndefined();
      }
    } finally {
      await settings.updateExperimental({ enableIsolatedWorkspaces: previous.enableIsolatedWorkspaces });
    }
  });

  it("replaces an old source with the selected binding's null source on an ordinary update", async () => {
    const f = await fixture(), svc = executionWorkspaceService(db), settings = instanceSettingsService(db);
    const previous = await settings.getExperimental();
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    try {
      await svc.bindTaskWorkspace(f.companyId, f.issueId, f.workspaceId);
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Organizational project" }).returning();
      const [source] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id,
        name: "Previous source", cwd: "/tmp/previous-source" }).returning();
      const [oldWorkspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: project.id,
        projectWorkspaceId: source.id, name: "Previous folder", cwd: source.cwd, mode: "shared_workspace", strategyType: "project_primary" }).returning();
      const [task] = await db.insert(issues).values({ companyId: f.companyId, projectId: project.id,
        projectWorkspaceId: source.id, executionWorkspaceId: oldWorkspace.id, title: "Switch to task files" }).returning();
      await svc.selectTaskWorkspace({ ...f, issueId: task.id, selection: { kind: "task_directory" },
        expectedBindingRevision: 0, requestKey: "superseded-before-raw-binding" });
      const updated = await issueService(db).update(task.id, { executionWorkspaceId: f.workspaceId });
      expect(updated).toMatchObject({ projectId: project.id, executionWorkspaceId: f.workspaceId, projectWorkspaceId: null,
        workspaceBindingRevision: 2, workspacePendingSelection: null });
      expect(await svc.applyPendingTaskWorkspaceSelection({ ...f, issueId: task.id, runId: randomUUID() })).toBe(false);
      expect((await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).workspace)
        .toMatchObject({ id: f.workspaceId, projectId: null, projectWorkspaceId: null, cwd: `/tmp/task-${f.issueId}` });
      const [previousWorkspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, oldWorkspace.id));
      expect(previousWorkspace).toMatchObject({ projectId: project.id, projectWorkspaceId: source.id, cwd: source.cwd });
    } finally {
      await settings.updateExperimental({ enableIsolatedWorkspaces: previous.enableIsolatedWorkspaces });
    }
  });

  it("queues explicit root changes without changing the current binding and applies at admission", async () => {
    const f = await fixture(), svc = executionWorkspaceService(db);
    await svc.bindTaskWorkspace(f.companyId, f.issueId, f.workspaceId);
    const request = { ...f, selection: { kind: "task_directory" as const }, expectedBindingRevision: 1, requestKey: "choose-task-directory" };
    expect(await svc.selectTaskWorkspace(request)).toMatchObject({ kind: "scheduled", applies: "next_normal_admission" });
    expect(await svc.selectTaskWorkspace(request)).toMatchObject({ kind: "scheduled" });
    await expect(svc.selectTaskWorkspace({ ...request, selection: { kind: "existing", workspaceId: f.workspaceId } })).rejects.toThrow("different intent");
    expect((await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).workspace?.id).toBe(f.workspaceId);
    await svc.applyPendingTaskWorkspaceSelection({ ...f, runId: randomUUID() });
    const view = await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor);
    expect(view.workspace).toBeNull();
    expect(view.selection).toMatchObject({ selection: { kind: "task_directory" } });
    expect(view.bindingRevision).toBe(3);
    expect(await svc.selectTaskWorkspace(request)).toMatchObject({ kind: "applied", bindingRevision: 3 });
    expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0]?.metadata)
      .toMatchObject({ _issuePrivacySources: { [f.issueId]: true } });
    await expect(svc.selectTaskWorkspace({ ...request, requestKey: "stale" })).rejects.toThrow("binding changed");
  });

  it.each(["before admission", "after admission"] as const)("rejects a superseded selection retry %s without replacing the newer choice", async phase => {
    const f = await fixture(), svc = executionWorkspaceService(db);
    await svc.bindTaskWorkspace(f.companyId, f.issueId, f.workspaceId);
    const [nextWorkspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Newer choice", cwd: `/tmp/newer-${f.issueId}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Running worker" }).returning();
    const immutableInput = { cwd: `/tmp/task-${f.issueId}`, binding: { executionWorkspaceId: f.workspaceId } };
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent.id,
      status: "running", contextSnapshot: { issueId: f.issueId, persistedNativeExecutionInput: immutableInput } }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = f.actor; next(); });
    app.use("/api", taskWorkspaceRoutes(db));
    app.use(errorHandler);
    const select = (body: object) => request(app).put(`/api/issues/${f.issueId}/workspace`).send(body);
    const first = { selection: { kind: "task_directory" }, expectedBindingRevision: 1, requestKey: "choice-A" };
    const acceptedA = await select(first);
    expect(acceptedA.status).toBe(200);
    const second = { selection: { kind: "existing", workspaceId: nextWorkspace.id },
      expectedBindingRevision: acceptedA.body.bindingRevision, requestKey: "choice-B" };
    const acceptedB = await select(second);
    expect(acceptedB.status).toBe(200);
    const admission = { ...f, runId: randomUUID() };
    await expect(svc.applyPendingTaskWorkspaceSelection(admission)).rejects.toThrow("Previous task run must finish");
    expect(await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).toMatchObject({
      workspace: { id: f.workspaceId }, pendingSelection: { requestKey: second.requestKey },
    });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toMatchObject({
      status: "running", contextSnapshot: { persistedNativeExecutionInput: immutableInput },
    });
    if (phase === "after admission") {
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
      expect(await svc.applyPendingTaskWorkspaceSelection(admission)).toBe(true);
    }
    const beforeRetry = await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor);
    const retryA = await select(first);
    expect(retryA.status).toBe(409);
    expect(retryA.body.error).toContain("binding changed");
    expect(await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).toEqual(beforeRetry);
    const retryB = await select(second);
    expect(retryB.status).toBe(200);
    expect(retryB.body.kind).toBe(phase === "before admission" ? "scheduled" : "applied");
    if (phase === "before admission") {
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
      expect(await svc.applyPendingTaskWorkspaceSelection(admission)).toBe(true);
    }
    expect(await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).toMatchObject({
      workspace: { id: nextWorkspace.id }, selection: { request: { key: second.requestKey } }, pendingSelection: null,
    });
  });

  describe.each(["pending selection", "legacy update"] as const)("native settlement before %s", (entryPoint) => {
    let isolatedWorkspacesEnabled: boolean;
    beforeAll(async () => {
      isolatedWorkspacesEnabled = (await instanceSettingsService(db).getExperimental()).enableIsolatedWorkspaces;
      await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    });
    afterAll(async () => { await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: isolatedWorkspacesEnabled }); });
    async function settledNativeTask(failureCode = "native_retry_cancelled", acceptedResult = false) {
      const f = await fixture(), svc = executionWorkspaceService(db);
      await svc.bindTaskWorkspace(f.companyId, f.issueId, f.workspaceId);
      const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Stopped worker" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent.id,
        nativeIssueId: f.issueId, runtimeMode: "native", nativePhase: "terminal_failure", status: "cancelled",
        contextSnapshot: {}, finishedAt: new Date() }).returning();
      let resultId: string | null = null;
      if (acceptedResult) {
        const [contract] = await db.insert(completionContracts).values({ companyId: f.companyId, issueId: f.issueId,
          revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "low",
          completionAuthority: "agent", incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: "contract",
          createdByActorType: "agent", createdByActorId: agent.id }).returning();
        await db.update(heartbeatRuns).set({ completionContractId: contract.id }).where(eq(heartbeatRuns.id, run.id));
        const [result] = await db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId, runId: run.id,
          completionContractId: contract.id, serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: {}, canonicalSha256: "result" }).returning();
        resultId = result.id;
      }
      await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: run.id,
        phase: "terminal_failure", failureCode, resultId });
      const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
        heartbeatRunId: run.id, executionWorkspaceId: f.workspaceId, status: "released", cleanupStatus: "success", releasedAt: new Date() }).returning();
      if (entryPoint === "pending selection") await svc.selectTaskWorkspace({ ...f, selection: { kind: "task_directory" }, expectedBindingRevision: 1, requestKey: "after-stop" });
      const change = () => entryPoint === "pending selection"
        ? svc.applyPendingTaskWorkspaceSelection({ ...f, runId: randomUUID() })
        : issueService(db).update(f.issueId, { executionWorkspaceId: null });
      return { ...f, run, lease, svc, change };
    }

    it.each(["native_retry_cancelled", "native_permission_declined"])("allows a settled %s without deleting its historical failure", async (failureCode) => {
      const f = await settledNativeTask(failureCode);
      await f.change();
      expect(await f.svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).toMatchObject({ workspace: null, bindingRevision: entryPoint === "pending selection" ? 3 : 2, pendingSelection: null });
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)))[0])
        .toMatchObject({ phase: "terminal_failure", failureCode });
    });

    it.each(["running native owner", "coordinator owner", "applied result", "pending cleanup", "failed cleanup", "export marker", "active lease", "failed output", "accepted output"] as const)("keeps %s fenced until its durable obligation settles", async (obligation) => {
      const f = await settledNativeTask("native_retry_cancelled", obligation === "accepted output");
      if (obligation === "running native owner") await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.run.id));
      if (obligation === "coordinator owner") await db.update(nativeRunFinalizations).set({ leaseOwner: "controller" }).where(eq(nativeRunFinalizations.runId, f.run.id));
      if (obligation === "applied result") await db.update(nativeRunFinalizations).set({ phase: "applied" }).where(eq(nativeRunFinalizations.runId, f.run.id));
      if (obligation === "pending cleanup") await db.update(environmentLeases).set({ status: "pending_cleanup" }).where(eq(environmentLeases.id, f.lease.id));
      if (obligation === "failed cleanup") await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.id, f.lease.id));
      if (obligation === "export marker") await db.update(environmentLeases).set({ metadata: { nativeWorkspaceExportResume: { runId: f.run.id } } }).where(eq(environmentLeases.id, f.lease.id));
      if (obligation === "active lease") await db.update(environmentLeases).set({ status: "active", releasedAt: null }).where(eq(environmentLeases.id, f.lease.id));
      if (obligation === "failed output") await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId,
        heartbeatRunId: f.run.id, executionWorkspaceId: f.workspaceId, phase: "workspace_finalize", status: "failed" });
      await expect(f.change()).rejects.toThrow(/workspace|Previous task run/);
      expect(await f.svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).toMatchObject({ workspace: { id: f.workspaceId }, bindingRevision: entryPoint === "pending selection" ? 2 : 1 });
      if (obligation === "failed output" || obligation === "accepted output") {
        await db.update(workspaceOperations).set({ createdAt: new Date(0) }).where(eq(workspaceOperations.heartbeatRunId, f.run.id));
        await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId,
          heartbeatRunId: f.run.id, executionWorkspaceId: f.workspaceId, phase: "workspace_finalize", status: "succeeded", finishedAt: new Date() });
        await f.change();
        expect(await f.svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).toMatchObject({ workspace: null, bindingRevision: entryPoint === "pending selection" ? 3 : 2 });
      }
    });

    it.each(["warm release", "unsafe export omission"] as const)("accepts a settled %s receipt", async (receipt) => {
      const f = await settledNativeTask("native_retry_cancelled", receipt === "unsafe export omission");
      if (receipt === "warm release") await db.update(environmentLeases).set({ releasedAt: null, status: "retained", leasePolicy: "reuse_by_environment", cleanupStatus: "success" }).where(eq(environmentLeases.id, f.lease.id));
      if (receipt === "unsafe export omission") await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId,
        heartbeatRunId: f.run.id, executionWorkspaceId: f.workspaceId, phase: "workspace_finalize", status: "succeeded",
        metadata: { workspaceSync: { omitted: true } }, finishedAt: new Date() });
      await f.change();
      expect(await f.svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).toMatchObject({ workspace: null, bindingRevision: entryPoint === "pending selection" ? 3 : 2 });
    });
  });

  it("preserves a queued next-run choice through first binding and its original retry receipt", async () => {
    const f = await fixture(), svc = executionWorkspaceService(db);
    const [nextWorkspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Next folder", cwd: `/tmp/next-${f.issueId}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "First worker", adapterType: "process" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent.id,
      status: "running", invocationSource: "on_demand", contextSnapshot: { issueId: f.issueId } }).returning();
    const selectionRequest = { ...f, selection: { kind: "existing" as const, workspaceId: nextWorkspace.id },
      expectedBindingRevision: 0, requestKey: "choose-during-first-admission" };
    await svc.selectTaskWorkspace(selectionRequest);
    await svc.bindTaskWorkspace(f.companyId, f.issueId, f.workspaceId);
    expect(await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).toMatchObject({
      workspace: { id: f.workspaceId }, bindingRevision: 2,
      pendingSelection: { expectedBindingRevision: 2, intent: { request: { expectedBindingRevision: 0 } } },
    });
    expect(await svc.selectTaskWorkspace(selectionRequest)).toMatchObject({ kind: "scheduled", bindingRevision: 2 });
    await expect(svc.selectTaskWorkspace({ ...selectionRequest, expectedBindingRevision: 1 })).rejects.toThrow("different intent");
    const admission = { ...f, runId: randomUUID() };
    await expect(svc.applyPendingTaskWorkspaceSelection(admission)).rejects.toThrow("Previous task run must finish");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    expect(await svc.applyPendingTaskWorkspaceSelection(admission)).toBe(true);
    expect(await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).toMatchObject({
      workspace: { id: nextWorkspace.id }, bindingRevision: 3, pendingSelection: null,
    });
    expect(await svc.selectTaskWorkspace(selectionRequest)).toMatchObject({ kind: "applied", bindingRevision: 3 });

    await svc.selectTaskWorkspace({ ...f, selection: { kind: "task_directory" },
      expectedBindingRevision: 3, requestKey: "later-choice" });
    await svc.bindTaskWorkspace(f.companyId, f.issueId, f.workspaceId);
    await expect(svc.applyPendingTaskWorkspaceSelection({ ...f, runId: randomUUID() })).rejects.toThrow("Pending workspace selection is stale");
  });

  it("allows regular signed-in members to select files and request repositories while denying viewers", async () => {
    const f = await fixture(), svc = executionWorkspaceService(db), userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board member", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    const [membership] = await db.insert(companyMemberships).values({ companyId: f.companyId,
      principalType: "user", principalId: userId, status: "active", membershipRole: "member" }).returning();
    await svc.bindTaskWorkspace(f.companyId, f.issueId, f.workspaceId);
    const actor = { type: "board" as const, source: "session" as const, userId,
      companyIds: [f.companyId], isInstanceAdmin: false };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", taskWorkspaceRoutes(db));
    app.use(errorHandler);
    const [assignee] = await db.insert(agents).values({ companyId: f.companyId, name: "Assigned worker", status: "idle" }).returning();
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Protected files",
      executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
    const [source] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id,
      name: "Source", cwd: `/tmp/task-${f.issueId}` }).returning();
    await db.update(issues).set({ assigneeAgentId: assignee.id }).where(eq(issues.id, f.issueId));
    await db.update(executionWorkspaces).set({ projectId: project.id, projectWorkspaceId: source.id }).where(eq(executionWorkspaces.id, f.workspaceId));
    const selection = { selection: { kind: "existing" as const, workspaceId: f.workspaceId }, expectedBindingRevision: 1, requestKey: "member-selection" };
    const repository = { repository: { kind: "url" as const, url: "https://github.com/public/example" }, requestKey: "member-repository" };
    expect((await request(app).put(`/api/issues/${f.issueId}/workspace`).send(selection)).status).toBe(403);
    expect((await request(app).post(`/api/issues/${f.issueId}/workspace/repositories`).send(repository)).status).toBe(403);
    const channelDefaults = { companyId: f.companyId, actor, assigneeAgentId: assignee.id,
      defaults: { workspace: { kind: "configured_source" as const, projectWorkspaceId: source.id, mode: "shared" as const } } };
    await expect(assertChatExecutionDefaultsAccess(db, channelDefaults)).rejects.toThrow(/protected/);
    await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: userId,
      permissionKey: "tasks:assign_scope", scope: { projectId: project.id, assigneeAgentId: assignee.id } });
    await expect(assertChatExecutionDefaultsAccess(db, channelDefaults)).resolves.toBeUndefined();
    await expect(assertChatExecutionDefaultsAccess(db, { ...channelDefaults, assigneeAgentId: null })).rejects.toThrow(/protected/);
    expect(await issueService(db).create(f.companyId, { title: "Board-assigned shared work", createdByUserId: userId,
      assigneeAgentId: assignee.id, workspaceSelectionActor: actor,
      workspaceSelection: { kind: "configured_source", projectWorkspaceId: source.id, mode: "shared" } }))
      .toMatchObject({ assigneeAgentId: assignee.id, projectWorkspaceId: source.id });
    const selected = await request(app).put(`/api/issues/${f.issueId}/workspace`).send(selection);
    expect(selected.status, JSON.stringify(selected.body)).toBe(200);
    expect(selected.body).toMatchObject({ kind: "scheduled" });
    const prepared = await request(app).post(`/api/issues/${f.issueId}/workspace/repositories`).send(repository);
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    expect(prepared.body).toMatchObject({ kind: "requires_next_admission" });
    const before = await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor);
    expect(before).toMatchObject({ workspace: { id: f.workspaceId }, pendingSelection: { requestKey: selection.requestKey } });
    expect(await svc.listTaskRepositories(f.companyId, f.workspaceId)).toHaveLength(1);

    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.id, membership.id));
    const deniedSelection = { ...selection, requestKey: "viewer-selection" };
    const deniedRepository = { ...repository, requestKey: "viewer-repository" };
    expect((await request(app).put(`/api/issues/${f.issueId}/workspace`).send(deniedSelection)).status).toBe(403);
    expect((await request(app).post(`/api/issues/${f.issueId}/workspace/repositories`).send(deniedRepository)).status).toBe(403);
    await expect(svc.selectTaskWorkspace({ ...f, actor, ...deniedSelection })).rejects.toThrow("modification is not allowed");
    await expect(svc.requestTaskRepository({ ...f, actor, request: deniedRepository })).rejects.toThrow("modification is not allowed");
    expect(await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).toEqual(before);
    expect(await db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.executionWorkspaceId, f.workspaceId))).toHaveLength(1);
  });

  it.each(["binding", "configured_source"] as const)("enforces source authority on legacy PATCH %s and rolls back denied edits", async kind => {
    const f = await fixture(), userId = randomUUID(), settings = instanceSettingsService(db);
    const previous = await settings.getExperimental();
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    try {
      await db.insert(authUsers).values({ id: userId, name: "Workspace selector", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
      const [assignee, nextAssignee] = await db.insert(agents).values(["Current worker", "Next worker"].map(name => ({ companyId: f.companyId, name, status: "idle", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }))).returning();
      await db.update(issues).set({ assigneeAgentId: assignee.id }).where(eq(issues.id, f.issueId));
      const [project, organization] = await db.insert(projects).values([
        { companyId: f.companyId, name: "Protected source", executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } },
        { companyId: f.companyId, name: "Organization" },
      ]).returning();
      const [source] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Source", cwd: `/tmp/source-${f.issueId}` }).returning();
      await db.update(executionWorkspaces).set({ projectId: project.id, projectWorkspaceId: source.id }).where(eq(executionWorkspaces.id, f.workspaceId));
      const actor = { type: "board" as const, source: "session" as const, userId, companyIds: [f.companyId], isInstanceAdmin: false };
      const beforeMetadata = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0].metadata;
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = actor; next(); });
      app.use("/api", taskWorkspaceRoutes(db));
      app.use("/api", issueRoutes(db, {} as never));
      app.use(errorHandler);
      const patch = kind === "binding" ? { executionWorkspaceId: f.workspaceId } : { projectWorkspaceId: source.id, executionWorkspaceSettings: { mode: "shared_workspace" } };
      const selection = kind === "binding" ? { kind: "existing", workspaceId: f.workspaceId } : { kind: "configured_source", projectWorkspaceId: source.id, mode: "shared" };
      expect((await request(app).put(`/api/issues/${f.issueId}/workspace`).send({ selection, expectedBindingRevision: 0, requestKey: "denied" })).status).toBe(403);
      const denied = await request(app).patch(`/api/issues/${f.issueId}`).send(patch);
      expect(denied.status, JSON.stringify(denied.body)).toBe(403);
      const readTask = () => db.select().from(issues).where(eq(issues.id, f.issueId)).then(rows => rows[0]);
      expect(await readTask()).toMatchObject({ executionWorkspaceId: null, projectWorkspaceId: null, workspaceBindingRevision: 0 });
      expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0].metadata).toEqual(beforeMetadata);
      const [grant] = await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: userId, permissionKey: "tasks:assign_scope", scope: { projectId: project.id, assigneeAgentId: assignee.id } }).returning();
      await expect(issueService(db).update(f.issueId, { ...patch, assigneeAgentId: nextAssignee.id, workspaceSelectionActor: actor })).rejects.toThrow(/protected/);
      expect(await readTask()).toMatchObject({ assigneeAgentId: assignee.id, workspaceBindingRevision: 0 });
      const allowed = await request(app).patch(`/api/issues/${f.issueId}`).send(patch);
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      const bound = await readTask();
      expect(bound).toMatchObject({ ...patch, projectWorkspaceId: source.id, workspaceBindingRevision: 1 });
      await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.id, grant.id));
      const organized = await request(app).patch(`/api/issues/${f.issueId}`).send({ projectId: organization.id });
      expect(organized.status, JSON.stringify(organized.body)).toBe(200);
      expect(await readTask()).toMatchObject({ projectId: organization.id, executionWorkspaceId: bound.executionWorkspaceId, projectWorkspaceId: source.id, workspaceBindingRevision: 1 });
    } finally { await settings.updateExperimental({ enableIsolatedWorkspaces: previous.enableIsolatedWorkspaces }); }
  });

  it.each(["create", "patch", "selection"] as const)("uses the assigned agent's effective source strategy for %s authorization", async operation => {
    const f = await fixture(), userId = randomUUID(), settings = instanceSettingsService(db);
    const previous = await settings.getExperimental();
    await settings.updateExperimental({ enableIsolatedWorkspaces: true, enableIsolatedWorkspacesByDefault: false });
    try {
      await db.insert(authUsers).values({ id: userId, name: "Source reader", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
      const [isolatedAgent, sharedAgent] = await db.insert(agents).values(["git_worktree", "project_primary"].map(type => ({
        companyId: f.companyId, name: type, status: "idle", adapterConfig: { workspaceStrategy: { type } },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      }))).returning();
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Read-only source",
        executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
      const [source] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Source", cwd: `/tmp/source-${f.issueId}` }).returning();
      const actor = { type: "board" as const, source: "session" as const, userId, companyIds: [f.companyId], isInstanceAdmin: false };
      const sharedOverrides = { adapterConfig: { workspaceStrategy: { type: "project_primary" } } };
      const tasks = issueService(db), workspaces = executionWorkspaceService(db);
      if (operation === "create") {
        const input = { title: "Read source in separate checkout", assigneeAgentId: isolatedAgent.id,
          projectWorkspaceId: source.id, workspaceSelectionActor: actor, createdByUserId: userId };
        await expect(tasks.create(f.companyId, { ...input, assigneeAdapterOverrides: sharedOverrides })).rejects.toThrow(/protected/);
        await expect(tasks.create(f.companyId, input)).resolves.toMatchObject({ assigneeAgentId: isolatedAgent.id, projectWorkspaceId: source.id });
        await expect(tasks.create(f.companyId, { ...input, workspaceSelection: { kind: "configured_source", projectWorkspaceId: source.id, mode: "managed_isolated" },
          assigneeAdapterOverrides: sharedOverrides })).rejects.toThrow(/protected/);
      } else if (operation === "patch") {
        await db.update(issues).set({ assigneeAgentId: sharedAgent.id }).where(eq(issues.id, f.issueId));
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => { req.actor = actor; next(); });
        app.use("/api", issueRoutes(db, {} as never)); app.use(errorHandler);
        const patch = { projectWorkspaceId: source.id, assigneeAgentId: isolatedAgent.id };
        const denied = await request(app).patch(`/api/issues/${f.issueId}`).send({ ...patch, assigneeAdapterOverrides: sharedOverrides });
        expect(denied.status, JSON.stringify(denied.body)).toBe(403);
        expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ assigneeAgentId: sharedAgent.id, projectWorkspaceId: null });
        const allowed = await request(app).patch(`/api/issues/${f.issueId}`).send(patch);
        expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
        expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ assigneeAgentId: isolatedAgent.id, projectWorkspaceId: source.id });
      } else {
        await db.update(issues).set({ assigneeAgentId: isolatedAgent.id, assigneeAdapterOverrides: sharedOverrides }).where(eq(issues.id, f.issueId));
        const input = { companyId: f.companyId, issueId: f.issueId, actor,
          selection: { kind: "configured_source" as const, projectWorkspaceId: source.id, mode: "managed_isolated" as const } };
        await expect(workspaces.validateSelection(input)).rejects.toThrow(/protected/);
        await db.update(issues).set({ assigneeAdapterOverrides: null }).where(eq(issues.id, f.issueId));
        await expect(workspaces.validateSelection(input)).resolves.toMatchObject({ projectWorkspaceId: source.id });
        await db.update(issues).set({ assigneeAgentId: sharedAgent.id }).where(eq(issues.id, f.issueId));
        await expect(workspaces.validateSelection(input)).rejects.toThrow(/protected/);
      }
    } finally { await settings.updateExperimental({ enableIsolatedWorkspaces: previous.enableIsolatedWorkspaces, enableIsolatedWorkspacesByDefault: previous.enableIsolatedWorkspacesByDefault }); }
  });

  it("requires source project assignment authority for shared files while preserving isolated reads", async () => {
    const f = await fixture(), svc = executionWorkspaceService(db), tasks = issueService(db);
    const settings = instanceSettingsService(db), previous = await settings.getExperimental();
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    try {
      const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Read-only source user", adapterType: "process", status: "idle" }).returning();
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "agent", principalId: agent.id, status: "active", membershipRole: "member" });
      const actor = { type: "agent" as const, agentId: agent.id, companyId: f.companyId, source: "agent_key" as const };
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Protected source",
        executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
      const [source] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id,
        name: "Shared source", cwd: `/tmp/protected-${f.issueId}` }).returning();
      const [shared] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: project.id,
        projectWorkspaceId: source.id, name: "Shared files", cwd: source.cwd, mode: "shared_workspace", strategyType: "project_primary" }).returning();
      const [isolated] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: project.id,
        projectWorkspaceId: source.id, name: "Isolated files", cwd: `/tmp/isolated-${f.issueId}`, mode: "isolated_workspace", strategyType: "git_worktree" }).returning();
      expect(await authorizationService(db).decide({ actor, action: "project:read",
        resource: { type: "project", companyId: f.companyId, projectId: project.id } })).toMatchObject({ allowed: true });
      const sharedSelection = { kind: "configured_source" as const, projectWorkspaceId: source.id, mode: "shared" as const };
      const isolatedSelection = { ...sharedSelection, mode: "managed_isolated" as const };
      await expect(svc.validateSelection({ ...f, actor, selection: sharedSelection })).rejects.toThrow(/protected/);
      await expect(svc.validateSelection({ ...f, actor, selection: isolatedSelection })).resolves.toMatchObject({ executionWorkspaceSettings: { mode: "isolated_workspace" } });
      await expect(svc.validateSelection({ ...f, actor, selection: { kind: "existing", workspaceId: shared.id } })).rejects.toThrow(/protected/);
      await expect(svc.validateSelection({ ...f, actor, selection: { kind: "existing", workspaceId: isolated.id } })).resolves.toMatchObject({ executionWorkspaceId: isolated.id });
      for (const sourceKind of ["explicit", "channel"] as const) {
        await expect(tasks.create(f.companyId, { title: `Denied ${sourceKind}`, createdByAgentId: agent.id,
          workspaceSelection: sharedSelection, workspaceSelectionSource: sourceKind, workspaceSelectionActor: actor })).rejects.toThrow(/protected/);
        expect(await tasks.create(f.companyId, { title: `Isolated ${sourceKind}`, createdByAgentId: agent.id,
          workspaceSelection: isolatedSelection, workspaceSelectionSource: sourceKind, workspaceSelectionActor: actor })).toMatchObject({ projectId: null, projectWorkspaceId: source.id });
      }
      await expect(tasks.create(f.companyId, { title: "Denied legacy source", createdByAgentId: agent.id,
        projectWorkspaceId: source.id, workspaceSelectionActor: actor })).rejects.toThrow(/protected/);
      await expect(tasks.create(f.companyId, { title: "Denied legacy binding", createdByAgentId: agent.id,
        executionWorkspaceId: shared.id, workspaceSelectionActor: actor })).rejects.toThrow(/protected/);

      await db.update(executionWorkspaces).set({ mode: "isolated_workspace" }).where(eq(executionWorkspaces.id, shared.id));
      await expect(svc.validateSelection({ ...f, actor, selection: { kind: "existing", workspaceId: shared.id } })).rejects.toThrow(/protected/);
      await expect(tasks.create(f.companyId, { title: "Mislabelled isolated source", createdByAgentId: agent.id,
        projectWorkspaceId: source.id, workspaceSelectionActor: actor,
        executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "project_primary" } } })).rejects.toThrow(/protected/);
      await db.update(projects).set({ executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace",
        workspaceStrategy: { type: "project_primary" }, authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).where(eq(projects.id, project.id));
      await expect(svc.validateSelection({ ...f, actor, selection: isolatedSelection })).rejects.toThrow(/protected/);
      await db.update(projects).set({ executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).where(eq(projects.id, project.id));

      const [organization] = await db.insert(projects).values({ companyId: f.companyId, name: "Task organization" }).returning();
      await db.update(issues).set({ projectId: organization.id }).where(eq(issues.id, f.issueId));
      const [grant] = await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent",
        principalId: agent.id, permissionKey: "tasks:assign_scope", scope: { projectId: organization.id, assigneeAgentId: agent.id } }).returning();
      const selectionRequest = { ...f, actor, selection: sharedSelection, expectedBindingRevision: 0, requestKey: "authorized-shared" };
      await expect(svc.selectTaskWorkspace(selectionRequest)).rejects.toThrow(/protected/);
      const [otherAgent] = await db.insert(agents).values({ companyId: f.companyId, name: "Another assignee", status: "idle" }).returning();
      await db.update(issues).set({ assigneeAgentId: otherAgent.id }).where(eq(issues.id, f.issueId));
      await db.update(principalPermissionGrants).set({ scope: { projectId: project.id, assigneeAgentId: otherAgent.id } })
        .where(eq(principalPermissionGrants.id, grant.id));
      await expect(svc.selectTaskWorkspace(selectionRequest)).rejects.toThrow(/protected/);
      await db.update(principalPermissionGrants).set({ scope: { projectId: project.id, assigneeAgentId: agent.id } })
        .where(eq(principalPermissionGrants.id, grant.id));
      await expect(svc.selectTaskWorkspace(selectionRequest)).resolves.toMatchObject({ kind: "scheduled" });
      const responsibleUserId = randomUUID();
      await db.insert(authUsers).values({ id: responsibleUserId, name: "Source owner", email: `${responsibleUserId}@example.test`,
        createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: responsibleUserId,
        status: "active", membershipRole: "member" });
      const delegated = { ...actor, onBehalfOfUserId: responsibleUserId };
      await expect(svc.validateSelection({ ...f, actor: delegated, selection: sharedSelection })).rejects.toThrow(/Responsible user.*not authorized/);
      const [userGrant] = await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user",
        principalId: responsibleUserId, permissionKey: "tasks:assign_scope", scope: { projectId: project.id, assigneeAgentId: agent.id } }).returning();
      await expect(svc.validateSelection({ ...f, actor: delegated, selection: sharedSelection })).resolves.toMatchObject({ projectWorkspaceId: source.id });
      await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.id, userGrant.id));
      await expect(svc.validateSelection({ ...f, actor: delegated, selection: sharedSelection })).rejects.toThrow(/Responsible user.*not authorized/);
      expect(await tasks.create(f.companyId, { title: "Authorized shared source", createdByAgentId: agent.id,
        workspaceSelection: sharedSelection, workspaceSelectionActor: actor })).toMatchObject({ projectId: null, projectWorkspaceId: source.id });
      await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.id, grant.id));
      await expect(svc.applyPendingTaskWorkspaceSelection({ ...f, actor, runId: randomUUID() })).rejects.toThrow(/protected/);
      await expect(assertTaskWorkspaceAccess(db, actor, f.companyId, shared.id)).resolves.toBeUndefined();
      await expect(assertTaskWorkspaceAccess(db, actor, f.companyId, shared.id, { write: true })).rejects.toThrow(/protected/);
      await expect(assertTaskWorkspaceAccess(db, actor, f.companyId, isolated.id, { write: true })).resolves.toBeUndefined();
      expect((await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).workspace).toBeNull();
    } finally { await settings.updateExperimental({ enableIsolatedWorkspaces: previous.enableIsolatedWorkspaces }); }
  });

  it.each(["binding", "configured_source"] as const)("supersedes an older queued selection when an ordinary update changes %s", async kind => {
    const f = await fixture(), svc = executionWorkspaceService(db), tasks = issueService(db);
    const settings = instanceSettingsService(db), previous = await settings.getExperimental();
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    try {
      await svc.bindTaskWorkspace(f.companyId, f.issueId, f.workspaceId);
      const request = { ...f, selection: { kind: "task_directory" as const }, expectedBindingRevision: 1, requestKey: "older-choice" };
      await svc.selectTaskWorkspace(request);
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "New source" }).returning();
      const [source] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "New files", cwd: `/tmp/new-source-${f.issueId}` }).returning();
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: null,
        mode: "shared_workspace", strategyType: "project_primary", name: "New binding", cwd: `/tmp/new-binding-${f.issueId}` }).returning();
      const patch = kind === "binding" ? { executionWorkspaceId: workspace.id } : { executionWorkspaceId: null, projectWorkspaceId: source.id };
      await tasks.update(f.issueId, patch);
      expect(await svc.applyPendingTaskWorkspaceSelection({ ...f, runId: randomUUID() })).toBe(false);
      const view = await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor);
      expect(view).toMatchObject({ bindingRevision: 3, pendingSelection: null, selection: null });
      expect(view.workspace?.id ?? null).toBe(kind === "binding" ? workspace.id : null);
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(task.projectWorkspaceId).toBe(kind === "configured_source" ? source.id : null);
      await expect(svc.selectTaskWorkspace(request)).rejects.toThrow("binding changed");
      await tasks.update(f.issueId, { projectId: project.id, ...patch });
      expect((await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).bindingRevision).toBe(3);
    } finally { await settings.updateExperimental({ enableIsolatedWorkspaces: previous.enableIsolatedWorkspaces }); }
  });

  it("rejects an ordinary source annotation on bound files and preserves active run ownership", async () => {
    const f = await fixture(), svc = executionWorkspaceService(db), tasks = issueService(db);
    await svc.bindTaskWorkspace(f.companyId, f.issueId, f.workspaceId);
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Other source" }).returning();
    const [source] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Other files", cwd: `/tmp/other-${f.issueId}` }).returning();
    await expect(tasks.update(f.issueId, { projectWorkspaceId: source.id })).rejects.toThrow("already has bound files");
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Running worker", adapterType: "process", status: "active" }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent.id, status: "running", invocationSource: "on_demand", nativeIssueId: f.issueId, contextSnapshot: { issueId: f.issueId } });
    const settings = instanceSettingsService(db), previous = await settings.getExperimental();
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    try {
      await expect(tasks.update(f.issueId, { executionWorkspaceId: null, projectWorkspaceId: source.id })).rejects.toThrow("still owns its workspace");
      expect(await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).toMatchObject({ bindingRevision: 1, workspace: { id: f.workspaceId } });
      await expect(svc.selectTaskWorkspace({ ...f, selection: { kind: "configured_source", projectWorkspaceId: source.id, mode: "shared" },
        expectedBindingRevision: 1, requestKey: "next-admission" })).resolves.toMatchObject({ kind: "scheduled" });
    } finally { await settings.updateExperimental({ enableIsolatedWorkspaces: previous.enableIsolatedWorkspaces }); }
  });

  it("defaults app and chat tasks to independent directories without hydrating legacy agent files", async () => {
    const f = await fixture();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-workspace-default-"));
    vi.stubEnv("PAPERCLIP_HOME", root);
    try {
      const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "File worker", adapterType: "process", status: "idle" }).returning();
      const legacy = resolveDefaultAgentWorkspaceDir(agent!.id);
      await fs.mkdir(legacy, { recursive: true });
      const old = await fs.open(path.join(legacy, "unrelated.bin"), "w");
      await old.truncate(1_200_000_000); await old.close();
      const resolver = createHeartbeatWorkspaceResolver(db);
      const first = await resolver.resolveWorkspaceForRun(agent!, { issueId: f.issueId }, null);
      expect(first.cwd).not.toBe(legacy);
      expect(await fs.readdir(first.cwd)).toEqual([]);
      await fs.writeFile(path.join(first.cwd, "report.txt"), "task output");
      const again = await resolver.resolveWorkspaceForRun(agent!, { issueId: f.issueId }, null);
      expect(again.cwd).toBe(first.cwd);
      const chatId = randomUUID();
      await db.insert(issues).values({ id: chatId, companyId: f.companyId, title: "Chat report", originKind: "chat_channel" });
      const chat = await resolver.resolveWorkspaceForRun(agent!, { issueId: chatId }, null);
      expect(chat.cwd).not.toBe(first.cwd);
      expect(path.dirname(chat.cwd)).toBe(path.dirname(first.cwd));
      const organizationId = randomUUID();
      await db.insert(projects).values({ id: organizationId, companyId: f.companyId, name: "Organization only" });
      await db.update(issues).set({ projectId: organizationId }).where(eq(issues.id, chatId));
      const organized = await resolver.resolveWorkspaceForRun(agent!, { issueId: chatId }, null);
      expect(organized.cwd).toBe(chat.cwd);
      expect(organized.projectId).toBeNull();
      const nativeChatScope = await findNativeChatWorkspaceScope(db, {
        adapterType: "paperclip_runner", environmentDriver: "local", companyId: f.companyId,
        agentId: agent!.id, issueId: chatId, instanceRoot: root,
      });
      expect(nativeChatScope?.projectId).toBeNull();
      expect((await fs.stat(path.join(legacy, "unrelated.bin"))).size).toBe(1_200_000_000);
    } finally { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["missing_path", "clone_failure", "deleted_source"] as const)("refuses sibling and session fallbacks for an explicit configured source: %s", async (failure) => {
    const f = await fixture();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-source-selection-"));
    vi.stubEnv("PAPERCLIP_HOME", root);
    try {
      const projectId = randomUUID(), sourceId = randomUUID(), siblingId = randomUUID();
      const siblingCwd = path.join(root, "usable-sibling");
      await fs.mkdir(siblingCwd);
      await fs.writeFile(path.join(siblingCwd, "source.txt"), "Other repository");
      await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Multiple sources" });
      await db.insert(projectWorkspaces).values([
        { id: sourceId, companyId: f.companyId, projectId, name: "Selected", isPrimary: true,
          sourceType: failure === "clone_failure" ? "git_repo" : "local_path",
          cwd: failure === "clone_failure" ? null : path.join(root, "missing-source"),
          repoUrl: failure === "clone_failure" ? path.join(root, "missing-remote.git") : null },
        { id: siblingId, companyId: f.companyId, projectId, name: "Other", sourceType: "local_path", cwd: siblingCwd },
      ]);
      await db.update(issues).set({ projectId, projectWorkspaceId: sourceId,
        workspaceSelection: { version: 1, source: "explicit", selection: { kind: "configured_source", projectWorkspaceId: sourceId, mode: "shared" } },
      }).where(eq(issues.id, f.issueId));
      if (failure === "deleted_source") await db.delete(projectWorkspaces).where(eq(projectWorkspaces.id, sourceId));
      const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Worker", adapterType: "process",
        adapterConfig: { cwd: siblingCwd } }).returning();
      await expect(createHeartbeatWorkspaceResolver(db).resolveWorkspaceForRun(agent!, { issueId: f.issueId }, { cwd: siblingCwd }))
        .rejects.toMatchObject({ code: "workspace_validation_failed", resultJson: { workspaceValidation: {
          reason: failure === "clone_failure" ? "git_worktree_base_materialization_failed" : "configured_workspace_unavailable",
          issueProjectWorkspaceId: sourceId, baseCwdFallback: false,
          materializationFailures: failure === "clone_failure" ? [expect.objectContaining({ projectWorkspaceId: sourceId })] : [],
        } } });
      expect(await fs.readFile(path.join(siblingCwd, "source.txt"), "utf8")).toBe("Other repository");
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionWorkspaceId).toBeNull();
      if (failure === "missing_path") {
        await fs.mkdir(path.join(root, "missing-source"));
        const repaired = await createHeartbeatWorkspaceResolver(db).resolveWorkspaceForRun(agent!, { issueId: f.issueId }, { cwd: siblingCwd });
        expect(repaired).toMatchObject({ workspaceId: sourceId, cwd: path.join(root, "missing-source"), baseCwdFallback: false });
      }
    } finally { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it("retains every task privacy source when simultaneous tasks bind the same folder", async () => {
    const f = await fixture(), secondIssueId = randomUUID(), svc = executionWorkspaceService(db);
    await db.insert(issues).values({ id: secondIssueId, companyId: f.companyId, title: "Second task" });
    await Promise.all([svc.bindTaskWorkspace(f.companyId, f.issueId, f.workspaceId), svc.bindTaskWorkspace(f.companyId, secondIssueId, f.workspaceId)]);
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    expect(workspace?.metadata).toMatchObject({ _issuePrivacySources: { [f.issueId]: true, [secondIssueId]: true } });
  });

  it.each(["creation", "selection"] as const)("retains private writers after an existing workspace is installed by %s and then detached", async (installation) => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    try {
      const f = await fixture(), svc = executionWorkspaceService(db);
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Organization" }).returning();
      const [reader] = await db.insert(agents).values({ companyId: f.companyId, name: "Unrelated reader", adapterType: "process" }).returning();
      const writer = await issueService(db).create(f.companyId, {
        title: "Private writer", projectId: project.id, visibility: "private", responsibleUserId: "private-owner",
        workspaceSelectionActor: f.actor,
        ...(installation === "creation" ? { workspaceSelection: { kind: "existing" as const, workspaceId: f.workspaceId } } : {}),
      });
      if (installation === "selection") {
        await svc.selectTaskWorkspace({ ...f, issueId: writer.id, selection: { kind: "existing", workspaceId: f.workspaceId },
          expectedBindingRevision: 0, requestKey: "install-existing" });
        await svc.applyPendingTaskWorkspaceSelection({ ...f, issueId: writer.id, runId: randomUUID() });
      }
      const installed = await svc.inspectTaskWorkspace(f.companyId, writer.id, f.actor);
      expect(installed.workspace?.id).toBe(f.workspaceId);
      expect(installed.workspace?.metadata?._issuePrivacySources).toMatchObject({ [writer.id]: true });
      await svc.selectTaskWorkspace({ ...f, issueId: writer.id, selection: { kind: "task_directory" },
        expectedBindingRevision: installed.bindingRevision, requestKey: "detach-private-writer" });
      await svc.applyPendingTaskWorkspaceSelection({ ...f, issueId: writer.id, runId: randomUUID() });
      const [retained] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
      expect(retained.metadata?._issuePrivacySources).toMatchObject({ [writer.id]: true });
      expect(await canActorReadExecutionWorkspace(db, { type: "agent", agentId: reader.id, companyId: f.companyId }, retained.id)).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it("deletes a whole company in source-workspace dependency order", async () => {
    const f = await fixture(), sourceProjectId = randomUUID();
    await db.insert(projects).values({ id: sourceProjectId, companyId: f.companyId, name: "Source policy" });
    await db.update(executionWorkspaces).set({ projectId: sourceProjectId }).where(eq(executionWorkspaces.id, f.workspaceId));
    expect(await deleteCompany(db, f.companyId)).toMatchObject({ id: f.companyId });
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId))).toEqual([]);
    expect(await db.select().from(projects).where(eq(projects.id, sourceProjectId))).toEqual([]);
  });

  it("retains source-project policy until workspaces are explicitly cleaned up", async () => {
    const f = await fixture(), sourceProjectId = randomUUID();
    await db.insert(projects).values({ id: sourceProjectId, companyId: f.companyId, name: "Source policy" });
    await db.update(executionWorkspaces).set({ projectId: sourceProjectId }).where(eq(executionWorkspaces.id, f.workspaceId));
    await expect(db.delete(projects).where(eq(projects.id, sourceProjectId))).rejects.toThrow();
    expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0]?.projectId).toBe(sourceProjectId);
  });

  it("rejects foreign-company selections before changing pending state", async () => {
    const f = await fixture(), other = await fixture(), svc = executionWorkspaceService(db);
    await expect(svc.selectTaskWorkspace({ ...f, expectedBindingRevision: 0, requestKey: "foreign",
      selection: { kind: "existing", workspaceId: other.workspaceId } })).rejects.toThrow("unavailable or inaccessible");
    expect((await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).pendingSelection).toBeNull();
  });
});
