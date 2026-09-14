import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import type { Request } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, projectWorkspaces, projects,
  runtimeServiceDataDeletions, runtimeServices, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { createRuntimeServiceSchema } from "@paperclipai/shared";
import { createRuntimeServiceDataDeletionStore } from "./data-deletion.js";
import { createTaskWorkspaceDataDeletionStore } from "./workspace-data-deletion.js";
import { createRuntimeServiceDependencies } from "./application.js";
import { executionWorkspaceService, EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY } from "../execution-workspaces.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import { environmentService } from "../environments.js";
import { workspaceRuntimeLeaseService } from "../workspace-runtime-leases.js";
import { ensurePersistedExecutionWorkspaceAvailable, realizeExecutionWorkspace, startRuntimeServicesForWorkspaceControl } from "../workspace-runtime.js";

import { withTaskWorkspaceDataAdmission } from "./workspace-data-fence.js";
import { bindRuntimeServiceInvocationDirectory } from "./placement.js";

const exec = promisify(execFile);
const board = { actor: { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true } } as Request;
describe("operator deletion of owned local task workspace data", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-task-data-deletion-"); db = createDb(database.connectionString); }, 30_000);
  afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
  afterAll(async () => { await database?.cleanup(); });
  async function git(cwd: string, ...args: string[]) { return (await exec("git", ["-C", cwd, ...args])).stdout.trim(); }
  async function fixture(kind: "git_worktree" | "local_fs" = "git_worktree", nested = false) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-task-deletion-"))); roots.push(root);
    const base = path.join(root, "project"), cwd = nested ? path.join(base, ".paperclip", "worktrees", "task") : path.join(root, "task"); await fs.mkdir(base);
    await git(base, "init", "-b", "main"); await git(base, "config", "user.name", "Test"); await git(base, "config", "user.email", "test@example.test");
    await fs.writeFile(path.join(base, "source.txt"), "project source"); await git(base, "add", "."); await git(base, "commit", "-m", "Initial source");
    if (kind === "git_worktree") await git(base, "worktree", "add", "-b", "runtime/app", cwd); else await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "dirty.txt"), "uncommitted work"); await fs.mkdir(path.join(cwd, "sub"));
    const companyId = randomUUID(); await db.insert(companies).values({ id: companyId, name: "Task cleanup", issuePrefix: `D${companyId.slice(0, 5)}` });
    const [project] = await db.insert(projects).values({ companyId, name: "App" }).returning();
    const [primary] = await db.insert(projectWorkspaces).values({ companyId, projectId: project!.id, name: "Primary", cwd: base, isPrimary: true }).returning();
    const [task] = await db.insert(issues).values({ companyId, projectId: project!.id, title: "Develop app", status: "done" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project!.id, projectWorkspaceId: primary!.id, sourceIssueId: task!.id, name: "App workspace",
      mode: "isolated_workspace", strategyType: kind === "git_worktree" ? "git_worktree" : "project_primary", providerType: kind, cwd, providerRef: cwd,
      branchName: kind === "git_worktree" ? "runtime/app" : null, metadata: { createdByRuntime: true, gitBranchOwnershipVersion: 1 } }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace!.id }).where(eq(issues.id, task!.id));
    const make = () => createRuntimeServiceDependencies(db, {}), app = make();
    const input = createRuntimeServiceSchema.parse({ name: "Task preview", purpose: "worker", issueId: task!.id, command: "node worker.cjs", start: false, requestId: randomUUID() });
    const service = await app.operations.create(board, companyId, input);
    const peer = await app.operations.create(board, companyId, { ...input, name: "Task API", requestId: randomUUID(), cwd: path.join(cwd, "sub") });
    const review = () => app.operations.dataDeletionReview(board, companyId, service.id);
    const accept = async () => { const plan = await review(); expect(plan.blockers).toEqual([]);
      const request = { requestId: randomUUID(), confirmedAllocationId: plan.allocationId, planToken: plan.planToken, confirm: true as const };
      return { request, plan: await app.operations.deleteData(board, companyId, service.id, request) }; };
    return { root, base, cwd, companyId, project: project!, workspace: workspace!, task: task!, service, peer, app, make, input, review, accept };
  }
  it.each(["git_worktree", "local_fs"] as const)("expires unused %s data through a durable policy-authorized job, preserving the project", async (kind) => {
    const f = await fixture(kind), actor = { type: "board" as const, id: "retention-operator" };
    let clock = new Date();
    const store = () => createRuntimeServiceDataDeletionStore(db, { now: () => clock });
    await store().expirationTick();
    expect((await f.app.manager.get(f.companyId, f.service.id)).retention.expiration?.state).toBe("disabled");
    expect(await fs.readFile(path.join(f.cwd, "dirty.txt"), "utf8")).toBe("uncommitted work");
    const policy = await f.app.manager.updateCompanyPolicy(f.companyId, actor, { requestId: randomUUID(), expectedRevision: 0, config: { retainedDataSeconds: 86400 } });
    clock = new Date(Date.parse(policy.updatedAt!) + 1000);
    await store().expirationTick();
    const scheduled = (await f.app.manager.get(f.companyId, f.service.id)).retention.expiration!;
    expect(scheduled.state).toBe("scheduled");
    expect(scheduled.expiresAt).toBe(new Date(Date.parse(policy.updatedAt!) + 86400_000).toISOString());
    expect((await f.app.manager.get(f.companyId, f.peer.id)).retention.expiration).toEqual(scheduled);
    clock = new Date(Date.parse(scheduled.expiresAt!) + 1);
    await store().expirationTick();
    const accepted = (await f.app.manager.get(f.companyId, f.service.id)).dataDeletion!;
    expect(accepted).toMatchObject({ state: "pending", reason: "retention", policyRevision: policy.revision });
    const [job] = await db.select().from(runtimeServiceDataDeletions).where(eq(runtimeServiceDataDeletions.id, accepted.id));
    expect(job).toMatchObject({ requestedByUserId: null, authorization: { kind: "retention", policyRevision: 1, retainedDataSeconds: 86400 } });
    expect(await fs.readFile(path.join(f.cwd, "dirty.txt"), "utf8")).toBe("uncommitted work");
    // Policy changes do not undo an already committed destructive job/fence.
    await f.app.manager.updateCompanyPolicy(f.companyId, actor, { requestId: randomUUID(), expectedRevision: 1, config: { retainedDataSeconds: null } });
    await store().tick();
    expect((await f.app.manager.get(f.companyId, f.peer.id)).dataDeletion).toMatchObject({ id: accepted.id, state: "deleted", reason: "retention" });
    await expect(fs.stat(f.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(f.base, "source.txt"), "utf8")).toBe("project source");
    expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(0);
  });
  it("rechecks policy changes and completed work between expiry review and acceptance", async () => {
    const f = await fixture(), actor = { type: "board" as const, id: "retention-operator" };
    const policy = await f.app.manager.updateCompanyPolicy(f.companyId, actor, { requestId: randomUUID(), expectedRevision: 0, config: { retainedDataSeconds: 86400 } });
    let clock = new Date(Date.parse(policy.updatedAt!) + 2 * 86400_000);
    const store = createTaskWorkspaceDataDeletionStore(db, { now: () => clock });
    const { current, expiration } = await store.expiration(f.companyId, f.service.id);
    expect(expiration.state).toBe("expired");
    const input = { requestId: randomUUID(), confirmedAllocationId: current.plan.allocationId, planToken: current.plan.planToken, confirm: true as const };
    // Same terminal status and same plan token, but the task was used again.
    await db.update(issues).set({ updatedAt: clock }).where(eq(issues.id, f.task.id));
    await expect(store.requestExpired(f.companyId, f.service.id, input, policy.revision)).rejects.toThrow("workspace activity changed");
    expect((await f.app.manager.get(f.companyId, f.service.id)).dataDeletion).toBeNull();
    clock = new Date(clock.getTime() + 2 * 86400_000);
    const next = await store.expiration(f.companyId, f.service.id);
    await f.app.manager.updateCompanyPolicy(f.companyId, actor, { requestId: randomUUID(), expectedRevision: policy.revision, config: { retainedDataSeconds: null } });
    await expect(store.requestExpired(f.companyId, f.service.id, { ...input, planToken: next.current.plan.planToken }, policy.revision)).rejects.toThrow("retention policy");
    expect(await fs.readFile(path.join(f.cwd, "dirty.txt"), "utf8")).toBe("uncommitted work");
  });
  it("protects active shared consumers and resets expiry for a turn that finished between sweeps", async () => {
    const f = await fixture(), actor = { type: "board" as const, id: "retention-operator" };
    const policy = await f.app.manager.updateCompanyPolicy(f.companyId, actor, { requestId: randomUUID(), expectedRevision: 0, config: { retainedDataSeconds: 86400 } });
    const clock = new Date(Date.parse(policy.updatedAt!) + 2 * 86400_000), store = createTaskWorkspaceDataDeletionStore(db, { now: () => clock });
    await db.update(runtimeServices).set({ desiredState: "running" }).where(eq(runtimeServices.id, f.peer.id));
    expect((await store.expiration(f.companyId, f.service.id)).expiration.state).toBe("protected");
    await db.update(runtimeServices).set({ desiredState: "stopped" }).where(eq(runtimeServices.id, f.peer.id));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.task.id));
    expect((await store.expiration(f.companyId, f.service.id)).expiration.blockers.join(" ")).toContain("Complete or cancel");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.task.id));
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Developer" }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id, status: "succeeded", finishedAt: clock, updatedAt: clock, contextSnapshot: { issueId: f.task.id, executionWorkspaceId: f.workspace.id } });
    const fresh = (await store.expiration(f.companyId, f.service.id)).expiration;
    expect(fresh.state).toBe("scheduled");
    expect(fresh.expiresAt).toBe(new Date(clock.getTime() + 86400_000).toISOString());
  });
  it.each(["git_worktree", "local_fs"] as const)("deletes reviewed %s files and shared services only after committing a durable job", async (kind) => {
    const f = await fixture(kind), before = await f.review();
    expect(before.services.map((service) => service.id).sort()).toEqual([f.service.id, f.peer.id].sort());
    expect(before.workspace).toMatchObject({ id: f.workspace.id, name: "App workspace" });
    expect(before.tasks).toMatchObject([{ id: f.task.id }]);
    const { request, plan } = await f.accept();
    expect(plan.deletion?.state).toBe("pending"); expect(await fs.readFile(path.join(f.cwd, "dirty.txt"), "utf8")).toBe("uncommitted work");
    expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(2);
    await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    const completed = (await f.app.manager.get(f.companyId, f.service.id)).dataDeletion;
    expect(completed, completed?.error ?? undefined).toMatchObject({ state: "deleted", attempts: 1 });
    expect((await f.app.manager.get(f.companyId, f.peer.id)).dataDeletion?.id).toBe(plan.deletion!.id);
    await expect(fs.lstat(f.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(f.base, "source.txt"), "utf8")).toBe("project source");
    if (kind === "git_worktree") expect(await git(f.base, "rev-parse", "runtime/app")).toBe(await git(f.base, "rev-parse", "main"));
    expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(0);
    expect((await f.app.operations.deleteData(board, f.companyId, f.service.id, request)).deletion?.state).toBe("deleted");
    expect(await f.app.manager.list(f.companyId)).toEqual([]);
  });
  it("blocks active tasks, stale confirmation and active final-sync leases", async () => {
    const f = await fixture(); const original = await f.review();
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.task.id));
    expect((await f.review()).blockers.join(" ")).toContain("Complete or cancel");
    await expect(f.app.operations.deleteData(board, f.companyId, f.service.id, { requestId: randomUUID(), confirmedAllocationId: original.allocationId, planToken: original.planToken, confirm: true })).rejects.toThrow("changed");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.task.id));
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Developer" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id, status: "succeeded", contextSnapshot: { issueId: f.task.id, executionWorkspaceId: f.workspace.id } }).returning();
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: environment!.id, provider: "local", status: "active", heartbeatRunId: run!.id, executionWorkspaceId: f.workspace.id }).returning();
    expect((await f.review()).blockers.join(" ")).toContain("final file sync");
    await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, lease!.id));
    const { plan } = await f.accept(); await f.app.manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("deleted");
  });
  it("rejects new service, workspace, runtime-control, realization and agent-run admission after acceptance", async () => {
    const f = await fixture(), { plan } = await f.accept();
    await expect(f.app.operations.create(board, f.companyId, { ...f.input, requestId: randomUUID() })).rejects.toThrow(/delet/i);
    await expect(f.app.operations.create(board, f.companyId, { ...f.input, issueId: undefined, cwd: f.cwd, requestId: randomUUID() })).rejects.toThrow(/delet/i);
    const workspaces = executionWorkspaceService(db);
    await expect(workspaces.update(f.workspace.id, { status: "active" })).rejects.toThrow(/delet/i);
    await expect(workspaces.reopenClosedIsolatedExecutionWorkspaceForIssue({ workspaceId: f.workspace.id, issue: f.task, actor: { actorType: "user", agentId: null } })).rejects.toThrow(/delet/i);
    await expect(workspaces.create({ ...f.workspace, id: randomUUID(), status: "active" })).rejects.toThrow(/delet/i);
    await expect(workspaceRuntimeLeaseService(db).claim({ companyId: f.companyId, executionWorkspaceId: f.workspace.id, action: "start", owner: { actorType: "user" } })).rejects.toThrow(/delet/i);
    const actor = { id: randomUUID(), name: "Operator", companyId: f.companyId };
    await expect(ensurePersistedExecutionWorkspaceAvailable({ db, agent: actor, issue: null, workspace: f.workspace,
      base: { baseCwd: f.base, source: "project_primary", projectId: f.project.id, workspaceId: f.workspace.projectWorkspaceId, repoUrl: null, repoRef: null } })).rejects.toThrow(/delet/i);
    await expect(startRuntimeServicesForWorkspaceControl({ db, actor, issue: null, executionWorkspaceId: f.workspace.id,
      workspace: { cwd: f.cwd } as Parameters<typeof startRuntimeServicesForWorkspaceControl>[0]["workspace"], config: {}, adapterEnv: {} })).rejects.toThrow(/delet/i);
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    const selected = (await environmentService(db).getById(environment!.id))!;
    await expect(environmentRuntimeService(db).acquireRunLease({ companyId: f.companyId, environment: selected, issueId: f.task.id, heartbeatRunId: null,
      persistedExecutionWorkspace: { id: f.workspace.id, mode: "isolated_workspace" } })).rejects.toThrow(/delet/i);
    await f.app.manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    await expect(workspaces.update(f.workspace.id, { status: "active" })).rejects.toThrow(/delet/i);
  });
  it("allows an idle parent checkout but blocks its queued run and another nested workspace", async () => {
    const f = await fixture("git_worktree", true);
    const [parent] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: f.project.id, name: "Primary checkout",
      mode: "shared_workspace", strategyType: "project_primary", providerType: "local_fs", cwd: f.base, providerRef: f.base }).returning();
    expect((await f.review()).blockers).toEqual([]);
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Parent developer" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id, status: "queued", contextSnapshot: { executionWorkspaceId: parent!.id } }).returning();
    expect((await f.review()).blockers.join(" ")).toContain("agent run");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run!.id));
    const [overlap] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: f.project.id, name: "Nested checkout",
      mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", cwd: path.join(f.cwd, "sub") }).returning();
    expect((await f.review()).blockers.join(" ")).toContain("Another execution workspace");
    await db.delete(executionWorkspaces).where(eq(executionWorkspaces.id, overlap!.id));
    const { plan } = await f.accept(); await f.app.manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("deleted");
    expect(await fs.readFile(path.join(f.base, "source.txt"), "utf8")).toBe("project source");
  });
  it("refuses deletion during workspace preparation and after a reopen until consumption finishes", async () => {
    const f = await fixture(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
    const preparation = withTaskWorkspaceDataAdmission(db, f.companyId, f.workspace.id, async () => { entered(); await gate; });
    await ready;
    try { await expect(f.accept()).rejects.toThrow("preparation is in progress"); }
    finally { release(); await preparation; }
    await db.update(executionWorkspaces).set({ metadata: { ...f.workspace.metadata, [EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY]: true } }).where(eq(executionWorkspaces.id, f.workspace.id));
    expect((await f.review()).blockers.join(" ")).toContain("just been reopened");
    await db.update(executionWorkspaces).set({ metadata: f.workspace.metadata }).where(eq(executionWorkspaces.id, f.workspace.id));
    const { plan } = await f.accept(); await f.app.manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("deleted");
  });
  it("fences aliases and quarantined files, and refuses new Git realization until cleanup completes", async () => {
    const f = await fixture(), { plan } = await f.accept();
    const alias = path.join(f.root, "alias"); await fs.symlink(f.root, alias);
    const quarantine = path.join(f.root, ".paperclip-service-deletions", plan.deletion!.id, f.workspace.id);
    await fs.mkdir(path.dirname(quarantine), { recursive: true }); await fs.rename(f.cwd, quarantine);
    for (const cwd of [path.join(alias, "task", "missing"), quarantine]) {
      await expect(withTaskWorkspaceDataAdmission(db, f.companyId, null, async () => undefined, cwd)).rejects.toThrow(/delet/i);
    }
    await expect(realizeExecutionWorkspace({ db, agent: { id: randomUUID(), name: "Developer", companyId: f.companyId }, issue: null,
      base: { baseCwd: f.base, source: "project_primary", projectId: f.project.id, workspaceId: f.workspace.projectWorkspaceId, repoUrl: null, repoRef: null },
      config: { workspaceStrategy: { type: "git_worktree", worktreeParentDir: f.root, branchTemplate: "task" } } })).rejects.toThrow(/delet/i);
    await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("deleted");
    await fs.mkdir(f.cwd); await fs.writeFile(path.join(f.cwd, "new.txt"), "new workspace");
    await expect(withTaskWorkspaceDataAdmission(db, f.companyId, null, async () => "new workspace", f.cwd)).resolves.toBe("new workspace");
    await expect(withTaskWorkspaceDataAdmission(db, f.companyId, f.workspace.id, async () => undefined)).rejects.toThrow(/delet/i);
  });
  it("refuses foreign-company file consumers without disclosing their services", async () => {
    const f = await fixture(), foreignCompanyId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId, name: "Other company", issuePrefix: `X${foreignCompanyId.slice(0, 5)}` });
    await f.app.operations.create(board, foreignCompanyId, { ...f.input, issueId: undefined, cwd: f.cwd, requestId: randomUUID() });
    const foreign = await f.review(); expect(foreign.blockers.join(" ")).toContain("Another workspace or company");
    expect(foreign.services.map((service) => service.id).sort()).toEqual([f.service.id, f.peer.id].sort());
  });
  it("refuses unconfirmed remote data and managed instance ownership", async () => {
    const f = await fixture();
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    const [remote] = await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: environment!.id, executionWorkspaceId: f.workspace.id,
      provider: "daytona", providerLeaseId: "fixture-no-real-sandbox", status: "released" }).returning();
    expect((await f.review()).blockers.join(" ")).toContain("Remote workspace data has not been confirmed deleted");
    await db.delete(environmentLeases).where(eq(environmentLeases.id, remote!.id));
    await db.update(executionWorkspaces).set({ metadata: { ...f.workspace.metadata, worktreeInstanceRoot: path.join(f.root, "managed-instance") } }).where(eq(executionWorkspaces.id, f.workspace.id));
    expect((await f.review()).blockers.join(" ")).toContain("managed instance");
    await db.update(executionWorkspaces).set({ metadata: f.workspace.metadata }).where(eq(executionWorkspaces.id, f.workspace.id));
    const { plan } = await f.accept(); await f.app.manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("deleted");
  });
  it("reviews local run directories without workspace IDs and fences late adapter binding", async () => {
    const f = await fixture(), [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Unbound developer" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id, status: "running" }).returning();
    const boundary = { version: 1, provider: "local", workspaceRoot: f.cwd, executionWorkspaceId: null, network: "enabled" };
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: environment!.id, heartbeatRunId: run!.id, provider: "local",
      status: "active", metadata: { runtimeServiceBoundary: boundary } }).returning();
    expect((await f.review()).blockers.join(" ")).toContain("agent run");
    await db.update(environmentLeases).set({ metadata: { runtimeServiceBoundary: { ...boundary, workspaceRoot: f.base } } }).where(eq(environmentLeases.id, lease!.id));
    const { plan } = await f.accept();
    await expect(bindRuntimeServiceInvocationDirectory(db, { companyId: f.companyId, runId: run!.id, environmentLeaseId: lease!.id, cwd: f.cwd })).rejects.toThrow(/delet/i);
    await f.app.manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("deleted");
  });
  it("shares admission locks so concurrent and nested preparation cannot exhaust the database pool", async () => {
    const f = await fixture(), smallPool = createDb(database.connectionString, { maxConnections: 3 });
    try {
      await Promise.all(Array.from({ length: 20 }, () => withTaskWorkspaceDataAdmission(smallPool, f.companyId, f.workspace.id,
        () => withTaskWorkspaceDataAdmission(smallPool, f.companyId, f.workspace.id, async () => {
          const [row] = await smallPool.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id));
          expect(row?.id).toBe(f.workspace.id);
        }))));
      const { plan } = await f.accept(); await f.app.manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
      expect((await f.review()).deletion?.state).toBe("deleted");
    } finally { await smallPool.$client.end({ timeout: 1 }); }
  }, 10_000);
  it("recovers the same local cleanup job after the controller dies immediately after quarantine", async () => {
    const f = await fixture(), { plan } = await f.accept(), marker = path.join(f.root, "renamed.json");
    // Only this test child's rename response is interrupted. The real host job,
    // Postgres commit and filesystem move happen before SIGKILL.
    const source = `
      import fs from "node:fs/promises";
      import { createDb } from "@paperclipai/db";
      import { createRuntimeServiceDependencies } from ${JSON.stringify(new URL("./application.ts", import.meta.url).href)};
      const rename = fs.rename;
      fs.rename = async (from, to) => {
        await rename(from, to);
        if (from === process.env.TASK_DELETE_SOURCE) {
          await fs.writeFile(process.env.TASK_DELETE_MARKER, JSON.stringify({ from, to }));
          await new Promise(() => {});
        }
      };
      await createRuntimeServiceDependencies(createDb(process.env.TASK_DELETE_DATABASE), {}).manager.reconcileDataDeletion(process.env.TASK_DELETE_COMPANY, process.env.TASK_DELETE_JOB);
    `;
    const child = spawn(process.execPath, ["--import", new URL("../../../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url).pathname, "--input-type=module", "-e", source], {
      cwd: new URL("../../../../server", import.meta.url).pathname,
      env: { ...process.env, TASK_DELETE_DATABASE: database.connectionString, TASK_DELETE_COMPANY: f.companyId, TASK_DELETE_JOB: plan.deletion!.id, TASK_DELETE_SOURCE: f.cwd, TASK_DELETE_MARKER: marker },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = ""; child.stderr!.on("data", (chunk) => { stderr += chunk.toString(); }); const exited = once(child, "exit");
    try {
      await vi.waitFor(async () => { if (child.exitCode !== null) throw new Error(`Cleanup child exited: ${stderr}`);
        expect(JSON.parse(await fs.readFile(marker, "utf8"))).toMatchObject({ from: f.cwd }); }, { timeout: 20_000, interval: 100 });
      expect((await f.review()).deletion).toMatchObject({ state: "deleting", attempts: 1 });
      child.kill("SIGKILL"); expect(await exited).toEqual([null, "SIGKILL"]);
      expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(2);
      await expect(f.app.operations.create(board, f.companyId, { ...f.input, requestId: randomUUID() })).rejects.toThrow(/delet|workspace is unavailable/i);
      await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
      expect((await f.review()).deletion).toMatchObject({ state: "deleting", attempts: 1 });
      // Another controller waits for the durable claim deadline even when this
      // test knows the original process has died. Then it recovers the same job.
      await db.update(runtimeServiceDataDeletions).set({ retryAt: new Date(Date.now() - 1) }).where(eq(runtimeServiceDataDeletions.id, plan.deletion!.id));
      await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
      expect((await f.review()).deletion).toMatchObject({ id: plan.deletion!.id, state: "deleted", attempts: 2 });
      const { to } = JSON.parse(await fs.readFile(marker, "utf8")); await expect(fs.lstat(to)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await git(f.base, "rev-parse", "runtime/app")).toBe(await git(f.base, "rev-parse", "main"));
      expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(0);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }
  }, 35_000);
  it("keeps replacement files, retained capacity and retry identity after incomplete cleanup", async () => {
    const f = await fixture(), { plan } = await f.accept();
    const original = `${f.cwd}-original`, replacement = `${f.cwd}-replacement`;
    await fs.rename(f.cwd, original); await fs.mkdir(f.cwd); await fs.writeFile(path.join(f.cwd, "new.txt"), "keep new files");
    await f.app.manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("failed"); expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(2);
    expect(await fs.readFile(path.join(f.cwd, "new.txt"), "utf8")).toBe("keep new files");
    await fs.rename(f.cwd, replacement); await fs.rename(original, f.cwd);
    const retried = await f.accept(); expect(retried.plan.deletion?.id).toBe(plan.deletion!.id);
    await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    const completed = (await f.review()).deletion;
    expect(completed, completed?.error ?? undefined).toMatchObject({ state: "deleted", attempts: 2 });
    expect(await fs.readFile(path.join(replacement, "new.txt"), "utf8")).toBe("keep new files");
  });
});
