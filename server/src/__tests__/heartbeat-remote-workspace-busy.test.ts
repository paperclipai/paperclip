import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environmentLeases, environments, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { RemoteWorkspaceWriterActiveError } from "../services/remote-workspaces.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("inherited remote workspace heartbeat wait", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "heartbeat-remote-workspace-busy-"));
    database = await startEmbeddedPostgresTestDatabase("heartbeat-remote-workspace-busy-");
    db = createDb(database.connectionString);
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("DATABASE_URL", database.connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "71".repeat(32));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
    vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", "unused-reservation-fixture");
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    heartbeat = heartbeatService(db);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    await db?.$client.end();
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it.each([
    { mode: "isolated_workspace", action: "Stop" },
    { mode: "operator_branch", action: "Stop" },
    { mode: "isolated_workspace", action: "reassignment" },
  ] as const)("persists a $mode writer wait and honors $action", async ({ mode, action }) => {
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Workspace owner", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Remote writer wait", issuePrefix: `W${randomUUID().slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
    const [environment] = await db.insert(environments).values({ name: `Remote wait ${randomUUID()}`,
      driver: "sandbox", status: "active", config: { provider: "daytona" } }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Native worker", status: "idle",
      adapterType: "paperclip_runner", defaultEnvironmentId: environment.id,
      adapterConfig: { provider: "codex", model: "gpt-6.1-sol" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } }).returning();
    const [parent] = await db.insert(issues).values({ companyId: company.id, title: "Running coordinator",
      status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: userId }).returning();
    const [writer] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      nativeIssueId: parent.id, runtimeMode: "native", status: "running", startedAt: new Date(), lastOutputAt: new Date() }).returning();
    const authority = { schema: "paperclip.remote-workspace.v1" as const, epoch: 3, snapshotId: randomUUID(),
      source: { kind: "empty" as const }, location: null, writerRunId: writer.id, dirty: true };
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: company.id, sourceIssueId: parent.id,
      name: "Inherited remote workspace", mode, strategyType: "project_primary", providerType: "cloud_sandbox",
      cwd: `/workspaces/${randomUUID()}`, metadata: { remoteWorkspace: authority } }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, parent.id));
    const [child] = await db.insert(issues).values({ companyId: company.id, parentId: parent.id,
      title: "Use the inherited files", status: "todo", assigneeAgentId: agent.id, responsibleUserId: userId,
      executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing", executionWorkspaceSettings: { mode } }).returning();
    const originalTransaction = db.transaction.bind(db);
    let reassignmentInjected = false;
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      try { return await originalTransaction(callback, config); }
      catch (error) {
        if (action === "reassignment" && error instanceof RemoteWorkspaceWriterActiveError) {
          const [replacement] = await db.insert(agents).values({ companyId: company.id,
            name: "New task owner", adapterType: "process" }).returning();
          await db.update(issues).set({ assigneeAgentId: replacement.id }).where(eq(issues.id, child.id));
          reassignmentInjected = true;
        }
        throw error;
      }
    });
    try {
      const run = await heartbeat.wakeup(agent.id, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        requestedByActorType: "user", requestedByActorId: userId, payload: { issueId: child.id }, contextSnapshot: { issueId: child.id } });
      expect(run).not.toBeNull();
      await heartbeat.drainActiveRunExecutions();
      const [deferred] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(deferred).toMatchObject({ status: "cancelled", errorCode: "workspace_busy",
        contextSnapshot: { workspaceBusyDeferredWhileAssignee: true },
        resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
          workspaceBusy: { executionWorkspaceId: workspace.id, holderRunId: writer.id } } });
      const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "workspace_busy" });
      const [bound] = await db.select().from(issues).where(eq(issues.id, child.id));
      expect(bound).toMatchObject({ executionRunId: retries[0].id, executionWorkspaceId: workspace.id });
      expect(bound.status).not.toBe("blocked");
      expect((await db.select().from(environmentLeases)).filter(lease => lease.heartbeatRunId === run!.id)).toEqual([]);
      expect(readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, workspace.id)))[0].metadata)).toEqual(authority);
      if (action === "Stop") await heartbeat.cancelRun(retries[0].id);
      expect((await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 5 * 60_000))).runIds).not.toContain(retries[0].id);
      if (action === "reassignment") {
        expect(reassignmentInjected).toBe(true);
        expect(await heartbeat.getRun(retries[0].id)).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
      }
    } finally { transactionSpy.mockRestore(); }
  });

  // A failed writer's final save runs after the run is terminal (system workspace
  // recovery). An immediate continuation must wait for that save instead of
  // failing setup and stranding the task.
  it.each([
    { name: "a recently failed writer whose save is still pending", finishedAgoMs: 0, recovery: null, expected: "deferred" },
    { name: "a failed writer whose recovery is actively saving", finishedAgoMs: 2 * 60 * 60_000, recovery: "running", expected: "deferred" },
    { name: "a failed writer whose recovery is exhausted", finishedAgoMs: 0, recovery: "exhausted", expected: "failed" },
    { name: "a failed writer silent past the holder cutoff", finishedAgoMs: 2 * 60 * 60_000, recovery: null, expected: "failed" },
  ] as const)("handles $name", async ({ finishedAgoMs, recovery, expected }) => {
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Workspace owner", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Remote save wait", issuePrefix: `S${randomUUID().slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
    const [environment] = await db.insert(environments).values({ name: `Remote save ${randomUUID()}`,
      driver: "sandbox", status: "active", config: { provider: "daytona" } }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Native worker", status: "idle",
      adapterType: "paperclip_runner", defaultEnvironmentId: environment.id,
      adapterConfig: { provider: "codex", model: "gpt-6.1-sol" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Continue after a failed turn",
      status: "todo", assigneeAgentId: agent.id, responsibleUserId: userId }).returning();
    const finishedAt = new Date(Date.now() - finishedAgoMs);
    const startedAt = new Date(finishedAt.getTime() - 60_000);
    const [writer] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      nativeIssueId: issue.id, runtimeMode: "native", status: "failed", errorCode: "adapter_failed",
      startedAt, finishedAt, lastOutputAt: startedAt, createdAt: startedAt }).returning();
    const authority = { schema: "paperclip.remote-workspace.v1" as const, epoch: 2, snapshotId: randomUUID(),
      source: { kind: "empty" as const }, location: null, writerRunId: writer.id, dirty: true };
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: company.id, sourceIssueId: issue.id,
      name: "Task remote workspace", mode: "isolated_workspace", strategyType: "project_primary", providerType: "cloud_sandbox",
      cwd: `/workspaces/${randomUUID()}`, metadata: { remoteWorkspace: authority } }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" } }).where(eq(issues.id, issue.id));
    if (recovery) await db.insert(issueRecoveryActions).values({ companyId: company.id, sourceIssueId: issue.id,
      kind: "active_run_watchdog", status: recovery === "exhausted" ? "escalated" : "active", cause: "run_failed",
      fingerprint: `save-${writer.id}`, nextAction: "preserve_files", updatedAt: new Date(),
      evidence: { runId: writer.id, systemRecovery: { schema: "paperclip.system-recovery.v1", policyVersion: 1,
        sourceRunId: writer.id, revision: 2, generationId: randomUUID(), intentId: null, phase: "preserve_files",
        state: recovery, attemptId: null, attempts: 1, retriesUsed: recovery === "exhausted" ? 5 : 0,
        firstFailureAt: null, nextAttemptAt: null, deadlineAt: null, providerCooldownAt: null, failure: null,
        preservationOperationIds: [], freshAttemptRunId: null } } });
    const run = await heartbeat.wakeup(agent.id, { source: "on_demand", triggerDetail: "manual", reason: "manual",
      requestedByActorType: "user", requestedByActorId: userId, payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id } });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    if (expected === "deferred") {
      expect(settled).toMatchObject({ status: "cancelled", errorCode: "workspace_busy",
        error: expect.stringContaining("is still saving its work"),
        resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
          workspaceBusy: { executionWorkspaceId: workspace.id, holderRunId: writer.id } } });
      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "workspace_busy" });
      const [waiting] = await db.select().from(issues).where(eq(issues.id, issue.id));
      expect(waiting).toMatchObject({ executionRunId: retries[0].id });
      expect(waiting.status).not.toBe("blocked");
      await heartbeat.cancelRun(retries[0].id);
    } else {
      expect(settled).toMatchObject({ status: "failed", errorCode: "setup_failed",
        error: "The workspace still has an unfinished writer or save operation." });
      expect(retries.filter(retry => retry.scheduledRetryReason === "workspace_busy")).toEqual([]);
    }
    expect((await db.select().from(environmentLeases)).filter(lease => lease.heartbeatRunId === run!.id)).toEqual([]);
    expect(readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspace.id)))[0].metadata)).toEqual(authority);
  });
});
