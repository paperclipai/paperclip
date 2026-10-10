import { findNativeChatWorkspaceScope } from "../services/native-runtime/native-chat-workspace.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { createHeartbeatWorkspaceResolver } from "../services/heartbeat/workspaces.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, executionWorkspaces, heartbeatRuns, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { canActorReadExecutionWorkspace } from "../services/authorization.js";
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
    expect(view.bindingRevision).toBe(2);
    expect(await svc.selectTaskWorkspace(request)).toMatchObject({ kind: "applied", bindingRevision: 2 });
    expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0]?.metadata)
      .toMatchObject({ _issuePrivacySources: { [f.issueId]: true } });
    await expect(svc.selectTaskWorkspace({ ...request, requestKey: "stale" })).rejects.toThrow("binding changed");
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
      expect(view).toMatchObject({ bindingRevision: 2, pendingSelection: null, selection: null });
      expect(view.workspace?.id ?? null).toBe(kind === "binding" ? workspace.id : null);
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(task.projectWorkspaceId).toBe(kind === "configured_source" ? source.id : null);
      await expect(svc.selectTaskWorkspace(request)).rejects.toThrow("binding changed");
      await tasks.update(f.issueId, { projectId: project.id, ...patch });
      expect((await svc.inspectTaskWorkspace(f.companyId, f.issueId, f.actor)).bindingRevision).toBe(2);
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
          // A nonexistent local remote exercises clone failure without network access.
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
      // No bindTaskWorkspace call or heartbeat is needed: the migration's issue
      // binding trigger retains provenance in the same installation transaction.
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
