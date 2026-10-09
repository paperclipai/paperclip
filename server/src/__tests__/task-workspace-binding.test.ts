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
import { agents, companies, createDb, executionWorkspaces, issues, projects } from "@paperclipai/db";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { canActorReadExecutionWorkspace } from "../services/authorization.js";
import { deleteCompany } from "../services/company-deletion.js";
import { issueService } from "../services/issues.js";
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
