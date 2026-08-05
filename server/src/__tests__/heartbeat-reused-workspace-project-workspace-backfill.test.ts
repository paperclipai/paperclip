import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";

const execFileAsync = promisify(execFile);

const adapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  sessionParams: { sessionId: "fresh-session" },
  sessionDisplayId: "fresh-session",
  summary: "Reused workspace projectWorkspaceId backfill test run.",
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
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reused-workspace projectWorkspaceId backfill tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function runGit(cwd: string, args: string[]) {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function createGitRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-reuse-backfill-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["checkout", "-B", "master"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip-test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await writeFile(path.join(repoRoot, "README.md"), "reused workspace projectWorkspaceId backfill\n");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

// Regression coverage for RENA-54893: executionWorkspacesSvc.update()'s reuse
// path omitted projectWorkspaceId, so a persisted execution_workspaces row
// that carried projectWorkspaceId = null (e.g. an older row from before
// project linkage existed for this issue) stayed null forever across every
// subsequent reuse, even though resolvedProjectWorkspaceId was correctly
// resolved in the same run. assertGitSensitiveAdapterWorkspaceValid() then
// failed every such run with persisted_workspace_missing_project_workspace_id
// before the adapter ever started, with no auto-retry.
describeEmbeddedPostgres("heartbeat reused execution workspace projectWorkspaceId backfill", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reuse-workspace-backfill-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    adapterExecute.mockClear();
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(agentTaskSessions);
    await db.delete(executionWorkspaces);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  it("backfills projectWorkspaceId on a reused execution workspace that persisted with none (RENA-54893)", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const reusedExecutionWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      defaultResponsibleUserId: "responsible-user",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Reused Workspace Backfill",
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
    // Stands in for a historical row created before project linkage existed
    // for this issue: it is already persisted (so the "missing" workspace
    // class from RENA-54657/RENA-54683 does not apply), but its
    // projectWorkspaceId was never backfilled.
    await db.insert(executionWorkspaces).values({
      id: reusedExecutionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId: null,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reused shared workspace",
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
      title: "Reuse a persisted workspace missing its projectWorkspaceId",
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      identifier: "PAP-9500",
      executionWorkspaceId: reusedExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      createdAt: new Date(),
      updatedAt: new Date(),
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
        skipIssueComment: true,
      },
    });

    expect(run).not.toBeNull();
    const finished = await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).not.toBe("queued");
      expect(latest?.status).not.toBe("running");
      return latest;
    }, { timeout: 10_000 });

    expect(finished?.error ?? "").not.toMatch(/persisted execution workspace has no project workspace id/i);
    expect(finished?.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const refreshedRun = await db
      .select({ resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0]);
    expect(
      (refreshedRun?.resultJson as { workspaceValidation?: { reason?: string } } | null)
        ?.workspaceValidation?.reason,
    ).not.toBe("persisted_workspace_missing_project_workspace_id");

    const refreshedWorkspace = await db
      .select({ id: executionWorkspaces.id, projectWorkspaceId: executionWorkspaces.projectWorkspaceId })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, reusedExecutionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    expect(refreshedWorkspace?.projectWorkspaceId).toBe(projectWorkspaceId);
  }, 20_000);
});
