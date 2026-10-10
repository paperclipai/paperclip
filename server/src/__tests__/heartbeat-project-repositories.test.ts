import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, environments, executionWorkspaces, heartbeatRuns, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { setExpensiveWorkspaceGitExecutor } from "@paperclipai/adapter-utils/git-workspace-sync";
import { buildProjectMentionHref } from "@paperclipai/shared";
import { createWorkspaceGitOperationScheduler, WorkspaceGitScanError } from "../services/workspace-git-operation-scheduler.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { findNativeChatWorkspaceScope } from "../services/native-runtime/native-chat-workspace.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const execute = vi.hoisted(() => vi.fn(async (_input: any) => ({ exitCode: 0, signal: null, timedOut: false })));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("task project repository provisioning", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-project-repos-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "false");
    database = await startEmbeddedPostgresTestDatabase("project-repositories");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
    heartbeat = heartbeatService(db);
    execute.mockImplementation(async (input) => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, input.context.issueId));
      return { exitCode: 0, signal: null, timedOut: false };
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }, 60_000);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    setExpensiveWorkspaceGitExecutor(null);
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "false");
    await instanceSettingsService(db).updateExperimental({
      enableIsolatedWorkspaces: false,
      enableIsolatedWorkspacesByDefault: false,
    });
  });

  it("isolates repository-free low-trust tasks while preserving reassignment and authorized referenced projects", async () => {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID();
    const referencedProjectId = randomUUID(), deniedProjectId = randomUUID();
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "true");
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(companies).values({ id: companyId, name: "Email company", issuePrefix: `E${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Onboarding" });
    for (const id of [referencedProjectId, deniedProjectId]) {
      const source = path.join(root, companyId, id);
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "reference.txt"), id);
      await db.insert(projects).values({ id, companyId, name: id });
      await db.insert(projectWorkspaces).values({ id: randomUUID(), companyId, projectId: id, name: "Reference", sourceType: "local_path", cwd: source, isPrimary: true });
    }
    await db.insert(environments).values({ id: environmentId, name: "Email sandbox", driver: "sandbox", status: "active", config: { provider: "fake", image: "fake:test" } });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Email agent", role: "engineer", status: "idle", adapterType: "codex_local",
      defaultEnvironmentId: environmentId, adapterConfig: {}, runtimeConfig: {},
      permissions: { trustPreset: "low_trust_review", authorizationPolicy: {
        trustPreset: "low_trust_review", trustBoundary: { mode: "low_trust_review", companyId, projectIds: [projectId, referencedProjectId] },
      } },
    });
    // Exercise the real lease and workspace lifecycle with the built-in fake
    // provider, executing its setup commands in a disposable filesystem root.
    const sandboxHeartbeat = heartbeatService(db, { environmentRuntime: {
      ...environmentRuntimeService(db),
      execute: async (input) => ({
        exitCode: 0,
        stdout: execFileSync(input.command, input.args ?? [], { cwd: root, input: input.stdin, encoding: "utf8", env: { ...process.env, ...input.env } }),
        stderr: "", signal: null, timedOut: false,
      }),
    } });
    const directories: string[] = [];
    const issueIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const issueId = randomUUID();
      issueIds.push(issueId);
      await db.insert(issues).values({
        id: issueId, companyId, projectId, title: "Incoming email", originKind: "chat_channel", status: "todo", assigneeAgentId: agentId,
        description: [referencedProjectId, deniedProjectId].map((id) => `[@Reference](${buildProjectMentionHref(id)})`).join(" "),
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      });
      const run = await sandboxHeartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId, projectId } });
      expect(run).not.toBeNull();
      await vi.waitFor(async () => {
        const latest = await sandboxHeartbeat.getRun(run!.id);
        expect({ status: latest?.status, error: latest?.error }).toEqual({ status: "succeeded", error: null });
      }, { timeout: 15_000 });
      await drainHeartbeatRunsToQuiescence(db, sandboxHeartbeat);
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.sourceIssueId, issueId));
      expect(workspace).toMatchObject({ companyId, projectId: null, mode: "isolated_workspace", strategyType: "project_primary" });
      expect(workspace.cwd).toContain(`/isolated-workspaces/${companyId}/${issueId}`);
      expect(execute.mock.calls.filter(([input]) => input.runId === run!.id)).toHaveLength(1);
      const call = execute.mock.calls.find(([input]) => input.runId === run!.id)![0];
      expect(call.context.paperclipEnvironment.driver).toBe("sandbox");
      expect(call.context.paperclipWorkspaces.map((workspace: { projectId: string }) => workspace.projectId)).toEqual([referencedProjectId]);
      directories.push(workspace.cwd!);
      await writeFile(path.join(workspace.cwd!, "email.txt"), `private email ${index}`);
    }
    expect(directories[0]).not.toBe(directories[1]);
    expect(await readFile(path.join(directories[0], "email.txt"), "utf8")).toBe("private email 0");
    const [originalAgent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const reassignedAgentId = randomUUID();
    await db.insert(agents).values({ ...originalAgent, id: reassignedAgentId, name: "Next agent", status: "idle" });
    await db.update(issues).set({ status: "todo", assigneeAgentId: reassignedAgentId }).where(eq(issues.id, issueIds[0]));
    const reassignedRun = await sandboxHeartbeat.wakeup(reassignedAgentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId: issueIds[0], projectId } });
    await vi.waitFor(async () => {
      const latest = await sandboxHeartbeat.getRun(reassignedRun!.id);
      expect({ status: latest?.status, error: latest?.error }).toEqual({ status: "succeeded", error: null });
    }, { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, sandboxHeartbeat);
    const reassignedCall = execute.mock.calls.find(([input]) => input.runId === reassignedRun!.id)![0];
    expect(reassignedCall.context.paperclipWorkspace.cwd).toBe(directories[0]);
    expect(await readFile(path.join(directories[0], "email.txt"), "utf8")).toBe("private email 0");
  }, 40_000);

  it.each([
    { scenario: "no configured workspace", configuredWorkspace: false, explicitIsolation: null },
    { scenario: "configured Git workspace", configuredWorkspace: true, explicitIsolation: null },
    { scenario: "explicit issue isolation without a workspace", configuredWorkspace: false, explicitIsolation: "issue" },
    { scenario: "explicit project isolation without a workspace", configuredWorkspace: false, explicitIsolation: "project" },
  ] as const)("applies default isolation safely with $scenario", async ({ configuredWorkspace, explicitIsolation }) => {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await instanceSettingsService(db).updateExperimental({
      enableIsolatedWorkspaces: true,
      enableIsolatedWorkspacesByDefault: true,
    });
    await db.insert(companies).values({ id: companyId, name: "Research", issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    await db.insert(projects).values({
      id: projectId, companyId, name: "Research", status: "in_progress",
      executionWorkspacePolicy: explicitIsolation === "project" ? { enabled: true, defaultMode: "isolated_workspace" } : null,
    });
    if (configuredWorkspace) {
      const source = path.join(root, companyId, "source");
      await mkdir(source, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", args, { cwd: source, stdio: "ignore" });
      git("init", "-b", "main");
      await writeFile(path.join(source, "README.md"), "Research notes\n");
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed");
      await db.insert(projectWorkspaces).values({
        id: randomUUID(), companyId, projectId, name: "Research repository", sourceType: "local_path", cwd: source, isPrimary: true,
      });
    }
    await db.insert(agents).values({ id: agentId, companyId, name: "Researcher", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({
      id: issueId, companyId, projectId, title: "Write a report", status: "todo", assigneeAgentId: agentId,
      executionWorkspaceSettings: explicitIsolation === "issue" ? { mode: "isolated_workspace" } : null,
    });
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId, projectId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect({ status: latest?.status, errorCode: latest?.errorCode }).toEqual({
        status: explicitIsolation ? "failed" : "succeeded",
        errorCode: explicitIsolation ? "workspace_validation_failed" : null,
      });
    }, { timeout: 15_000 });
    const calls = execute.mock.calls.filter(([input]) => input.runId === run!.id);
    expect(calls).toHaveLength(explicitIsolation ? 0 : 1);
    if (!explicitIsolation) {
      const workspace = calls[0]![0].context.paperclipWorkspace;
      expect(workspace.mode).toBe(configuredWorkspace ? "isolated_workspace" : "shared_workspace");
      if (configuredWorkspace) {
        expect(workspace.strategy).toBe("git_worktree");
        expect(execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workspace.cwd, encoding: "utf8" }).trim()).toBe("true");
      } else {
        expect(workspace.cwd).toContain(`/isolated-workspaces/${companyId}/${issueId}`);
      }
    }
  }, 25_000);

  it("keeps a task directory source projectless across chat admissions with an organizational project", async () => {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Chat files", issuePrefix: `C${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Organization only" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat agent", status: "idle", adapterType: "codex_local", adapterConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Keep chat files", originKind: "chat_channel", status: "todo", assigneeAgentId: agentId,
      workspaceSelection: { version: 1, source: "explicit", selection: { kind: "task_directory" } } });
    let bindingId: string | undefined;
    for (let admission = 0; admission < 2; admission++) {
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
      const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId, projectId } });
      await vi.waitFor(async () => { expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "succeeded", error: null }); }, { timeout: 15_000 });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, task.executionWorkspaceId!));
      expect(workspace.projectId).toBeNull();
      expect(task.projectId).toBe(projectId);
      if (bindingId) expect(workspace.id).toBe(bindingId);
      bindingId = workspace.id;
      const scope = await findNativeChatWorkspaceScope(db, { companyId, agentId, issueId, instanceRoot: root,
        adapterType: "paperclip_runner", environmentDriver: "local" });
      expect(scope?.projectId).toBeNull();
    }
  }, 40_000);

  it.each([true, false])("handles a deleted configured source with a retained workspace: %s", async (bound) => {
    const companyId = randomUUID(), projectId = randomUUID(), sourceId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const cwd = path.join(root, companyId, "retained-source");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "work.txt"), "Retained task work");
    await db.insert(companies).values({ id: companyId, name: "Retained source", issuePrefix: `D${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Source policy" });
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: "Source", sourceType: "local_path", cwd, isPrimary: true });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", status: "idle", adapterType: "codex_local", adapterConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue retained work", status: "todo", assigneeAgentId: agentId,
      projectWorkspaceId: sourceId, executionWorkspaceSettings: { mode: "shared_workspace" },
      workspaceSelection: { version: 1, source: "explicit", selection: { kind: "configured_source", projectWorkspaceId: sourceId, mode: "shared" } } });
    const admit = async () => {
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
      const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
      expect(run).not.toBeNull();
      await vi.waitFor(async () => expect((await heartbeat.getRun(run!.id))?.status).toMatch(/^(succeeded|failed)$/), { timeout: 15_000 });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      return (await heartbeat.getRun(run!.id))!;
    };
    let bindingId: string | null = null;
    if (bound) {
      expect(await admit()).toMatchObject({ status: "succeeded", error: null });
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      bindingId = task.executionWorkspaceId;
      expect(bindingId).not.toBeNull();
    }
    await db.delete(projectWorkspaces).where(eq(projectWorkspaces.id, sourceId));
    const result = await admit();
    const calls = execute.mock.calls.filter(([input]) => input.runId === result.id);
    if (bound) {
      expect(result).toMatchObject({ status: "succeeded", error: null });
      expect(calls).toHaveLength(1);
      expect(await realpath(calls[0]![0].context.paperclipWorkspace.cwd)).toBe(await realpath(cwd));
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, bindingId!));
      expect(task.executionWorkspaceId).toBe(bindingId);
      expect(workspace).toMatchObject({ projectId, projectWorkspaceId: null });
      expect(await readFile(path.join(cwd, "work.txt"), "utf8")).toBe("Retained task work");
      await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, projectId));
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
      const callsBeforeRevocation = execute.mock.calls.length;
      expect(await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } })).toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(execute.mock.calls).toHaveLength(callsBeforeRevocation);
    } else {
      expect(result.status).toBe("failed");
      expect(result.error).toContain("Workspace source is unavailable or inaccessible");
      expect(calls).toHaveLength(0);
    }
  }, 40_000);

  it.each([
    { code: "workspace_git_scan_timeout", scenario: "temporary", retryable: true },
    { code: "workspace_git_scan_saturated", scenario: "temporary", retryable: true },
    { code: "workspace_git_scan_timeout", scenario: "exhausted", retryable: true },
    { code: "workspace_git_scan_timeout", scenario: "paused", retryable: true },
    { code: "workspace_git_scan_output_limit", scenario: "permanent", retryable: false },
    { code: "workspace_git_scan_cancelled", scenario: "cancelled", retryable: false },
    { code: "workspace_git_scan_failed", scenario: "permanent", retryable: false },
  ] as const)("handles $scenario $code during local-source preparation", async ({ code, scenario, retryable }) => {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const source = path.join(root, companyId, "source");
    await mkdir(source, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: source, stdio: "ignore" });
    git("init", "-b", "main");
    await writeFile(path.join(source, "README.md"), "committed");
    await writeFile(path.join(source, ".gitignore"), "private.secret\n");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed");
    await writeFile(path.join(source, "README.md"), "preserved dirty work");
    await writeFile(path.join(source, "private.secret"), "must not copy");
    await db.insert(companies).values({ id: companyId, name: "Bootstrap recovery", issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Local source", status: "in_progress" });
    await db.insert(projectWorkspaces).values([
      { id: randomUUID(), companyId, projectId, name: "Anchor", sourceType: "local_path", cwd: source, isPrimary: true, createdAt: new Date(Date.now() - 1000) },
      { id: randomUUID(), companyId, projectId, name: "Source copy", sourceType: "git_repo", repoUrl: pathToFileURL(source).href, cwd: source, isPrimary: false },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Test", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Recover startup and use existing work", status: "todo", assigneeAgentId: agentId });
    let inject = true;
    const canonicalSource = await realpath(source);
    const scheduler = createWorkspaceGitOperationScheduler();
    setExpensiveWorkspaceGitExecutor(async (input) => {
      if (inject && (input.localDir === source || input.localDir === canonicalSource) && input.operation === "adapter_sync.ignored_files") {
        inject = scenario === "exhausted";
        throw new WorkspaceGitScanError(code, "Injected temporary scan failure");
      }
      return scheduler.run({
        workspacePath: input.localDir,
        args: input.args,
        operation: input.operation,
        cacheTtlMs: 0,
        timeoutMs: input.timeout,
        maxStdoutBytes: input.maxBuffer,
        maxStderrBytes: input.maxBuffer,
        env: input.env,
        onStdout: input.onStdout,
        signal: input.signal,
      });
    });
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId, projectId } });
    await vi.waitFor(async () => expect((await heartbeat.getRun(run!.id))?.errorCode).toBe(code), { timeout: 15_000 });
    expect(execute.mock.calls.filter(([input]) => input.runId === run!.id)).toHaveLength(0);
    await heartbeat.drainActiveRunExecutions();
    if (!retryable) {
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id))).toHaveLength(0);
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.status).toBe("blocked");
      return;
    }
    let retry: typeof heartbeatRuns.$inferSelect;
    await vi.waitFor(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
      expect(rows).toHaveLength(1);
      retry = rows[0]!;
      expect(retry.status).toBe("scheduled_retry");
      expect(retry.scheduledRetryAttempt).toBe(1);
    });
    // Recreate the service as on restart; durable scheduling must not need the old closure.
    await heartbeat.drainActiveRunExecutions();
    heartbeat = heartbeatService(db);
    if (scenario === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1000) }).where(eq(heartbeatRuns.id, retry!.id));
    await heartbeat.promoteDueScheduledRetries();
    await heartbeat.promoteDueScheduledRetries();
    await heartbeat.resumeQueuedRuns();
    if (scenario === "paused") {
      expect((await heartbeat.getRun(retry!.id))?.status).toBe("cancelled");
      expect(execute.mock.calls.filter(([input]) => input.agent.id === agentId)).toHaveLength(0);
      return;
    }
    if (scenario === "exhausted") {
      await heartbeat.drainActiveRunExecutions();
      expect((await heartbeat.getRun(retry!.id))?.errorCode).toBe(code);
      const [last] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, retry!.id));
      expect(last).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 2 });
      await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1000) }).where(eq(heartbeatRuns.id, last!.id));
      await heartbeat.promoteDueScheduledRetries();
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      expect((await heartbeat.getRun(last!.id))?.errorCode).toBe(code);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(3);
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "blocked", assigneeAgentId: agentId });
      expect(execute.mock.calls.filter(([input]) => input.agent.id === agentId)).toHaveLength(0);
      return;
    }
    await vi.waitFor(async () => expect((await heartbeat.getRun(retry!.id))?.status).toBe("succeeded"), { timeout: 15_000 });
    expect(execute.mock.calls.filter(([input]) => input.runId === retry!.id)).toHaveLength(1);
    const [task] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    expect(task).toMatchObject({ status: "done", assigneeAgentId: agentId });
    const copies = (execute.mock.calls.find(([input]) => input.runId === retry!.id)![0].context.paperclipWorkspaces as Array<{ cwd: string }>).filter((hint) => hint.cwd.includes(".paperclip-repositories"));
    expect(copies.length).toBeGreaterThan(0);
    expect(await readFile(path.join(copies[0]!.cwd, "README.md"), "utf8")).toBe("preserved dirty work");
    await expect(readFile(path.join(copies[0]!.cwd, "private.secret"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(source, "README.md"), "utf8")).toBe("preserved dirty work");
  }, 40_000);

  it.each([1, 2])("gives a task all %i repositories without any configured local folders", async (count) => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const repositoryRows = [];
    for (let index = 0; index < count; index++) {
      const source = path.join(root, companyId, `source-${index}`);
      await mkdir(source, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", args, { cwd: source, stdio: "ignore" });
      git("init", "-b", "main");
      await writeFile(path.join(source, "README.md"), `repository ${index}`);
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed");
      repositoryRows.push({ id: randomUUID(), companyId, projectId, name: `Repo ${index}`, sourceType: "git_repo", repoUrl: pathToFileURL(source).href, cwd: null, isPrimary: index === 0 });
    }
    await db.insert(companies).values({ id: companyId, name: "Repo test", issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Multi-repo", status: "in_progress" });
    await db.insert(projectWorkspaces).values(repositoryRows);
    await db.insert(agents).values({ id: agentId, companyId, name: "Test", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Use project repositories", status: "todo", assigneeAgentId: agentId });
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId, projectId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect({ status: latest?.status, error: latest?.error }).toEqual({ status: "succeeded", error: null });
    }, { timeout: 15_000 });
    const input = execute.mock.calls.find(([ctx]) => ctx.runId === run!.id)![0];
    const hints = input.context.paperclipWorkspaces as Array<{ workspaceId: string; cwd: string }>;
    for (let index = 0; index < count; index++) {
      const hint = hints.find((entry) => entry.workspaceId === repositoryRows[index]!.id);
      expect(hint?.cwd).toBeTruthy();
      expect(await readFile(path.join(hint!.cwd, "README.md"), "utf8")).toBe(`repository ${index}`);
      expect(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: hint!.cwd, encoding: "utf8" }).trim()).toBe(await realpath(hint!.cwd));
    }
  }, 25_000);
});
