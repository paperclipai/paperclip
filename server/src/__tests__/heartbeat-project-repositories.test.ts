import express from "express";
import request from "supertest";
import { fileResourceRoutes } from "../routes/file-resources.js";
import { errorHandler } from "../middleware/index.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, realpath, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, environments, executionWorkspaces, heartbeatRuns, issues, issueAccessGrants, principalPermissionGrants, projects, projectAccessMembers, projectWorkspaces } from "@paperclipai/db";
import { setExpensiveWorkspaceGitExecutor } from "@paperclipai/adapter-utils/git-workspace-sync";
import { buildProjectMentionHref } from "@paperclipai/shared";
import { createWorkspaceGitOperationScheduler, WorkspaceGitScanError } from "../services/workspace-git-operation-scheduler.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { createHeartbeatWorkspaceResolver } from "../services/heartbeat/workspaces.js";
import { resolveManagedProjectWorkspaceDir, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { accessService } from "../services/access.js";
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

  it.each(["agent", "organization"] as const)("isolates repository-free low-trust tasks while preserving reassignment and authorized referenced projects (%s policy)", async policyOwner => {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID();
    const referencedProjectId = randomUUID(), deniedProjectId = randomUUID();
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "true");
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(companies).values({ id: companyId, name: "Email company", issuePrefix: `E${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    const authorizationPolicy = {
      trustPreset: "low_trust_review", trustBoundary: { mode: "low_trust_review", companyId, projectIds: [projectId, referencedProjectId] },
    };
    await db.insert(projects).values({ id: projectId, companyId, name: "Onboarding",
      executionWorkspacePolicy: policyOwner === "organization" ? { authorizationPolicy } : null });
    for (const id of [referencedProjectId, deniedProjectId]) {
      const source = path.join(root, companyId, id);
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "reference.txt"), id);
      await db.insert(projects).values({ id, companyId, name: id });
      await db.insert(projectWorkspaces).values({ id: randomUUID(), companyId, projectId: id, name: "Reference", sourceType: "local_path", cwd: source, isPrimary: true });
    }
    await db.insert(environments).values({ id: environmentId, name: `Email sandbox ${policyOwner}`, driver: "sandbox", status: "active", config: { provider: "fake", image: "fake:test" } });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Email agent", role: "engineer", status: "idle", adapterType: "codex_local",
      defaultEnvironmentId: environmentId, adapterConfig: {}, runtimeConfig: {},
      permissions: policyOwner === "agent" ? { trustPreset: "low_trust_review", authorizationPolicy } : {},
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
      expect((await sandboxHeartbeat.getRun(run!.id))?.contextSnapshot).toMatchObject({
        executionPolicy: { trustPreset: "low_trust_review", authorizationPolicy: {
          trustBoundary: { projectIds: [projectId, referencedProjectId].sort() },
        } },
      });
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

  it.each([
    { name: "task override without agent cwd", agentCwd: false, taskDirectory: false },
    { name: "task override replacing agent cwd", agentCwd: true, taskDirectory: false },
    { name: "explicit task directory ahead of cwd overrides", agentCwd: true, taskDirectory: true },
  ])("resolves $name before binding and retains that root on continuation", async ({ agentCwd, taskDirectory }) => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const overrideCwd = path.join(root, companyId, "task-override");
    const agentDefaultCwd = path.join(root, companyId, "agent-default");
    const laterCwd = path.join(root, companyId, "later-override");
    for (const cwd of [overrideCwd, agentDefaultCwd, laterCwd]) {
      await mkdir(cwd, { recursive: true });
      await writeFile(path.join(cwd, "input.txt"), cwd);
    }
    await db.insert(companies).values({ id: companyId, name: "Task cwd", issuePrefix: `W${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "idle", adapterType: "codex_local", adapterConfig: agentCwd ? { cwd: agentDefaultCwd } : {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Use task files", status: "todo", assigneeAgentId: agentId,
      assigneeAdapterOverrides: { adapterConfig: { cwd: overrideCwd } },
      workspaceSelection: taskDirectory ? { version: 1, source: "explicit", selection: { kind: "task_directory" } } : null });
    const expectedCwd = taskDirectory
      ? path.join(resolvePaperclipInstanceRoot(), "isolated-workspaces", companyId, issueId)
      : overrideCwd;
    let bindingId: string | null = null;
    for (let admission = 0; admission < 2; admission++) {
      const defaultExecute = execute.getMockImplementation()!;
      execute.mockImplementationOnce(async (input) => {
        const cwd = input.context.paperclipWorkspace.cwd;
        expect(await realpath(cwd)).toBe(await realpath(expectedCwd));
        if (!taskDirectory) expect(await readFile(path.join(cwd, "input.txt"), "utf8")).toBe(overrideCwd);
        if (admission === 1) expect(await readFile(path.join(cwd, "output.txt"), "utf8")).toBe("first admission");
        await writeFile(path.join(cwd, "output.txt"), admission === 0 ? "first admission" : "continued");
        return defaultExecute(input);
      });
      const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
      await vi.waitFor(async () => { expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "succeeded", error: null }); }, { timeout: 15_000 });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(execute.mock.calls.filter(([input]) => input.runId === run!.id)).toHaveLength(1);
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, task.executionWorkspaceId!));
      expect(workspace.projectId).toBeNull();
      expect(await realpath(workspace.cwd!)).toBe(await realpath(expectedCwd));
      if (bindingId) expect(workspace.id).toBe(bindingId);
      bindingId = workspace.id;
      await db.update(issues).set({ status: "todo", assigneeAdapterOverrides: { adapterConfig: { cwd: laterCwd } } }).where(eq(issues.id, issueId));
    }
    expect(await readFile(path.join(expectedCwd, "output.txt"), "utf8")).toBe("continued");
    await expect(readFile(path.join(laterCwd, "output.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(agentDefaultCwd, "output.txt"), "utf8")).rejects.toThrow();
  }, 40_000);

  it.each([false, true])("keeps a task directory source projectless across chat admissions with an organizational project (explicit=%s)", async explicit => {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Chat files", issuePrefix: `C${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Organization only" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat agent", status: "idle", adapterType: "codex_local", adapterConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Keep chat files", originKind: "chat_channel", status: "todo", assigneeAgentId: agentId,
      workspaceSelection: explicit ? { version: 1, source: "explicit", selection: { kind: "task_directory" } } : null });
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

  it.each(["task_directory", "configured_source", "default"] as const)("keeps organizational environment separate from %s files", async (kind) => {
    const companyId = randomUUID(), projectId = randomUUID(), sourceProjectId = randomUUID(), sourceId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const cwd = path.join(root, companyId, "source");
    await mkdir(cwd, { recursive: true });
    await db.insert(companies).values({ id: companyId, name: "Environment ownership", issuePrefix: `V${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    await db.insert(projects).values([
      { id: projectId, companyId, name: "Task project", env: { PROJECT_VALUE: "task", TASK_ONLY: "present" } },
      { id: sourceProjectId, companyId, name: "File source", env: { PROJECT_VALUE: "source", SOURCE_ONLY: "must-not-leak" } },
    ]);
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId: sourceProjectId, name: "Source", cwd, isPrimary: true });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "idle", adapterType: "codex_local", adapterConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Use task environment", status: "todo", assigneeAgentId: agentId, executionWorkspaceSettings: { mode: "shared_workspace" },
      projectWorkspaceId: kind === "configured_source" ? sourceId : null,
      workspaceSelection: kind === "default" ? null : { version: 1, source: "explicit", selection: kind === "configured_source"
        ? { kind, projectWorkspaceId: sourceId, mode: "shared" } : { kind } },
    });
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
    await vi.waitFor(async () => { expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "succeeded", error: null }); }, { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const call = execute.mock.calls.find(([input]) => input.runId === run!.id)![0];
    expect(call.config.env).toMatchObject({ PROJECT_VALUE: "task", TASK_ONLY: "present" });
    expect(call.config.env.SOURCE_ONLY).toBeUndefined();
    expect(call.context.projectId).toBe(projectId);
    if (kind === "configured_source") expect(await realpath(call.context.paperclipWorkspace.cwd)).toBe(await realpath(cwd));
  }, 25_000);

  it.each([
    { policy: "organization", selection: "task_directory" },
    { policy: "organization", selection: "default" },
    { policy: "organization", selection: "configured_source" },
    { policy: "source", selection: "configured_source" },
  ] as const)("retains $policy low-trust restrictions with $selection", async ({ policy, selection }) => {
    const companyId = randomUUID(), projectId = randomUUID(), sourceProjectId = randomUUID(), sourceId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const cwd = path.join(root, companyId, "source");
    await mkdir(cwd, { recursive: true });
    await db.insert(companies).values({ id: companyId, name: "Policy ownership", issuePrefix: `L${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    const restricted = { authorizationPolicy: { trustPreset: "low_trust_review", trustBoundary: { mode: "low_trust_review", companyId, issueIds: [issueId] } } };
    await db.insert(projects).values([
      { id: projectId, companyId, name: "Task project", executionWorkspacePolicy: policy === "organization" ? restricted : null },
      { id: sourceProjectId, companyId, name: "File source", executionWorkspacePolicy: policy === "source" ? restricted : null },
    ]);
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId: sourceProjectId, name: "Source", cwd, isPrimary: true });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "idle", adapterType: "codex_local", adapterConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Do not relax policy", status: "todo", assigneeAgentId: agentId, executionWorkspaceSettings: { mode: "shared_workspace" },
      projectWorkspaceId: selection === "configured_source" ? sourceId : null,
      workspaceSelection: selection === "default" ? null : { version: 1, source: "explicit", selection: selection === "configured_source"
        ? { kind: selection, projectWorkspaceId: sourceId, mode: "shared" } : { kind: selection } },
    });
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
    await vi.waitFor(async () => { expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "failed" }); }, { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(execute.mock.calls.filter(([input]) => input.runId === run!.id)).toHaveLength(0);
    expect((await heartbeat.getRun(run!.id))?.contextSnapshot).toMatchObject({ executionPolicy: { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: { issueIds: [issueId] } } } });
  }, 25_000);

  it.each(["shared_workspace", "isolated_workspace"] as const)("continues authorized source execution after filesystem assignment grants are revoked with retained mode %s", async (retainedMode) => {
    const companyId = randomUUID(), projectId = randomUUID(), sourceId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const cwd = path.join(root, companyId, "protected-shared-source");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "work.txt"), "Protected project files");
    await db.insert(companies).values({ id: companyId, name: "Shared source authority", issuePrefix: `W${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Readable protected source", executionWorkspacePolicy: {
      authorizationPolicy: { assignmentPolicy: { mode: "protected" } },
    } });
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: "Shared source", sourceType: "local_path", cwd, isPrimary: true });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", status: "idle", adapterType: "codex_local", adapterConfig: {}, permissions: {} });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId, status: "active", membershipRole: "member" });
    const [grant] = await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agentId,
      permissionKey: "tasks:assign_scope", scope: { projectId, assigneeAgentId: agentId } }).returning();
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: "responsible-user",
      permissionKey: "tasks:assign_scope", scope: { projectId, assigneeAgentId: agentId } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Work in another project's shared files", status: "todo", assigneeAgentId: agentId,
      projectWorkspaceId: sourceId, executionWorkspaceSettings: { mode: "shared_workspace" },
      workspaceSelection: { version: 1, source: "explicit", selection: { kind: "configured_source", projectWorkspaceId: sourceId, mode: "shared" } } });
    const admit = async () => {
      const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
      expect(run).not.toBeNull();
      await vi.waitFor(async () => expect((await heartbeat.getRun(run!.id))?.status).toMatch(/^(succeeded|failed)$/), { timeout: 15_000 });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      return (await heartbeat.getRun(run!.id))!;
    };
    const first = await admit();
    expect(first).toMatchObject({ status: "succeeded", error: null });
    expect(execute.mock.calls.filter(([input]) => input.runId === first.id)).toHaveLength(1);
    const [bound] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(bound.projectId).toBeNull();
    expect(bound.executionWorkspaceId).not.toBeNull();
    if (retainedMode === "isolated_workspace") {
      await db.update(executionWorkspaces).set({ mode: retainedMode }).where(eq(executionWorkspaces.id, bound.executionWorkspaceId!));
      await db.update(issues).set({ executionWorkspaceSettings: { mode: retainedMode, workspaceStrategy: { type: "project_primary" } } }).where(eq(issues.id, issueId));
    }
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.id, grant.id));
    const actor = { type: "agent" as const, agentId, companyId, source: "agent_jwt" as const, onBehalfOfUserId: "responsible-user" };
    expect(await accessService(db).decide({ actor, action: "project:read", resource: { type: "project", companyId, projectId } })).toMatchObject({ allowed: true });
    expect(await accessService(db).decide({ actor, action: "tasks:assign", resource: { type: "issue", companyId, projectId, assigneeAgentId: agentId },
      scope: { projectId, assigneeAgentId: agentId } })).toMatchObject({ allowed: false, reason: "deny_policy_restricted" });
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    const continued = await admit();
    expect(continued).toMatchObject({ status: "succeeded", error: null });
    expect(execute.mock.calls.filter(([input]) => input.runId === continued.id)).toHaveLength(1);
    const [retained] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(retained.executionWorkspaceId).toBe(bound.executionWorkspaceId);
    expect(await readFile(path.join(cwd, "work.txt"), "utf8")).toBe("Protected project files");
  }, 40_000);

  it.each(["task", "agent"] as const)("admits existing assignments on an ordinary shared source despite protected %s assignment policy", async (protectedEntity) => {
    const companyId = randomUUID(), projectId = randomUUID(), sourceId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const cwd = path.join(root, companyId, "ordinary-source");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "work.txt"), "Existing assignment files");
    const authorizationPolicy = { assignmentPolicy: { mode: "protected" } };
    await db.insert(companies).values({ id: companyId, name: "Existing assignments", issuePrefix: `A${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Ordinary source" });
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: "Shared source", sourceType: "local_path", cwd, isPrimary: true });
    await db.insert(agents).values({ id: agentId, companyId, name: "Already assigned", status: "idle", adapterType: "codex_local", adapterConfig: {},
      permissions: protectedEntity === "agent" ? { authorizationPolicy } : {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue authorized assignment", status: "todo", assigneeAgentId: agentId,
      executionPolicy: protectedEntity === "task" ? { authorizationPolicy } : null,
      projectWorkspaceId: sourceId, executionWorkspaceSettings: { mode: "shared_workspace" },
      workspaceSelection: { version: 1, source: "explicit", selection: { kind: "configured_source", projectWorkspaceId: sourceId, mode: "shared" } } });
    const actor = { type: "agent" as const, agentId, companyId, source: "agent_jwt" as const, onBehalfOfUserId: "responsible-user" };
    expect(await accessService(db).decide({ actor, action: "tasks:assign", resource: { type: "issue", companyId, issueId, assigneeAgentId: agentId },
      scope: { assigneeAgentId: agentId } })).toMatchObject({ allowed: false });
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "succeeded", error: null }), { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const calls = execute.mock.calls.filter(([input]) => input.runId === run!.id);
    expect(calls).toHaveLength(1);
    expect(await realpath(calls[0]![0].context.paperclipWorkspace.cwd)).toBe(await realpath(cwd));
    expect(await readFile(path.join(cwd, "work.txt"), "utf8")).toBe("Existing assignment files");
  }, 30_000);

  it.each(["project_primary", "adapter_managed", "cloud_sandbox", "git_worktree"] as const)("authorizes current selected source without requiring filesystem assignment grants: %s", async (strategy) => {
    const companyId = randomUUID(), projectId = randomUUID(), sourceId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const cwd = path.join(root, companyId, "protected-source");
    await mkdir(cwd, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
    git("init", "-b", "main");
    await writeFile(path.join(cwd, "work.txt"), "Protected source content");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed");
    await db.insert(companies).values({ id: companyId, name: "Strategy authorization", issuePrefix: `S${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Protected source", executionWorkspacePolicy: {
      authorizationPolicy: { assignmentPolicy: { mode: "protected" } },
    } });
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: "Source", sourceType: "local_path", cwd, isPrimary: true });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reader", status: "idle", adapterType: "codex_local", adapterConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Use an isolated source", status: "todo", assigneeAgentId: agentId,
      projectWorkspaceId: sourceId, executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: strategy } },
      workspaceSelection: { version: 1, source: "explicit", selection: { kind: "configured_source", projectWorkspaceId: sourceId, mode: "managed_isolated" } } });
    const actor = { type: "agent" as const, agentId, companyId, source: "agent_jwt" as const, onBehalfOfUserId: "responsible-user" };
    expect(await accessService(db).decide({ actor, action: "project:read", resource: { type: "project", companyId, projectId } })).toMatchObject({ allowed: true });
    expect(await accessService(db).decide({ actor, action: "tasks:assign", resource: { type: "issue", companyId, projectId, assigneeAgentId: agentId },
      scope: { projectId, assigneeAgentId: agentId } })).toMatchObject({ allowed: false });
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => expect((await heartbeat.getRun(run!.id))?.status).toMatch(/^(succeeded|failed)$/), { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const result = await heartbeat.getRun(run!.id);
    const calls = execute.mock.calls.filter(([input]) => input.runId === run!.id);
    expect(result).toMatchObject({ status: "succeeded", error: null });
    expect(calls).toHaveLength(1);
    const workspace = calls[0]![0].context.paperclipWorkspace;
    if (strategy === "git_worktree") {
      expect(workspace.strategy).toBe("git_worktree");
      expect(await realpath(workspace.cwd)).not.toBe(await realpath(cwd));
    }
    expect(await readFile(path.join(workspace.cwd, "work.txt"), "utf8")).toBe("Protected source content");
    expect(await readFile(path.join(cwd, "work.txt"), "utf8")).toBe("Protected source content");
  }, 30_000);

  it.each(["success", "provision_failure", "copy_only_provision", "occupied_target"] as const)("copies selected Git source regardless of nested private filesystem history while preserving provisioning integrity (%s)", async (scenario) => {
    const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    try {
      if (scenario === "provision_failure") await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
      const companyId = randomUUID(), projectId = randomUUID(), privateProjectId = randomUUID();
      const sourceId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
      const cwd = path.join(root, companyId, "public-source");
      const privateCwd = path.join(cwd, "private");
      const occupiedTarget = path.join(cwd, ".paperclip", "worktrees", "occupied-private");
      await mkdir(privateCwd, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      git("init", "-b", "main");
      await writeFile(path.join(privateCwd, "secret.txt"), "NESTED_PRIVATE_TRACKED_BYTES");
      if (scenario === "occupied_target") {
        await mkdir(path.join(occupiedTarget, "private"), { recursive: true });
        await writeFile(path.join(occupiedTarget, "private/secret.txt"), "NESTED_PRIVATE_TRACKED_BYTES");
      }
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed");
      const initialWorktrees = git("worktree", "list", "--porcelain");
      await db.insert(companies).values({ id: companyId, name: "Private copy", issuePrefix: `C${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
      await db.insert(projects).values([
        { id: projectId, companyId, name: "Public Git source", executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } },
        { id: privateProjectId, companyId, name: "Private nested source", visibility: "private" },
      ]);
      await db.insert(projectWorkspaces).values([
        { id: sourceId, companyId, projectId, name: "Git source", sourceType: "local_path", cwd, isPrimary: true },
        { id: randomUUID(), companyId, projectId: privateProjectId, name: "Nested private source", sourceType: "local_path", cwd: privateCwd, isPrimary: true },
      ]);
      if (scenario === "occupied_target") await db.insert(projectWorkspaces).values({
        id: randomUUID(), companyId, projectId: privateProjectId, name: "Private parent of occupied target",
        sourceType: "local_path", cwd: path.dirname(occupiedTarget), isPrimary: false,
      });
      await db.insert(agents).values({ id: agentId, companyId, name: "Isolated reader", status: "idle", adapterType: "codex_local", adapterConfig: {}, permissions: {} });
      if (scenario === "provision_failure") await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId, status: "active", membershipRole: "member" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Read isolated source", status: "todo", assigneeAgentId: agentId,
        projectId: scenario === "provision_failure" ? projectId : null,
        projectWorkspaceId: sourceId, executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree", ...(scenario === "provision_failure" ? { provisionCommand: "exit 42" } : {}), ...(scenario === "copy_only_provision" ? { provisionCommand: "touch provision-ran; exit 42" } : {}), ...(scenario === "occupied_target" ? { branchTemplate: "occupied-private", provisionCommand: "touch provision-ran" } : {}) } },
        workspaceSelection: scenario === "provision_failure" ? null : { version: 1, source: "explicit", selection: { kind: "configured_source", projectWorkspaceId: sourceId, mode: "managed_isolated" } } });
      if (scenario === "provision_failure") await db.insert(principalPermissionGrants).values([
        { companyId, principalType: "agent", principalId: agentId, permissionKey: "tasks:assign_scope", scope: { projectId, assigneeAgentId: agentId } },
        { companyId, principalType: "user", principalId: "responsible-user", permissionKey: "tasks:assign_scope", scope: { projectId, assigneeAgentId: agentId } },
      ]);
      const admit = async () => {
        const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
        expect(run).not.toBeNull();
        await vi.waitFor(async () => expect((await heartbeat.getRun(run!.id))?.status).toMatch(/^(succeeded|failed)$/), { timeout: 15_000 });
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        return (await heartbeat.getRun(run!.id))!;
      };
      const allowed = await admit();
      const calls = execute.mock.calls.filter(([input]) => input.runId === allowed.id);
      let copiedCwd: string;
      if (scenario === "provision_failure" || scenario === "occupied_target") {
        expect(allowed.status).toBe("failed");
        expect(calls).toHaveLength(0);
        if (scenario === "provision_failure") {
          expect(allowed.error).toContain("provision");
          const paths = git("worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice(9));
          expect(paths).toHaveLength(2);
          copiedCwd = paths.find(entry => entry !== paths[0])!;
        } else {
          expect(allowed.error).toMatch(/exists|occupied|worktree|checkout|provision|protected|assignment grant/i);
          expect(git("worktree", "list", "--porcelain")).toBe(initialWorktrees);
          copiedCwd = occupiedTarget;
          await expect(readFile(path.join(copiedCwd, ".git"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
          await expect(readFile(path.join(copiedCwd, "provision-ran"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionWorkspaceId).toBeNull();
        const aliasId = randomUUID();
        await db.insert(executionWorkspaces).values({ id: aliasId, companyId, projectId: null, sourceIssueId: issueId,
          name: "Public alias after failed provisioning", mode: "shared_workspace", strategyType: "project_primary", cwd: copiedCwd,
          providerType: "local_fs", status: "active" });
        await db.update(issues).set({ executionWorkspaceId: aliasId }).where(eq(issues.id, issueId));
      } else {
        expect(allowed).toMatchObject({ status: "succeeded", error: null });
        expect(calls).toHaveLength(1);
        expect(calls[0]![0].context.paperclipWorkspace.strategy).toBe("git_worktree");
        copiedCwd = calls[0]![0].context.paperclipWorkspace.cwd;
        if (scenario === "copy_only_provision") {
          await expect(readFile(path.join(copiedCwd, "provision-ran"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
          const [bound] = await db.select().from(issues).where(eq(issues.id, issueId));
          const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, bound.executionWorkspaceId!));
          expect(workspace.metadata?._controllerProvisionCopyOnly).toBe(true);
        }
      }
      const workspace = { cwd: copiedCwd };
      expect(await realpath(workspace.cwd)).not.toBe(await realpath(cwd));
      expect(await readFile(path.join(workspace.cwd, "private/secret.txt"), "utf8")).toBe("NESTED_PRIVATE_TRACKED_BYTES");
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = { type: "board", userId: "responsible-user", companyIds: [companyId], source: "session", isInstanceAdmin: false };
        next();
      });
      app.use("/api", fileResourceRoutes(db));
      app.use(errorHandler);
      const fileUrl = `/api/issues/${issueId}/file-resources/content`;
      expect((await request(app).get(fileUrl).query({ workspace: "execution", path: "private/secret.txt" }).expect(200)).body.content.data).toBe("NESTED_PRIVATE_TRACKED_BYTES");
      await db.delete(projectAccessMembers).where(and(eq(projectAccessMembers.projectId, privateProjectId), eq(projectAccessMembers.subjectId, "responsible-user")));
      for (const download of [false, true]) {
        await request(app).get(fileUrl).query({ workspace: "execution", path: "private/secret.txt", download }).expect(200);
      }
      expect(await readFile(path.join(workspace.cwd, "private/secret.txt"), "utf8")).toBe("NESTED_PRIVATE_TRACKED_BYTES");
    } finally {
      vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", previousPrivacyMode);
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
      expect(result.error).toMatch(/Workspace source is unavailable or inaccessible|Task workspace source is unavailable/);
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

  it.each(["fresh", "existing", "occupied", "file_url", "absolute_path"] as const)("prepares an authorized configured sibling independently of private task filesystem history (%s)", async (scenario) => {
    const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    try {
      const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
      const sourceId = randomUUID(), siblingId = randomUUID(), privateIssueId = randomUUID();
      const anchor = path.join(root, companyId, "anchor"), sibling = path.join(root, companyId, "private-sibling");
      for (const cwd of [anchor, sibling]) {
        await mkdir(cwd, { recursive: true });
        execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
        await writeFile(path.join(cwd, "README.md"), "public committed content");
        execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
        execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed"], { cwd, stdio: "ignore" });
      }
      execFileSync("git", ["remote", "add", "origin", pathToFileURL(anchor).href], { cwd: anchor, stdio: "ignore" });
      const urlOnly = scenario === "file_url" || scenario === "absolute_path";
      await writeFile(path.join(sibling, "private.txt"), "PRIVATE_DIRTY_SIBLING_BYTES");
      if (urlOnly) {
        execFileSync("git", ["add", "private.txt"], { cwd: sibling, stdio: "ignore" });
        execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "private source"], { cwd: sibling, stdio: "ignore" });
        await writeFile(path.join(sibling, "uncommitted.txt"), "DO_NOT_OVERLAY_URL_ONLY_SOURCE");
      }
      await db.insert(companies).values({ id: companyId, name: "Late sibling", issuePrefix: "L" + companyId.slice(0, 6), defaultResponsibleUserId: "responsible-user" });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
      await db.insert(projects).values({ id: projectId, companyId, name: "Read-only source", executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } });
      await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: "Primary", sourceType: "local_path", cwd: anchor, repoUrl: pathToFileURL(anchor).href, isPrimary: true });
      await db.insert(agents).values({ id: agentId, companyId, name: "Reader", adapterType: "codex_local", status: "idle", adapterConfig: {}, permissions: {} });
      await db.insert(issues).values({ id: issueId, companyId, title: "Keep task binding", status: "todo", assigneeAgentId: agentId,
        projectWorkspaceId: sourceId, executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } },
        workspaceSelection: { version: 1, source: "explicit", selection: { kind: "configured_source", projectWorkspaceId: sourceId, mode: "managed_isolated" } } });
      const admit = async () => {
        await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
        const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", manualUserWake: true,
          requestedByActorType: "user", requestedByActorId: "responsible-user", contextSnapshot: { issueId } });
        expect(run).not.toBeNull();
        await vi.waitFor(async () => expect((await heartbeat.getRun(run!.id))?.status).toMatch(/^(succeeded|failed)$/), { timeout: 15_000 });
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        return (await heartbeat.getRun(run!.id))!;
      };
      const initial = await admit();
      expect(initial).toMatchObject({ status: "succeeded", error: null });
      const binding = (await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionWorkspaceId!;
      const taskCwd = execute.mock.calls.find(([input]) => input.runId === initial.id)![0].context.paperclipWorkspace.cwd as string;
      await db.insert(issues).values({ id: privateIssueId, companyId, title: "Private source task", status: "todo", visibility: "private", responsibleUserId: "private-owner" });
      await db.insert(executionWorkspaces).values({ companyId, projectId: null, sourceIssueId: privateIssueId, name: "Private source files",
        mode: "shared_workspace", strategyType: "project_primary", cwd: sibling, providerType: "local_fs", status: "active" });
      const repoUrl = scenario === "absolute_path" ? sibling : pathToFileURL(sibling).href;
      const configuredCwd = urlOnly ? null : sibling;
      await db.insert(projectWorkspaces).values({ id: siblingId, companyId, projectId, name: "Late sibling", sourceType: "local_path", cwd: configuredCwd, repoUrl, isPrimary: false });
      const key = (scenario === "absolute_path" ? "repo-" : "private-sibling-") + createHash("sha256").update(JSON.stringify([siblingId, repoUrl, null, configuredCwd])).digest("hex").slice(0, 12);
      const copy = path.join(taskCwd, ".paperclip-repositories", key);
      if (scenario === "existing" || scenario === "occupied") {
        await mkdir(path.dirname(copy), { recursive: true });
        if (scenario === "existing") execFileSync("git", ["clone", "--no-hardlinks", sibling, copy], { stdio: "ignore" });
        else await mkdir(copy);
        await writeFile(path.join(copy, "private.txt"), "PRESERVED_EXISTING_SIBLING_BYTES");
      }
      const authorized = await admit();
      expect(authorized.status).toBe(scenario === "occupied" ? "failed" : "succeeded");
      expect(execute.mock.calls.filter(([input]) => input.runId === authorized.id)).toHaveLength(scenario === "occupied" ? 0 : 1);
      if (scenario === "occupied") expect(authorized.error).toContain("not a git checkout");
      const expectedBytes = scenario === "fresh" || urlOnly ? "PRIVATE_DIRTY_SIBLING_BYTES" : "PRESERVED_EXISTING_SIBLING_BYTES";
      expect(await readFile(path.join(copy, "private.txt"), "utf8")).toBe(expectedBytes);
      if (urlOnly) await expect(readFile(path.join(copy, "uncommitted.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      if (urlOnly) {
        const sharedBase = await realpath(resolveManagedProjectWorkspaceDir({ companyId, projectId, repoName: scenario === "absolute_path" ? null : "private-sibling" }));
        expect(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: copy, encoding: "utf8" }).trim()).toBe(path.join(sharedBase, ".git"));
        expect(execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: copy, encoding: "utf8" }).trim()).toMatch(/^paperclip\/[a-f0-9]{12}\/main$/);
      }
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionWorkspaceId).toBe(binding);
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", userId: "responsible-user", companyIds: [companyId], source: "session", isInstanceAdmin: false }; next(); });
      app.use("/api", fileResourceRoutes(db));
      app.use(errorHandler);
      const fileUrl = "/api/issues/" + issueId + "/file-resources/content";
      const relativeFile = path.relative(taskCwd, path.join(copy, "private.txt"));
      expect((await request(app).get(fileUrl).query({ workspace: "execution", path: relativeFile }).expect(200)).body.content.data).toBe(expectedBytes);
      await db.delete(projectWorkspaces).where(eq(projectWorkspaces.id, siblingId));
      await db.delete(issueAccessGrants).where(eq(issueAccessGrants.issueId, privateIssueId));
      for (const download of [false, true]) {
        await request(app).get(fileUrl).query({ workspace: "execution", path: relativeFile, download }).expect(200);
      }
      // The fixture adapter reports no progress; exercise reuse outside its unrelated wake cooldown.
      await db.update(heartbeatRuns).set({ startedAt: new Date(Date.now() - 181_000), finishedAt: new Date(Date.now() - 180_000) })
        .where(eq(heartbeatRuns.agentId, agentId));
      const continued = await admit();
      expect(continued.status).toBe("succeeded");
      expect(execute.mock.calls.filter(([input]) => input.runId === continued.id)).toHaveLength(1);
      // Removing a configured repository detaches its files under the same task root.
      const detachedRoot = path.join(taskCwd, ".paperclip-runtime", "detached-repositories");
      const detached = await readdir(detachedRoot);
      expect(detached.length).toBeGreaterThan(0);
      const retained = await Promise.all(detached.map(name => readFile(path.join(detachedRoot, name, "private.txt"), "utf8").catch(() => null)));
      expect(retained).toContain(expectedBytes);
      for (const name of scenario === "occupied" ? [] : detached) {
        expect(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: path.join(detachedRoot, name), encoding: "utf8" }).trim())
          .toBe(await realpath(path.join(detachedRoot, name)));
      }
    } finally {
      vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", previousPrivacyMode);
    }
  }, 60_000);

  it("checks current run identity for an unbound file-URL anchor without inheriting private filesystem history", async () => {
    const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    try {
      const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
      const sourceId = randomUUID(), privateIssueId = randomUUID();
      const source = path.join(root, companyId, "private-anchor");
      await mkdir(source, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: source, stdio: "ignore" });
      await writeFile(path.join(source, "secret.txt"), "PRIVATE_ANCHOR_COMMITTED_BYTES");
      execFileSync("git", ["add", "."], { cwd: source, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "private source"], { cwd: source, stdio: "ignore" });
      await writeFile(path.join(source, "dirty.txt"), "DO_NOT_OVERLAY_URL_ONLY_ANCHOR");
      await db.insert(companies).values({ id: companyId, name: "Private anchor", issuePrefix: "A" + companyId.slice(0, 6), defaultResponsibleUserId: "responsible-user" });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
      await db.insert(projects).values({ id: projectId, companyId, name: "Public project" });
      await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: "URL-only anchor", sourceType: "git_repo", cwd: null, repoUrl: pathToFileURL(source).href, isPrimary: true });
      await db.insert(agents).values({ id: agentId, companyId, name: "Reader", adapterType: "codex_local", status: "idle", adapterConfig: {}, permissions: {} });
      await db.insert(issues).values({ id: privateIssueId, companyId, title: "Private original", visibility: "private", responsibleUserId: "private-owner" });
      await db.insert(executionWorkspaces).values({ companyId, projectId: null, sourceIssueId: privateIssueId, name: "Private original files",
        mode: "shared_workspace", strategyType: "project_primary", cwd: source, providerType: "local_fs", status: "active" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Read anchor", status: "todo", assigneeAgentId: agentId, projectWorkspaceId: sourceId,
        workspaceSelection: { version: 1, source: "explicit", selection: { kind: "configured_source", projectWorkspaceId: sourceId, mode: "shared" } } });
      const [actualAgent] = await db.select().from(agents).where(eq(agents.id, agentId));
      const [otherAgent] = await db.insert(agents).values({ companyId, name: "Other run owner", adapterType: "codex_local", status: "idle" }).returning();
      const [foreignRun] = await db.insert(heartbeatRuns).values({ companyId, agentId: otherAgent.id, issueId, status: "failed", responsibleUserId: "responsible-user" }).returning();
      const resolver = createHeartbeatWorkspaceResolver(db);
      await expect(resolver.resolveWorkspaceForRun(actualAgent, { issueId, executionIdentityRunId: foreignRun.id }, null))
        .rejects.toThrow(/authoritative run identity/);
      await db.insert(authUsers).values({ id: "private-owner", name: "Private owner", email: "private-owner@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "private-owner", status: "active", membershipRole: "member" });
      await db.insert(issueAccessGrants).values({ issueId: privateIssueId, subjectType: "agent", subjectId: agentId, source: "explicit" });
      const [ownedRun] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, status: "failed", responsibleUserId: "responsible-user" }).returning();
      // The resolver derives the sponsor from the authoritative run, ignoring a stale context hint.
      await expect(resolver.resolveWorkspaceForRun(actualAgent, { issueId, executionIdentityRunId: ownedRun.id, responsibleUserId: "private-owner" }, null))
        .resolves.toMatchObject({ source: "project_primary" });
      await db.delete(issueAccessGrants).where(eq(issueAccessGrants.issueId, privateIssueId));
      const admit = async () => {
        await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
        const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
        expect(run).not.toBeNull();
        await vi.waitFor(async () => expect((await heartbeat.getRun(run!.id))?.status).toMatch(/^(succeeded|failed)$/), { timeout: 15_000 });
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        return (await heartbeat.getRun(run!.id))!;
      };
      const managedCwd = resolveManagedProjectWorkspaceDir({ companyId, projectId, repoName: "private-anchor" });
      const authorized = await admit();
      expect(authorized).toMatchObject({ status: "succeeded", error: null });
      const copiedCwd = execute.mock.calls.find(([input]) => input.runId === authorized.id)![0].context.paperclipWorkspace.cwd;
      expect(await realpath(copiedCwd)).toBe(await realpath(managedCwd));
      expect(await readFile(path.join(copiedCwd, "secret.txt"), "utf8")).toBe("PRIVATE_ANCHOR_COMMITTED_BYTES");
      await expect(readFile(path.join(copiedCwd, "dirty.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", userId: "responsible-user", companyIds: [companyId], source: "session", isInstanceAdmin: false }; next(); });
      app.use("/api", fileResourceRoutes(db)); app.use(errorHandler);
      const fileUrl = "/api/issues/" + issueId + "/file-resources/content";
      expect((await request(app).get(fileUrl).query({ workspace: "execution", path: "secret.txt" }).expect(200)).body.content.data).toBe("PRIVATE_ANCHOR_COMMITTED_BYTES");
      await db.delete(issueAccessGrants).where(eq(issueAccessGrants.issueId, privateIssueId));
      await expect(resolver.resolveWorkspaceForRun(actualAgent, { issueId, executionIdentityRunId: authorized.id, responsibleUserId: "private-owner" }, null))
        .resolves.toMatchObject({ source: "project_primary" });
      await db.delete(projectWorkspaces).where(eq(projectWorkspaces.id, sourceId));
      await rename(source, source + "-removed");
      await db.delete(issueAccessGrants).where(eq(issueAccessGrants.issueId, privateIssueId));
      for (const download of [false, true]) await request(app).get(fileUrl).query({ workspace: "execution", path: "secret.txt", download }).expect(200);
      expect(await readFile(path.join(copiedCwd, "secret.txt"), "utf8")).toBe("PRIVATE_ANCHOR_COMMITTED_BYTES");
    } finally {
      vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", previousPrivacyMode);
    }
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
