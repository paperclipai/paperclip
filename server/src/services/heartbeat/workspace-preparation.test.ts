import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access, rename, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { captureDirectorySnapshot, directorySnapshotSha256, serializeDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, executionWorkspaces, executionWorkspaceRepositoryAccess, heartbeatRuns, issues, issueAccessGrants, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { environmentRunOrchestrator } from "../environment-run-orchestrator.js";
import { environmentService } from "../environments.js";
import { assertExecutionWorkspaceRootReadAccess } from "../execution-workspace-repositories.js";
import { executionWorkspaceService } from "../execution-workspaces.js";
import { instanceSettingsService } from "../instance-settings.js";
import { workspaceOperationService } from "../workspace-operations.js";
import { nativeWorkspaceSyncInternals, prepareNativeWorkspaceSync } from "../native-runtime/native-workspace-sync.js";
import { createHeartbeatWorkspaceResolver, prepareProjectRepositoryWorkspaces, resolveExecutionWorkspaceReuseRequestForIssue } from "./workspaces.js";
import { prepareHeartbeatWorkspace, type HeartbeatWorkspacePreparationInput } from "./workspace-preparation.js";
import { buildNativeExecutionInput } from "../native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../native-runtime/runtime-context.test-fixture.js";
import * as managedRepositoryCheckout from "../managed-repository-checkout.js";
import { isolatedRemoteSourcePath } from "../isolated-remote-workspace-source.js";
import { cleanupExecutionWorkspaceArtifacts } from "../workspace-runtime.js";
import { issueService } from "../issues.js";
import { trace } from "@opentelemetry/api";
import { buildExecutionWorkspaceAdapterConfig } from "../execution-workspace-policy.js";
import { prepareRestrictedWorkspaceRetry } from "../restricted-workspace-retry.js";
import express from "express";
import request from "supertest";
import { issueRoutes } from "../../routes/issues.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

const execFile = promisify(execFileCallback);
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("heartbeat workspace preparation boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paperclip-workspace-preparation-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    database = await startEmbeddedPostgresTestDatabase("paperclip-workspace-preparation");
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
    await db.execute(sql`truncate table companies restart identity cascade`);
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
  const readIssue = (id: string) => db.select().from(issues).where(eq(issues.id, id)).then(rows => rows[0]!);
  const readRun = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);
  const leases = (id: string) => db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, id));

  async function reuse(input: HeartbeatWorkspacePreparationInput, workspace: NonNullable<Awaited<ReturnType<typeof prepareHeartbeatWorkspace>>["persistedExecutionWorkspace"]>) {
    input.reuse.requestedShouldReuseExisting = true;
    input.reuse.existingExecutionWorkspace = workspace;
    input.reuse.reusableExistingExecutionWorkspace = workspace;
    input.reuse.workspaceReuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({ issueExecutionWorkspaceId: workspace.id, issueExecutionWorkspacePreference: "reuse_existing", existingExecutionWorkspaceStatus: workspace.status });
    input.task.issueRef = { ...input.task.issueRef!, executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing" };
    const [run] = await db.insert(heartbeatRuns).values({ companyId: input.run.companyId, agentId: input.agent.id, issueId: input.task.issueId, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    input.run = run;
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
    const acquire = envOrchestrator.acquireForRun;
    vi.spyOn(envOrchestrator, "acquireForRun").mockImplementation(async args => {
      expect((await readIssue(issue.id)).executionWorkspaceId).toBe(args.persistedExecutionWorkspace?.id);
      expect((await readRun(input.run.id)).contextSnapshot?.executionWorkspaceId).toBe(args.persistedExecutionWorkspace?.id);
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

  it.each(["create", "retry-restricted", "retry-fixed-branch", "retry-existing-branch", "retry-adapter-branch", "failed-save", "shared-retry-after-failed-save", "literal-branch", "legacy-explicit-source", "inherited-source", "legacy-untyped-source", "changed-source-intent", "context-source"] as const)("preserves restricted source isolation during %s", async scenario => {
    const { input, source, issue: originalIssue } = await fixture(true);
    await db.update(companies).set({ issueCounter: 1 }).where(eq(companies.id, originalIssue.companyId));
    const issue = await issueService(db).create(originalIssue.companyId, {
      title: "Prepare the selected source", projectId: originalIssue.projectId,
      assigneeAgentId: input.agent.id, executionWorkspaceSettings: { mode: "isolated_workspace" },
      ...(scenario === "legacy-explicit-source" ? { projectWorkspaceId: originalIssue.projectWorkspaceId } : {}),
      ...(scenario === "inherited-source" ? { parentId: originalIssue.id } : {}),
      workspaceSelectionActor: { type: "agent", source: "agent_jwt", companyId: originalIssue.companyId, agentId: input.agent.id },
    });
    input.task.issueRef = issue;
    input.task.issueId = issue.id;
    input.task.context.issueId = issue.id;
    input.task.workspaceSelection = issue.workspaceSelection ?? null;
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, input.run.id));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: issue.companyId, agentId: input.agent.id,
      issueId: issue.id, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    input.run = run;
    if (scenario === "legacy-untyped-source") {
      await db.update(issues).set({ workspaceSelection: null }).where(eq(issues.id, issue.id));
      input.task.workspaceSelection = null;
    } else if (scenario === "changed-source-intent") {
      await db.update(issues).set({ workspaceSelection: { ...issue.workspaceSelection!, source: "explicit" } }).where(eq(issues.id, issue.id));
    } else if (scenario === "context-source") {
      await db.update(issues).set({ projectWorkspaceId: null, workspaceSelection: null }).where(eq(issues.id, issue.id));
      input.task.issueRef = { ...issue, projectWorkspaceId: null };
      input.task.workspaceSelection = null;
      input.task.context.projectWorkspaceId = issue.projectWorkspaceId;
    }
    const remoteUrl = "https://example.test/public/repository.git";
    await db.update(projectWorkspaces).set({ repoUrl: remoteUrl }).where(eq(projectWorkspaces.id, issue.projectWorkspaceId!));
    const publishedSource = join(home, `published-${issue.id}`);
    await execFile("git", ["clone", "--no-hardlinks", source, publishedSource]);
    const [privateIssue] = await db.insert(issues).values({ companyId: issue.companyId, title: "Private work",
      visibility: "private", projectId: issue.projectId }).returning();
    const privateCwd = join(source, "private-work");
    await execFile("git", ["-C", source, "worktree", "add", "-b", "restricted-task", privateCwd, "main"]);
    await writeFile(join(privateCwd, "confidential.txt"), "Private source must not be copied");
    await execFile("git", ["-C", privateCwd, "add", "confidential.txt"]);
    await execFile("git", ["-C", privateCwd, "commit", "-m", "Restricted task work"]);
    const privateCommit = (await execFile("git", ["-C", privateCwd, "rev-parse", "HEAD"])).stdout.trim();
    const [privateWorkspace] = await db.insert(executionWorkspaces).values({ companyId: issue.companyId,
      name: "Private workspace", projectId: issue.projectId, sourceIssueId: privateIssue.id, cwd: privateCwd, mode: "isolated_workspace",
      strategyType: "git_worktree", providerType: "git_worktree", providerRef: privateCwd, branchName: "restricted-task", status: "idle" }).returning();
    await db.update(issues).set({ executionWorkspaceId: privateWorkspace.id }).where(eq(issues.id, privateIssue.id));
    const clone = vi.spyOn(managedRepositoryCheckout, "materializeManagedProjectWorkspace").mockImplementation(async (cwd, options) => {
      expect(options.repoUrl).toBe(remoteUrl);
      expect(options.localSource).toBeUndefined();
      expect(options.resolveGitAuth).toBeTypeOf("function");
      await execFile("git", ["clone", "--no-hardlinks", publishedSource, cwd]);
      await execFile("git", ["-C", cwd, "remote", "set-url", "origin", remoteUrl]);
      return { cwd, warning: null };
    });
    const isolatedSource = isolatedRemoteSourcePath(issue.companyId, issue.id);
    if (scenario.startsWith("retry-")) {
      const fixedBranch = scenario === "retry-fixed-branch";
      const existingBranch = scenario === "retry-existing-branch";
      const projectPolicy = { enabled: true, defaultMode: "isolated_workspace" as const,
        workspaceStrategy: { type: "git_worktree" as const, baseRef: "main", provisionCommand: "true",
          ...(fixedBranch ? { branchTemplate: "fixed-project-branch" } : {}) } };
      await db.update(projects).set({ executionWorkspacePolicy: projectPolicy }).where(eq(projects.id, issue.projectId!));
      input.policy.projectExecutionWorkspacePolicy = projectPolicy;
      const [oldWorkspace] = await db.insert(executionWorkspaces).values({ companyId: issue.companyId,
        projectId: issue.projectId, projectWorkspaceId: issue.projectWorkspaceId, sourceIssueId: issue.id,
        name: "Original files", cwd: source, repoUrl: remoteUrl, mode: "shared_workspace",
        strategyType: "project_primary", providerType: "local", status: "idle" }).returning();
      await writeFile(join(source, "unfinished.txt"), "Keep my original files\n");
      await db.update(heartbeatRuns).set({ status: "failed", contextSnapshot: { issueId: issue.id, projectId: issue.projectId },
        resultJson: { configurationIncomplete: { reason: "workspace_source_restricted" }, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      }).where(eq(heartbeatRuns.id, run.id));
      await db.update(issues).set({ status: "blocked", executionWorkspaceId: oldWorkspace.id, executionWorkspacePreference: "reuse_existing",
        assigneeAdapterOverrides: scenario === "retry-adapter-branch" ? { adapterConfig: { model: "preserved-model", workspaceStrategy: { type: "git_worktree", baseRef: "main", branchTemplate: "fixed-adapter-branch" } } } : null,
        executionWorkspaceSettings: { mode: "shared_workspace", environmentId: input.environment.localEnvironment.id,
          ...(existingBranch ? { workspaceStrategy: { type: "git_worktree", baseRef: "main", existingBranch: "restricted-task" } } : {}) },
      }).where(eq(issues.id, issue.id));
      const service = executionWorkspaceService(db);
      const actor = { type: "board" as const, source: "local_implicit" as const };
      const action = await issueRecoveryActionService(db).upsertSourceScoped({
        companyId: issue.companyId, sourceIssueId: issue.id, kind: "configuration_validation",
        ownerType: "board", returnOwnerAgentId: input.agent.id, cause: "configuration_incomplete",
        fingerprint: `restricted:${run.id}`, evidence: { latestRunId: run.id }, nextAction: "Retry the task.",
      });
      const retryPlan = await prepareRestrictedWorkspaceRetry(db, await readIssue(issue.id), action);
      expect(retryPlan?.selection).toEqual({ kind: "configured_source", projectWorkspaceId: issue.projectWorkspaceId!, mode: "managed_isolated" });
      const enqueue = vi.fn(async () => null);
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = actor; next(); });
      app.use("/api", issueRoutes(db, createStorageService(createLocalDiskStorageProvider(join(home, "storage"))), {
        recoveryActionEnqueueWakeup: enqueue,
      }));
      app.use(errorHandler);
      const retry = () => request(app).post(`/api/issues/${issue.id}/recovery-actions/resolve`)
        .send({ actionId: action.id, outcome: "restored", sourceIssueStatus: "todo" });
      const failedResult = (await readRun(run.id)).resultJson!;
      await db.update(heartbeatRuns).set({ resultJson: { ...failedResult, executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } })
        .where(eq(heartbeatRuns.id, run.id));
      expect((await retry()).status).toBe(409);
      expect((await readIssue(issue.id)).workspacePendingSelection).toBeNull();
      expect(enqueue).not.toHaveBeenCalled();
      await db.update(heartbeatRuns).set({ resultJson: failedResult }).where(eq(heartbeatRuns.id, run.id));
      await db.update(projects).set({ pausedAt: new Date() }).where(eq(projects.id, issue.projectId!));
      expect((await retry()).status).toBe(409);
      expect((await readIssue(issue.id)).workspacePendingSelection).toBeNull();
      expect(enqueue).not.toHaveBeenCalled();
      await db.update(projects).set({ pausedAt: null }).where(eq(projects.id, issue.projectId!));
      const responses = await Promise.all([retry(), retry()]);
      for (const response of responses) expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(enqueue).toHaveBeenCalledOnce();
      expect((await readIssue(issue.id)).workspacePendingSelection?.intent.source).toBe("recovery");
      expect((await readIssue(issue.id)).executionWorkspaceId).toBe(oldWorkspace.id);
      await service.applyPendingTaskWorkspaceSelection({ companyId: issue.companyId, issueId: issue.id, runId: run.id, actor });
      const selected = await readIssue(issue.id);
      input.task.issueRef = selected;
      input.task.workspaceSelection = selected.workspaceSelection;
      input.policy.issueExecutionWorkspaceSettings = selected.executionWorkspaceSettings;
      input.config.mergedConfig = buildExecutionWorkspaceAdapterConfig({ agentConfig: {}, projectPolicy,
        issueSettings: selected.executionWorkspaceSettings, mode: "isolated_workspace", legacyUseProjectWorkspace: null,
        adapterConfigOverrides: selected.assigneeAdapterOverrides?.adapterConfig as Record<string, unknown> | undefined });
      if (scenario === "retry-adapter-branch") expect(input.config.mergedConfig.model).toBe("preserved-model");
    }
    if (["literal-branch", "legacy-explicit-source", "inherited-source", "legacy-untyped-source", "changed-source-intent", "context-source"].includes(scenario)) {
      const selectedBranch = scenario === "literal-branch" ? "feature/literal-pin" : `test-${issue.identifier}`;
      await execFile("git", ["-C", source, "checkout", "-b", selectedBranch]);
      await writeFile(join(source, "selected-work.txt"), "Selected unpublished branch work\n");
      await execFile("git", ["-C", source, "add", "selected-work.txt"]);
      await execFile("git", ["-C", source, "commit", "-m", "Selected branch work"]);
      const branchTip = (await execFile("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
      await execFile("git", ["-C", source, "checkout", "main"]);
      if (scenario === "literal-branch") input.config.mergedConfig = { workspaceStrategy: { type: "git_worktree", baseRef: "main", branchTemplate: "feature/literal-pin" } };
      const acquire = vi.spyOn(input.services.envOrchestrator, "acquireForRun");
      await expect(prepareHeartbeatWorkspace(db, input)).rejects.toMatchObject({ code: "configuration_incomplete",
        resultJson: { configurationIncomplete: { reason: "workspace_source_restricted", issueId: issue.id } } });
      expect(clone).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect((await readIssue(issue.id)).executionWorkspaceId).toBeNull();
      expect((await execFile("git", ["-C", source, "rev-parse", `refs/heads/${selectedBranch}`])).stdout.trim()).toBe(branchTip);
      await expect(access(isolatedSource)).rejects.toMatchObject({ code: "ENOENT" });
      return;
    }
    expect(issue.workspaceSelection).toMatchObject({ source: "project", selection: {
      kind: "configured_source", projectWorkspaceId: issue.projectWorkspaceId, mode: "managed_isolated",
    } });
    if (scenario === "failed-save" || scenario === "shared-retry-after-failed-save") {
      vi.spyOn(input.services.executionWorkspacesSvc, "create").mockRejectedValueOnce(new Error("Workspace persistence failed"));
      await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("Workspace persistence failed");
      const worktrees = (await execFile("git", ["-C", isolatedSource, "worktree", "list", "--porcelain"])).stdout;
      expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
      await expect(execFile("git", ["-C", isolatedSource, "rev-parse", "--verify", `refs/heads/test-${issue.identifier}`])).rejects.toBeDefined();
      expect((await readIssue(issue.id)).executionWorkspaceId).toBeNull();
      expect(await readFile(join(privateCwd, "confidential.txt"), "utf8")).toBe("Private source must not be copied");
      if (scenario === "shared-retry-after-failed-save") {
        await execFile("git", ["-C", source, "remote", "add", "origin", remoteUrl]);
        await db.update(issues).set({ visibility: "open" }).where(eq(issues.id, privateIssue.id));
        const saved = await prepareHeartbeatWorkspace(db, input);
        const workspace = saved.persistedExecutionWorkspace!;
        expect(saved.executionWorkspace.baseCwd).toBe(source);
        expect(workspace.metadata?.isolatedRemoteSource).toBeUndefined();
        await writeFile(join(workspace.cwd!, "unpublished-work.txt"), "Keep the shared-source task commits\n");
        await execFile("git", ["-C", workspace.cwd!, "add", "unpublished-work.txt"]);
        await execFile("git", ["-C", workspace.cwd!, "commit", "-m", "Unpublished task work"]);
        const branchTip = (await execFile("git", ["-C", workspace.cwd!, "rev-parse", "HEAD"])).stdout.trim();
        await expect(execFile("git", ["-C", isolatedSource, "cat-file", "-e", branchTip])).rejects.toBeDefined();
        await execFile("git", ["-C", source, "worktree", "remove", "--force", workspace.cwd!]);
        await reuse(input, workspace);
        const rebuilt = await prepareHeartbeatWorkspace(db, input);
        expect(rebuilt.executionWorkspace.baseCwd).toBe(await realpath(source));
        expect((await execFile("git", ["-C", rebuilt.executionWorkspace.cwd, "rev-parse", "HEAD"])).stdout.trim()).toBe(branchTip);
        expect(await readFile(join(rebuilt.executionWorkspace.cwd, "unpublished-work.txt"), "utf8")).toBe("Keep the shared-source task commits\n");
        expect(clone).toHaveBeenCalledOnce();
      }
      return;
    }
    const result = await prepareHeartbeatWorkspace(db, input);
    expect(result.executionWorkspace.baseCwd).toBe(isolatedSource);
    expect(await readFile(join(result.executionWorkspace.cwd, "README.md"), "utf8")).toBe("source content\n");
    await expect(access(join(result.executionWorkspace.cwd, "private-work"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(clone).toHaveBeenCalledOnce();
    if (scenario.startsWith("retry-")) {
      expect((await readIssue(issue.id)).executionWorkspaceSettings).toMatchObject({ mode: "isolated_workspace", environmentId: input.environment.localEnvironment.id });
      expect(await readFile(join(source, "unfinished.txt"), "utf8")).toBe("Keep my original files\n");
      await expect(access(join(result.executionWorkspace.cwd, "unfinished.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(execFile("git", ["-C", isolatedSource, "cat-file", "-e", privateCommit])).rejects.toBeDefined();
    await expect(execFile("git", ["-C", isolatedSource, "rev-parse", "--verify", "refs/heads/restricted-task"])).rejects.toBeDefined();
    expect(await realpath(join(isolatedSource, ".git"))).not.toBe(await realpath(join(source, ".git")));
    await reuse(input, result.persistedExecutionWorkspace!);
    const resumed = await prepareHeartbeatWorkspace(db, input);
    expect(resumed.persistedExecutionWorkspace!.id).toBe(result.persistedExecutionWorkspace!.id);
    expect(resumed.executionWorkspace.baseCwd).toBe(await realpath(isolatedSource));
    expect(clone).toHaveBeenCalledOnce();
    expect((await readIssue(privateIssue.id)).visibility).toBe("private");
    const workspace = resumed.persistedExecutionWorkspace!;
    const cleanup = await cleanupExecutionWorkspaceArtifacts({ workspace,
      projectWorkspace: { cwd: source, cleanupCommand: null }, runCleanupCommands: false });
    expect(cleanup.warnings).toEqual([]);
    await expect(access(workspace.cwd!)).rejects.toMatchObject({ code: "ENOENT" });
    await db.update(executionWorkspaces).set({ status: "archived" }).where(eq(executionWorkspaces.id, workspace.id));
    const reopened = await executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({ workspaceId: workspace.id,
      issue: { id: issue.id, companyId: issue.companyId, projectId: issue.projectId },
      actor: { agentId: input.agent.id, actorType: "agent" },
      authorizationActor: { type: "agent", source: "agent_jwt", agentId: input.agent.id, companyId: issue.companyId },
    });
    expect(reopened).toMatchObject({ ok: true });
    expect(await readFile(join(workspace.cwd!, "README.md"), "utf8")).toBe("source content\n");
    expect(await readFile(join(privateCwd, "confidential.txt"), "utf8")).toBe("Private source must not be copied");
  });

  it("keeps a reused shared-checkout workspace denied with an owner action after a restricted worktree appears", async () => {
    const { input, source, issue } = await fixture(true);
    const first = await prepareHeartbeatWorkspace(db, input);
    const workspace = first.persistedExecutionWorkspace!;
    expect(first.executionWorkspace.baseCwd).toBe(source);
    await writeFile(join(workspace.cwd!, "unpublished-work.txt"), "Keep this task's local work\n");
    const [privateIssue] = await db.insert(issues).values({ companyId: issue.companyId, title: "Private work",
      visibility: "private", projectId: issue.projectId }).returning();
    const privateCwd = join(source, "private-work");
    await execFile("git", ["-C", source, "worktree", "add", "-b", "restricted-task", privateCwd, "main"]);
    const [privateWorkspace] = await db.insert(executionWorkspaces).values({ companyId: issue.companyId,
      name: "Private workspace", projectId: issue.projectId, sourceIssueId: privateIssue.id, cwd: privateCwd, mode: "isolated_workspace",
      strategyType: "git_worktree", providerType: "git_worktree", providerRef: privateCwd, branchName: "restricted-task", status: "idle" }).returning();
    await db.update(issues).set({ executionWorkspaceId: privateWorkspace.id }).where(eq(issues.id, privateIssue.id));
    await reuse(input, workspace);
    const clone = vi.spyOn(managedRepositoryCheckout, "materializeManagedProjectWorkspace");
    const acquire = vi.spyOn(input.services.envOrchestrator, "acquireForRun");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toMatchObject({ code: "configuration_incomplete",
      resultJson: { configurationIncomplete: { reason: "workspace_source_restricted", issueId: issue.id } } });
    expect(clone).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect((await readIssue(issue.id)).executionWorkspaceId).toBe(workspace.id);
    expect(await readFile(join(workspace.cwd!, "unpublished-work.txt"), "utf8")).toBe("Keep this task's local work\n");
    await expect(access(isolatedRemoteSourcePath(issue.companyId, issue.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["sandbox", "ssh", "local", null] as const)("uses the selected %s placement for controller provisioning", async driver => {
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
    if (driver === "sandbox" || driver === "ssh") await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(marker, "utf8")).toBe("host");
    expect(input.config.mergedConfig).toEqual(originalConfig);
  });

  it("checks physical root admission before publishing configured sibling repositories", async () => {
    const { input, source, issue } = await fixture();
    await db.insert(projectWorkspaces).values({ companyId: issue.companyId, projectId: issue.projectId!,
      name: "Sibling repository", repoUrl: pathToFileURL(source).href });
    vi.spyOn(input.services.executionWorkspacesSvc, "prepareTaskRepositoriesForAdmission")
      .mockRejectedValue(new Error("Physical root reader cannot access this source"));
    const acquire = vi.spyOn(input.services.envOrchestrator, "acquireForRun");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("Physical root reader cannot access this source");
    await expect(access(join(source, ".paperclip-repositories"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("rechecks physical root access after configured clone and before publication", async () => {
    const { input, source, issue } = await fixture();
    await db.insert(projectWorkspaces).values({ companyId: issue.companyId, projectId: issue.projectId!,
      name: "Sibling repository", repoUrl: pathToFileURL(source).href });
    const namespace = join(source, ".paperclip-repositories");
    const guard = vi.spyOn(input.services.executionWorkspacesSvc, "guardTaskRepositoryRootForPublication")
      .mockImplementation(async () => {
        const candidates = await readdir(namespace);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toContain(".clone-");
        expect(await readFile(join(namespace, candidates[0]!, "README.md"), "utf8")).toBe("source content\n");
        throw new Error("Physical root access revoked during clone");
      });
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("Physical root access revoked during clone");
    expect(guard).toHaveBeenCalledOnce();
    expect(await readdir(namespace)).toEqual([]);
    expect(await leases(input.run.id)).toEqual([]);
  });

  it("retains sibling privacy before copying when its source disappears before publication", async () => {
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
      const originalPrepare = input.services.executionWorkspacesSvc.prepareConfiguredRepositorySource;
      const prepare = vi.spyOn(input.services.executionWorkspacesSvc, "prepareConfiguredRepositorySource").mockImplementation(async args => {
        const recheck = await originalPrepare(args);
        return async () => {
          const candidates = await readdir(namespace);
          expect(candidates).toHaveLength(1);
          expect(candidates[0]).toContain(".clone-");
          expect(await readFile(join(namespace, candidates[0]!, "private.txt"), "utf8")).toBe("PRIVATE_SIBLING_STAGING_BYTES");
          const retained = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, issue.companyId));
          expect(retained).toContainEqual(expect.objectContaining({ kind: "isolated_source", scopeId: privateWorkspace.id }));
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
      await expect(assertExecutionWorkspaceRootReadAccess(db, { companyId: issue.companyId, cwd: source,
        actor: { type: "agent", source: "agent_jwt", companyId: issue.companyId, agentId: input.agent.id } })).rejects.toThrow();
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
    const anchor = vi.spyOn(input.services, "resolveReusedGitWorkspaceAnchor");
    const prepareRepositories = vi.spyOn(input.services.executionWorkspacesSvc, "prepareTaskRepositoriesForAdmission");
    const reserveRoot = vi.spyOn(input.services.executionWorkspacesSvc, "reserveTaskRepositoryRootForRecovery");
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
    { transport: "daytona", descriptor: "valid" },
    { transport: "daytona", descriptor: "absent" },
    { transport: "daytona", descriptor: "corrupt" },
  ] as const)("reserves the admitted host root for $transport recovery with $descriptor descriptor", async ({ transport, descriptor }) => {
    const { input, issue } = await fixture(true);
    const first = await prepareHeartbeatWorkspace(db, input);
    await reuse(input, first.persistedExecutionWorkspace!);
    await db.update(issues).set({ executionWorkspaceId: null, projectWorkspaceId: null }).where(eq(issues.id, issue.id));
    input.task.issueRef = { ...input.task.issueRef!, executionWorkspaceId: null, projectWorkspaceId: null };
    input.reuse.nativeRecoveryExecutionWorkspaceId = first.persistedExecutionWorkspace!.id;
    const admittedRoot = join(home, `admitted-${input.run.id}`);
    await mkdir(admittedRoot);
    const remoteCwd = "/remote/admitted-task";
    input.reuse.persistedNativeExecutionInput = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId: issue.companyId, runId: input.run.id, issueId: issue.id,
        agentId: input.agent.id, executionWorkspaceId: first.persistedExecutionWorkspace!.id },
      task: { identifier: "WSP-1", title: issue.title, description: null, prompt: "Continue admitted work", workMode: "standard" },
      workspace: { cwd: transport === "local" ? admittedRoot : remoteCwd, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: null, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      provider: { kind: "codex", model: null },
      completionContract: { id: "contract", sha256: "abc123", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Continue admitted work", criteria: [{ id: "objective", requirement: "Finish" }] } },
      interactionResponses: [], credentialBindings: [],
    };
    const target: AdapterExecutionTarget = transport === "local" ? { kind: "local" }
      : transport === "ssh" ? { kind: "remote", transport: "ssh", remoteCwd,
        spec: { host: "fixture.invalid", port: 22, username: "fixture", remoteWorkspacePath: remoteCwd,
          privateKey: null, knownHosts: null, strictHostKeyChecking: true, remoteCwd } }
      : { kind: "remote", transport: "sandbox", providerKey: "daytona", remoteCwd };
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
      input.run.runnerProfileJson = { nativeWorkspaceSync: reference };
      if (descriptor === "corrupt") {
        await writeFile(nativeWorkspaceSyncInternals.descriptorPath(input.run.id, reference.descriptorSha256), "{}");
      }
    }
    const reserve = vi.spyOn(input.services.executionWorkspacesSvc, "reserveTaskRepositoryRootForRecovery");
    const prepare = vi.spyOn(input.services.executionWorkspacesSvc, "prepareTaskRepositoriesForAdmission");
    if (transport !== "daytona" || descriptor === "valid") {
      const result = await prepareHeartbeatWorkspace(db, input);
      expect(result.executionTarget).toEqual(target);
      if (transport === "ssh") expect(reserve).not.toHaveBeenCalled();
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
