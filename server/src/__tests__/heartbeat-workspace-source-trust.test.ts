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
import { issueService } from "../services/issues.js";
import { accessService } from "../services/access.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { findNativeChatWorkspaceScope } from "../services/native-runtime/native-chat-workspace.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";

const execute = vi.hoisted(() => vi.fn(async (_input: any) => ({ exitCode: 0, signal: null, timedOut: false })));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("heartbeat physical workspace source trust", () => {
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
      if (!input.context.conversationMode) {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, input.context.issueId));
      }
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

  it.each(["current", "retained", "sandbox", "provision_current", "provision_retained"] as const)("uses current selected trust without inferring policy from unrelated physical aliases (%s)", async scenario => {
    const sandbox = scenario === "sandbox";
    const provision = scenario.startsWith("provision_");
    const companyId = randomUUID(), projectId = randomUUID(), sourceId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    const cwd = path.join(root, companyId, "low-trust-source");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "work.txt"), "Low-trust source files");
    const base = path.join(root, companyId, "base");
    if (provision || sandbox) {
      await mkdir(base, { recursive: true });
      await writeFile(path.join(base, "source.txt"), "source");
      if (sandbox) {
        await mkdir(path.join(base, "scripts"));
        await writeFile(path.join(base, "scripts", "provision-worktree.sh"), `if [ "$FIXTURE_SANDBOX_EXECUTION" != 1 ]; then printf host-provisioned > '${path.join(cwd, "provision-ran")}'; fi\n`);
      }
      const git = (...args: string[]) => execFileSync("git", args, { cwd: base, stdio: "ignore" });
      git("init", "-b", "main"); git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source");
      await rm(cwd, { recursive: true });
      git("worktree", "add", "-b", "task", cwd);
    }
    const provisionCommand = `printf host-provisioned > '${path.join(cwd, "provision-ran")}'`;
    await db.insert(companies).values({ id: companyId, name: "Physical trust", issuePrefix: `F${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Low-trust folder owner", executionWorkspacePolicy: {
      trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review", trustBoundary: { mode: "low_trust_review", companyId, rootIssueId: issueId, projectIds: [projectId] } },
    } });
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: "Source", sourceType: "local_path", cwd: sandbox ? base : cwd, isPrimary: true });
    await db.insert(agents).values({ id: agentId, companyId, name: "Standard local worker", status: "idle", adapterType: "codex_local", adapterConfig: {}, permissions: {} });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId, status: "active", membershipRole: "member" });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, name: "Projectless alias", cwd, projectId: sandbox ? projectId : null, mode: sandbox ? "isolated_workspace" : "shared_workspace", strategyType: sandbox ? "git_worktree" : "project_primary",
      ...(sandbox ? { projectWorkspaceId: sourceId, providerRef: cwd, branchName: "task", baseRef: "main", config: { provisionCommand: "bash ./scripts/provision-worktree.sh" } } : {}),
      ...(provision ? { branchName: "task", baseRef: "main", config: { provisionCommand } } : {}) }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Standard task", status: "todo", assigneeAgentId: agentId,
      executionWorkspaceId: workspace.id, projectWorkspaceId: sandbox ? sourceId : null, executionWorkspacePreference: "reuse_existing", executionWorkspaceSettings: { mode: sandbox || provision ? "isolated_workspace" : "shared_workspace",
        ...(provision ? { workspaceStrategy: { type: "git_worktree", provisionCommand } } : {}) },
      workspaceSelection: { version: 1, source: "explicit", selection: { kind: "existing", workspaceId: workspace.id } } });
    if (scenario === "retained" || scenario === "provision_retained") {
      const { projectService } = await import("../services/projects.js");
      await projectService(db).updateWorkspace(projectId, sourceId, { cwd: path.join(root, companyId, "relocated") });
    }
    let driver = heartbeat;
    if (sandbox) {
      const environmentId = randomUUID();
      await db.insert(environments).values({ id: environmentId, name: "Source sandbox", driver: "sandbox", status: "active", config: { provider: "fake", image: "fake:test" } });
      await db.update(agents).set({ defaultEnvironmentId: environmentId }).where(eq(agents.id, agentId));
      driver = heartbeatService(db, { environmentRuntime: { ...environmentRuntimeService(db), execute: async input => ({
        exitCode: 0, stdout: execFileSync(input.command, input.args ?? [], { cwd: root, input: input.stdin, encoding: "utf8", env: { ...process.env, ...input.env, FIXTURE_SANDBOX_EXECUTION: "1" } }),
        stderr: "", signal: null, timedOut: false,
      }) } });
    }
    const run = await driver.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => expect((await driver.getRun(run!.id))?.status).toMatch(/^(succeeded|failed)$/), { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, driver);
    if (sandbox) {
      expect(await driver.getRun(run!.id)).toMatchObject({ status: "succeeded", error: null });
      const calls = execute.mock.calls.filter(([input]) => input.runId === run!.id);
      expect(calls).toHaveLength(1);
      expect(calls[0][0].context.paperclipEnvironment.driver).toBe("sandbox");
      await expect(readFile(path.join(cwd, "provision-ran"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await driver.getRun(run!.id)).toMatchObject({ status: "succeeded", error: null });
      expect(execute.mock.calls.filter(([input]) => input.runId === run!.id)).toHaveLength(1);
    }
  });

  it.each([
    ["configured", "none", "sandbox"], ["builtin", "none", "sandbox"],
    ["configured", "agent", "sandbox"], ["builtin", "agent", "sandbox"],
    ["configured", "both", "sandbox"], ["builtin", "both", "sandbox"],
    ["configured", "both", "local"], ["builtin", "both", "local"],
    ["configured", "none", "local"], ["builtin", "none", "local"],
    ["configured", "both", "local_default"], ["builtin", "both", "local_default"],
    ["configured", "both", "local_new_default"], ["builtin", "both", "local_new_default"],
    ["configured", "both", "local_new_primary"], ["builtin", "both", "local_new_primary"],
    ["configured", "agent", "local_effective_strategy"], ["builtin", "agent", "local_effective_strategy"],
  ] as const)("places standard source %s provisioning with %s grants on %s", async (provisionKind, grants, placement) => {
    const implicitDefault = placement.startsWith("local_");
    const newerDefault = placement === "local_new_default" || placement === "local_new_primary";
    const companyId = randomUUID(), projectId = randomUUID(), sourceId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    const cwd = path.join(root, companyId, "read-only-source");
    const marker = path.join(root, companyId, "host-script-ran");
    await mkdir(path.join(cwd, "scripts"), { recursive: true });
    await writeFile(path.join(cwd, "source.txt"), "read-only source bytes");
    await writeFile(path.join(cwd, "scripts", "provision-worktree.sh"), `printf host-script-ran > '${marker}'\n`);
    const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
    git("init", "-b", "main"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source");
    git("remote", "add", "origin", pathToFileURL(cwd).href);
    await db.insert(companies).values({ id: companyId, name: "Read-only source", issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Protected source", executionWorkspacePolicy: {
      authorizationPolicy: { assignmentPolicy: { mode: "protected" } },
      ...(placement === "local_new_default" ? { defaultProjectWorkspaceId: sourceId } : {}),
    } });
    if (newerDefault) await db.insert(projectWorkspaces).values({ id: randomUUID(), companyId, projectId, name: "Older source", sourceType: "local_path", cwd: path.join(root, companyId, "older-source"), isPrimary: placement === "local_new_default", createdAt: new Date(0) });
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: "Source", sourceType: "local_path", cwd, repoUrl: pathToFileURL(cwd).href, isPrimary: placement !== "local_new_default" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reader", status: "idle", adapterType: "codex_local", adapterConfig: { fullAuto: grants === "both",
      ...(placement === "local_effective_strategy" ? { workspaceStrategy: { type: "project_primary" } } : {}) }, permissions: {} });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId, status: "active", membershipRole: "member" });
    const taskInput = { id: issueId, companyId, projectId: implicitDefault ? projectId : null, title: "Read-only isolated source", status: "todo" as const, assigneeAgentId: agentId,
      projectWorkspaceId: sourceId, executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree",
        worktreeParentDir: path.join(root, companyId, "worktrees"), ...(provisionKind === "configured" ? { provisionCommand: `printf host-script-ran > '${marker}'` } : {}) } },
      workspaceSelection: implicitDefault ? null : { version: 1 as const, source: "explicit" as const, selection: { kind: "configured_source" as const, projectWorkspaceId: sourceId, mode: "managed_isolated" as const } } };
    if (newerDefault || placement === "local_effective_strategy") {
      const { projectWorkspaceId: _source, workspaceSelection: _selection, ...createInput } = taskInput;
      const created = await issueService(db).create(companyId, createInput);
      expect(created.projectWorkspaceId).toBe(sourceId);
      expect(created.workspaceSelection).toMatchObject({ source: "project" });
    } else await db.insert(issues).values(taskInput);
    if (grants !== "none") await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agentId,
      permissionKey: "tasks:assign_scope", scope: { projectId, assigneeAgentId: agentId } });
    if (grants === "both") await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: "responsible-user",
      permissionKey: "tasks:assign_scope", scope: { projectId, assigneeAgentId: agentId } });
    const actor = { type: "agent" as const, agentId, companyId, source: "agent_jwt" as const, onBehalfOfUserId: "responsible-user" };
    expect(await accessService(db).decide({ actor, action: "project:read", resource: { type: "project", companyId, projectId } })).toMatchObject({ allowed: true });
    expect(await accessService(db).decide({ actor, action: "project:write_workspace", resource: { type: "issue", companyId, projectId, issueId, assigneeAgentId: agentId }, scope: { projectId, assigneeAgentId: agentId } })).toMatchObject({ allowed: grants === "both" });
    if (placement === "local_effective_strategy") {
      const selection = { kind: "configured_source" as const, projectWorkspaceId: sourceId, mode: "managed_isolated" as const };
      await expect(executionWorkspaceService(db).validateSelection({ companyId, actor, issueId, selection })).resolves.toMatchObject({ projectWorkspaceId: sourceId });
      await expect(executionWorkspaceService(db).validateSelection({ companyId, actor, issueId,
        selection: { ...selection, mode: "shared" }, preserveImplicitDefaultSettings: true })).rejects.toThrow("Task workspace default changed");
    }
    const environmentId = randomUUID();
    await db.insert(environments).values({ id: environmentId, name: `Standard sandbox ${companyId}`, driver: "sandbox", status: "active", config: { provider: "fake", image: "fake:test" } });
    await db.update(agents).set({ defaultEnvironmentId: placement === "sandbox" ? environmentId : null }).where(eq(agents.id, agentId));
    const driver = heartbeatService(db, { environmentRuntime: { ...environmentRuntimeService(db), execute: async input => ({
      exitCode: 0, stdout: execFileSync(input.command, input.args ?? [], { cwd: root, input: input.stdin, encoding: "utf8", env: { ...process.env, ...input.env } }),
      stderr: "", signal: null, timedOut: false,
    }) } });
    const run = await driver.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => expect((await driver.getRun(run!.id))?.status).toMatch(/^(succeeded|failed)$/), { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, driver);
    expect(await driver.getRun(run!.id)).toMatchObject({ status: "succeeded", error: null });
    const [bound] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, bound.executionWorkspaceId!));
    expect(workspace.cwd).not.toBe(cwd);
    expect(await readFile(path.join(workspace.cwd!, "source.txt"), "utf8")).toBe("read-only source bytes");
    expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("read-only source bytes");
    const calls = execute.mock.calls.filter(([input]) => input.runId === run!.id);
    expect(calls).toHaveLength(1);
    expect(calls[0][0].context.paperclipEnvironment.driver).toBe(placement === "sandbox" ? "sandbox" : "local");
    if (!implicitDefault) await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(marker, "utf8")).toBe("host-script-ran");
    await rm(marker, { force: true });
    if (grants === "none") await rm(workspace.cwd!, { recursive: true, force: true });
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    if (placement === "local" && grants === "both") await db.update(issues).set({ projectId, workspaceSelection: null }).where(eq(issues.id, issueId));
    await executionWorkspaceService(db).update(workspace.id, { metadata: { ...workspace.metadata,
      _controllerProvisionCopyOnly: false, config: { provisionCommand: `printf host-script-ran > '${marker}'` } } });
    const resumed = await driver.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
    await vi.waitFor(async () => expect((await driver.getRun(resumed!.id))?.status).toMatch(/^(succeeded|failed)$/), { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, driver);
    expect(await driver.getRun(resumed!.id)).toMatchObject({ status: "succeeded", error: null });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionWorkspaceId).toBe(workspace.id);
    expect(await readFile(path.join(workspace.cwd!, "source.txt"), "utf8")).toBe("read-only source bytes");
    if (!implicitDefault) await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(marker, "utf8")).toBe("host-script-ran");
  }, 30_000);

  it.each([
    { kind: "projectless_task", placement: "local", settings: { mode: "isolated_workspace" as const } },
    { kind: "projectless_task", placement: "sandbox", settings: { mode: "isolated_workspace" as const } },
    { kind: "projectless_chat", placement: "local", settings: { mode: "isolated_workspace" as const } },
    { kind: "projectless_chat", placement: "sandbox", settings: { mode: "isolated_workspace" as const } },
    { kind: "projectless_chat", placement: "local", settings: null },
    { kind: "projectless_chat", placement: "sandbox", settings: null },
    { kind: "repo_free_project_task", placement: "local", settings: null },
    { kind: "repo_free_project_task", placement: "sandbox", settings: null },
  ] as const)(
    "runs $kind on $placement in a company with no repository when isolated workspaces by default is enabled (settings: $settings)",
    async ({ kind, placement, settings }) => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const projectId = kind === "repo_free_project_task" ? randomUUID() : null;
      await instanceSettingsService(db).updateExperimental({
        enableIsolatedWorkspaces: true,
        enableIsolatedWorkspacesByDefault: true,
      });
      await db.insert(companies).values({
        id: companyId,
        name: "No-repo company",
        issuePrefix: `NR${companyId.slice(0, 5).toUpperCase()}`,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: "responsible-user",
        status: "active",
        membershipRole: "owner",
      });
      if (projectId) {
        await db.insert(projects).values({
          id: projectId,
          companyId,
          name: "Docs project without repo",
          executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace" },
        });
      }
      const environmentId = placement === "sandbox" ? randomUUID() : null;
      if (environmentId) {
        await db.insert(environments).values({
          id: environmentId,
          name: `Cloud sandbox ${companyId}`,
          driver: "sandbox",
          status: "active",
          config: { provider: "fake", image: "fake:test" },
        });
      }
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "General worker",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        defaultEnvironmentId: environmentId,
        permissions: {},
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        status: "active",
        membershipRole: "member",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        projectId,
        projectWorkspaceId: null,
        title: kind === "projectless_chat" ? "Chat with General worker" : "No-repo isolated task",
        status: kind === "projectless_chat" ? "in_review" : "todo",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
        ...(kind === "projectless_chat"
          ? {
              conversationAgentId: agentId,
              conversationUserId: "responsible-user",
              conversationState: "waiting",
            }
          : {}),
        executionWorkspaceSettings: settings,
      });

      const driver = placement === "sandbox"
        ? heartbeatService(db, {
            environmentRuntime: {
              ...environmentRuntimeService(db),
              execute: async (input) => ({
                exitCode: 0,
                stdout: execFileSync(input.command, input.args ?? [], {
                  cwd: root,
                  input: input.stdin,
                  encoding: "utf8",
                  env: { ...process.env, ...input.env },
                }),
                stderr: "",
                signal: null,
                timedOut: false,
              }),
            },
          })
        : heartbeat;

      const expectIsolated = settings?.mode === "isolated_workspace" || kind === "repo_free_project_task";

      for (let turn = 0; turn < 2; turn += 1) {
        if (turn === 1 && kind !== "projectless_chat") {
          await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
        }
        let wakeOptions: Parameters<typeof driver.wakeup>[1] = {
          source: "on_demand",
          triggerDetail: "manual",
          contextSnapshot: { issueId },
        };
        if (kind === "projectless_chat") {
          const comment = await issueService(db).addComment(issueId, `Chat turn ${turn + 1}`, {
            userId: "responsible-user",
          });
          wakeOptions = {
            source: "assignment",
            triggerDetail: "system",
            reason: "issue_commented",
            requestedByActorType: "user",
            requestedByActorId: "responsible-user",
            payload: { issueId, commentId: comment.id },
            contextSnapshot: {
              issueId,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "issue_commented",
            },
          };
        }
        const run = await driver.wakeup(agentId, wakeOptions);
        expect(run).not.toBeNull();
        await vi.waitFor(
          async () => expect((await driver.getRun(run!.id))?.status).toMatch(/^(succeeded|failed)$/),
          { timeout: 15_000 },
        );
        await drainHeartbeatRunsToQuiescence(db, driver);
        expect(await driver.getRun(run!.id)).toMatchObject({ status: "succeeded", errorCode: null });

        const expectedDir = path.join(
          await realpath(resolvePaperclipInstanceRoot()),
          "isolated-workspaces",
          companyId,
          issueId,
        );
        const calls = execute.mock.calls.filter(([input]) => input.runId === run!.id);
        expect(calls).toHaveLength(1);
        expect(calls[0][0].context.paperclipEnvironment.driver).toBe(placement);
        expect(await realpath(calls[0][0].context.paperclipWorkspace.cwd)).toBe(expectedDir);
        expect(calls[0][0].context.paperclipWorkspace.strategy).toBe("project_primary");
        if (expectIsolated) {
          expect(calls[0][0].context.paperclipWorkspace.mode).toBe("isolated_workspace");
        }
      }

      const expectedDir = path.join(
        await realpath(resolvePaperclipInstanceRoot()),
        "isolated-workspaces",
        companyId,
        issueId,
      );
      const [bound] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(bound.status).not.toBe("blocked");
      expect(bound.executionWorkspaceId).toBeTruthy();
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, bound.executionWorkspaceId!));
      expect(workspace).toMatchObject({
        mode: expectIsolated ? "isolated_workspace" : "shared_workspace",
        strategyType: "project_primary",
        providerType: "local_fs",
        sourceIssueId: issueId,
      });
      expect(await realpath(workspace.cwd!)).toBe(expectedDir);
    },
    30_000,
  );

  it("still uses git_worktree for git-backed projects under default isolation and still blocks explicit projectless git_worktree", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceId = randomUUID();
    const agentId = randomUUID();
    const gitIssueId = randomUUID();
    const explicitWorktreeIssueId = randomUUID();
    await instanceSettingsService(db).updateExperimental({
      enableIsolatedWorkspaces: true,
      enableIsolatedWorkspacesByDefault: true,
    });
    const repoCwd = path.join(root, companyId, "git-project");
    await mkdir(repoCwd, { recursive: true });
    await writeFile(path.join(repoCwd, "README.md"), "# repo\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repoCwd, stdio: "ignore" });
    git("init", "-b", "main");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "init");

    await db.insert(companies).values({
      id: companyId,
      name: "Git regression company",
      issuePrefix: `GR${companyId.slice(0, 5).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Git project" });
    await db.insert(projectWorkspaces).values({
      id: sourceId,
      companyId,
      projectId,
      name: "Primary repo",
      sourceType: "local_path",
      cwd: repoCwd,
      isPrimary: true,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Repo worker",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(issues).values([
      {
        id: gitIssueId,
        companyId,
        projectId,
        projectWorkspaceId: sourceId,
        title: "Git project task",
        status: "todo",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
        issueNumber: 1,
        identifier: `GR-1`,
      },
      {
        id: explicitWorktreeIssueId,
        companyId,
        projectId: null,
        projectWorkspaceId: null,
        title: "Explicit git worktree without project",
        status: "todo",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
        issueNumber: 2,
        identifier: `GR-2`,
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
        },
      },
    ]);

    const gitRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId: gitIssueId },
    });
    expect(gitRun).not.toBeNull();
    await vi.waitFor(
      async () => expect((await heartbeat.getRun(gitRun!.id))?.status).toMatch(/^(succeeded|failed)$/),
      { timeout: 15_000 },
    );
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await heartbeat.getRun(gitRun!.id)).toMatchObject({ status: "succeeded", errorCode: null });
    const gitCalls = execute.mock.calls.filter(([input]) => input.runId === gitRun!.id);
    expect(gitCalls).toHaveLength(1);
    const gitWorkspace = gitCalls[0][0].context.paperclipWorkspace;
    expect(gitWorkspace.mode).toBe("isolated_workspace");
    expect(gitWorkspace.strategy).toBe("git_worktree");
    expect(
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: gitWorkspace.cwd, encoding: "utf8" }).trim(),
    ).toBe("true");

    const blockedRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId: explicitWorktreeIssueId },
    });
    expect(blockedRun).toBeNull();
    const [blockedIssue] = await db.select().from(issues).where(eq(issues.id, explicitWorktreeIssueId));
    expect(blockedIssue.status).toBe("blocked");

    const sshEnvId = randomUUID();
    const sshAgentId = randomUUID();
    const sshIssueId = randomUUID();
    await db.insert(environments).values({
      id: sshEnvId,
      name: `SSH env ${companyId.slice(0, 6)}`,
      driver: "ssh",
      status: "active",
      config: { host: "fixture.invalid", port: 22, username: "fixture", remoteWorkspacePath: "/home/fixture/work" },
    });
    await db.insert(agents).values({
      id: sshAgentId,
      companyId,
      name: "SSH worker",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      defaultEnvironmentId: sshEnvId,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: sshAgentId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(issues).values({
      id: sshIssueId,
      companyId,
      projectId: null,
      projectWorkspaceId: null,
      title: "Projectless SSH isolated task",
      status: "todo",
      assigneeAgentId: sshAgentId,
      responsibleUserId: "responsible-user",
      issueNumber: 3,
      identifier: `GR-3`,
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
    const sshBlockedRun = await heartbeat.wakeup(sshAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId: sshIssueId },
    });
    expect(sshBlockedRun).toBeNull();
    const [sshBlockedIssue] = await db.select().from(issues).where(eq(issues.id, sshIssueId));
    expect(sshBlockedIssue.status).toBe("blocked");

    const sandboxEnvId = randomUUID();
    const lowTrustSandboxIssueId = randomUUID();
    await db.insert(environments).values({
      id: sandboxEnvId,
      name: `Low-trust sandbox ${companyId.slice(0, 6)}`,
      driver: "sandbox",
      status: "active",
      config: { provider: "fake", image: "fake:test" },
    });
    await db.insert(issues).values({
      id: lowTrustSandboxIssueId,
      companyId,
      projectId: null,
      projectWorkspaceId: null,
      title: "Low-trust projectless sandbox task on SSH-default agent",
      status: "todo",
      assigneeAgentId: sshAgentId,
      responsibleUserId: "responsible-user",
      issueNumber: 4,
      identifier: `GR-4`,
      executionPolicy: {
        trustPreset: "low_trust_review",
        authorizationPolicy: {
          trustPreset: "low_trust_review",
          trustBoundary: { mode: "low_trust_review", companyId, issueIds: [lowTrustSandboxIssueId] },
        },
      },
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId: sandboxEnvId,
      },
    });
    const sandboxHeartbeat = heartbeatService(db, {
      environmentRuntime: {
        ...environmentRuntimeService(db),
        execute: async (input) => ({
          exitCode: 0,
          stdout: execFileSync(input.command, input.args ?? [], {
            cwd: root,
            input: input.stdin,
            encoding: "utf8",
            env: { ...process.env, ...input.env },
          }),
          stderr: "",
          signal: null,
          timedOut: false,
        }),
      },
    });
    const lowTrustRun = await sandboxHeartbeat.wakeup(sshAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId: lowTrustSandboxIssueId },
    });
    expect(lowTrustRun).not.toBeNull();
    await vi.waitFor(
      async () => expect((await sandboxHeartbeat.getRun(lowTrustRun!.id))?.status).toMatch(/^(succeeded|failed)$/),
      { timeout: 15_000 },
    );
    await drainHeartbeatRunsToQuiescence(db, sandboxHeartbeat);
    expect(await sandboxHeartbeat.getRun(lowTrustRun!.id)).toMatchObject({ status: "succeeded", errorCode: null });
    const lowTrustCalls = execute.mock.calls.filter(([input]) => input.runId === lowTrustRun!.id);
    expect(lowTrustCalls).toHaveLength(1);
    expect(lowTrustCalls[0][0].context.paperclipEnvironment.driver).toBe("sandbox");
    expect(lowTrustCalls[0][0].context.paperclipWorkspace.strategy).toBe("project_primary");
    const [lowTrustIssue] = await db.select().from(issues).where(eq(issues.id, lowTrustSandboxIssueId));
    expect(lowTrustIssue.status).not.toBe("blocked");

    const otherTaskId = randomUUID();
    const archivedWorkspaceId = randomUUID();
    const archivedBindingIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherTaskId,
      companyId,
      projectId: null,
      projectWorkspaceId: null,
      title: "Other task with archived directory",
      status: "done",
      responsibleUserId: "responsible-user",
      issueNumber: 5,
      identifier: `GR-5`,
    });
    await db.insert(executionWorkspaces).values({
      id: archivedWorkspaceId,
      companyId,
      sourceIssueId: otherTaskId,
      mode: "isolated_workspace",
      strategyType: "project_primary",
      providerType: "local_fs",
      name: "Archived other-task directory",
      status: "archived",
      cleanupReason: "issue_terminal_done",
      cwd: path.join(root, companyId, "archived-other-task"),
    });
    await db.insert(issues).values({
      id: archivedBindingIssueId,
      companyId,
      projectId: null,
      projectWorkspaceId: null,
      executionWorkspaceId: archivedWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      title: "Projectless task bound to another task's archived workspace",
      status: "todo",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 6,
      identifier: `GR-6`,
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
    const archivedBlockedRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId: archivedBindingIssueId },
    });
    expect(archivedBlockedRun).toBeNull();
    const [archivedBlockedIssue] = await db.select().from(issues).where(eq(issues.id, archivedBindingIssueId));
    expect(archivedBlockedIssue.status).toBe("blocked");

    const ownArchivedIssueId = randomUUID();
    const ownArchivedWorkspaceId = randomUUID();
    const ownArchivedCwd = path.join(
      await realpath(resolvePaperclipInstanceRoot()),
      "isolated-workspaces",
      companyId,
      ownArchivedIssueId,
    );
    await mkdir(ownArchivedCwd, { recursive: true });
    await db.insert(issues).values({
      id: ownArchivedIssueId,
      companyId,
      projectId: null,
      projectWorkspaceId: null,
      title: "Projectless task reopening its own archived directory",
      status: "todo",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 7,
      identifier: `GR-7`,
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
    await db.insert(executionWorkspaces).values({
      id: ownArchivedWorkspaceId,
      companyId,
      sourceIssueId: ownArchivedIssueId,
      mode: "isolated_workspace",
      strategyType: "project_primary",
      providerType: "local_fs",
      name: "Own archived directory",
      status: "archived",
      cleanupReason: "issue_terminal_done",
      cwd: ownArchivedCwd,
    });
    await db.update(issues).set({
      executionWorkspaceId: ownArchivedWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    }).where(eq(issues.id, ownArchivedIssueId));
    const ownArchivedRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId: ownArchivedIssueId },
    });
    expect(ownArchivedRun).not.toBeNull();
    await vi.waitFor(
      async () => expect((await heartbeat.getRun(ownArchivedRun!.id))?.status).toMatch(/^(succeeded|failed)$/),
      { timeout: 15_000 },
    );
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await heartbeat.getRun(ownArchivedRun!.id)).toMatchObject({ status: "succeeded", errorCode: null });
    const [reopenedIssue] = await db.select().from(issues).where(eq(issues.id, ownArchivedIssueId));
    expect(reopenedIssue.status).not.toBe("blocked");
  }, 30_000);

});
