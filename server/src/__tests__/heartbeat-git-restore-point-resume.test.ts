import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  executionWorkspaceRestorePoints,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { materializeIsolatedRemoteWorkspaceSource } from "../services/isolated-remote-workspace-source.js";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.js";
import { expireReconstructableGitWorkspace } from "../services/git-workspace-expiration.js";
import { getStorageService } from "../storage/index.js";

const adapterExecute = vi.hoisted(() => vi.fn(async (_input?: unknown) => ({
  exitCode: 0, signal: null, timedOut: false, summary: "Resumed restored work.", provider: "test", model: "test-model",
})));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
const DAY_MS = 24 * 60 * 60 * 1000;

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("heartbeat resume of an idle-expired workspace", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("heartbeat-git-restore-point-resume-");
    db = createDb(database.connectionString);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-heartbeat-restore-point-")));
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    adapterExecute.mockClear();
    await db.delete(executionWorkspaceRestorePoints);
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db.delete(authUsers).where(eq(authUsers.id, "responsible-user"));
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await db.$client.end();
    await database.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }, 60_000);

  async function seed() {
    const home = path.join(root, randomUUID());
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const workspaceId = randomUUID(), runId = randomUUID(), wakeupId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const location = path.join(home, "repos"), author = path.join(location, "author"), remote = path.join(location, "remote.git");
    await fs.mkdir(author, { recursive: true });
    git(author, "init", "--initial-branch=main");
    await fs.writeFile(path.join(author, "marker.txt"), "commit A\n");
    git(author, "add", "."); git(author, "commit", "-m", "A");
    git(location, "clone", "--bare", author, remote);
    const repoUrl = pathToFileURL(remote).href;
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(companies).values({ id: companyId, name: "Restore point resume", issuePrefix, status: "active", defaultResponsibleUserId: "responsible-user" });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Resumed project", status: "active",
      executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace", workspaceStrategy: { type: "git_worktree", baseRef: "origin/main" } } });
    await db.insert(agents).values({ id: agentId, companyId, name: "Resumer", role: "engineer", status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    const idleSince = new Date(Date.now() - 8 * DAY_MS);
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Stalled work", status: "in_progress", workMode: "standard",
      assigneeAgentId: agentId, responsibleUserId: "responsible-user", issueNumber: 1, identifier: `${issuePrefix}-1`,
      executionWorkspaceSettings: { mode: "isolated_workspace" }, updatedAt: idleSince });
    const baseCwd = await materializeIsolatedRemoteWorkspaceSource({ companyId, issueId, repoUrl, resolveGitAuth: async () => null });
    const realized = await realizeExecutionWorkspace({
      base: { baseCwd, source: "task_session", projectId, workspaceId: null, repoUrl, repoRef: "origin/main" },
      issue: { id: issueId, identifier: `${issuePrefix}-1`, title: "Stalled work" }, agent: { id: agentId, name: "Resumer", companyId },
      config: { workspaceStrategy: { type: "git_worktree", branchTemplate: "stalled-task", baseRef: "origin/main" } }, skipHostProvision: true,
    });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, sourceIssueId: issueId, mode: "isolated_workspace",
      strategyType: "git_worktree", name: "Stalled work", status: "active", providerType: "git_worktree", cwd: realized.cwd, providerRef: realized.cwd,
      repoUrl, baseRef: "origin/main", branchName: realized.branchName,
      metadata: { createdByRuntime: realized.branchCreatedByRuntime, gitBranchOwnershipVersion: 1, baseRefSha: realized.baseRefSha,
        isolatedRemoteSource: { schema: "paperclip.isolated-remote-source.v1", companyId, issueId, repoUrl } } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId, executionWorkspacePreference: "reuse_existing", updatedAt: idleSince })
      .where(eq(issues.id, issueId));
    await fs.writeFile(path.join(realized.cwd, "marker.txt"), "commit B (unpushed)\n");
    git(realized.cwd, "commit", "-qam", "B");
    const unpushed = git(realized.cwd, "rev-parse", "HEAD");
    await fs.writeFile(path.join(realized.cwd, "notes.md"), "uncommitted notes\n");
    const workspace = () => db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId)).then(rows => rows[0]!);
    const expiration = await expireReconstructableGitWorkspace(db, await workspace(), {
      dryRun: false, expireBase: false, now: new Date(), idleCutoff: new Date(Date.now() - 7 * DAY_MS),
      restorePoint: { storage: getStorageService(), notBefore: new Date(Date.now() - DAY_MS), keyDurable: true },
    });
    const queueRun = async () => {
      await db.insert(agentWakeupRequests).values({ id: wakeupId, companyId, agentId, source: "assignment", triggerDetail: "system",
        reason: "issue_assigned", payload: { issueId }, status: "queued", runId });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system", status: "queued",
        wakeupRequestId: wakeupId, responsibleUserId: "responsible-user", contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" } });
      await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId, executionAgentNameKey: "resumer", executionLockedAt: new Date() })
        .where(eq(issues.id, issueId));
    };
    return { issueId, workspaceId, runId, cwd: realized.cwd, unpushed, expiration, workspace, queueRun };
  }

  async function waitForRun(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && run.status !== "queued" && run.status !== "running") return run;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return heartbeat.getRun(runId);
  }

  it("restores the expired workspace and runs the agent in it", async () => {
    const seeded = await seed();
    expect(seeded.expiration).toMatchObject({ expired: true, restorePoint: true });
    await expect(fs.access(seeded.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    await seeded.queueRun();
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    const run = await waitForRun(heartbeat, seeded.runId);
    await heartbeat.waitForRunExecutionDrain(seeded.runId);
    expect(run).toMatchObject({ status: "succeeded" });
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    expect(adapterExecute.mock.calls[0]?.[0]).toMatchObject({ context: { executionWorkspaceId: seeded.workspaceId,
      paperclipWorkspace: { cwd: seeded.cwd } } });
    expect(git(seeded.cwd, "rev-parse", "HEAD")).toBe(seeded.unpushed);
    expect(await fs.readFile(path.join(seeded.cwd, "notes.md"), "utf8")).toBe("uncommitted notes\n");
    const workspace = await seeded.workspace();
    expect(workspace.status).not.toBe("archived");
    expect(workspace.metadata?.reopenPendingConsumption).toBeUndefined();
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue.executionWorkspaceId).toBe(seeded.workspaceId);
  });
});
