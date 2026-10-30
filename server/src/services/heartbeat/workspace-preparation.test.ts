import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { captureDirectorySnapshot, directorySnapshotSha256, serializeDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { agentWakeupRequests, heartbeatRunEvents, companyObservability, issueRecoveryActions, agents, authUsers, companyMemberships, companies, createDb, applyPendingMigrations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, executionWorkspaces, executionWorkspaceRepositoryAccess, heartbeatRuns, issues, issueAccessGrants, plugins, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { heartbeatService } from "../heartbeat.js";
import { registerServerAdapter, getServerAdapter, type AdapterExecutionContext } from "../../adapters/index.js";
import { environmentRunOrchestrator } from "../environment-run-orchestrator.js";
import { environmentService } from "../environments.js";
import { executionWorkspaceService, toExecutionWorkspace } from "../execution-workspaces.js";
import { instanceSettingsService } from "../instance-settings.js";
import { workspaceOperationService } from "../workspace-operations.js";
import { nativeWorkspaceSyncInternals, prepareNativeWorkspaceSync } from "../native-runtime/native-workspace-sync.js";
import { createHeartbeatWorkspaceResolver, prepareProjectRepositoryWorkspaces, resolveExecutionWorkspaceReuseRequestForIssue } from "./workspaces.js";
import { prepareHeartbeatWorkspace, type HeartbeatWorkspacePreparationInput } from "./workspace-preparation.js";
import { buildNativeExecutionInput } from "../native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../native-runtime/runtime-context.test-fixture.js";
import * as managedRepositoryCheckout from "../managed-repository-checkout.js";
import { requestTaskRetry } from "../task-retry.js";
import { readFreshWorkspaceReadiness } from "../fresh-workspace-continuation.js";
import { createSystemRecovery } from "../system-recovery-state.js";
import { isolatedRemoteSourcePath } from "../isolated-remote-workspace-source.js";
import { cleanupExecutionWorkspaceArtifacts } from "../workspace-runtime.js";
import { buildProjectMentionHref } from "@paperclipai/shared";
import { trace } from "@opentelemetry/api";
import { effectiveProjectWorkspacePolicy } from "../project-workspace-provider.js";
import { resolveExecutionWorkspaceMode, buildExecutionWorkspaceAdapterConfig } from "../execution-workspace-policy.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { selectHeartbeatEnvironment } from "./environment-selection.js";

const execFile = promisify(execFileCallback);
const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_WORKSPACE_PREPARATION_TEST_DATABASE_URL");
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported && !externalDatabaseUrl)("heartbeat workspace preparation boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paperclip-workspace-preparation-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    const external = externalDatabaseUrl;
    if (external) await applyPendingMigrations(external);
    database = external ? { connectionString: external, cleanup: async () => {} }
      : await startEmbeddedPostgresTestDatabase("paperclip-workspace-preparation");
    db = createDb(database.connectionString);
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.execute(sql`truncate table companies, plugins restart identity cascade`);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
  });

  async function fixture(isolated = false) {
    const [company] = await db.insert(companies).values({ name: "Workspace preparation", issuePrefix: "WSP" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Workspace agent", status: "running", adapterType: "process" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Source project" }).returning();
    const source = join(home, project.id);
    await mkdir(source);
    await execFile("git", ["init", "--initial-branch=main", source]);
    await execFile("git", ["-C", source, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", source, "config", "user.name", "Workspace test"]);
    await writeFile(join(source, "README.md"), "source content\n");
    await execFile("git", ["-C", source, "add", "."]);
    await execFile("git", ["-C", source, "commit", "-m", "Source"]);
    const [projectWorkspace] = await db.insert(projectWorkspaces).values({ companyId: company.id, projectId: project.id, name: "Source", cwd: source, isPrimary: true }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Prepare this workspace", identifier: "WSP-1", projectId: project.id, projectWorkspaceId: projectWorkspace.id, assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    const localEnvironment = await environmentService(db).ensureLocalEnvironment(company.id);
    const envOrchestrator = environmentRunOrchestrator(db);
    const resolver = createHeartbeatWorkspaceResolver(db);
    const input: HeartbeatWorkspacePreparationInput = {
      run, agent,
      task: { issueRef: issue, issueId: issue.id, context: { issueId: issue.id, projectId: project.id }, responsibleUserId: null, previousSessionParams: null },
      policy: {
        trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
        isolatedWorkspacesEnabled: true,
        effectiveExecutionWorkspaceMode: isolated ? "isolated_workspace" : "shared_workspace",
        requestedExecutionWorkspaceMode: isolated ? "isolated_workspace" : "shared_workspace",
        useIsolatedTaskDirectory: false, nativeChatWorkspaceScope: null,
        projectExecutionWorkspacePolicy: null, issueExecutionWorkspaceSettings: null, environmentExecutionWorkspaceSettings: null,
        executionPolicy: { executionMode: "any" },
      },
      environment: { selectedEnvironmentId: localEnvironment.id, localEnvironment, selectedEnvironmentForConfig: localEnvironment, environmentResolution: { environmentId: localEnvironment.id, source: "default" }, resolvedInstanceSettings: await instanceSettingsService(db).get() },
      config: { mergedConfig: isolated ? { workspaceStrategy: { type: "git_worktree", baseRef: "main", branchTemplate: "test-{{issue.identifier}}" } } : {}, configSnapshot: null, secretManifest: [] },
      reuse: { requestedShouldReuseExisting: false, existingExecutionWorkspace: null, reusableExistingExecutionWorkspace: null, workspaceReuseRequest: resolveExecutionWorkspaceReuseRequestForIssue({ issueExecutionWorkspaceId: null, issueExecutionWorkspacePreference: null, existingExecutionWorkspaceStatus: null }), nativeRecoveryExecutionWorkspaceId: null, persistedNativeExecutionInput: null, isDotRun: false, runOptions: {} },
      services: { envOrchestrator, executionWorkspacesSvc: executionWorkspaceService(db), workspaceOperationsSvc: workspaceOperationService(db), ...resolver, appendRunEvent: vi.fn() },
      controllerLease: { assertOwned: vi.fn(async () => {}) }, nativeRunnerPreparationSpans: [],
    };
    return { input, source, issue, run, envOrchestrator };
  }
  it.each([
    { inherited: false, mode: "isolated_workspace" as const, fresh: false },
    { inherited: false, mode: "isolated_workspace" as const, fresh: true },
    { inherited: true, mode: "isolated_workspace" as const, fresh: false },
    { inherited: true, mode: "operator_branch" as const, fresh: false },
  ])("prepares managed storage before acquisition (inherited: $inherited, mode: $mode, fresh: $fresh) without touching a Core checkout", async ({ inherited, mode: defaultMode, fresh }) => {
    const { input, source, issue } = await fixture(true);
    const pluginKey = `test.managed-storage-${inherited}-${defaultMode}-${fresh}`;
    const [plugin] = await db.insert(plugins).values({ pluginKey, packageName: "test-storage", version: "1.0.0", apiVersion: 1, status: "ready", categories: ["workspace"],
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Storage", description: "Storage", author: "Test", categories: ["workspace"],
        workspaceProvider: { freshWorkspaceVersion: 1, modes: ["isolated_workspace", "operator_branch"], strategies: ["git_worktree"], ...(inherited ? { defaultForProjects: { mode: defaultMode, strategy: "git_worktree" as const } } : {}) }, capabilities: ["workspaces.manage", "events.subscribe"], resourceLifecycle: ["project"], entrypoints: { worker: "./worker.js" } } }).returning();
    const explicitPolicy = { enabled: true, storageProviderPluginId: plugin.id, defaultMode: "isolated_workspace" as const,
      workspaceStrategy: { type: "git_worktree" as const, baseRef: "main", branchTemplate: "test-{{issue.identifier}}" } };
    if (!inherited) await db.update(projects).set({ executionWorkspacePolicy: explicitPolicy }).where(eq(projects.id, issue.projectId!));
    {
      const policy = await effectiveProjectWorkspacePolicy(db, input.agent.companyId, inherited ? null : explicitPolicy, true);
      const mode = resolveExecutionWorkspaceMode({ projectPolicy: policy, issueSettings: null, legacyUseProjectWorkspace: null });
      input.policy.projectExecutionWorkspacePolicy = policy;
      input.policy.requestedExecutionWorkspaceMode = mode;
      input.policy.effectiveExecutionWorkspaceMode = mode;
      input.config.mergedConfig = buildExecutionWorkspaceAdapterConfig({ agentConfig: input.config.mergedConfig, projectPolicy: policy, issueSettings: null, mode, legacyUseProjectWorkspace: null });
    }
    await db.update(projectWorkspaces).set({ cwd: null, sourceType: "remote_managed", repoUrl: "https://github.com/example/repo.git" }).where(eq(projectWorkspaces.id, issue.projectWorkspaceId!));
    await rm(source, { recursive: true });
    if (fresh) input.task.freshWorkspace = { mode: "fresh_isolated_workspace", retryIntentId: input.run.id, sourceRunId: input.run.id, retainedSourceIds: [] };
    const sequence: string[] = [];
    input.services.workspaceWorkers = { getWorker: () => ({ supportedMethods: ["workspaceOperation"] }), call: async (_: string, __: string, params: any) => {
      sequence.push("prepare");
      return { kind: "prepared", binding: { pluginId: plugin.id, projectId: issue.projectId, executionWorkspaceId: params.executionWorkspaceId,
        projectWorkspaceId: issue.projectWorkspaceId, sourceRevision: params.operation.source.revision, workspaceRef: "provider:checkout" },
        branchName: params.operation.branchName, baseSha: "a".repeat(40), created: true, branchCreatedByRuntime: true };
    } } as any;
    const acquire = input.services.envOrchestrator.acquireForRun;
    vi.spyOn(input.services.envOrchestrator, "acquireForRun").mockImplementation(async args => {
      sequence.push("acquire"); expect(args.persistedExecutionWorkspace).toMatchObject({ providerType: "plugin", cwd: null });
      return acquire(args);
    });
    vi.spyOn(input.services.envOrchestrator, "realizeForRun").mockImplementation(async args => {
      expect(args.executionWorkspace.providerBinding?.workspaceRef).toBe("provider:checkout");
      throw new Error("reached execution handoff");
    });
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("reached execution handoff");
    expect(sequence).toEqual(["prepare", "acquire"]);
    await expect(access(source)).rejects.toThrow();
    const [task] = await db.select().from(issues).where(eq(issues.id, issue.id));
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, task.executionWorkspaceId!));
    expect(workspace).toMatchObject({ providerType: "plugin", cwd: null, mode: defaultMode, strategyType: "git_worktree", branchName: fresh ? null : inherited ? "WSP-1-prepare-this-workspace" : "test-WSP-1" });
  });
  async function installDefault() {
    const [plugin] = await db.insert(plugins).values({ pluginKey: "test.default-storage", packageName: "test-storage", version: "1.0.0", status: "ready",
      manifestJson: { id: "test.default-storage", apiVersion: 1, version: "1.0.0", displayName: "Default storage", description: "Storage", author: "Test", categories: ["workspace"],
        workspaceProvider: { modes: ["isolated_workspace"], strategies: ["git_worktree"], defaultForProjects: { mode: "isolated_workspace", strategy: "git_worktree" } },
        capabilities: ["workspaces.manage", "events.subscribe"], resourceLifecycle: ["project"], entrypoints: { worker: "./worker.js" } } }).returning();
    return plugin;
  }
  it("keeps source-free project tasks outside installed provider preparation", async () => {
    const { input, issue } = await fixture();
    await installDefault();
    await db.update(issues).set({ projectWorkspaceId: null }).where(eq(issues.id, issue.id));
    await db.delete(projectWorkspaces).where(eq(projectWorkspaces.id, issue.projectWorkspaceId!));
    input.task.issueRef = { ...issue, projectWorkspaceId: null };
    input.policy.projectExecutionWorkspacePolicy = await effectiveProjectWorkspacePolicy(db, input.agent.companyId, null, false);
    const call = vi.fn();
    input.services.workspaceWorkers = { getWorker: () => ({ supportedMethods: ["workspaceOperation"] }), call } as any;
    const prepared = await prepareHeartbeatWorkspace(db, input);
    expect(prepared.executionWorkspace.cwd).toBeTruthy();
    expect(prepared.persistedExecutionWorkspace?.providerType).not.toBe("plugin");
    expect(call).not.toHaveBeenCalled();
  });
  it("pins a resolved Core choice through source selection when a default appears during setup", async () => {
    const { input, source } = await fixture();
    expect(input.policy.projectExecutionWorkspacePolicy).toBeNull();
    await installDefault();
    const call = vi.fn();
    input.services.workspaceWorkers = { getWorker: () => ({ supportedMethods: ["workspaceOperation"] }), call } as any;
    const prepared = await prepareHeartbeatWorkspace(db, input);
    expect(prepared.executionWorkspace.cwd).toBe(source);
    expect(prepared.persistedExecutionWorkspace?.providerType).not.toBe("plugin");
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    { project: false, savedSource: false },
    { project: true, savedSource: true },
    { project: true, savedSource: false },
  ])("keeps a fresh task reservation stable through repeated preparation (project: $project, saved source: $savedSource)", async ({ project, savedSource }) => {
    const { input, issue, envOrchestrator } = await fixture();
    if (!project) await db.update(issues).set({ projectId: null, projectWorkspaceId: null }).where(eq(issues.id, issue.id));
    else if (!savedSource) {
      await db.update(issues).set({ projectWorkspaceId: null }).where(eq(issues.id, issue.id));
      input.task.issueRef = { ...input.task.issueRef!, projectWorkspaceId: null };
    }
    const pluginKey = "test.fresh-task";
    await db.insert(plugins).values({ pluginKey, packageName: "test-tasks", version: "1.0.0", apiVersion: 1,
      status: "ready", categories: ["workspace"], manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0",
        displayName: "Tasks", description: "Tasks", author: "Test", categories: ["workspace"],
        capabilities: ["environment.drivers.register"], entrypoints: { worker: "./worker.js" },
        environmentDrivers: [{ driverKey: "tasks", displayName: "Task VM", configSchema: { type: "object" }, supportsTasks: true, freshWorkspaceVersion: 1 }] } });
    input.agent.adapterType = "paperclip_runner";
    if (!project) {
      input.task.issueRef = { ...input.task.issueRef!, projectId: null, projectWorkspaceId: null };
      input.task.context = { issueId: issue.id };
    }
    input.task.freshWorkspace = { mode: "fresh_isolated_workspace", retryIntentId: input.run.id, sourceRunId: input.run.id, retainedSourceIds: [] };
    input.policy.requestedExecutionWorkspaceMode = input.policy.effectiveExecutionWorkspaceMode = "isolated_workspace";
    input.config.mergedConfig = { workspaceStrategy: { type: "project_primary" } };
    input.environment.selectedEnvironmentForConfig = { ...input.environment.localEnvironment, driver: "plugin",
      config: { pluginKey, driverKey: "tasks" } };
    const stopped = new Error("Reached projectless environment handoff");
    const acquire = vi.spyOn(envOrchestrator, "acquireForRun").mockRejectedValue(stopped);
    const read = vi.spyOn(input.services.executionWorkspacesSvc, "getStoredById");
    for (let attempt = 0; attempt < 2; attempt++) await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(stopped);
    expect(read).toHaveBeenCalledWith(input.agent.companyId, input.run.id);
    expect(acquire).toHaveBeenCalledTimes(2);
    for (const [args] of acquire.mock.calls) expect(args.persistedExecutionWorkspace).toMatchObject({ id: input.run.id,
      providerType: "adapter_managed", projectId: project ? issue.projectId : null,
      projectWorkspaceId: project ? issue.projectWorkspaceId : null,
      metadata: { runnerTaskFreshWorkspace: { attemptId: input.run.id } } });
    const rows = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, input.agent.companyId));
    expect(rows).toHaveLength(1);
    const [task] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(task.projectWorkspaceId).toBe(project ? issue.projectWorkspaceId : null);
  });
  it.each(["implicit", "task", "agent"] as const)("keeps provider directory selection after a fresh task succeeds (strategy: %s)", async strategySource => {
    const { input, issue, envOrchestrator } = await fixture();
    await db.update(issues).set({ projectId: null, projectWorkspaceId: null }).where(eq(issues.id, issue.id));
    input.task.issueRef = { ...issue, projectId: null, projectWorkspaceId: null };
    input.task.context = { issueId: issue.id };
    const pluginKey = "test.fresh-followup";
    await db.insert(plugins).values({ pluginKey, packageName: "test-tasks", version: "1.0.0", apiVersion: 1,
      status: "ready", categories: ["workspace"], manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0",
        displayName: "Tasks", description: "Tasks", author: "Test", categories: ["workspace"],
        capabilities: ["environment.drivers.register"], entrypoints: { worker: "./worker.js" },
        environmentDrivers: [{ driverKey: "tasks", displayName: "Task VM", configSchema: { type: "object" }, supportsTasks: true, freshWorkspaceVersion: 1 }] } });
    const environment = await environmentService(db).create({ name: `Task computer ${issue.id}`, driver: "plugin", status: "active", envVars: {}, config: { pluginKey, driverKey: "tasks" } });
    input.agent = { ...input.agent, adapterType: "paperclip_runner", defaultEnvironmentId: environment.id };
    input.environment.selectedEnvironmentForConfig = environment;
    input.policy.requestedExecutionWorkspaceMode = input.policy.effectiveExecutionWorkspaceMode = "isolated_workspace";
    input.task.freshWorkspace = { mode: "fresh_isolated_workspace", retryIntentId: input.run.id, sourceRunId: input.run.id, retainedSourceIds: [] };
    const stopped = new Error("Provider directory prepared");
    vi.spyOn(envOrchestrator, "acquireForRun").mockRejectedValue(stopped);
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(stopped);
    const [task] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(task.executionWorkspaceSettings).toEqual({ mode: "isolated_workspace" });
    const settings = { mode: "isolated_workspace" as const, ...(strategySource === "task" ? { workspaceStrategy: { type: "git_worktree" as const } } : {}) };
    const agentConfig = strategySource === "agent" ? { workspaceStrategy: { type: "git_worktree" as const } } : {};
    const selection = await selectHeartbeatEnvironment(db, {
      run: input.run, agent: input.agent,
      task: { issueRef: task, issueContext: task, issueId: issue.id, context: input.task.context,
        executionProjectId: null, workspaceProjectContext: null, boundSourceWorkspace: null,
        hasSelectedWorkspaceSource: false, taskWorkspaceIntent: null, responsibleUserId: null },
      policy: { ...input.policy, issueExecutionWorkspaceSettings: settings },
      config: { config: agentConfig, sourceWorkspaceConfig: buildExecutionWorkspaceAdapterConfig({ agentConfig, projectPolicy: null,
        issueSettings: settings, mode: "isolated_workspace", legacyUseProjectWorkspace: null }), issueAssigneeOverrides: null },
      services: { environmentsSvc: environmentService(db), executionWorkspacesSvc: executionWorkspaceService(db),
        instanceSettings: instanceSettingsService(db), findSharedWorkspaceHolder: async () => null, findExecutionWorkspaceHolder: async () => null },
    });
    expect(selection.useIsolatedTaskDirectory).toBe(strategySource === "implicit");
    expect(selection.reusableExistingExecutionWorkspace?.id).toBe(task.executionWorkspaceId);
  });

  const readIssue = (id: string) => db.select().from(issues).where(eq(issues.id, id)).then(rows => rows[0]!);
  const readRun = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);
  const leases = (id: string) => db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, id));

  it("keeps plugin-owned storage untouched when a fresh attempt provider is unavailable", async () => {
    const { input, source, issue } = await fixture(true);
    await db.update(projects).set({ executionWorkspacePolicy: {
      enabled: true, storageProviderPluginId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    } }).where(eq(projects.id, issue.projectId!));
    input.policy.projectExecutionWorkspacePolicy = { enabled: true, storageProviderPluginId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    input.task.freshWorkspace = { mode: "fresh_isolated_workspace", retryIntentId: input.run.id,
      sourceRunId: input.run.id, retainedSourceIds: [] };
    const call = vi.fn();
    input.services.workspaceWorkers = { getWorker: () => ({ supportedMethods: ["workspaceOperation"] }), call } as any;
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("workspace storage plugin is unavailable");
    expect(call).not.toHaveBeenCalled();
    expect(await leases(input.run.id)).toHaveLength(0);
    expect((await readIssue(issue.id)).executionWorkspaceId).toBeNull();
    expect(await readFile(join(source, "README.md"), "utf8")).toBe("source content\n");
  });

  it("a fresh retry creates independent files and Git storage instead of reopening a configured task branch", async () => {
    const { input, source, issue } = await fixture(true);
    const original = await prepareHeartbeatWorkspace(db, input);
    await writeFile(join(original.executionWorkspace.cwd, "unpublished.txt"), "keep the old work\n");
    const [nextRun] = await db.insert(heartbeatRuns).values({ companyId: input.run.companyId,
      agentId: input.agent.id, issueId: issue.id, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    input.task.freshWorkspace = { mode: "fresh_isolated_workspace", retryIntentId: nextRun.id,
      sourceRunId: input.run.id, retainedSourceIds: [] };
    input.run = nextRun;
    input.task.issueRef = { ...issue, executionWorkspaceId: null, executionWorkspacePreference: "create_new" };
    const replacement = await prepareHeartbeatWorkspace(db, input);
    expect(replacement.persistedExecutionWorkspace!.id).not.toBe(original.persistedExecutionWorkspace!.id);
    expect(replacement.executionWorkspace.cwd).not.toBe(original.executionWorkspace.cwd);
    expect(replacement.executionWorkspace.cwd).not.toBe(source);
    expect(await readFile(join(replacement.executionWorkspace.cwd, "README.md"), "utf8")).toBe("source content\n");
    expect(await readFile(join(original.executionWorkspace.cwd, "unpublished.txt"), "utf8")).toBe("keep the old work\n");
    const common = await execFile("git", ["-C", replacement.executionWorkspace.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    expect(common.stdout.trim()).toBe(join(replacement.executionWorkspace.cwd, ".git"));
    await expect(access(join(replacement.executionWorkspace.cwd, "unpublished.txt"))).rejects.toThrow();
    expect((await readIssue(issue.id)).executionWorkspaceId).toBe(replacement.persistedExecutionWorkspace!.id);
  }, 30_000);

  it.each(["historical_first", "recovery_first"] as const)(
    "prepares the admitted fresh directory with sibling holds in either order: %s", async order => {
      const { input, source, issue } = await fixture(true);
      const original = await prepareHeartbeatWorkspace(db, input);
      await writeFile(join(original.executionWorkspace.cwd, "unpublished.txt"), "keep the old work\n");
      const sourceRunId = input.run.id, retryIntentId = randomUUID();
      const [nextRun] = await db.insert(heartbeatRuns).values({ companyId: input.run.companyId,
        agentId: input.agent.id, issueId: issue.id, scopeKind: "issue", status: "running", runtimeMode: "legacy",
        contextSnapshot: { issueId: issue.id, taskRetryRequestId: retryIntentId } }).returning();
      await db.insert(agentWakeupRequests).values({ id: retryIntentId, companyId: input.run.companyId,
        agentId: input.agent.id, reason: "task_retry", source: "on_demand", status: "coalesced", runId: nextRun.id,
        payload: { issueId: issue.id } });
      const readiness = { mode: "fresh_isolated_workspace" as const, retryIntentId, sourceRunId, retainedSourceIds: [] };
      const evidence = { runId: sourceRunId, explicitUserContinuation: { runId: nextRun.id, readiness } };
      const hold = { companyId: input.run.companyId, sourceIssueId: issue.id, kind: "active_run_watchdog",
        status: "resolved", ownerType: "system", nextAction: "Preserve the original source outcome." };
      const historical = { ...hold, cause: "native_session_retry_exhausted", fingerprint: randomUUID(), evidence };
      const recovery = { ...hold, cause: "native_continuation_requires_reconciliation", fingerprint: randomUUID(),
        evidence: { ...evidence, systemRecovery: { ...createSystemRecovery(sourceRunId, retryIntentId),
          state: "exhausted", freshAttemptRunId: nextRun.id } } };
      await db.insert(issueRecoveryActions).values(order === "historical_first" ? [historical, recovery] : [recovery, historical]);
      // Use the same committed-receipt lookup as run preparation, not a
      // hand-built freshWorkspace input. The historical hold has no generation.
      input.task.freshWorkspace = await readFreshWorkspaceReadiness(db, nextRun);
      expect(input.task.freshWorkspace).toEqual(readiness);
      input.run = nextRun;
      input.task.issueRef = { ...issue, executionWorkspaceId: null, executionWorkspacePreference: "create_new" };
      const replacement = await prepareHeartbeatWorkspace(db, input);
      expect(replacement.executionWorkspace.cwd).not.toBe(original.executionWorkspace.cwd);
      expect(replacement.executionWorkspace.cwd).not.toBe(source);
      expect(await readFile(join(replacement.executionWorkspace.cwd, "README.md"), "utf8")).toBe("source content\n");
      await expect(access(join(replacement.executionWorkspace.cwd, "unpublished.txt"))).rejects.toThrow();
      expect(await readFile(join(original.executionWorkspace.cwd, "unpublished.txt"), "utf8")).toBe("keep the old work\n");
      const common = await execFile("git", ["-C", replacement.executionWorkspace.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
      expect(common.stdout.trim()).toBe(join(replacement.executionWorkspace.cwd, ".git"));
      expect((await readIssue(issue.id)).executionWorkspaceId).toBe(replacement.persistedExecutionWorkspace!.id);
    }, 30_000,
  );

  it("starts a fresh clean task directory without treating it as a Git source", async () => {
    const { input, source, issue } = await fixture();
    input.policy.useIsolatedTaskDirectory = true;
    input.policy.effectiveExecutionWorkspaceMode = "isolated_workspace";
    input.policy.requestedExecutionWorkspaceMode = "isolated_workspace";
    input.task.freshWorkspace = { mode: "fresh_isolated_workspace", retryIntentId: input.run.id,
      sourceRunId: input.run.id, retainedSourceIds: [] };
    const prepared = await prepareHeartbeatWorkspace(db, input);
    expect(prepared.executionWorkspace.cwd).toContain("/isolated-workspace-attempts/");
    expect(prepared.executionWorkspace.cwd).toContain(`/${input.run.id}`);
    expect(prepared.executionWorkspace.cwd).not.toBe(source);
    await expect(access(join(prepared.executionWorkspace.cwd, "README.md"))).rejects.toThrow();
    expect(await readFile(join(source, "README.md"), "utf8")).toBe("source content\n");
    expect((await readIssue(issue.id)).executionWorkspaceId).toBe(prepared.persistedExecutionWorkspace!.id);
  });

  it.each(["reuse", "explicit_git", "foreign_path", "missing_path", "symlink_path", "binding_changed", "canonical_retry", "canonical_warning", "canonical_unknown_warning", "canonical_provider_warning", "canonical_fresh", "canonical_lease", "canonical_result", "canonical_controller", "canonical_output", "canonical_measurement", "canonical_repaired_git"] as const)("recomputes ordinary-turn policy for a saved source-free fresh directory: %s", async scenario => {
    const { input, issue } = await fixture();
    const userId = `directory-owner-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Directory owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: input.agent.companyId, principalId: userId, principalType: "user", membershipRole: "owner", status: "active" });
    await db.update(companies).set({ defaultResponsibleUserId: userId }).where(eq(companies.id, input.agent.companyId));
    await db.update(issues).set({ projectId: null, projectWorkspaceId: null, status: "in_progress", responsibleUserId: userId }).where(eq(issues.id, issue.id));
    input.task.issueRef = await readIssue(issue.id);
    input.task.context = { issueId: issue.id };
    input.policy.useIsolatedTaskDirectory = true;
    input.policy.effectiveExecutionWorkspaceMode = "isolated_workspace";
    input.policy.requestedExecutionWorkspaceMode = "isolated_workspace";
    input.config.mergedConfig = { workspaceStrategy: { type: "git_worktree" } };
    input.task.freshWorkspace = { mode: "fresh_isolated_workspace", retryIntentId: input.run.id,
      sourceRunId: input.run.id, retainedSourceIds: [] };
    const original = await prepareHeartbeatWorkspace(db, input);
    const workspace = original.persistedExecutionWorkspace!;
    await writeFile(join(workspace.cwd!, "saved-review.txt"), "completed snapshot review\n");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, input.run.id));
    await db.update(environmentLeases).set({ status: "expired", cleanupStatus: "success", releasedAt: new Date() }).where(eq(environmentLeases.heartbeatRunId, input.run.id));
    const adapterType = "process";
    const originalAdapter = getServerAdapter(adapterType);
    let preservedCwd = workspace.cwd!;
    if (scenario === "explicit_git" || scenario.startsWith("canonical_")) await db.update(issues).set({ executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } } }).where(eq(issues.id, issue.id));
    if (scenario === "foreign_path") {
      const outside = join(home, "unowned-directory"); await mkdir(outside);
      await db.update(executionWorkspaces).set({ cwd: outside }).where(eq(executionWorkspaces.id, workspace.id));
    }
    if (scenario === "missing_path" || scenario === "symlink_path") {
      preservedCwd = join(home, `retained-files-${issue.id}`); await rename(workspace.cwd!, preservedCwd);
      if (scenario === "symlink_path") await symlink(preservedCwd, workspace.cwd!);
    }
    if (scenario === "binding_changed") await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, issue.id));
    const freshExpected = ["canonical_unknown_warning", "canonical_provider_warning", "canonical_fresh", "canonical_lease", "canonical_result", "canonical_controller", "canonical_output", "canonical_measurement"].includes(scenario);
    const executed = vi.fn(async (execution: AdapterExecutionContext) => {
      const [lease] = await leases(execution.runId);
      if (freshExpected) {
        expect(lease.executionWorkspaceId).not.toBe(workspace.id);
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, issue.id));
        return { exitCode: 0, signal: null, timedOut: false, summary: "Fresh workspace required" };
      }
      if (scenario !== "canonical_repaired_git") expect(lease.executionWorkspaceId).toBe(workspace.id);
      const activeWorkspace = await input.services.executionWorkspacesSvc.getStoredById(input.agent.companyId, lease.executionWorkspaceId!);
      if (scenario === "canonical_repaired_git") {
        expect(execution.config.workspaceStrategy).toMatchObject({ type: "git_worktree" });
        expect((await execFile("git", ["-C", activeWorkspace!.cwd!, "rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe("true");
      }
      else expect(activeWorkspace?.cwd).toBe(workspace.cwd);
      expect(await readFile(join(activeWorkspace!.cwd!, "saved-review.txt"), "utf8")).toBe("completed snapshot review\n");
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issue.id));
      return { exitCode: 0, signal: null, timedOut: false, summary: "Retained review confirmed" };
    });
    registerServerAdapter({ ...originalAdapter, type: adapterType, supportsLocalAgentJwt: false, execute: executed,
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    await db.update(agents).set({ adapterType, status: "idle", adapterConfig: { workspaceStrategy: { type: "git_worktree" } } }).where(eq(agents.id, input.agent.id));
    if (scenario.includes("warning")) await db.insert(companyObservability).values({ companyId: input.agent.companyId, revision: randomUUID(), enabled: true,
      destination: { provider: "otlp", endpointBaseUrl: "https://collector.example/otel" },
      capture: { userPrompts: false, assistantResponses: false, toolDetails: false, toolContent: false } });
    const heartbeat = heartbeatService(db);
    try {
      const next = await heartbeat.wakeup(input.agent.id, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        requestedByActorType: "user", requestedByActorId: userId, payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id } });
      await heartbeat.drainActiveRunExecutions();
      let finalRunId = next?.id;
      if (scenario.startsWith("canonical_")) {
        expect(await readRun(next!.id)).toMatchObject({ status: "failed", errorCode: "workspace_validation_failed" });
        expect(executed).not.toHaveBeenCalled();
        if (scenario.includes("warning")) {
          const warning = (await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, next!.id))).find(event => event.seq === 1)!;
          expect(warning).toMatchObject({ eventType: "agent_observability.unavailable", payload: { reason: "unsupported_harness" } });
          if (scenario === "canonical_unknown_warning") await db.update(heartbeatRunEvents).set({ payload: { ...warning.payload, reason: "unknown" } }).where(eq(heartbeatRunEvents.id, warning.id));
          if (scenario === "canonical_provider_warning") await db.update(heartbeatRunEvents).set({ sourcePayloadSha256: "a".repeat(64), protocolSchemaVersion: 1 }).where(eq(heartbeatRunEvents.id, warning.id));
        }
        if (scenario === "canonical_lease") await db.insert(environmentLeases).values({ companyId: input.agent.companyId, issueId: issue.id, heartbeatRunId: next!.id, provider: "local_fs", status: "expired", cleanupStatus: "success" });
        if (scenario === "canonical_result") { const failed = await readRun(next!.id); await db.update(heartbeatRuns).set({ resultJson: { ...failed.resultJson, acceptedResult: { outcome: "unknown" } } }).where(eq(heartbeatRuns.id, next!.id)); }
        if (scenario === "canonical_controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, next!.id));
        if (scenario === "canonical_output") await db.update(heartbeatRuns).set({ lastOutputSeq: 1 }).where(eq(heartbeatRuns.id, next!.id));
        if (scenario === "canonical_measurement") { const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, next!.id)); const measured = events.find(event => event.eventType === "lifecycle")!; await db.update(heartbeatRunEvents).set({ payload: { ...measured.payload, durationMs: -1 } }).where(eq(heartbeatRunEvents.id, measured.id)); }
        if (scenario === "canonical_repaired_git") {
          await execFile("git", ["init", "--initial-branch=main", workspace.cwd!]);
          await execFile("git", ["-C", workspace.cwd!, "config", "user.email", "test@example.com"]);
          await execFile("git", ["-C", workspace.cwd!, "config", "user.name", "Directory repair"]);
          await execFile("git", ["-C", workspace.cwd!, "add", "."]);
          await execFile("git", ["-C", workspace.cwd!, "commit", "-m", "Retain saved review"]);
        } else await db.update(issues).set({ executionWorkspaceSettings: { mode: "isolated_workspace" } }).where(eq(issues.id, issue.id));
        const intent = await requestTaskRetry({ db, companyId: input.agent.companyId, issueId: issue.id,
          actorId: userId, actorSource: "local_implicit", observedRunId: next!.id, idempotencyKey: randomUUID() });
        expect(intent.requestId).toBeTruthy();
        if (scenario === "canonical_fresh") await db.update(agentWakeupRequests).set({ payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{taskRetry,strategy}', '"fresh_isolated_workspace"'::jsonb)` }).where(eq(agentWakeupRequests.id, intent.requestId!));
        await heartbeat.resumeTaskRetry(input.agent.companyId, intent.requestId!);
        await heartbeat.drainActiveRunExecutions();
        const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intent.requestId!));
        expect(receipt.runId).toBeTruthy();
        finalRunId = receipt.runId!;
      }
      const continued = scenario === "reuse" || scenario.startsWith("canonical_");
      if (scenario === "binding_changed") {
        expect(next).toBeNull();
        const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, input.agent.id));
        expect(receipt).toMatchObject({ status: "skipped", reason: "workspace_worktree_requires_project", runId: null });
      } else {
        expect(next).not.toBeNull();
        expect(await readRun(finalRunId!)).toMatchObject(continued
          ? { status: "succeeded", errorCode: null } : { status: "failed", errorCode: "workspace_validation_failed" });
      }
      expect(executed).toHaveBeenCalledTimes(continued ? 1 : 0);
      if (freshExpected) expect((await readIssue(issue.id)).executionWorkspaceId).not.toBe(workspace.id);
      else if (scenario !== "canonical_repaired_git") expect((await readIssue(issue.id)).executionWorkspaceId).toBe(scenario === "binding_changed" ? null : workspace.id);
      expect(await readFile(join(preservedCwd, "saved-review.txt"), "utf8")).toBe("completed snapshot review\n");
      if (scenario === "missing_path") await expect(access(workspace.cwd!)).rejects.toThrow();
    } finally { await heartbeat.drainActiveRunExecutions(); registerServerAdapter(originalAdapter); }
  }, 30_000);

  it("reuses a successful fresh task attempt for the next ordinary user turn", async () => {
    const { input, issue } = await fixture();
    input.policy.useIsolatedTaskDirectory = true;
    input.policy.effectiveExecutionWorkspaceMode = "isolated_workspace";
    input.policy.requestedExecutionWorkspaceMode = "isolated_workspace";
    input.task.freshWorkspace = { mode: "fresh_isolated_workspace", retryIntentId: input.run.id,
      sourceRunId: input.run.id, retainedSourceIds: [] };
    const original = await prepareHeartbeatWorkspace(db, input);
    const workspace = original.persistedExecutionWorkspace!;
    await writeFile(join(workspace.cwd!, "saved-review.txt"), "completed review history\n");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, input.run.id));
    await reuse(input, workspace);
    input.task.freshWorkspace = null;
    const next = await prepareHeartbeatWorkspace(db, input);
    expect(next.persistedExecutionWorkspace!.id).toBe(workspace.id);
    expect(next.executionWorkspace.cwd).toBe(workspace.cwd);
    expect(await readFile(join(next.executionWorkspace.cwd, "saved-review.txt"), "utf8"))
      .toBe("completed review history\n");
    expect((await readIssue(issue.id)).executionWorkspaceId).toBe(workspace.id);
    await reuse(input, workspace);
    input.task.freshWorkspace = { mode: "fresh_isolated_workspace", retryIntentId: input.run.id,
      sourceRunId: input.run.id, retainedSourceIds: [] };
    input.reuse.existingExecutionWorkspace = null;
    input.reuse.reusableExistingExecutionWorkspace = null;
    input.reuse.requestedShouldReuseExisting = false;
    input.reuse.workspaceReuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({
      issueExecutionWorkspaceId: null, issueExecutionWorkspacePreference: "create_new", existingExecutionWorkspaceStatus: null,
    });
    const replacement = await prepareHeartbeatWorkspace(db, input);
    expect(replacement.executionWorkspace.cwd).not.toBe(workspace.cwd);
    await expect(access(join(replacement.executionWorkspace.cwd, "saved-review.txt"))).rejects.toThrow();
    expect(await readFile(join(workspace.cwd!, "saved-review.txt"), "utf8")).toBe("completed review history\n");
  });

  it.each(["task_binding", "workspace_row", "foreign_issue", "foreign_company", "closed_workspace"])(
    "rejects a retained task attempt after its %s changes", async change => {
      const { input, issue, source } = await fixture();
      input.policy.useIsolatedTaskDirectory = true;
      input.policy.effectiveExecutionWorkspaceMode = "isolated_workspace";
      input.policy.requestedExecutionWorkspaceMode = "isolated_workspace";
      input.task.freshWorkspace = { mode: "fresh_isolated_workspace", retryIntentId: input.run.id,
        sourceRunId: input.run.id, retainedSourceIds: [] };
      const original = await prepareHeartbeatWorkspace(db, input);
      const workspace = original.persistedExecutionWorkspace!;
      await writeFile(join(workspace.cwd!, "saved-review.txt"), "keep saved work\n");
      await reuse(input, workspace);
      input.task.freshWorkspace = null;
      if (change === "task_binding") await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, issue.id));
      if (change === "workspace_row") await db.update(executionWorkspaces).set({ cwd: source }).where(eq(executionWorkspaces.id, workspace.id));
      if (change === "foreign_issue") await db.update(executionWorkspaces).set({ sourceIssueId: null }).where(eq(executionWorkspaces.id, workspace.id));
      if (change === "foreign_company") {
        const [other] = await db.insert(companies).values({ name: "Other workspace company", issuePrefix: "OTH" }).returning();
        await db.update(executionWorkspaces).set({ companyId: other.id }).where(eq(executionWorkspaces.id, workspace.id));
      }
      if (change === "closed_workspace") await db.update(executionWorkspaces).set({ status: "archived" }).where(eq(executionWorkspaces.id, workspace.id));
      await expect(prepareHeartbeatWorkspace(db, input)).rejects.toMatchObject({
        resultJson: { workspaceValidation: { reason: "isolated_task_directory_binding_mismatch", issueId: issue.id } },
      });
      expect(await readFile(join(workspace.cwd!, "saved-review.txt"), "utf8")).toBe("keep saved work\n");
    },
  );

  async function reuse(input: HeartbeatWorkspacePreparationInput, workspace: NonNullable<Awaited<ReturnType<typeof prepareHeartbeatWorkspace>>["persistedExecutionWorkspace"]>) {
    input.reuse.requestedShouldReuseExisting = true;
    input.reuse.existingExecutionWorkspace = workspace;
    input.reuse.reusableExistingExecutionWorkspace = workspace;
    input.reuse.workspaceReuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({ issueExecutionWorkspaceId: workspace.id, issueExecutionWorkspacePreference: "reuse_existing", existingExecutionWorkspaceStatus: workspace.status });
    input.task.issueRef = { ...input.task.issueRef!, executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing" };
    const [run] = await db.insert(heartbeatRuns).values({ companyId: input.run.companyId, agentId: input.agent.id, issueId: input.task.issueId, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    input.run = run;
  }

  async function persistRecoveryInput(input: HeartbeatWorkspacePreparationInput, workspaceId: string, cwd: string) {
    const issue = await readIssue(input.task.issueId!);
    const admitted = buildNativeExecutionInput({ companyId: input.agent.companyId, agentId: input.agent.id,
      runId: input.run.id, provider: "codex",
      issue: { id: issue.id, identifier: issue.identifier, title: issue.title, description: null, workMode: "standard" },
      taskPrompt: "Continue admitted task", normalizedSessionId: null,
      workspace: { id: workspaceId, cwd, repoUrl: null, repoRef: null, branchName: null },
      completionContract: { id: input.run.id, sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Continue admitted task", criteria: [{ id: "objective", requirement: "Finish" }] } },
      runtimeContext: nativeRuntimeContextFixture(),
    });
    input.run.runtimeMode = "native";
    input.run.nativeIssueId = issue.id;
    input.run.runnerProfileJson = { nativeExecutionInput: admitted };
    input.reuse.persistedNativeExecutionInput = admitted;
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issue.id,
      runnerProfileJson: input.run.runnerProfileJson }).where(eq(heartbeatRuns.id, input.run.id));
    return admitted;
  }

  it.each(["muse", "openai_dot", "grok_bot"] as const)("uses private %s controller storage without rebinding task files or preparing repositories", async provider => {
    const { input, issue } = await fixture();
    input.agent.adapterType = "paperclip_runner";
    input.config.mergedConfig = { provider, cwd: "/task/source/must-not-be-read", workspaceStrategy: { type: "git_worktree" } };
    input.reuse.isDotRun = true;
    const resolve = vi.spyOn(input.services, "resolveWorkspaceForRun").mockRejectedValue(new Error("Task files must not be adopted"));
    const bind = vi.spyOn(input.services.executionWorkspacesSvc, "bindTaskWorkspace").mockRejectedValue(new Error("Task binding must not change"));
    const repos = vi.spyOn(input.services.executionWorkspacesSvc, "prepareTaskRepositoriesForAdmission").mockRejectedValue(new Error("Repositories must not be prepared"));
    try {
      const result = await prepareHeartbeatWorkspace(db, input);
      expect(result.executionWorkspace.cwd).toContain(provider === "muse" ? "muse-controllers" : "dot-controllers");
      expect(result.persistedExecutionWorkspace).toBeNull();
      expect(result.projectRepositoryPaths).toEqual([]);
      expect((await readIssue(issue.id)).executionWorkspaceId).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
      expect(bind).not.toHaveBeenCalled();
      expect(repos).not.toHaveBeenCalled();
      const binding = { companyId: input.agent.companyId, agentId: input.agent.id, bindingId: input.run.id,
        bindingGeneration: 1, acceptByUnixMs: Date.now() + 60_000, expiresAtUnixMs: Date.now() + 600_000 };
      const admitted = buildNativeExecutionInput({ companyId: input.agent.companyId, agentId: input.agent.id,
        runId: input.run.id, provider, ...(provider === "muse" ? { museBinding: binding } : { dotBinding: binding }),
        issue: { id: issue.id, identifier: null, title: issue.title, description: null, workMode: "standard" },
        taskPrompt: "Preserve the admitted controller", normalizedSessionId: input.run.id,
        workspace: { id: input.run.id, cwd: result.executionWorkspace.cwd, repoUrl: null, repoRef: null, branchName: null },
        completionContract: { id: input.run.id, sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
          contract: { revision: "1", objective: "Preserve the controller", criteria: [{ id: "objective", requirement: "Preserve the original checkpoint path" }] } },
        runtimeContext: nativeRuntimeContextFixture(),
      });
      input.reuse.persistedNativeExecutionInput = admitted;
      input.run.runtimeMode = "native";
      input.run.runnerProfileJson = { nativeExecutionInput: admitted };
      input.config.mergedConfig = { provider: "codex" };
      const recovered = await prepareHeartbeatWorkspace(db, input);
      expect(recovered.executionWorkspace.cwd).toBe(result.executionWorkspace.cwd);
      expect(recovered.persistedExecutionWorkspace).toBeNull();
      expect(bind).not.toHaveBeenCalled();
      expect(repos).not.toHaveBeenCalled();

    } finally { resolve.mockRestore(); bind.mockRestore(); repos.mockRestore(); }
  });

  it("persists the workspace and issue binding before acquiring its environment", async () => {
    const { input, source, issue, envOrchestrator } = await fixture();
    input.config.managedAiCredentialIdentity = "account:generation";
    const acquire = envOrchestrator.acquireForRun;
    vi.spyOn(envOrchestrator, "acquireForRun").mockImplementation(async args => {
      expect((await readIssue(issue.id)).executionWorkspaceId).toBe(args.persistedExecutionWorkspace?.id);
      expect((await readRun(input.run.id)).contextSnapshot?.executionWorkspaceId).toBe(args.persistedExecutionWorkspace?.id);
      expect(args.managedAiCredentialIdentity).toBe("account:generation");
      return acquire(args);
    });
    const result = await prepareHeartbeatWorkspace(db, input);
    expect(result.executionWorkspace.cwd).toBe(source);
    expect(result.persistedExecutionWorkspace).toMatchObject({ companyId: issue.companyId, projectId: issue.projectId, projectWorkspaceId: issue.projectWorkspaceId, mode: "shared_workspace" });
    expect(await leases(input.run.id)).toMatchObject([{ status: "active", executionWorkspaceId: result.persistedExecutionWorkspace!.id }]);
    expect(input.nativeRunnerPreparationSpans.map(span => span.name)).toEqual(["environment.acquire", "environment.workspace.realize"]);
    expect(input.nativeRunnerPreparationSpans.every(span => span.parentName === "task.provider_session")).toBe(true);
    expect(input.controllerLease.assertOwned).toHaveBeenCalledTimes(2);
  });

  it("records workspace steps around real persistence before environment acquisition", async () => {
    const { input, source, issue, envOrchestrator } = await fixture();
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    const acquire = envOrchestrator.acquireForRun;
    vi.spyOn(envOrchestrator, "acquireForRun").mockImplementation(async args => {
      const names = exporter.getFinishedSpans().map(span => span.name);
      expect(names).toContain("heartbeat.prepare.workspace_record_create");
      expect(names).toContain("heartbeat.prepare.workspace_binding");
      expect((await readIssue(issue.id)).executionWorkspaceId).toBe(args.persistedExecutionWorkspace?.id);
      return acquire(args);
    });
    try {
      const result = await prepareHeartbeatWorkspace(db, input);
      expect(result.executionWorkspace.cwd).toBe(source);
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans.map(span => span.name)).toEqual(expect.arrayContaining([
        "heartbeat.prepare.workspace_source_resolution",
        "heartbeat.prepare.workspace_provision_policy",
        "heartbeat.prepare.workspace_base_validation",
        "heartbeat.prepare.workspace_provision",
        "heartbeat.prepare.workspace_operation_binding",
        "heartbeat.prepare.workspace_config_recording",
        "heartbeat.prepare.workspace_repository_admission",
        "heartbeat.prepare.workspace_project_repositories",
      ]));
      for (const span of spans) {
        expect(Object.keys(span.attributes)).toEqual(["paperclip.task.run.run_id"]);
        expect(JSON.stringify(span.attributes)).not.toContain(source);
      }
    } finally {
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
      trace.disable();
      await provider.shutdown();
    }
  });

  it("prepares, reuses, and reopens a selected source containing an inaccessible private worktree", async () => {
    const { input, source, issue } = await fixture(true);
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    const [privateIssue] = await db.insert(issues).values({ companyId: issue.companyId,
      title: "Private historical task", visibility: "private", projectId: issue.projectId }).returning();
    const privateCwd = join(source, "private-work");
    await execFile("git", ["-C", source, "worktree", "add", "-b", "historical-private", privateCwd, "main"]);
    await writeFile(join(privateCwd, "confidential.txt"), "Shared OS storage is not task authorization");
    const [privateWorkspace] = await db.insert(executionWorkspaces).values({ companyId: issue.companyId,
      name: "Private workspace", sourceIssueId: privateIssue.id, cwd: privateCwd,
      mode: "isolated_workspace", strategyType: "git_worktree", providerType: "git_worktree",
      providerRef: privateCwd, branchName: "historical-private", status: "idle" }).returning();
    await db.update(issues).set({ executionWorkspaceId: privateWorkspace.id }).where(eq(issues.id, privateIssue.id));
    const clone = vi.spyOn(managedRepositoryCheckout, "materializeManagedProjectWorkspace");
    const result = await prepareHeartbeatWorkspace(db, input);
    expect(result.executionWorkspace.baseCwd).toBe(source);
    expect(result.persistedExecutionWorkspace!.metadata?.isolatedRemoteSource).toBeUndefined();
    expect(await readFile(join(result.executionWorkspace.cwd, "README.md"), "utf8")).toBe("source content\n");
    expect(clone).not.toHaveBeenCalled();
    await expect(access(isolatedRemoteSourcePath(issue.companyId, issue.id))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(result.executionWorkspace.cwd, "unpublished-work.txt"), "Keep current task edits\n");
    await reuse(input, result.persistedExecutionWorkspace!);
    const resumed = await prepareHeartbeatWorkspace(db, input);
    expect(resumed.persistedExecutionWorkspace!.id).toBe(result.persistedExecutionWorkspace!.id);
    expect(await readFile(join(resumed.executionWorkspace.cwd, "unpublished-work.txt"), "utf8")).toBe("Keep current task edits\n");
    const workspace = resumed.persistedExecutionWorkspace!;
    const cleanup = await cleanupExecutionWorkspaceArtifacts({ workspace,
      projectWorkspace: { cwd: source, cleanupCommand: null }, runCleanupCommands: false });
    expect(cleanup.warnings).toEqual([]);
    await db.update(executionWorkspaces).set({ status: "archived" }).where(eq(executionWorkspaces.id, workspace.id));
    const reopened = await executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({ workspaceId: workspace.id,
      issue: { id: issue.id, companyId: issue.companyId, projectId: issue.projectId },
      actor: { agentId: input.agent.id, actorType: "agent" },
      authorizationActor: { type: "agent", source: "agent_jwt", agentId: input.agent.id, companyId: issue.companyId, runId: input.run.id },
    });
    expect(reopened).toMatchObject({ ok: true });
    expect(await readFile(join(workspace.cwd!, "README.md"), "utf8")).toBe("source content\n");
    expect(await readFile(join(privateCwd, "confidential.txt"), "utf8")).toContain("OS storage");
  });

  it("cleans up a new local worktree after workspace persistence fails", async () => {
    const { input, source, issue } = await fixture(true);
    vi.spyOn(input.services.executionWorkspacesSvc, "create").mockRejectedValueOnce(new Error("Workspace persistence failed"));
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("Workspace persistence failed");
    const worktrees = (await execFile("git", ["-C", source, "worktree", "list", "--porcelain"])).stdout;
    expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
    await expect(execFile("git", ["-C", source, "rev-parse", "--verify", `refs/heads/test-${issue.identifier}`])).rejects.toBeDefined();
    expect((await readIssue(issue.id)).executionWorkspaceId).toBeNull();
  });

  it.each(["sandbox", "ssh", "plugin", "local", null] as const)("uses the selected %s placement for controller provisioning", async driver => {
    const { input, source, issue, envOrchestrator } = await fixture(true);
    const marker = join(source, "host-provision-ran");
    const provisionCommand = `printf host > '${marker}'`;
    input.config.mergedConfig = { workspaceStrategy: { type: "git_worktree", provisionCommand, runtimeProvisionCommand: "printf runtime" } };
    const originalConfig = structuredClone(input.config.mergedConfig);
    input.environment.selectedEnvironmentForConfig = driver === null ? null : { ...input.environment.localEnvironment, driver };
    const stopped = new Error("Fixture stops before transport acquisition");
    vi.spyOn(envOrchestrator, "acquireForRun").mockRejectedValue(stopped);
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(stopped);
    const bound = await readIssue(issue.id);
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, bound.executionWorkspaceId!));
    expect(await readFile(join(workspace.cwd!, "README.md"), "utf8")).toBe("source content\n");
    if (driver === "sandbox" || driver === "ssh" || driver === "plugin") await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(marker, "utf8")).toBe("host");
    expect(input.config.mergedConfig).toEqual(originalConfig);
  });

  it("keeps a plugin workspace ledger across runs without preparing Core repositories", async () => {
    const { input, issue, envOrchestrator, source } = await fixture();
    input.agent.adapterType = "paperclip_runner";
    input.environment.selectedEnvironmentForConfig = { ...input.environment.localEnvironment, driver: "plugin" };
    const guestOnly = join(home, "guest-only", issue.projectId!);
    await db.update(projectWorkspaces).set({ cwd: guestOnly }).where(eq(projectWorkspaces.id, issue.projectWorkspaceId!));
    const copy = vi.spyOn(input.services.executionWorkspacesSvc, "prepareTaskRepositoriesForAdmission").mockRejectedValue(new Error("Core must not prepare repositories"));
    const restoredCopy = vi.spyOn(input.services.executionWorkspacesSvc, "prepareConfiguredRepositoryCopy").mockRejectedValue(new Error("Core must not restore repositories"));
    const stopped = new Error("Plugin realization boundary");
    const realize = vi.spyOn(envOrchestrator, "realizeForRun").mockRejectedValue(stopped);
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(stopped);
    const firstId = (await readIssue(issue.id)).executionWorkspaceId!;
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, firstId));
    expect(workspace).toMatchObject({ cwd: `/workspaces/${issue.projectWorkspaceId}`, strategyType: "project_primary", providerType: "adapter_managed" });
    await reuse(input, toExecutionWorkspace(workspace));
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(stopped);
    expect((await readIssue(issue.id)).executionWorkspaceId).toBe(firstId);
    expect(realize).toHaveBeenCalledTimes(2);
    expect(copy).not.toHaveBeenCalled(); expect(restoredCopy).not.toHaveBeenCalled();
    await expect(access(guestOnly)).rejects.toMatchObject({ code: "ENOENT" });
    input.environment.selectedEnvironmentForConfig = input.environment.localEnvironment;
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toMatchObject({
      resultJson: { reason: "plugin_workspace_owner_mismatch" },
    });
    expect(realize).toHaveBeenCalledTimes(2);
    input.environment.selectedEnvironmentForConfig = { ...input.environment.localEnvironment, driver: "plugin" };
    const [localWorkspace] = await db.update(executionWorkspaces).set({ providerType: "local_fs", cwd: source, metadata: {} })
      .where(eq(executionWorkspaces.id, firstId)).returning();
    await reuse(input, toExecutionWorkspace(localWorkspace));
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toMatchObject({
      resultJson: { reason: "plugin_workspace_owner_mismatch" },
    });
    expect(realize).toHaveBeenCalledTimes(2);
    expect(await readFile(join(source, "README.md"), "utf8")).toBe("source content\n");
  });

  it.each(["services", "fresh"] as const)("rejects unsupported %s before plugin workspace preparation or acquisition", async mode => {
    const { input, envOrchestrator } = await fixture();
    input.agent.adapterType = "paperclip_runner";
    input.environment.selectedEnvironmentForConfig = { ...input.environment.localEnvironment, driver: "plugin" };
    if (mode === "services") input.config.mergedConfig.workspaceRuntime = { services: [{ name: "preview", command: "must-not-run-on-core" }] };
    else input.task.freshWorkspace = { mode: "fresh_isolated_workspace", retryIntentId: input.run.id,
      sourceRunId: input.run.id, retainedSourceIds: [] };
    const acquire = vi.spyOn(envOrchestrator, "acquireForRun");
    const resolve = vi.spyOn(input.services, "resolveWorkspaceForRun");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toMatchObject({
      resultJson: { reason: mode === "services" ? "plugin_workspace_services_unsupported" : "fresh_workspace_storage_unsupported" },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("admits the metadata-only agent-default strategy for a plugin workspace", async () => {
    const { input, envOrchestrator } = await fixture();
    input.agent.adapterType = "paperclip_runner";
    input.environment.selectedEnvironmentForConfig = { ...input.environment.localEnvironment, driver: "plugin" };
    input.policy.requestedExecutionWorkspaceMode = "agent_default";
    input.policy.effectiveExecutionWorkspaceMode = "agent_default";
    const stopped = new Error("Plugin agent-default admission reached");
    const realize = vi.spyOn(envOrchestrator, "realizeForRun").mockRejectedValue(stopped);
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(stopped);
    expect(realize).toHaveBeenCalledWith(expect.objectContaining({ executionWorkspace: expect.objectContaining({ strategy: "adapter_managed", cwd: `/workspaces/${input.task.issueId}` }),
      persistedExecutionWorkspace: expect.objectContaining({ strategyType: "adapter_managed", providerType: "adapter_managed" }) }));
  });

  it("rejects Core Git worktree preparation for a plugin-owned workspace", async () => {
    const { input, envOrchestrator } = await fixture(true);
    input.agent.adapterType = "paperclip_runner";
    input.environment.selectedEnvironmentForConfig = { ...input.environment.localEnvironment, driver: "plugin" };
    const acquire = vi.spyOn(envOrchestrator, "acquireForRun");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toMatchObject({
      code: "workspace_validation_failed", resultJson: { reason: "plugin_workspace_strategy_unsupported" },
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each([true, false])("forwards only authorized plugin project IDs without staging (remote enabled: %s)", async enabled => {
    const { input, issue, envOrchestrator } = await fixture();
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "true");
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC_REMOTE", String(enabled));
    input.agent = { ...input.agent, adapterType: "paperclip_runner" };
    input.environment.selectedEnvironmentForConfig = { ...input.environment.localEnvironment, driver: "plugin" };
    const [readable, privateProject] = await db.insert(projects).values([
      { companyId: issue.companyId, name: "Readable reference" },
      { companyId: issue.companyId, name: "Private reference", visibility: "private" },
    ]).returning();
    const unavailableCwd = join(home, readable.id, "must-not-stage");
    await db.insert(projectWorkspaces).values({ companyId: issue.companyId, projectId: readable.id, name: "Provider-only storage", cwd: unavailableCwd });
    await db.update(issues).set({ description: [readable, privateProject].map(project => `[project](${buildProjectMentionHref(project.id)})`).join(" ") }).where(eq(issues.id, issue.id));
    const stopped = new Error("Fixture reached plugin realization");
    const acquire=vi.spyOn(envOrchestrator,"acquireForRun");
    const realize = vi.spyOn(envOrchestrator, "realizeForRun").mockRejectedValue(stopped);
    try {
      await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(stopped);
      expect(realize).toHaveBeenCalledWith(expect.objectContaining({
        runnerTaskProjectIds: enabled ? [issue.projectId, readable.id] : undefined,
        executionWorkspace: expect.objectContaining({ additionalWorkspaces: [] }),
      }));
      expect(acquire).toHaveBeenCalledWith(expect.objectContaining({runnerTaskProjectIds:
        enabled ? [issue.projectId,readable.id] : [issue.projectId]}));
      await expect(access(unavailableCwd)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      acquire.mockRestore();
      vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "true");
      vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC_REMOTE", "true");
    }
  });

  it("checks current repository admission before publishing configured sibling repositories", async () => {
    const { input, source, issue } = await fixture();
    await db.insert(projectWorkspaces).values({ companyId: issue.companyId, projectId: issue.projectId!,
      name: "Sibling repository", repoUrl: pathToFileURL(source).href });
    vi.spyOn(input.services.executionWorkspacesSvc, "prepareTaskRepositoriesForAdmission")
      .mockRejectedValue(new Error("Current run identity is unavailable"));
    const acquire = vi.spyOn(input.services.envOrchestrator, "acquireForRun");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("Current run identity is unavailable");
    await expect(access(join(source, ".paperclip-repositories"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("rechecks current binding after configured clone and before publication", async () => {
    const { input, source, issue } = await fixture();
    await db.insert(projectWorkspaces).values({ companyId: issue.companyId, projectId: issue.projectId!,
      name: "Sibling repository", repoUrl: pathToFileURL(source).href });
    const namespace = join(source, ".paperclip-repositories");
    const guard = vi.spyOn(input.services.executionWorkspacesSvc, "assertTaskRepositoryPublicationAllowed")
      .mockImplementation(async () => {
        expect(await readdir(namespace)).toEqual([]);
        throw new Error("Task binding changed during clone");
      });
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("Task binding changed during clone");
    expect(guard).toHaveBeenCalledOnce();
    expect(await readdir(namespace)).toEqual([]);
    expect(await leases(input.run.id)).toEqual([]);
  });

  it("rejects a configured sibling copy when its source disappears before publication", async () => {
    const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    try {
      const { input, source, issue } = await fixture();
      const sibling = source + "-private-sibling";
      await execFile("git", ["clone", "--no-hardlinks", source, sibling]);
      await writeFile(join(sibling, "private.txt"), "PRIVATE_SIBLING_STAGING_BYTES");
      const [privateIssue] = await db.insert(issues).values({ companyId: issue.companyId, title: "Private sibling owner",
        visibility: "private", responsibleUserId: "private-owner" }).returning();
      const [privateWorkspace] = await db.insert(executionWorkspaces).values({ companyId: issue.companyId,
        name: "Private sibling", projectId: null, sourceIssueId: privateIssue.id, cwd: sibling,
        providerType: "local_fs", strategyType: "project_primary", mode: "shared_workspace", status: "active" }).returning();
      await db.insert(issueAccessGrants).values({ issueId: privateIssue.id, subjectType: "agent", subjectId: input.agent.id, source: "explicit" });
      const [configured] = await db.insert(projectWorkspaces).values({ companyId: issue.companyId, projectId: issue.projectId!,
        name: "Private sibling", cwd: sibling, repoUrl: pathToFileURL(sibling).href }).returning();
      const namespace = join(source, ".paperclip-repositories");
      const originalPrepare = input.services.executionWorkspacesSvc.prepareConfiguredRepositoryCopy;
      const prepare = vi.spyOn(input.services.executionWorkspacesSvc, "prepareConfiguredRepositoryCopy").mockImplementation(async args => {
        const recheck = await originalPrepare(args);
        return async () => {
          const candidates = await readdir(namespace);
          expect(candidates).toHaveLength(1);
          expect(candidates[0]).toContain(".clone-");
          expect(await readFile(join(namespace, candidates[0]!, "private.txt"), "utf8")).toBe("PRIVATE_SIBLING_STAGING_BYTES");
          const retained = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, issue.companyId));
          expect(retained).toEqual([]);
          await rename(sibling, sibling + "-moved");
          await db.update(projectWorkspaces).set({ cwd: sibling + "-moved" }).where(eq(projectWorkspaces.id, configured.id));
          await recheck();
        };
      });
      await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow(/ENOENT|unavailable|inaccessible|no longer/i);
      expect(prepare).toHaveBeenCalledOnce();
      expect(await readdir(namespace)).toEqual([]);
      expect(await leases(input.run.id)).toEqual([]);
      await db.delete(issueAccessGrants).where(eq(issueAccessGrants.issueId, privateIssue.id));

    } finally {
      vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", previousPrivacyMode);
    }
  });

  it.each(["file://untrusted-host/private/repository", "file:///private%2Frepository", "file:///private/repository?other", "file:///private/repository#other"])("rejects malformed local repository URL before source access: %s", async repoUrl => {
    const { source, issue } = await fixture();
    const prepareLocalSource = vi.fn();
    await expect(prepareProjectRepositoryWorkspaces({ cwd: source, anchorRepoUrl: null,
      workspaces: [{ id: issue.projectWorkspaceId!, repoUrl, repoRef: null, cwd: null }], prepareLocalSource })).rejects.toThrow();
    expect(prepareLocalSource).not.toHaveBeenCalled();
    expect(await readdir(join(source, ".paperclip-repositories"))).toEqual([]);
  });

  it("persists and reuses task-owned files without adopting the organizational project as their source", async () => {
    const { input, issue } = await fixture();
    await db.update(issues).set({ projectWorkspaceId: null,
      workspaceSelection: { version: 1, source: "explicit", selection: { kind: "task_directory" } },
    }).where(eq(issues.id, issue.id));
    input.task.issueRef = await readIssue(issue.id);
    const bind = vi.spyOn(input.services.executionWorkspacesSvc, "bindTaskWorkspace");
    const first = await prepareHeartbeatWorkspace(db, input);
    expect(first.persistedExecutionWorkspace).toMatchObject({ projectId: null, projectWorkspaceId: null, sourceIssueId: issue.id });
    expect(bind).toHaveBeenCalled();
    expect((await readIssue(issue.id)).executionWorkspaceId).toBe(first.persistedExecutionWorkspace!.id);
    await writeFile(join(first.executionWorkspace.cwd, "retained.txt"), "task files");
    const [organization] = await db.insert(projects).values({ companyId: issue.companyId, name: "New organization" }).returning();
    await db.update(issues).set({ projectId: organization.id }).where(eq(issues.id, issue.id));
    input.task.issueRef = await readIssue(issue.id);
    await reuse(input, first.persistedExecutionWorkspace!);
    const next = await prepareHeartbeatWorkspace(db, input);
    expect(next.persistedExecutionWorkspace).toMatchObject({ id: first.persistedExecutionWorkspace!.id, projectId: null });
    expect(next.executionWorkspace.cwd).toBe(first.executionWorkspace.cwd);
    expect(await readFile(join(next.executionWorkspace.cwd, "retained.txt"), "utf8")).toBe("task files");
    expect((await readIssue(issue.id)).projectId).toBe(organization.id);
  });

  it("retains task-directory provenance through shared workspace preparation", async () => {
    const { input, issue, source } = await fixture();
    await db.update(issues).set({ projectId: null, projectWorkspaceId: null,
      workspaceSelection: { version: 1, source: "explicit", selection: { kind: "task_directory" } },
    }).where(eq(issues.id, issue.id));
    input.task.issueRef = await readIssue(issue.id);
    input.task.context = { issueId: issue.id };
    const first = await prepareHeartbeatWorkspace(db, input);
    expect(first.executionWorkspace.source).toBe("task_session");
    expect(first.persistedExecutionWorkspace).toMatchObject({ mode: "shared_workspace", strategyType: "project_primary",
      sourceIssueId: issue.id, projectId: null, projectWorkspaceId: null, repoUrl: null, metadata: { source: "task_session" } });
    await mkdir(join(first.executionWorkspace.cwd, ".git", "info"), { recursive: true });
    await writeFile(join(first.executionWorkspace.cwd, ".git", "info", "exclude"), "/.paperclip-repositories/\n");
    await writeFile(join(first.executionWorkspace.cwd, "original-context.txt"), "Preserve the original task bytes\n");
    await db.update(issues).set({ executionRunId: input.run.id }).where(eq(issues.id, issue.id));
    const taskRepositories = executionWorkspaceService(db);
    const receipt = await taskRepositories.requestTaskRepository({ companyId: issue.companyId, issueId: issue.id,
      actor: { type: "board", source: "local_implicit", userId: "local-board" },
      request: { repository: { kind: "url", url: "https://github.com/public/source" }, requestKey: "retained-task-directory" } });
    const materialize = managedRepositoryCheckout.materializeManagedProjectWorkspace;
    vi.spyOn(managedRepositoryCheckout, "materializeManagedProjectWorkspace").mockImplementation((cwd, options) =>
      materialize(cwd, { ...options, localSource: source }));
    await reuse(input, first.persistedExecutionWorkspace!);
    await db.update(issues).set({ executionRunId: input.run.id }).where(eq(issues.id, issue.id));
    input.task.issueRef = await readIssue(issue.id);
    const next = await prepareHeartbeatWorkspace(db, input);
    expect(next.executionWorkspace.source).toBe("task_session");
    expect(next.persistedExecutionWorkspace!.metadata?.source).toBe("task_session");
    expect(next.persistedExecutionWorkspace!.id).toBe(first.persistedExecutionWorkspace!.id);
    expect(await readFile(join(next.executionWorkspace.cwd, "original-context.txt"), "utf8")).toBe("Preserve the original task bytes\n");
    const [repository] = await taskRepositories.listTaskRepositories(issue.companyId, next.persistedExecutionWorkspace!.id);
    expect(repository).toMatchObject({ id: receipt.operationId, state: "ready" });
    expect(await readFile(join(next.executionWorkspace.cwd, repository.relativePath, "README.md"), "utf8")).toBe("source content\n");
  });

  it("creates a real isolated worktree and reuses its recorded workspace", async () => {
    const { input, source, issue } = await fixture(true);
    const first = await prepareHeartbeatWorkspace(db, input);
    expect(first.executionWorkspace.cwd).not.toBe(source);
    expect(await readFile(join(first.executionWorkspace.cwd, "README.md"), "utf8")).toBe("source content\n");
    expect(await readIssue(issue.id)).toMatchObject({ executionWorkspaceId: first.persistedExecutionWorkspace!.id, executionWorkspacePreference: "reuse_existing" });
    await writeFile(join(first.executionWorkspace.cwd, "retained.txt"), "keep this work");
    await reuse(input, first.persistedExecutionWorkspace!);
    const next = await prepareHeartbeatWorkspace(db, input);
    expect(next.reusedExecutionWorkspace).toMatchObject({ cwd: first.executionWorkspace.cwd });
    expect(next.persistedExecutionWorkspace!.id).toBe(first.persistedExecutionWorkspace!.id);
    expect(await readFile(join(next.executionWorkspace.cwd, "retained.txt"), "utf8")).toBe("keep this work");
  });

  it("keeps the admitted recovery workspace when the issue now points elsewhere", async () => {
    const { input, issue } = await fixture(true);
    const first = await prepareHeartbeatWorkspace(db, input);
    await reuse(input, first.persistedExecutionWorkspace!);
    await db.update(issues).set({ executionWorkspaceId: null, projectWorkspaceId: null }).where(eq(issues.id, issue.id));
    input.task.issueRef = { ...input.task.issueRef!, executionWorkspaceId: null, projectWorkspaceId: null };
    input.reuse.nativeRecoveryExecutionWorkspaceId = first.persistedExecutionWorkspace!.id;
    await persistRecoveryInput(input, first.persistedExecutionWorkspace!.id, first.executionWorkspace.cwd);
    const anchor = vi.spyOn(input.services, "resolveReusedGitWorkspaceAnchor");
    const prepareRepositories = vi.spyOn(input.services.executionWorkspacesSvc, "prepareTaskRepositoriesForAdmission");
    const reserveRoot = vi.spyOn(input.services.executionWorkspacesSvc, "assertTaskRepositoryRecoveryBinding");
    const next = await prepareHeartbeatWorkspace(db, input);
    expect(reserveRoot).toHaveBeenCalledWith({ companyId: issue.companyId, issueId: issue.id,
      workspaceId: first.persistedExecutionWorkspace!.id, cwd: first.executionWorkspace.cwd,
      agentId: input.agent.id, runId: input.run.id });
    expect(prepareRepositories).not.toHaveBeenCalled();
    expect(next.persistedExecutionWorkspace!.id).toBe(first.persistedExecutionWorkspace!.id);
    expect(anchor).toHaveBeenCalledWith(expect.objectContaining({ immutableNativeBinding: true, explicitProjectWorkspaceId: first.persistedExecutionWorkspace!.projectWorkspaceId }));
    expect(await readIssue(issue.id)).toMatchObject({ executionWorkspaceId: null, projectWorkspaceId: null });
  });

  it.each([
    { transport: "local", descriptor: "absent" },
    { transport: "ssh", descriptor: "absent" },
    { transport: "task", descriptor: "absent" },
    { transport: "daytona", descriptor: "valid" },
    { transport: "daytona", descriptor: "absent" },
    { transport: "daytona", descriptor: "corrupt" },
  ] as const)("validates the admitted host binding for $transport recovery with $descriptor descriptor", async ({ transport, descriptor }) => {
    const { input, issue } = await fixture(true);
    const first = await prepareHeartbeatWorkspace(db, input);
    await reuse(input, first.persistedExecutionWorkspace!);
    await db.update(issues).set({ executionWorkspaceId: null, projectWorkspaceId: null }).where(eq(issues.id, issue.id));
    input.task.issueRef = { ...input.task.issueRef!, executionWorkspaceId: null, projectWorkspaceId: null };
    input.reuse.nativeRecoveryExecutionWorkspaceId = first.persistedExecutionWorkspace!.id;
    const admittedRoot = join(home, `admitted-${input.run.id}`);
    await mkdir(admittedRoot);
    const remoteCwd = "/remote/admitted-task";
    await persistRecoveryInput(input, first.persistedExecutionWorkspace!.id, transport === "local" ? admittedRoot : remoteCwd);
    const target: AdapterExecutionTarget = transport === "local" ? { kind: "local" }
      : transport === "ssh" ? { kind: "remote", transport: "ssh", remoteCwd,
        spec: { host: "fixture.invalid", port: 22, username: "fixture", remoteWorkspacePath: remoteCwd,
          privateKey: null, knownHosts: null, strictHostKeyChecking: true, remoteCwd } }
      : { kind: "remote", transport: "sandbox", providerKey: "daytona", remoteCwd,
          ...(transport === "task" ? { runnerTask: vi.fn() } : {}) };
    const realize = input.services.envOrchestrator.realizeForRun;
    vi.spyOn(input.services.envOrchestrator, "realizeForRun").mockImplementation(async args => ({
      ...await realize(args), executionTarget: target,
    }));
    if (descriptor !== "absent") {
      const baseline = await captureDirectorySnapshot(admittedRoot);
      const reference = await nativeWorkspaceSyncInternals.writeDescriptor({
        schema: "paperclip.native-workspace-sync/v1", state: "prepared",
        binding: { companyId: issue.companyId, runId: input.run.id, workspaceId: first.persistedExecutionWorkspace!.id,
          leaseId: "admitted-lease", providerLeaseId: "admitted-provider", localCwd: admittedRoot, remoteCwd },
        baseline: serializeDirectorySnapshot(baseline), baselineSha256: directorySnapshotSha256(baseline),
        gitSnapshot: null, seed: null, createdAt: new Date().toISOString(), finalizedAt: null, finalHostSha256: null, resourceDisposition: null,
      });
      input.run.runnerProfileJson = { ...input.run.runnerProfileJson, nativeWorkspaceSync: reference };
      await db.update(heartbeatRuns).set({ runnerProfileJson: input.run.runnerProfileJson }).where(eq(heartbeatRuns.id, input.run.id));
      if (descriptor === "corrupt") {
        await writeFile(nativeWorkspaceSyncInternals.descriptorPath(input.run.id, reference.descriptorSha256), "{}");
      }
    }
    const reserve = vi.spyOn(input.services.executionWorkspacesSvc, "assertTaskRepositoryRecoveryBinding");
    const prepare = vi.spyOn(input.services.executionWorkspacesSvc, "prepareTaskRepositoriesForAdmission");
    if (transport !== "daytona" || descriptor === "valid") {
      const result = await prepareHeartbeatWorkspace(db, input);
      expect(result.executionTarget).toEqual(target);
      if (transport === "ssh" || transport === "task") expect(reserve).not.toHaveBeenCalled();
      else expect(reserve).toHaveBeenCalledWith({ companyId: issue.companyId, issueId: issue.id,
        workspaceId: first.persistedExecutionWorkspace!.id, cwd: admittedRoot, agentId: input.agent.id, runId: input.run.id });
      if (transport !== "daytona") {
        await expect(prepareNativeWorkspaceSync({ db, runId: input.run.id, companyId: issue.companyId,
          workspaceId: first.persistedExecutionWorkspace!.id, workspaceLocalDir: first.executionWorkspace.cwd,
          target, lease: result.activeEnvironmentLease.lease })).resolves.toBeNull();
      }
      expect(admittedRoot).not.toBe(first.executionWorkspace.cwd);
    } else {
      await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow(descriptor === "absent"
        ? "native_workspace_sync_descriptor_binding_missing" : "native_workspace_sync_descriptor_digest_mismatch");
      expect(reserve).not.toHaveBeenCalled();
      expect(await leases(input.run.id)).toMatchObject([{ status: "active" }]);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect((await readIssue(issue.id)).executionWorkspaceId).toBeNull();
  });

  it("removes a newly created worktree when persistence fails and preserves the original error", async () => {
    const { input, source } = await fixture(true);
    const error = new Error("workspace persistence unavailable");
    let createdCwd = "";
    vi.spyOn(input.services.executionWorkspacesSvc, "create").mockImplementation(async args => { createdCwd = args.cwd!; throw error; });
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(error);
    expect(createdCwd).not.toBe("");
    await expect(access(createdCwd)).rejects.toThrow();
    expect(await readFile(join(source, "README.md"), "utf8")).toBe("source content\n");
    expect(await leases(input.run.id)).toHaveLength(0);
  });

  it("preserves a reused worktree when its metadata update fails", async () => {
    const { input } = await fixture(true);
    const first = await prepareHeartbeatWorkspace(db, input);
    await reuse(input, first.persistedExecutionWorkspace!);
    await writeFile(join(first.executionWorkspace.cwd, "retained.txt"), "unsaved work");
    const error = new Error("workspace update unavailable");
    vi.spyOn(input.services.executionWorkspacesSvc, "update").mockRejectedValueOnce(error);
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(error);
    expect(await readFile(join(first.executionWorkspace.cwd, "retained.txt"), "utf8")).toBe("unsaved work");
    expect(await leases(input.run.id)).toHaveLength(0);
  });

  it.each(["acquire", "realize", "ownership"] as const)("preserves %s errors and durable lease state for outer cleanup", async failure => {
    const { input, envOrchestrator } = await fixture();
    const error = new Error(`${failure} failed`);
    if (failure === "acquire") vi.spyOn(envOrchestrator, "acquireForRun").mockRejectedValueOnce(error);
    if (failure === "realize") vi.spyOn(envOrchestrator, "realizeForRun").mockRejectedValueOnce(error);
    if (failure === "ownership") vi.mocked(input.controllerLease.assertOwned).mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(error);
    expect(input.nativeRunnerPreparationSpans.at(-1)).toMatchObject({ name: failure === "realize" ? "environment.workspace.realize" : "environment.acquire", outcome: "failed" });
    expect((await readRun(input.run.id)).status).toBe("running");
    expect(await leases(input.run.id)).toHaveLength(failure === "acquire" ? 0 : 1);
    if (failure !== "acquire") {
      expect(await leases(input.run.id)).toMatchObject([{ status: "active" }]);
      // The production executor terminalizes first, then releases by durable run ID.
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, input.run.id));
      await envOrchestrator.releaseForRun({ heartbeatRunId: input.run.id, companyId: input.run.companyId, agentId: input.agent.id, status: "released" });
      expect(await leases(input.run.id)).toMatchObject([{ status: "released" }]);
    }
  });

  it("checks the acquired environment allowlist before realization", async () => {
    const { input, envOrchestrator } = await fixture();
    input.policy.executionPolicy = { managedSandboxOnly: true };
    const realize = vi.spyOn(envOrchestrator, "realizeForRun");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("forbids local execution");
    expect(realize).not.toHaveBeenCalled();
    expect(await leases(input.run.id)).toMatchObject([{ status: "active" }]);
  });

  it("rejects low-trust local execution before resolving or provisioning a workspace", async () => {
    const { input } = await fixture(true);
    input.policy.trustPreset = {
      kind: "low_trust_review", preset: "low_trust_review", sourcePresets: {},
      boundary: { mode: "low_trust_review", companyId: input.agent.companyId, rootIssueId: input.task.issueId! },
    };
    const resolve = vi.spyOn(input.services, "resolveWorkspaceForRun");
    const create = vi.spyOn(input.services.executionWorkspacesSvc, "create");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("requires a sandbox environment");
    expect(resolve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(await leases(input.run.id)).toHaveLength(0);
  });

  it("rejects remote recovery without its retained sync binding before acquiring a lease", async () => {
    const { input, envOrchestrator } = await fixture();
    input.reuse.runOptions.nativeRestartRecovery = {
      kind: "reattach_remote_runner", runId: input.run.id, leaseOwner: "controller",
      controllerGeneration: 1, providerAttempt: 1, restartKind: "hard", recoveryRequestId: null,
      remote: { providerLeaseId: "original-provider-lease", remoteCwd: "/original" },
    };
    const acquire = vi.spyOn(envOrchestrator, "acquireForRun");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("native_remote_recovery_lease_mismatch");
    expect(acquire).not.toHaveBeenCalled();
    expect(await leases(input.run.id)).toHaveLength(0);
    expect(input.nativeRunnerPreparationSpans).toMatchObject([{ name: "environment.acquire", outcome: "failed" }]);
  });

  it("binds a replacement workspace from realization and snapshots the restore lease", async () => {
    const { input, envOrchestrator, issue } = await fixture();
    const realize = envOrchestrator.realizeForRun;
    vi.spyOn(envOrchestrator, "realizeForRun").mockImplementation(async args => {
      const result = await realize(args);
      const workspace = await input.services.executionWorkspacesSvc.create({ companyId: issue.companyId, projectId: issue.projectId!, projectWorkspaceId: issue.projectWorkspaceId, sourceIssueId: issue.id, name: "Realized workspace", mode: "shared_workspace", strategyType: "project_primary", cwd: args.executionWorkspace.cwd });
      return { ...result, persistedExecutionWorkspace: workspace, lease: { ...result.lease, metadata: { remoteCwd: "/original" } } };
    });
    const result = await prepareHeartbeatWorkspace(db, input);
    expect((await readIssue(issue.id)).executionWorkspaceId).toBe(result.persistedExecutionWorkspace!.id);
    expect(result.persistedExecutionWorkspace!.name).toBe("Realized workspace");
    result.activeEnvironmentLease.lease.metadata!.remoteCwd = "/rebound";
    expect(result.workspaceRestoreSource.metadata?.remoteCwd).toBe("/original");
  });
});
