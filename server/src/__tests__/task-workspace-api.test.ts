import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, executionWorkspaceRepositories, executionWorkspaces, issues, heartbeatRuns, projects, projectWorkspaces, principalPermissionGrants, companyMemberships } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("task workspace API and native semantic authority", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => { process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID(); server = await startRunnerApiTestServer(); }, 60_000);
  afterAll(async () => { await server?.close(); if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET; else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret; });
  it("creates an explicit-workspace child through the authenticated low-trust API without repeating its saved policy", async () => {
    const f = await server.fixture({ connectionScenario: "fresh", disableWakeOnDemand: true });
    const policy = { trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review",
      trustBoundary: { mode: "low_trust_review", companyId: f.companyId, rootIssueId: f.issueId, projectIds: [f.projectId] } } };
    const [workspace] = await server.db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: f.projectId,
      projectWorkspaceId: f.projectWorkspaceId, sourceIssueId: f.issueId, name: "Review files", cwd: f.workspace,
      mode: "isolated_workspace", strategyType: "task_directory" }).returning();
    await server.db.update(projects).set({ executionWorkspacePolicy: policy }).where(eq(projects.id, f.projectId));
    await server.db.update(issues).set({ executionPolicy: policy, executionWorkspaceId: workspace.id }).where(eq(issues.id, f.issueId));
    await server.db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: policy } }).where(eq(heartbeatRuns.id, f.runId));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.userId);
    const create = (parentId: string) => fetch(`${server.apiUrl}/api/companies/${f.companyId}/issues`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: `Review child ${randomUUID()}`, parentId, projectId: f.projectId,
        assigneeAgentId: f.agentId, status: "backlog", workspaceSelection: { kind: "existing", workspaceId: workspace.id } }),
    });
    const response = await create(f.issueId), body = await response.json();
    expect({ status: response.status, body }).toMatchObject({ status: 201, body: {
      parentId: f.issueId, executionWorkspaceId: workspace.id,
      executionPolicy: { authorizationPolicy: { trustBoundary: policy.authorizationPolicy.trustBoundary } },
    } });
    const denied = await create(f.blockerId);
    expect(denied.status).toBe(403);
  });
  it("inspects an idle admitted workspace, requests a repository, and stages root selection without interrupting", async () => {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    const [workspace] = await server.db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: null, sourceIssueId: f.issueId, name: "Task files", cwd: f.workspace, mode: "shared_workspace", strategyType: "task_directory", status: "idle" }).returning();
    await server.db.update(issues).set({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: workspace.id }).where(eq(issues.id, f.issueId));
    const authority = new PaperclipRunnerToolAuthority(server.db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId: f.runId, apiUrl: server.apiUrl, workspaceRoot: "/admitted/task" });
    const call = (tool: string, args: Record<string, unknown>) => authority.execute({ tool, arguments: args, callId: randomUUID() });
    const view = await call("get_workspace", {}) as { bindingRevision: number; cwd: string; workspace: { id: string } };
    expect(view).toMatchObject({ cwd: "/admitted/task", workspace: { id: workspace.id } });
    const args = { repository: { kind: "url", url: "https://github.com/public/example" }, requestKey: "repository-one" };
    const first = await call("prepare_repository", args) as { preparationId: string; kind: string };
    expect(first.kind).toBe("requires_next_admission");
    expect(await call("prepare_repository", args)).toMatchObject({ preparationId: first.preparationId });
    expect(await call("select_workspace", { selection: { kind: "task_directory" }, expectedBindingRevision: view.bindingRevision, requestKey: "root-one" })).toMatchObject({ kind: "scheduled", applies: "next_normal_admission" });
    const [task] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task).toMatchObject({ executionWorkspaceId: workspace.id, projectId: null, workspacePendingSelection: { requestKey: "root-one" } });
    const runs = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: f.runId, status: "running" });
  });
  it("keeps projectless protected-folder aliases readable while enforcing scoped write grants", async () => {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    const [project] = await server.db.insert(projects).values({ companyId: f.companyId, name: "Protected physical source",
      executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
    await server.db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Protected folder", cwd: f.workspace });
    const [workspace] = await server.db.insert(executionWorkspaces).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      name: "Projectless alias", cwd: f.workspace, mode: "shared_workspace", strategyType: "task_directory" }).returning();
    await server.db.update(issues).set({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: workspace.id }).where(eq(issues.id, f.issueId));
    const call = (tool: string, args: Record<string, unknown>) => f.authority.execute({ tool, arguments: args, callId: randomUUID() });
    const selection = { selection: { kind: "existing", workspaceId: workspace.id }, expectedBindingRevision: 0, requestKey: "protected-alias" };
    const repository = { repository: { kind: "url", url: "https://github.com/public/example" }, requestKey: "protected-root-write" };
    await expect(call("get_workspace", {})).resolves.toMatchObject({ workspace: { id: workspace.id, projectId: null } });
    await expect(call("select_workspace", selection)).rejects.toThrow(/protected|not authorized/);
    await expect(call("prepare_repository", repository)).rejects.toThrow(/protected|not authorized/);
    await server.db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "agent", principalId: f.agentId,
      membershipRole: "member", status: "active" });
    await server.db.insert(principalPermissionGrants).values([
      { companyId: f.companyId, principalType: "agent", principalId: f.agentId, permissionKey: "tasks:assign_scope", scope: { projectId: project.id, assigneeAgentId: f.agentId } },
      { companyId: f.companyId, principalType: "user", principalId: f.userId!, permissionKey: "tasks:assign_scope", scope: { projectId: project.id, assigneeAgentId: f.agentId } },
    ]);
    await expect(call("select_workspace", selection)).resolves.toMatchObject({ kind: "scheduled" });
    await expect(call("prepare_repository", repository)).resolves.toMatchObject({ kind: "requires_next_admission" });
  });

  it("denies new public clones for unlinked full-auto chat while keeping workspace discovery readable", async () => {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    const cwd = await mkdtemp(join(dirname(f.workspace), "unlinked-task-"));
    const [workspace] = await server.db.insert(executionWorkspaces).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      name: "Unlinked chat files", cwd, mode: "isolated_workspace", strategyType: "task_directory" }).returning();
    const policy = { trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review",
      trustBoundary: { mode: "low_trust_review", companyId: f.companyId, rootIssueId: f.issueId } } };
    await server.db.update(agents).set({ adapterConfig: { provider: "codex", codexPermissionMode: "never" } }).where(eq(agents.id, f.agentId));
    await server.db.update(issues).set({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: workspace.id,
      executionPolicy: {} }).where(eq(issues.id, f.issueId));
    await server.db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: policy } }).where(eq(heartbeatRuns.id, f.runId));
    const call = (tool: string, args: Record<string, unknown>) => f.authority.execute({ tool, arguments: args, callId: randomUUID() });
    await expect(call("get_workspace", {})).resolves.toMatchObject({ workspace: { id: workspace.id } });
    await expect(call("prepare_repository", { repository: { kind: "url", url: "https://github.com/public/example" }, requestKey: "unlinked-full-auto" }))
      .rejects.toThrow(/trusted task/);
    expect(await server.db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.companyId, f.companyId))).toHaveLength(0);
  });

  it("does not expose repository preparation or workspace selection to Ask mode", async () => {
    const f = await server.fixture({ mode: "ask", conversation: true, disableWakeOnDemand: true });
    await expect(f.authority.execute({ tool: "prepare_repository", callId: randomUUID(), arguments: { repository: { kind: "url", url: "https://github.com/public/example" }, requestKey: "denied" } })).rejects.toThrow();
    await expect(f.authority.execute({ tool: "select_workspace", callId: randomUUID(), arguments: { selection: { kind: "task_directory" }, expectedBindingRevision: 0, requestKey: "denied" } })).rejects.toThrow();
  });
  it("lists shared and isolated task selections and excludes unavailable lifecycle states", async () => {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    const definitions = [
      { name: "Shared active", mode: "shared_workspace", status: "active", closedAt: null },
      { name: "Shared idle", mode: "shared_workspace", status: "idle", closedAt: null },
      { name: "Isolated idle", mode: "isolated_workspace", status: "idle", closedAt: null },
      { name: "In review", mode: "isolated_workspace", status: "in_review", closedAt: null },
      { name: "Archived", mode: "shared_workspace", status: "archived", closedAt: null },
      { name: "Closed", mode: "shared_workspace", status: "active", closedAt: new Date() },
    ];
    const rows = await server.db.insert(executionWorkspaces).values(definitions.map(definition => ({
      ...definition, companyId: f.companyId, projectId: null, strategyType: "task_directory", cwd: f.workspace,
    }))).returning();
    const call = (tool: string, args: Record<string, unknown>) => f.authority.execute({ tool, arguments: args, callId: randomUUID() });
    const listed = await call("list_workspaces", {}) as Array<{ id: string }>;
    const candidates = new Set(rows.slice(0, 3).map(row => row.id));
    expect(listed.filter(row => rows.some(candidate => candidate.id === row.id)).map(row => row.id).sort()).toEqual([...candidates].sort());
    for (const row of rows) {
      const view = await call("get_workspace", {}) as { bindingRevision: number };
      const selection = call("select_workspace", { selection: { kind: "existing", workspaceId: row.id },
        expectedBindingRevision: view.bindingRevision, requestKey: `select-${row.id}` });
      if (candidates.has(row.id)) await expect(selection).resolves.toMatchObject({ kind: "scheduled" });
      else await expect(selection).rejects.toThrow("Workspace is unavailable or inaccessible");
    }
  });
  it("keeps source authorization on projectless task workspace inspection, selection, and preparation", async () => {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    await server.db.update(issues).set({ projectId: null, projectWorkspaceId: null }).where(eq(issues.id, f.issueId));
    const [source] = await server.db.insert(executionWorkspaces).values({ companyId: f.companyId,
      projectId: f.projectId, projectWorkspaceId: f.projectWorkspaceId, mode: "shared_workspace", strategyType: "project_primary", cwd: f.workspace, name: "Source project" }).returning();
    const [unrelated] = await server.db.insert(executionWorkspaces).values({ companyId: f.companyId,
      projectId: null, sourceIssueId: f.blockerId, mode: "shared_workspace", strategyType: "task_directory", cwd: f.workspace, name: "Unrelated task files" }).returning();
    await server.db.update(issues).set({ projectId: null }).where(eq(issues.id, f.blockerId));
    const boundary = { mode: "low_trust_review", companyId: f.companyId, rootIssueId: f.issueId };
    const policy = (projectIds: string[]) => ({ trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: { ...boundary, projectIds } } });
    await server.db.update(agents).set({ permissions: policy([]) }).where(eq(agents.id, f.agentId));
    const call = (tool: string, args: Record<string, unknown>) => f.authority.execute({ tool, arguments: args, callId: randomUUID() });
    await expect(call("list_workspaces", {})).rejects.toThrow(/outside.*boundary|company-wide|privileged/i);
    for (const selection of [{ kind: "existing", workspaceId: source.id },
      { kind: "configured_source", projectWorkspaceId: f.projectWorkspaceId, mode: "shared" },
      { kind: "existing", workspaceId: unrelated.id }]) {
      await expect(call("select_workspace", { selection, expectedBindingRevision: 0, requestKey: randomUUID() })).rejects.toThrow(/outside.*boundary/i);
    }
    await server.db.update(issues).set({ executionWorkspaceId: source.id }).where(eq(issues.id, f.issueId));
    await expect(call("get_workspace", {})).rejects.toThrow(/outside.*boundary/i);
    const repository = { repository: { kind: "url", url: "https://github.com/public/example" }, requestKey: "source-denied" };
    await expect(call("prepare_repository", repository)).rejects.toThrow(/outside.*boundary/i);
    expect(await server.db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.companyId, f.companyId))).toHaveLength(0);
    await server.db.update(agents).set({ permissions: policy([f.projectId]) }).where(eq(agents.id, f.agentId));
    await expect(call("get_workspace", {})).resolves.toMatchObject({ workspace: { id: source.id, projectId: f.projectId } });
    await expect(call("select_workspace", { selection: { kind: "existing", workspaceId: source.id }, expectedBindingRevision: 0, requestKey: "source-allowed" })).rejects.toThrow(/outside.*boundary/i);
    await expect(call("prepare_repository", repository)).rejects.toThrow(/outside.*boundary/i);
    expect(await server.db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.companyId, f.companyId))).toHaveLength(0);
    const unrelatedCwd = await mkdtemp(join(dirname(f.workspace), "unrelated-workspace-"));
    await server.db.update(executionWorkspaces).set({ cwd: unrelatedCwd }).where(eq(executionWorkspaces.id, unrelated.id));
    await expect(call("select_workspace", { selection: { kind: "existing", workspaceId: source.id }, expectedBindingRevision: 0, requestKey: "source-allowed" })).resolves.toMatchObject({ kind: "scheduled" });
    await expect(call("prepare_repository", repository)).rejects.toThrow(/trusted task/);
    expect((await server.db.select().from(issues).where(eq(issues.id, f.issueId)))[0]?.projectId).toBeNull();
  });
});
