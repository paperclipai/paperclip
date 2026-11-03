import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environments,
  executionWorkspaces,
  issues,
  plugins,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

const adapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  sessionParams: { sessionId: "session-1" },
  sessionDisplayId: "session-1",
  provider: "test",
  model: "test-model",
})));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat plugin storage local tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat plugin storage local execution", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const tempRoots: string[] = [];
  const heartbeats: ReturnType<typeof heartbeatService>[] = [];

  async function grantResponsibleUser(companyId: string, userId: string) {
    await db.insert(authUsers).values({
      id: userId, name: "Responsible user", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member",
    });
  }

  /**
   * Stands in for the storage plugin's wt claim flow: the source repo hosts a
   * worktree at `tree` on the requested branch. The real plugin will issue the
   * `git worktree add` (via wt) inside its prepare op, so the mock prepares a
   * real claim tree with real git metadata.
   */
  function claimWorktree(mainRepo: string, tree: string, branch: string) {
    execFileSync("git", ["worktree", "add", tree, "-b", branch], { cwd: mainRepo, stdio: "pipe" });
  }

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-plugin-storage-local");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    // The `local` driver is an instance-wide singleton (unique partial index).
    // A shared admin test database may persist rows across runs: reuse the
    // existing local environment instead of trusting a fresh insert.
    const [existingLocal] = await db.select({ id: environments.id })
      .from(environments).where(eq(environments.driver, "local")).limit(1);
    if (existingLocal) {
      sharedLocalEnvironmentId = existingLocal.id;
    } else {
      sharedLocalEnvironmentId = randomUUID();
      await db.insert(environments).values({ id: sharedLocalEnvironmentId,
        name: `Local storage host ${randomUUID().slice(0, 8)}`, driver: "local", status: "active",
        config: {} }).onConflictDoNothing();
      const [created] = await db.select({ id: environments.id })
        .from(environments).where(eq(environments.driver, "local")).limit(1);
      if (created) sharedLocalEnvironmentId = created.id;
    }
  }, 20_000);

  afterEach(async () => {
    for (const heartbeat of heartbeats.splice(0)) await heartbeat.drainActiveRunExecutions();
    adapterExecute.mockClear();
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await db.$client.end();
    await stopDb?.();
  });

  let sharedLocalEnvironmentId!: string;

  it("runs a plugin-storage workspace in place on the local driver at the provider host tree", async () => {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceId = randomUUID();
    const environmentId = sharedLocalEnvironmentId, pluginId = randomUUID(), pluginKey = `test.storage.${pluginId}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-storage-local-")); tempRoots.push(root);
    const mainRepo = path.join(root, "repo");
    const hostRef = path.join(root, "claim", "pc-issue");
    await mkdir(mainRepo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: mainRepo, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: mainRepo, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: mainRepo, stdio: "pipe" });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: mainRepo, stdio: "pipe" });
    await db.insert(companies).values({ id: companyId, name: "Storage local fixture", issuePrefix: "STS", defaultResponsibleUserId: "storage-user" });
    await grantResponsibleUser(companyId, "storage-user");
    await db.insert(projects).values({ id: projectId, companyId, name: "Storage local fixture", status: "active",
      executionWorkspacePolicy: { enabled: true, storageProviderPluginId: pluginId } });
    await db.insert(projectWorkspaces).values([
      { id: sourceId, companyId, projectId, name: "Primary", cwd: mainRepo, isPrimary: true },
      { companyId, projectId, name: "Extra", cwd: null, repoUrl: "/unavailable-controller-repository.git", isPrimary: false },
    ]);
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "@test/storage", version: "1.0.0", apiVersion: 1,
      categories: ["automation"], status: "ready", manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0",
        displayName: "Storage", description: "Local storage plugin", author: "Paperclip", categories: ["automation"],
        capabilities: ["workspaces.manage", "events.subscribe"], resourceLifecycle: ["project"],
        workspaceProvider: { modes: ["shared_workspace", "isolated_workspace", "operator_branch"], strategies: ["project_primary", "git_worktree"] },
        entrypoints: { worker: "worker.js" } } });
    await db.insert(agents).values({ id: agentId, companyId, name: "Local agent", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-6.1-sol", lifecycleMode: "warm" }, runtimeConfig: {},
      defaultEnvironmentId: environmentId, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, projectId, projectWorkspaceId: sourceId, title: "Local storage dispatch", status: "in_progress",
      assigneeAgentId: agentId, issueNumber: 1, identifier: "STS-1" });
    const call = vi.fn(async (_id: string, method: string, params?: any) => {
      if (method === "workspaceOperation") {
        // The provider creates the claim tree (wt claim) during prepare.
        await mkdir(path.dirname(hostRef), { recursive: true });
        claimWorktree(mainRepo, hostRef, params.operation.branchName);
        return { kind: "prepared", binding: { pluginId, projectId,
          executionWorkspaceId: params.executionWorkspaceId, projectWorkspaceId: params.operation.source.id,
          sourceRevision: params.operation.source.revision, workspaceRef: hostRef },
          branchName: params.operation.branchName, baseSha: "a".repeat(40), created: true, branchCreatedByRuntime: false };
      }
      if (method === "environmentReleaseLease" || method === "environmentDestroyLease") return undefined;
      throw new Error(`Unexpected storage provider call: ${method}`);
    });
    const workerManager = { isRunning: () => true, getWorker: () => ({ supportedMethods: ["workspaceOperation"] }), call } as unknown as PluginWorkerManager;
    const entered = vi.fn(() => { throw new Error("synthetic_native_boundary_reached"); });
    const heartbeat = heartbeatService(db, { pluginWorkerManager: workerManager, nativeSessionBackendFactory: entered });
    heartbeats.push(heartbeat);
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId, projectId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => { expect((await heartbeat.getRun(run!.id))?.status).toBe("failed"); }, { timeout: 15_000 });
    expect((await heartbeat.getRun(run!.id))?.error).toContain("synthetic_native_boundary_reached");
    // The native Runner would execute at the claim tree, not a Core workspace copy.
    const seamInput = entered.mock.calls.at(-1)?.[0] as { workspace?: { cwd?: unknown } } | undefined;
    expect(seamInput?.workspace?.cwd ?? null).toBe(hostRef);
    // The storage layer recorded the host path on the row.
    const [ws] = await db.select().from(executionWorkspaces)
      .where(and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.sourceIssueId, issueId)));
    expect(ws?.providerType).toBe("plugin");
    expect(ws?.providerRef).toBe(hostRef);
    expect(ws?.cwd).toBe(hostRef);
    // A pure storage plugin only ever sees storage operations.
    expect(call.mock.calls.every(([, method]) => method === "workspaceOperation")).toBe(true);
    expect(call.mock.calls.filter(([, method]) => method === "workspaceOperation")).toHaveLength(1);
    expect(adapterExecute).not.toHaveBeenCalled();
  }, 30_000);

  it("refuses a local run when the provider host tree is missing instead of bridging to a plugin environment", async () => {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceId = randomUUID();
    const environmentId = sharedLocalEnvironmentId, pluginId = randomUUID(), pluginKey = `test.storage.missing.${pluginId}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-storage-missing-")); tempRoots.push(root);
    const mainRepo = path.join(root, "repo");
    const missingHostRef = path.join(root, "gone", "pc-issue");
    await mkdir(mainRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: mainRepo, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: mainRepo, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: mainRepo, stdio: "pipe" });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: mainRepo, stdio: "pipe" });
    await db.insert(companies).values({ id: companyId, name: "Storage missing fixture", issuePrefix: "STM", defaultResponsibleUserId: "storage-user" });
    await grantResponsibleUser(companyId, "storage-user");
    await db.insert(projects).values({ id: projectId, companyId, name: "Storage missing fixture", status: "active",
      executionWorkspacePolicy: { enabled: true, storageProviderPluginId: pluginId } });
    await db.insert(projectWorkspaces).values([
      { id: sourceId, companyId, projectId, name: "Primary", cwd: mainRepo, isPrimary: true },
    ]);
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "@test/storage", version: "1.0.0", apiVersion: 1,
      categories: ["automation"], status: "ready", manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0",
        displayName: "Storage", description: "Local storage plugin", author: "Paperclip", categories: ["automation"],
        capabilities: ["workspaces.manage", "events.subscribe"], resourceLifecycle: ["project"],
        workspaceProvider: { modes: ["shared_workspace", "isolated_workspace", "operator_branch"], strategies: ["project_primary", "git_worktree"] },
        entrypoints: { worker: "worker.js" } } });
    await db.insert(agents).values({ id: agentId, companyId, name: "Local agent", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-6.1-sol", lifecycleMode: "warm" }, runtimeConfig: {},
      defaultEnvironmentId: environmentId, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, projectId, projectWorkspaceId: sourceId, title: "Missing tree dispatch", status: "in_progress",
      assigneeAgentId: agentId, issueNumber: 1, identifier: "STM-1" });
    const call = vi.fn(async (_id: string, method: string, params?: any) => {
      if (method === "workspaceOperation") {
        // The tree is gone (or the reference was never a host path).
        return { kind: "prepared", binding: { pluginId, projectId,
          executionWorkspaceId: params.executionWorkspaceId, projectWorkspaceId: params.operation.source.id,
          sourceRevision: params.operation.source.revision, workspaceRef: missingHostRef },
          branchName: params.operation.branchName, baseSha: "a".repeat(40), created: true, branchCreatedByRuntime: false };
      }
      if (method === "environmentReleaseLease" || method === "environmentDestroyLease") return undefined;
      throw new Error(`Unexpected storage provider call: ${method}`);
    });
    const workerManager = { isRunning: () => true, getWorker: () => ({ supportedMethods: ["workspaceOperation"] }), call } as unknown as PluginWorkerManager;
    const entered = vi.fn(() => { throw new Error("synthetic_native_boundary_reached"); });
    const heartbeat = heartbeatService(db, { pluginWorkerManager: workerManager, nativeSessionBackendFactory: entered });
    heartbeats.push(heartbeat);
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId, projectId } });
    await vi.waitFor(async () => { expect((await heartbeat.getRun(run!.id))?.status).toBe("failed"); }, { timeout: 15_000 });
    expect((await heartbeat.getRun(run!.id))?.error).toContain("not an accessible host directory");
    expect(entered).not.toHaveBeenCalled();
  }, 30_000);
});
