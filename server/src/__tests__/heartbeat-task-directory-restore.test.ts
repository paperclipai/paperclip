import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { materializeIsolatedTaskDirectory } from "../services/isolated-task-directory.js";
import { expireIsolatedTaskDirectory, readTaskDirectoryRetention } from "../services/isolated-task-directory-retention.js";
import { getStorageService } from "../storage/index.js";

const adapterExecute = vi.hoisted(() => vi.fn(async (_input?: unknown) => ({
  exitCode: 0, signal: null, timedOut: false, summary: "Resumed restored files.", provider: "test", model: "test-model",
})));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("heartbeat resume of a removed task directory", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("heartbeat-task-directory-restore-");
    db = createDb(database.connectionString);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-heartbeat-task-directory-")));
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

  async function waitForRun(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && run.status !== "queued" && run.status !== "running") return run;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return heartbeat.getRun(runId);
  }

  it("restores a removed task directory before the run uses it", async () => {
    const mode = "shared_workspace";
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, randomUUID()));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
    const runId = randomUUID(), wakeupId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Task directory resume", issuePrefix, status: "active", defaultResponsibleUserId: "responsible-user" });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Resumer", role: "engineer", status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Finished files", status: "done", workMode: "standard",
      assigneeAgentId: agentId, responsibleUserId: "responsible-user", issueNumber: 1, identifier: `${issuePrefix}-1`,
      completedAt: new Date(Date.now() - 4 * DAY_MS) });
    const cwd = await materializeIsolatedTaskDirectory({ companyId, issueId });
    await fs.mkdir(path.join(cwd, "out"));
    await fs.writeFile(path.join(cwd, "out", "report.md"), "only copy of the report\n");
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId, mode, strategyType: "project_primary",
      name: "Finished files", status: "active", providerType: "local_fs", cwd, metadata: { source: "task_session", createdByRuntime: false } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId, executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode } }).where(eq(issues.id, issueId));
    const workspace = () => db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId)).then(rows => rows[0]!);
    expect(await expireIsolatedTaskDirectory(db, await workspace(), { dryRun: false, now: new Date(), notBefore: new Date(Date.now() - DAY_MS),
      restorePoint: { storage: getStorageService(), keyDurable: true } })).toMatchObject({ expired: true });
    await expect(fs.access(cwd)).rejects.toMatchObject({ code: "ENOENT" });

    await db.update(issues).set({ status: "in_progress", completedAt: null }).where(eq(issues.id, issueId));
    await db.insert(agentWakeupRequests).values({ id: wakeupId, companyId, agentId, source: "assignment", triggerDetail: "system",
      reason: "issue_assigned", payload: { issueId }, status: "queued", runId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system", status: "queued",
      wakeupRequestId: wakeupId, responsibleUserId: "responsible-user", contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" } });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId, executionAgentNameKey: "resumer", executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    const run = await waitForRun(heartbeat, runId);
    await heartbeat.waitForRunExecutionDrain(runId);
    expect(run).toMatchObject({ status: "succeeded" });
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    expect(adapterExecute.mock.calls[0]?.[0]).toMatchObject({ context: { executionWorkspaceId: workspaceId, paperclipWorkspace: { cwd } } });
    expect(await fs.readFile(path.join(cwd, "out", "report.md"), "utf8")).toBe("only copy of the report\n");
    const restored = await workspace();
    expect(restored.status).not.toBe("archived");
    expect(readTaskDirectoryRetention(restored)).toBeNull();
  });
});
