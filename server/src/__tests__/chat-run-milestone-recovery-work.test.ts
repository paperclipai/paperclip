import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chatPublications, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createChatMilestoneFixtures } from "./helpers/chat-milestone-fixtures.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { chatRunMilestoneWork } from "../services/chat-run-milestone-work.js";
import { recoveryService } from "../services/recovery/service.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_MILESTONE_RECOVERY_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("chat milestones after run recovery", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let fixtures: ReturnType<typeof createChatMilestoneFixtures>;
  let f: Awaited<ReturnType<typeof fixtures.create>>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("chat-recovery-milestones-");
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    fixtures = createChatMilestoneFixtures(db);
  }, 60_000);
  beforeEach(async () => {
    errors.length = 0; f = await fixtures.create();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; vi.useRealTimers(); vi.restoreAllMocks();
    await fixtures.cleanup(); expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function flush() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
  }
  async function quiet() {
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    try { await vi.advanceTimersByTimeAsync(120_000); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); }
    finally { reads.mockRestore(); writes.mockRestore(); }
  }
  const publications = () => db.select().from(chatPublications).where(eq(chatPublications.issueId, f.issueId));

  it.each(["process_gone", "issue_cancelled"] as const)("publishes the recovered terminal state after %s and becomes quiet", async reason => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      status: "running", runtimeMode: "legacy", responsibleUserId: f.userId,
      processPid: reason === "process_gone" ? 2_000_000_000 : process.pid,
      contextSnapshot: { issueId: f.issueId, source: "chat:slack", endpointId: f.endpointId, wakeCommentId: f.commentId },
    });
    await db.update(issues).set({ executionRunId: runId,
      status: reason === "issue_cancelled" ? "cancelled" : "in_progress",
    }).where(eq(issues.id, f.issueId));
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
    await chatRunMilestoneWork(db).register(coordinator, () => true).ready;
    await flush();
    expect(await publications()).toEqual([expect.objectContaining({ idempotencyKey: `run:${runId}:working:${f.endpointId}` })]);
    await quiet();

    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    expect(await recovery.sweepStaleIssueLocks()).toEqual({ cleared: 1, issueIds: [f.issueId], terminalizedRunIds: [runId] });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].status)
      .toBe(reason === "process_gone" ? "interrupted" : "cancelled");
    await flush();
    expect((await publications()).map(row => row.idempotencyKey).sort()).toEqual([
      `run:${runId}:failed:${f.endpointId}`, `run:${runId}:working:${f.endpointId}`,
    ].sort());
    await quiet();
    expect(await recovery.sweepStaleIssueLocks()).toEqual({ cleared: 0, issueIds: [], terminalizedRunIds: [] });
    await flush(); await quiet(); expect(await publications()).toHaveLength(2);
  });

  it("wakes an older failed run when recovery refreshes its quota classification", async () => {
    const runId = randomUUID(), old = new Date(Date.now() - 48 * 60 * 60_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      status: "failed", runtimeMode: "legacy", responsibleUserId: f.userId,
      createdAt: old, startedAt: old, finishedAt: old, updatedAt: old,
      error: "You've hit your usage limit for GPT-5. Try again at 12:00 AM (UTC).", errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId: f.issueId, source: "chat:slack", endpointId: f.endpointId, wakeCommentId: f.commentId },
    });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
    await chatRunMilestoneWork(db).register(coordinator, () => true).ready;
    await flush(); expect(await publications()).toEqual([]); await quiet();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    expect(await recovery.reconcileStrandedAssignedIssues()).toMatchObject({ providerQuotaMonitored: 1 });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].errorCode).toBe("provider_quota");
    expect(enqueueWakeup).not.toHaveBeenCalled();
    await flush();
    expect(await publications()).toEqual([expect.objectContaining({ idempotencyKey: `run:${runId}:failed:${f.endpointId}` })]);
    await quiet();
    expect(await recovery.reconcileStrandedAssignedIssues()).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    await flush(); await quiet(); expect(await publications()).toHaveLength(1);
  });

});
