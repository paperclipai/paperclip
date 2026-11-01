import { enqueueChatRunLifecycleMilestones } from "../services/chat-run-publications.js";
import { persistReprojectedWorkspaceDiffs, projectCodexWorkspaceDiffsFromTrace } from "../services/provider-trace-workspace-diff-reprojection.js";
import { randomUUID } from "node:crypto";
import { eq, like, and } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chatPublications, createDb, heartbeatRunEvents, heartbeatRuns, issues, subscribeDatabaseWork } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createChatMilestoneFixtures } from "./helpers/chat-milestone-fixtures.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { nativeChatProgressWork } from "../services/chat-native-progress-work.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { NativeRunCoordinatorStore } from "../services/native-runtime/native-run-coordinator-store.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import type { PrpEvent } from "../vendor/paperclip-runner/index.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_PROGRESS_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("native chat progress work", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let fixtures: ReturnType<typeof createChatMilestoneFixtures>;
  let f: Awaited<ReturnType<typeof fixtures.create>>;
  let runId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let canRun = true;
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("native-chat-progress-");
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    fixtures = createChatMilestoneFixtures(db);
  }, 60_000);
  beforeEach(async () => {
    errors.length = 0; canRun = true; f = await fixtures.create(); runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "running", responsibleUserId: f.userId,
      contextSnapshot: { issueId: f.issueId, source: "chat:slack", endpointId: f.endpointId, wakeCommentId: f.commentId },
    });
    await db.insert(chatPublications).values({ companyId: f.companyId, endpointId: f.endpointId,
      conversationId: f.conversationId, issueId: f.issueId, idempotencyKey: `run:${runId}:working:${f.endpointId}`,
      payload: { text: "Maya is working…", progressState: "working" }, state: "published",
      createdAt: new Date(Date.now() - 60_000),
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks(); await fixtures.cleanup();
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  const publications = () => db.select().from(chatPublications).where(and(
    eq(chatPublications.issueId, f.issueId), like(chatPublications.idempotencyKey, "%:native:%"),
  ));
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun, canReconcile: () => true,
      onError: error => errors.push(error) });
    await nativeChatProgressWork(db).register(coordinator, () => canRun).ready;
  }
  async function settle() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
  }
  async function quiet() {
    const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
    try { await vi.advanceTimersByTimeAsync(120_000); expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled(); }
    finally { select.mockRestore(); transaction.mockRestore(); }
  }
  function event(nativeSource = false, eventType = "item.completed") {
    return { companyId: f.companyId, agentId: f.agentId, runId, eventType,
      message: "PRIVATE event text", payload: { token: "PRIVATE token" },
      ...(nativeSource ? { nativeSource: { sourceInstanceId: runId, sourceEventId: "event-1", sourceSeq: 1,
        protocolSchemaVersion: 1, canonicalPayload: { eventType } } } : {}),
    };
  }

  it.each([false, true])("wakes from a real committed event after idle (native source: %s)", async nativeSource => {
    await start(); await settle(); await quiet(); expect(await publications()).toEqual([]);
    const input = event(nativeSource);
    const save = (rollback: boolean) => db.transaction(async tx => {
      await appendHeartbeatRunEvent(tx as unknown as typeof db, input);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await publications()).toEqual([]);
      if (rollback) throw new Error("outer rollback");
    });
    await expect(save(true)).rejects.toThrow("outer rollback");
    await settle(); expect(await publications()).toEqual([]); await quiet();
    await save(false);
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(await publications()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ text: "Maya is making progress…" }) })]);
    }, { timeout: 5000 });
    await settle(); await quiet(); expect(errors).toEqual([]);
    if (nativeSource) {
      const signals: string[] = [];
      const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatNativeProgress, kind => signals.push(kind));
      try { expect((await appendHeartbeatRunEvent(db, input)).disposition).toBe("duplicate"); expect(signals).toEqual([]); }
      finally { unsubscribe(); }
      await quiet();
    }
  });

  it("wakes a saved event when its first working publication commits after event selection", async () => {
    await db.delete(chatPublications).where(eq(chatPublications.issueId, f.issueId));
    await appendHeartbeatRunEvent(db, event(true));
    await start(); await settle(); expect(await publications()).toEqual([]); await quiet();
    await db.transaction(async tx => {
      expect(await enqueueChatRunLifecycleMilestones(tx as unknown as typeof db, {
        scope: { companyId: f.companyId, issueId: f.issueId },
      })).toBe(1);
      // Model a base transaction that began before the event but committed
      // afterwards, without a wall-clock delay in the suite. PostgreSQL's
      // default now() is transaction-start time, not commit time.
      await tx.update(chatPublications).set({ createdAt: new Date(Date.now() - 300_000) })
        .where(eq(chatPublications.idempotencyKey, `run:${runId}:working:${f.endpointId}`));
      await vi.advanceTimersByTimeAsync(1000); expect(await publications()).toEqual([]);
    });
    await settle(); expect(await publications()).toHaveLength(1); await quiet(); expect(errors).toEqual([]);
  });

  it("reconstructs saved progress after restart and becomes quiet with published history", async () => {
    await appendHeartbeatRunEvent(db, event(true));
    await start(); await settle(); expect(await publications()).toHaveLength(1); await quiet();
    await coordinator!.stop(); await start(); await settle();
    expect(await publications()).toHaveLength(1); await quiet(); expect(errors).toEqual([]);
  });

  it.each(["issue", "run"] as const)("retries a contended %s without another event", async owner => {
    await appendHeartbeatRunEvent(db, event(true));
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const lock = db.transaction(async tx => {
      if (owner === "issue") await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      else await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
      entered(); await hold;
    });
    try {
      await ready; await start(); expect(await publications()).toEqual([]);
      expect(coordinator!.nextWakeAt()).not.toBeNull();
      release(); await lock;
      await settle(); expect(await publications()).toHaveLength(1); await quiet(); expect(errors).toEqual([]);
    } finally { release(); await lock; }
  });

  it.each(["port", "coordinator"] as const)("wakes from the real %s event owner after outer commit, with quiet replay", async kind => {
    const sessionId = randomUUID(), runnerId = randomUUID();
    await db.update(heartbeatRuns).set({ nativeSessionId: sessionId }).where(eq(heartbeatRuns.id, runId));
    const binding = { companyId: f.companyId, issueId: f.issueId, runId, agentId: f.agentId,
      sessionId, completionContractId: randomUUID(), completionContractSha256: "fixture",
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: "control",
      normalizedSessionId: sessionId, runnerSourceInstanceId: runnerId,
      completionContractRevision: "1", completionContractCriterionIds: [],
    };
    const source: PrpEvent = { schema: "paperclip.prp.event.v1", schemaVersion: 1,
      sourceEventId: "event-1", sourceSeq: 1, sourceInstanceId: runnerId, sourceKind: "runner",
      runId, normalizedSessionId: sessionId, turnId: "turn-1", itemId: "item-1",
      eventType: "item.completed", priority: 1, emittedAt: new Date().toISOString(), payload: {},
    };
    const append = (client: typeof db) => (kind === "port"
      ? new PaperclipControlPlanePort(client, binding)
      : new NativeRunCoordinatorStore(client, binding)).appendEvent(source);
    await start(); await settle(); await quiet();
    await expect(db.transaction(async tx => {
      await append(tx as unknown as typeof db); throw new Error("rollback owner");
    })).rejects.toThrow("rollback owner");
    await settle(); expect(await publications()).toEqual([]); await quiet();
    await db.transaction(async tx => {
      await append(tx as unknown as typeof db); await vi.advanceTimersByTimeAsync(1000);
      expect(await publications()).toEqual([]);
    });
    await settle(); expect(await publications()).toHaveLength(1); await quiet();
    const signals: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatNativeProgress, kind => signals.push(kind));
    try { expect((await append(db)).disposition).toBe("duplicate"); expect(signals).toEqual([]); }
    finally { unsubscribe(); }
    await quiet(); expect(errors).toEqual([]);
  });

  it.each(["issue", "run"] as const)("disarms after terminalization wins during a contended %s", async owner => {
    await appendHeartbeatRunEvent(db, event(true));
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const lock = db.transaction(async tx => {
      if (owner === "issue") await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      else await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
      entered(); await hold;
      await tx.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, runId));
    });
    try {
      await ready; await start(); expect(coordinator!.nextWakeAt()).not.toBeNull();
      release(); await lock; await settle(); expect(await publications()).toEqual([]); await quiet();
      expect(errors).toEqual([]);
    } finally { release(); await lock; }
  });

  it.each(["first write", "startup"] as const)("retains %s through drain without passive SQL", async kind => {
    if (kind === "first write") { await start(); await settle(); }
    canRun = false;
    await appendHeartbeatRunEvent(db, event(true));
    if (kind === "startup") await start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    expect(await publications()).toEqual([]); await quiet();
    canRun = true; await vi.advanceTimersByTimeAsync(30_000); await settle();
    expect(await publications()).toHaveLength(1); await quiet(); expect(errors).toEqual([]);
  });

  it("retains failed startup selection through drain and retries after resume", async () => {
    await appendHeartbeatRunEvent(db, event(true));
    const select = vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("temporary read failure"); });
    try { await start(); } finally { select.mockRestore(); }
    expect(errors.splice(0)).toHaveLength(1); canRun = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    await quiet(); expect(await publications()).toEqual([]);
    canRun = true; await vi.advanceTimersByTimeAsync(30_000); await settle();
    expect(await publications()).toHaveLength(1); await quiet(); expect(errors).toEqual([]);
  });

  it("leaves unrelated direct log events on their atomic statement path without projection intent", async () => {
    await start(); await settle();
    const signals: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatNativeProgress, kind => signals.push(kind));
    const transaction = vi.spyOn(db, "transaction");
    try {
      await appendHeartbeatRunEvent(db, event(false, "item.delta"));
      expect(transaction).not.toHaveBeenCalled(); expect(signals).toEqual([]);
    } finally { transaction.mockRestore(); unsubscribe(); }
    await quiet(); expect(await publications()).toEqual([]); expect(errors).toEqual([]);
  });

  it("wakes saved trace reprojection without live runner ingress and leaves duplicate recovery quiet", async () => {
    await start(); await settle(); await quiet();
    const projection = projectCodexWorkspaceDiffsFromTrace([{
      kind: "frame", direction: "provider_to_client", frameId: 1,
      rawBase64: Buffer.from(JSON.stringify({ method: "turn/diff/updated", params: {
        turnId: "turn-1", diff: "diff --git a/private.txt b/private.txt\n--- a/private.txt\n+++ b/private.txt\n@@ -1 +1 @@\n-private\n+PRIVATE replacement\n",
      } })).toString("base64"),
    }]);
    expect(projection.turns).toHaveLength(1);
    const input = { traceId: randomUUID(), companyId: f.companyId, agentId: f.agentId, runId, projection };
    expect(await persistReprojectedWorkspaceDiffs(db, input)).toMatchObject({ created: 1 });
    await settle();
    expect(await publications()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ text: "Maya is working with files…" }) })]);
    await quiet();
    const signals: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatNativeProgress, kind => signals.push(kind));
    try { expect(await persistReprojectedWorkspaceDiffs(db, input)).toMatchObject({ created: 0 }); expect(signals).toEqual([]); }
    finally { unsubscribe(); }
    await quiet(); expect(errors).toEqual([]);
  });

  it("retains a committed event that arrives before the current projection pass returns", async () => {
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const secondRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: secondRunId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      runtimeMode: "native", status: "running", responsibleUserId: f.userId, contextSnapshot: source.contextSnapshot,
    });
    await db.insert(chatPublications).values({
      companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId,
      issueId: f.issueId, idempotencyKey: `run:${secondRunId}:working:${f.endpointId}`,
      payload: { text: "Maya is working…", progressState: "working" }, state: "published",
      createdAt: new Date(Date.now() - 60_000),
    });
    await start(); await settle();
    let held = false, release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const transaction = db.transaction.bind(db);
    const barrier = vi.spyOn(db, "transaction").mockImplementation(async (callback, options) => {
      const result = await transaction(callback, options);
      // Pause after the first projection commits, before its pass can disarm.
      // Producer transactions return event records, not an inserted row count.
      if (result === 1 && !held) { held = true; await pending; }
      return result;
    });
    try {
      await appendHeartbeatRunEvent(db, event(true));
      await vi.waitFor(() => expect(held).toBe(true), { timeout: 5000 });
      await appendHeartbeatRunEvent(db, { ...event(false), runId: secondRunId });
      release(); await settle();
      expect(await publications()).toHaveLength(2); barrier.mockRestore();
      await quiet(); expect(errors).toEqual([]);
    } finally { release(); barrier.mockRestore(); }
  });

  it("limits an event wake to its issue and reconstructs other saved scopes on restart", async () => {
    await start(); await settle();
    // Seed rows without signals to expose an accidentally global event wake.
    const others = [await fixtures.create(f.companyId), await fixtures.create()];
    for (const other of others) {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id, companyId: other.companyId, agentId: other.agentId, nativeIssueId: other.issueId,
        runtimeMode: "native", status: "running", responsibleUserId: other.userId,
        contextSnapshot: { issueId: other.issueId, source: "chat:slack", endpointId: other.endpointId, wakeCommentId: other.commentId },
      });
      await db.insert(chatPublications).values({
        companyId: other.companyId, endpointId: other.endpointId, conversationId: other.conversationId,
        issueId: other.issueId, idempotencyKey: `run:${id}:working:${other.endpointId}`,
        payload: { text: "Maya is working…", progressState: "working" }, state: "published",
        createdAt: new Date(Date.now() - 60_000),
      });
      await db.insert(heartbeatRunEvents).values({ companyId: other.companyId, agentId: other.agentId,
        runId: id, seq: 1, eventType: "item.completed" });
    }
    const saved = (issueId: string) => db.select().from(chatPublications).where(and(
      eq(chatPublications.issueId, issueId), like(chatPublications.idempotencyKey, "%:native:%"),
    ));
    await appendHeartbeatRunEvent(db, event(true)); await settle();
    expect(await publications()).toHaveLength(1);
    for (const other of others) expect(await saved(other.issueId)).toEqual([]);
    await quiet(); await coordinator!.stop(); await start(); await settle();
    for (const other of others) expect(await saved(other.issueId)).toHaveLength(1);
    await quiet(); expect(errors).toEqual([]);
  });

  it("drains more than one issue batch and becomes quiet with all progress retained", async () => {
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const ids = Array.from({ length: 105 }, () => randomUUID());
    await db.insert(heartbeatRuns).values(ids.map(id => ({
      id, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      runtimeMode: "native", status: "running", responsibleUserId: f.userId, contextSnapshot: source.contextSnapshot,
    })));
    await db.insert(chatPublications).values(ids.map(id => ({
      companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId,
      issueId: f.issueId, idempotencyKey: `run:${id}:working:${f.endpointId}`,
      payload: { text: "Maya is working…", progressState: "working" }, state: "published",
      createdAt: new Date(Date.now() - 60_000),
    })));
    await db.insert(heartbeatRunEvents).values(ids.map(id => ({
      companyId: f.companyId, agentId: f.agentId, runId: id, seq: 1, eventType: "item.completed",
    })));
    await start(); await settle();
    expect(await publications()).toHaveLength(ids.length); await quiet(); expect(errors).toEqual([]);
  });

  it("unsubscribes at shutdown and reconstructs a later event on restart", async () => {
    await start(); await settle(); await coordinator!.stop();
    await appendHeartbeatRunEvent(db, event(true));
    await quiet(); expect(await publications()).toEqual([]);
    await start(); await settle(); expect(await publications()).toHaveLength(1); expect(errors).toEqual([]);
  });

});
