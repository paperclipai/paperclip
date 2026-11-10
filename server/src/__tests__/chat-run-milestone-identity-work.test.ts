import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, chatActions, chatExternalPrincipals, chatIdentityLinks, chatMessageLinks, chatPublications, companyMemberships, createDb, heartbeatRuns, issueComments, issues, subscribeDatabaseWork } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createChatMilestoneFixtures } from "./helpers/chat-milestone-fixtures.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { chatRunMilestoneWork } from "../services/chat-run-milestone-work.js";
import { initializeRunIdentity, reserveSteeredIdentity, acceptSteeredIdentity } from "../services/run-identity.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { accessService } from "../services/access.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_MILESTONE_IDENTITY_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("chat milestones after identity activation", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let fixtures: ReturnType<typeof createChatMilestoneFixtures>;
  let f: Awaited<ReturnType<typeof fixtures.create>>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("chat-identity-milestones-");
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

  it.each([false, true])("rechecks concurrent membership suspension before restoring notice access (rollback=%s)", async rollback => {
    const membershipWhere = and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.userId));
    // A Board-origin reply uses the linked author and current membership.
    // Remove the fixture's unrelated provider-ingress provenance.
    await db.delete(chatMessageLinks).where(eq(chatMessageLinks.commentId, f.commentId));
    await db.update(issueComments).set({ authorUserId: f.userId }).where(eq(issueComments.id, f.commentId));
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId: f.companyId,
      provider: "slack", providerAccountId: "", externalId: f.userId,
    }).returning();
    await db.insert(chatIdentityLinks).values({ companyId: f.companyId, endpointId: f.endpointId,
      principalId: principal.id, paperclipUserId: f.userId, status: "linked",
    });
    await db.insert(chatActions).values({ companyId: f.companyId, endpointId: f.endpointId,
      conversationId: f.conversationId, kind: "slack_board_message", status: "processed",
      providerActionId: `board-comment:${f.commentId}`, payload: { issueId: f.issueId, commentId: f.commentId,
        userId: f.userId, principalId: principal.id, agentId: f.agentId },
    });
    const runId = randomUUID(), sourceId = randomUUID();
    const nextCheckAt = new Date(Date.now() - 1000).toISOString();
    await db.insert(heartbeatRuns).values({ id: sourceId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "succeeded", responsibleUserId: f.userId,
      contextSnapshot: { issueId: f.issueId, source: "chat:slack", endpointId: f.endpointId, wakeCommentId: f.commentId },
      resultJson: { semanticToolReceipts: { schedule: { operationId: "set_task_monitor",
        result: { taskId: f.issueId, monitor: { status: "scheduled", nextCheckAt } } } } },
    });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "running", responsibleUserId: f.userId,
      contextSnapshot: { issueId: f.issueId, source: "issue.monitor" },
    });
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, runId,
      source: "automation", reason: "issue_monitor_due", status: "claimed",
      idempotencyKey: `issue-monitor:${f.issueId}:${nextCheckAt}`, payload: { issueId: f.issueId, nextCheckAt },
    });
    await initializeRunIdentity(db, { companyId: f.companyId, runId, issueId: f.issueId,
      responsibleUserId: f.userId, cause: "dispatch" });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    let releaseSuspension!: () => void;
    const suspensionHeld = new Promise<void>(resolve => { releaseSuspension = resolve; });
    let markSuspended!: () => void;
    const suspended = new Promise<void>(resolve => { markSuspended = resolve; });
    let releaseRestoration!: () => void;
    const restorationHeld = new Promise<void>(resolve => { releaseRestoration = resolve; });
    let restored = false;
    let restorationPid = 0;
    const suspending = db.transaction(async tx => {
      await tx.update(companyMemberships).set({ status: "suspended" }).where(membershipWhere);
      markSuspended();
      await suspensionHeld;
    });
    await suspended;
    const restoring = db.transaction(async tx => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      restorationPid = backend.pid;
      await accessService(tx as unknown as typeof db).ensureMembership(f.companyId, "user", f.userId, "operator");
      restored = true;
      await restorationHeld;
      if (rollback) throw new Error("outer membership rollback");
    });
    void restoring.catch(() => undefined);
    try {
      // The old read sees active membership, then its UPDATE waits. The fixed
      // read waits first and observes the suspension after that writer commits.
      await vi.waitFor(async () => {
        expect(restorationPid).toBeGreaterThan(0);
        const [state] = await db.execute<{ blocked: boolean }>(sql`select cardinality(pg_blocking_pids(${restorationPid})) > 0 as blocked`);
        expect(state.blocked).toBe(true);
      });
      releaseSuspension();
      await suspending;
      await vi.waitFor(() => expect(restored).toBe(true));
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
      await chatRunMilestoneWork(db).register(coordinator, () => true).ready;
      await vi.advanceTimersByTimeAsync(1000);
      expect(await publications()).toEqual([]);
      expect((await db.select().from(companyMemberships).where(membershipWhere))[0].status).toBe("suspended");
      releaseRestoration();
      if (rollback) await expect(restoring).rejects.toThrow("outer membership rollback");
      else await restoring;
      await flush();
      expect((await db.select().from(companyMemberships).where(membershipWhere))[0].status)
        .toBe(rollback ? "suspended" : "active");
      expect(await publications()).toEqual(rollback ? [] : [expect.objectContaining({ idempotencyKey: `run:${runId}:working:${f.endpointId}` })]);
      await quiet();
      if (!rollback) {
        const notices: string[] = [];
        const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatRunMilestones, event => notices.push(event));
        try {
          await accessService(db).ensureMembership(f.companyId, "user", f.userId, "operator");
          expect(notices).toEqual([]);
        } finally { unsubscribe(); }
        await quiet();
      }
    } finally {
      releaseSuspension();
      releaseRestoration();
      await Promise.allSettled([suspending, restoring]);
    }
  });

  it.each(["initialization", "steering"] as const)("wakes matching monitor lineage after %s commits, preserving rollback and replay", async kind => {
    const nextCheckAt = new Date(Date.now() - 1000).toISOString();
    const sourceId = randomUUID(), successorId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "succeeded", responsibleUserId: f.userId,
      contextSnapshot: { issueId: f.issueId, source: "chat:slack", endpointId: f.endpointId, wakeCommentId: f.commentId },
      resultJson: { semanticToolReceipts: { schedule: { operationId: "set_task_monitor",
        result: { taskId: f.issueId, monitor: { status: "scheduled", nextCheckAt } } } } },
    });
    await db.insert(heartbeatRuns).values({ id: successorId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "running", responsibleUserId: null,
      contextSnapshot: { issueId: f.issueId, source: "issue.monitor" },
    });
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, runId: successorId,
      source: "automation", reason: "issue_monitor_due", status: "claimed",
      idempotencyKey: `issue-monitor:${f.issueId}:${nextCheckAt}`, payload: { issueId: f.issueId, nextCheckAt },
    });
    const identityInput = { companyId: f.companyId, runId: successorId, issueId: f.issueId, responsibleUserId: f.userId, cause: "dispatch" };
    if (kind === "steering") {
      await initializeRunIdentity(db, { ...identityInput, responsibleUserId: null });
      await db.update(issueComments).set({ authorUserId: f.userId }).where(eq(issueComments.id, f.commentId));
    }
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
    await chatRunMilestoneWork(db).register(coordinator, () => true).ready;
    await flush(); expect(await publications()).toEqual([]); await quiet();
    const pending = kind === "steering" ? await reserveSteeredIdentity(db, {
      companyId: f.companyId, runId: successorId, issueId: f.issueId, messageId: f.commentId,
    }) : null;
    // Reserving an unacknowledged message must not activate its identity.
    if (kind === "steering") expect(pending?.status).toBe("pending");
    await flush(); expect(await publications()).toEqual([]); await quiet();
    const activate = (rollback: boolean) => db.transaction(async tx => {
      if (kind === "steering") await acceptSteeredIdentity(tx, pending!);
      else await initializeRunIdentity(tx as unknown as typeof db, identityInput);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await publications()).toEqual([]);
      if (rollback) throw new Error("outer rollback");
    });
    await expect(activate(true)).rejects.toThrow("outer rollback");
    await flush(); expect(await publications()).toEqual([]); await quiet();
    await activate(false); await flush();
    expect(await publications()).toEqual([expect.objectContaining({ idempotencyKey: `run:${successorId}:working:${f.endpointId}` })]);
    await quiet();
    const notices: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatRunMilestones, event => notices.push(event));
    try {
      await db.transaction(async tx => {
        if (kind === "steering") await acceptSteeredIdentity(tx, pending!);
        else await initializeRunIdentity(tx as unknown as typeof db, identityInput);
      });
      expect(notices).toEqual([]);
    } finally { unsubscribe(); }
    await flush(); await quiet();
  });
});
