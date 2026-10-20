import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agents, companies, createDb, environments, heartbeatRuns, issues, projects, projectWorkspaces, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { environmentService } from "../environments.js";
import { executionWorkspaceService } from "../execution-workspaces.js";
import { instanceSettingsService } from "../instance-settings.js";
import { buildNativeExecutionInput } from "../native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../native-runtime/runtime-context.test-fixture.js";
import { selectHeartbeatEnvironment, type HeartbeatEnvironmentSelectionInput } from "./environment-selection.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("heartbeat environment selection boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "heartbeat-environment-selection-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "environment-selection");
    await mkdir(resolvePaperclipInstanceRoot(), { recursive: true });
    database = await startEmbeddedPostgresTestDatabase("heartbeat-environment-selection-");
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
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Environment selection", issuePrefix: "ENV" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Selecting agent", status: "running", adapterType: "process" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Project" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Select this environment", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    const input: HeartbeatEnvironmentSelectionInput = {
      run, agent,
      task: { issueRef: issue, issueContext: issue, issueId: issue.id, executionProjectId: project.id, workspaceProjectContext: { hasWorkspace: false }, boundSourceWorkspace: null, hasSelectedWorkspaceSource: false, taskWorkspaceIntent: null, responsibleUserId: null, context: { issueId: issue.id } },
      policy: {
        trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
        requestedExecutionWorkspaceMode: "shared_workspace", isolatedWorkspacesEnabled: true,
        projectExecutionWorkspacePolicy: null, issueExecutionWorkspaceSettings: null,
      },
      config: { config: {}, sourceWorkspaceConfig: {}, issueAssigneeOverrides: null },
      services: { environmentsSvc: environmentService(db), executionWorkspacesSvc: executionWorkspaceService(db), instanceSettings: instanceSettingsService(db), findSharedWorkspaceHolder: vi.fn(async () => null), findExecutionWorkspaceHolder: vi.fn(async () => null) },
    };
    const workspace = async () => {
      const created = await executionWorkspaceService(db).create({ companyId: company.id, projectId: project.id, sourceIssueId: issue.id, name: "Saved workspace", mode: "isolated_workspace", strategyType: "git_worktree", cwd: home, providerRef: home });
      if (!created) throw new Error("Workspace fixture was not created");
      return created;
    };
    const recover = (workspaceId: string) => {
      input.run.runtimeMode = "native";
      input.run.runnerProfileJson = { nativeExecutionInput: buildNativeExecutionInput({
        companyId: company.id, runId: run.id, agentId: agent.id,
        issue: { id: issue.id, identifier: "ENV-1", title: issue.title, description: null, workMode: "standard" },
        taskPrompt: "Continue the same task", normalizedSessionId: randomUUID(), provider: "codex",
        workspace: { id: workspaceId, cwd: home, repoUrl: null, repoRef: null, branchName: null },
        completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Select the environment", criteria: [{ id: "objective", requirement: "Preserve the workspace" }] } },
        runtimeContext: nativeRuntimeContextFixture(),
      }) };
    };
    return { input, issue, project, workspace, recover };
  }

  it("keeps the admitted workspace binding when the issue points at a newer workspace", async () => {
    const { input, workspace, recover } = await fixture();
    const original = await workspace();
    const newer = await workspace();
    input.task.issueRef!.executionWorkspaceId = newer.id;
    input.task.issueRef!.executionWorkspacePreference = null;
    recover(original.id);
    const result = await selectHeartbeatEnvironment(db, input);
    expect(result.nativeRecoveryExecutionWorkspaceId).toBe(original.id);
    expect(result.reusableExistingExecutionWorkspace?.id).toBe(original.id);
    expect(result.requestedShouldReuseExisting).toBe(true);
    expect(input.task.issueRef!.executionWorkspaceId).toBe(newer.id);
    expect(result.persistedNativeExecutionInput?.binding.executionWorkspaceId).toBe(original.id);
  });

  it("selects the saved execution workspace without inspecting live Git delivery state", async () => {
    const { input, workspace, recover } = await fixture();
    const saved = await workspace();
    recover(saved.id);
    input.services.executionWorkspacesSvc = executionWorkspaceService(db, {
      inspectGitCloseReadiness: async () => {
        throw new Error("Live Git inspection is unavailable");
      },
    });

    const result = await selectHeartbeatEnvironment(db, input);

    expect(result.reusableExistingExecutionWorkspace).toMatchObject({
      id: saved.id,
      companyId: input.agent.companyId,
      cwd: home,
      strategyType: "git_worktree",
    });
    expect(result.nativeRecoveryExecutionWorkspaceId).toBe(saved.id);
  });

  it("does not treat a synthetic run-id recovery binding as a persisted workspace", async () => {
    const { input, recover } = await fixture();
    recover(input.run.id);
    const result = await selectHeartbeatEnvironment(db, input);
    expect(result).toMatchObject({ existingExecutionWorkspace: null, nativeRecoveryExecutionWorkspaceId: null, requestedShouldReuseExisting: false, reusableExistingExecutionWorkspace: null });
    expect(result.persistedNativeExecutionInput?.binding.executionWorkspaceId).toBe(input.run.id);
  });

  it("does not make an archived issue workspace available for reuse", async () => {
    const { input, workspace } = await fixture();
    const saved = await workspace();
    await executionWorkspaceService(db).update(saved.id, { status: "archived" });
    input.task.issueRef!.executionWorkspaceId = saved.id;
    input.task.issueRef!.executionWorkspacePreference = "reuse_existing";
    const result = await selectHeartbeatEnvironment(db, input);
    expect(result.requestedShouldReuseExisting).toBe(true);
    expect(result.reusableExistingExecutionWorkspace).toBeNull();
    expect(result.requestedReusableExecutionWorkspaceConfig).toBeNull();
  });

  it.each(["muse", "openai_dot", "grok_bot"] as const)("keeps %s managed placement without adopting the task's selected workspace", async provider => {
    const { input, issue, workspace } = await fixture();
    const source = await workspace();
    const [sandbox] = await db.insert(environments).values({ name: `External controller ${provider}`, driver: "sandbox", status: "active", config: { provider: "fake" } }).returning();
    input.agent.adapterType = "paperclip_runner";
    input.agent.adapterConfig = { provider };
    input.agent.defaultEnvironmentId = sandbox.id;
    input.task.issueRef!.executionWorkspaceId = source.id;
    input.task.issueRef!.projectWorkspaceId = randomUUID();
    input.task.boundSourceWorkspace = source;
    input.task.workspaceProjectContext = { hasWorkspace: true };
    input.task.hasSelectedWorkspaceSource = true;
    input.task.taskWorkspaceIntent = { version: 1, source: "explicit", selection: { kind: "task_directory" } };
    await db.update(issues).set({ originKind: "chat_channel" }).where(eq(issues.id, issue.id));
    const read = vi.spyOn(input.services.executionWorkspacesSvc, "getStoredById").mockRejectedValue(new Error("Task source must remain inaccessible"));
    const select = vi.spyOn(input.services.executionWorkspacesSvc, "validateStoredSelectionForRun").mockRejectedValue(new Error("Task selection must remain inaccessible"));
    try {
      const result = await selectHeartbeatEnvironment(db, input);
      expect(result).toMatchObject({ isDotRun: true, selectedEnvironmentId: sandbox.id,
        existingExecutionWorkspace: null, reusableExistingExecutionWorkspace: null,
        nativeChatWorkspaceScope: null, useIsolatedTaskDirectory: false, explicitTaskDirectory: false });
      expect(read).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(input.services.findSharedWorkspaceHolder).not.toHaveBeenCalled();
      expect(input.task.issueRef!.executionWorkspaceId).toBe(source.id);
    } finally { read.mockRestore(); select.mockRestore(); }
  });

  it("uses the low-trust task sandbox even when workspace feature gates hide issue settings", async () => {
    const { input, issue } = await fixture();
    const [sandbox] = await db.insert(environments).values({ name: "Task sandbox", driver: "sandbox", status: "active", config: { provider: "fake" } }).returning();
    input.task.issueContext!.executionWorkspaceSettings = { mode: "isolated_workspace", environmentId: sandbox.id };
    input.policy.trustPreset = { kind: "low_trust_review", preset: "low_trust_review", sourcePresets: {}, boundary: { mode: "low_trust_review", companyId: input.agent.companyId, rootIssueId: issue.id } };
    input.policy.requestedExecutionWorkspaceMode = "isolated_workspace";
    input.policy.isolatedWorkspacesEnabled = false;
    const result = await selectHeartbeatEnvironment(db, input);
    expect(result.selectedEnvironmentForConfig?.id).toBe(sandbox.id);
    expect(result.useIsolatedTaskDirectory).toBe(true);
  });

  it("returns the task-owned local chat root before workspace realization", async () => {
    const { input, issue } = await fixture();
    await db.update(issues).set({ originKind: "chat_channel", projectId: null }).where(eq(issues.id, issue.id));
    input.agent.adapterType = "paperclip_runner";
    input.task.executionProjectId = null;
    input.task.workspaceProjectContext = null;
    const result = await selectHeartbeatEnvironment(db, input);
    expect(result.nativeChatWorkspaceScope).toMatchObject({ companyId: input.agent.companyId, agentId: input.agent.id, issueId: issue.id, projectId: null });
    expect(result.nativeChatExpectedCwd).toBe(result.nativeChatWorkspaceScope?.taskRoot);
    expect(result.nativeChatExpectedCwd).toContain(`isolated-workspaces/${input.agent.companyId}/${issue.id}`);
  });

  it.each(["git_worktree", "project_primary"] as const)("only prepares fresh native chat isolation with a %s source strategy", async (strategy) => {
    const { input, issue, project } = await fixture();
    const [source] = await db.insert(projectWorkspaces).values({ companyId: input.agent.companyId, projectId: project.id,
      name: "Chat source", cwd: home, sourceType: "local_path", isPrimary: true }).returning();
    const intent = { version: 1 as const, source: "explicit" as const, selection: { kind: "configured_source" as const, projectWorkspaceId: source.id, mode: "managed_isolated" as const } };
    await db.update(issues).set({ originKind: "chat_channel", projectWorkspaceId: source.id, workspaceSelection: intent }).where(eq(issues.id, issue.id));
    input.task.issueRef!.projectWorkspaceId = source.id;
    input.task.workspaceProjectContext = { hasWorkspace: true };
    input.task.hasSelectedWorkspaceSource = true;
    input.task.taskWorkspaceIntent = intent;
    input.agent.adapterType = "paperclip_runner";
    input.policy.requestedExecutionWorkspaceMode = "isolated_workspace";
    input.config.sourceWorkspaceConfig = { workspaceStrategy: { type: strategy } };
    if (strategy === "project_primary") {
      await expect(selectHeartbeatEnvironment(db, input)).rejects.toThrow("External chat requires a task-owned isolated workspace");
    } else {
      const result = await selectHeartbeatEnvironment(db, input);
      expect(result).toMatchObject({ materializeNativeChatWorktree: true, nativeChatExpectedCwd: null, existingExecutionWorkspace: null });
      expect(result.nativeChatWorkspaceScope?.projectId).toBe(project.id);
      expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].executionWorkspaceId).toBeNull();
    }
  });
});
