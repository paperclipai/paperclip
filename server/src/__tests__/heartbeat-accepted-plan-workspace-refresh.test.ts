import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq, ne } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentTaskSessions,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const execFileAsync = promisify(execFile);

const adapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  sessionParams: { sessionId: "fresh-session" },
  sessionDisplayId: "fresh-session",
  summary: "Accepted plan workspace refresh test run.",
  provider: "test",
  model: "test-model",
})));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres accepted-plan workspace refresh tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function createGitRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-accepted-plan-repo-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.email", "paperclip-test@example.com"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "Paperclip Test"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "README.md"), "accepted plan workspace refresh\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoRoot });
  return repoRoot;
}

describeEmbeddedPostgres("accepted plan workspace refresh", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-accepted-plan-workspace-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    adapterExecute.mockClear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 5) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  it("realizes an isolated workspace and drops stale shared task-session params before executing", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const sharedExecutionWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);

    await instanceSettingsService(db).updateExperimental({
      enableIsolatedWorkspaces: true,
    });
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Accepted Plan Workspace Refresh",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: repoRoot,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: sharedExecutionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Shared planning workspace",
      status: "active",
      cwd: repoRoot,
      providerType: "local_fs",
      providerRef: repoRoot,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Implement accepted plan",
      status: "in_progress",
      workMode: "planning",
      priority: "medium",
      assigneeAgentId: agentId,
      identifier: "PAP-9122",
      executionWorkspaceId: sharedExecutionWorkspaceId,
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: issueId,
      sessionParamsJson: {
        sessionId: "stale-shared-session",
        cwd: repoRoot,
        workspaceId: projectWorkspaceId,
      },
      sessionDisplayId: "stale-shared-session",
    });
    adapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionParams: { sessionId: "fresh-session" },
        sessionDisplayId: "fresh-session",
        summary: "Accepted plan workspace refresh test run.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        forceFreshSession: true,
        workspaceRefreshReason: "accepted_plan_confirmation",
      },
    });

    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).toBe("succeeded");
    }, { timeout: 10_000 });

    expect(adapterExecute).toHaveBeenCalledTimes(1);
    const adapterInput = adapterExecute.mock.calls[0]?.[0] as {
      runtime: { sessionId: string | null; sessionParams: Record<string, unknown> | null };
      context: Record<string, unknown>;
    };
    expect(adapterInput.runtime.sessionId).toBeNull();
    expect(adapterInput.runtime.sessionParams).toBeNull();
    expect(adapterInput.context.paperclipWorkspace).toEqual(expect.objectContaining({
      mode: "isolated_workspace",
      strategy: "git_worktree",
    }));
    expect((adapterInput.context.paperclipWorkspace as { cwd: string }).cwd).not.toBe(repoRoot);

    const refreshedIssue = await db
      .select({
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(refreshedIssue?.executionWorkspaceId).toBeTruthy();
    expect(refreshedIssue?.executionWorkspaceId).not.toBe(sharedExecutionWorkspaceId);
    expect(refreshedIssue?.executionWorkspaceSettings).toMatchObject({
      mode: "isolated_workspace",
    });

    const isolatedRows = await db
      .select()
      .from(executionWorkspaces)
      .where(ne(executionWorkspaces.id, sharedExecutionWorkspaceId));
    expect(isolatedRows).toHaveLength(1);
    expect(isolatedRows[0]).toMatchObject({
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      sourceIssueId: issueId,
    });
    expect(isolatedRows[0]?.cwd).not.toBe(repoRoot);
  }, 20_000);
});
