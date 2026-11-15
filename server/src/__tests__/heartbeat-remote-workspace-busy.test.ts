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
    // An unrelated task that explicitly shares the running task's workspace. A
    // child bound this way would get its own workspace at admission instead.
    const [child] = await db.insert(issues).values({ companyId: company.id,
      title: "Use the shared files", status: "todo", assigneeAgentId: agent.id, responsibleUserId: userId,
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

  async function terminalWriterFixture(finishedAt: Date) {
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Workspace owner", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Settling writer", issuePrefix: `S${randomUUID().slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
    const [environment] = await db.insert(environments).values({ name: `Settling ${randomUUID()}`,
      driver: "sandbox", status: "active", config: { provider: "daytona" } }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Native worker", status: "idle",
      adapterType: "paperclip_runner", defaultEnvironmentId: environment.id,
      adapterConfig: { provider: "codex", model: "gpt-6.1-sol" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Continue after a failed save",
      status: "todo", assigneeAgentId: agent.id, responsibleUserId: userId }).returning();
    // The previous run on this task ended, but its workspace save and sandbox
    // release have not settled: the writer hold and unsaved files remain.
    const [writer] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      nativeIssueId: issue.id, runtimeMode: "native", status: "failed", errorCode: "provider_transport_failed",
      startedAt: new Date(finishedAt.getTime() - 60_000), lastOutputAt: new Date(finishedAt.getTime() - 30_000),
      finishedAt }).returning();
    const authority = { schema: "paperclip.remote-workspace.v1" as const, epoch: 5, snapshotId: randomUUID(),
      source: { kind: "empty" as const }, location: null, writerRunId: writer.id, dirty: true };
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: company.id, sourceIssueId: issue.id,
      name: "Task workspace", mode: "isolated_workspace", strategyType: "project_primary", providerType: "cloud_sandbox",
      cwd: `/workspaces/${randomUUID()}`, metadata: { remoteWorkspace: authority } }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" } }).where(eq(issues.id, issue.id));
    const run = await heartbeat.wakeup(agent.id, { source: "on_demand", triggerDetail: "manual", reason: "manual",
      requestedByActorType: "user", requestedByActorId: userId, payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id } });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    const [current] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id));
    return { run: settled, writer, workspace, authority, current };
  }

  it("waits for a writer that just ended while its save or sandbox release settles", async () => {
    const f = await terminalWriterFixture(new Date());
    expect(f.run).toMatchObject({ status: "cancelled", errorCode: "workspace_busy",
      error: expect.stringContaining("ended, but its workspace save has not settled"),
      resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
        workspaceBusy: { executionWorkspaceId: f.workspace.id, holderRunId: f.writer.id } } });
    const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.run.id));
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "workspace_busy" });
    // Waiting never takes over or discards the unsaved writer's files.
    expect(readRemoteWorkspaceAuthority(f.current.metadata)).toEqual(f.authority);
  });

  async function workspaceBusyRunIds(companyId: string) {
    return (await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
      .filter(row => row.status === "cancelled" && row.errorCode === "workspace_busy").map(row => row.id);
  }

  it("parks one waiter while an ended writer's save settles, then admits it once the hold releases", async () => {
    // A task reassigned mid-run: the stopped writer ended, but its save has
    // not settled. The waiter must stay one parked retry, not a new run per check.
    const f = await terminalWriterFixture(new Date());
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.run.id));
    expect(retry).toMatchObject({ status: "scheduled_retry", contextSnapshot: { workspaceBusyWait: {
      key: `execution:${f.workspace.id}`, holderRunId: f.writer.id } } });
    let checkAt = new Date(retry.scheduledRetryAt!.getTime() + 1_000);
    for (let check = 0; check < 3; check += 1) {
      expect((await heartbeat.promoteDueScheduledRetries(checkAt)).runIds).not.toContain(retry.id);
      const parked = await heartbeat.getRun(retry.id);
      expect(parked?.status).toBe("scheduled_retry");
      const recheckAt = new Date(parked!.scheduledRetryAt!);
      expect(recheckAt.getTime()).toBeGreaterThan(checkAt.getTime());
      // Bounded by the holder cutoff measured from the writer's end.
      expect(recheckAt.getTime()).toBeLessThanOrEqual(f.writer.finishedAt!.getTime() + 60 * 60_000 + 1_000);
      checkAt = new Date(recheckAt.getTime() + 1_000);
    }
    expect(await workspaceBusyRunIds(f.run.companyId)).toEqual([f.run.id]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, retry.id))).toEqual([]);

    // The save settles: the writer hold is released.
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...f.authority, writerRunId: null, dirty: false } } })
      .where(eq(executionWorkspaces.id, f.workspace.id));
    expect((await heartbeat.promoteDueScheduledRetries(checkAt)).runIds).toContain(retry.id);
    await heartbeat.cancelRun(retry.id);
    await heartbeat.drainActiveRunExecutions();
    expect(await workspaceBusyRunIds(f.run.companyId)).toEqual([f.run.id]);
  });

  it("stops parking behind an ended writer once its unsettled save reaches the holder cutoff", async () => {
    const f = await terminalWriterFixture(new Date(Date.now() - 58 * 60_000));
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.run.id));
    expect(retry?.status).toBe("scheduled_retry");
    const cutoff = f.writer.finishedAt!.getTime() + 60 * 60_000;
    if (retry.scheduledRetryAt!.getTime() < cutoff) {
      expect((await heartbeat.promoteDueScheduledRetries(new Date(retry.scheduledRetryAt!.getTime() + 1))).runIds)
        .not.toContain(retry.id);
    }
    expect((await heartbeat.promoteDueScheduledRetries(new Date(cutoff + 2_000))).runIds).toContain(retry.id);
    await heartbeat.cancelRun(retry.id);
    await heartbeat.drainActiveRunExecutions();
  });

  // A writer stopped by reassignment whose retained files Paperclip is still
  // saving (an in-progress workspace recovery) is still settling, even after the
  // one-hour cutoff from its end. A waiter already parked for it stays parked
  // instead of being released into a setup failure; the save's own retry budget
  // bounds the wait. A finished or board-handed-off save no longer extends it.
  it.each([
    { state: undefined, waits: true },
    { state: "scheduled", waits: true },
    { state: "awaiting_evidence", waits: true },
    { state: "exhausted", waits: false },
    { state: "complete", waits: false },
  ] as const)("keeps a waiter parked while an ended writer's save is in progress ($state)", async ({ state, waits }) => {
    const f = await terminalWriterFixture(new Date());
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.run.id));
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "workspace_busy" });
    // The writer ended over an hour ago; its save recovery recorded progress a minute ago.
    const endedAt = new Date(Date.now() - 2 * 60 * 60_000);
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_reassigned", finishedAt: endedAt,
      startedAt: new Date(endedAt.getTime() - 60_000), lastOutputAt: endedAt }).where(eq(heartbeatRuns.id, f.writer.id));
    await db.insert(issueRecoveryActions).values({ companyId: f.run.companyId, sourceIssueId: f.workspace.sourceIssueId!,
      kind: "active_run_watchdog", status: "resolved", outcome: "blocked", ownerType: "board",
      cause: "native_continuation_requires_reconciliation", fingerprint: `native-workspace:${f.writer.id}`,
      resolvedAt: new Date(), updatedAt: new Date(Date.now() - 60_000), nextAction: "Save the retained files.",
      evidence: { runId: f.writer.id, workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [randomUUID()] },
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: f.writer.id, replay: "blocked" },
        ...(state ? { systemRecovery: { state } } : {}) } });
    const checkAt = new Date(retry.scheduledRetryAt!.getTime() + 1_000);
    const promoted = (await heartbeat.promoteDueScheduledRetries(checkAt)).runIds;
    if (waits) {
      expect(promoted).not.toContain(retry.id);
      const parked = await heartbeat.getRun(retry.id);
      expect(parked?.status).toBe("scheduled_retry");
      // Bounded by the cutoff measured from the save's last progress.
      expect(new Date(parked!.scheduledRetryAt!).getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
    } else expect(promoted).toContain(retry.id);
    await heartbeat.cancelRun(retry.id);
    await heartbeat.drainActiveRunExecutions();
    // Waiting never takes over or discards the unsaved writer's files.
    expect(readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, f.workspace.id)))[0].metadata)).toEqual(f.authority);
  });

  it("stops waiting for an ended writer whose save stayed unsettled past the holder cutoff", async () => {
    const f = await terminalWriterFixture(new Date(Date.now() - 2 * 60 * 60_000));
    expect(f.run).toMatchObject({ status: "failed", error: "The workspace still has an unfinished writer or save operation." });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.run.id))).toEqual([]);
    expect(readRemoteWorkspaceAuthority(f.current.metadata)).toEqual(f.authority);
  });
});
