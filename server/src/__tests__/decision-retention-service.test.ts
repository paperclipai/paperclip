import { sql } from "drizzle-orm";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { registerDecisionArchiveDeliveryWork } from "../services/decision-archive-delivery-work.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  decisionArchiveNotificationOutbox,
  decisionRetention,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";
import { decisionRetentionService } from "../services/decision-retention.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RETENTION_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("decision retention", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  let stopWorker: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-retention-");
    db = createDb(externalUrl ?? tempDb!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 30_000);

  afterEach(async () => {
    await stopWorker?.(); stopWorker = undefined;
    await db.delete(decisionArchiveNotificationOutbox);
    await db.delete(decisionRetention);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await tempDb?.cleanup(); });

  async function seedReviewItems(count: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Retention",
      issuePrefix: `R${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Origin",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const old = new Date("2026-04-01T00:00:00.000Z");
    const issueIds = Array.from({ length: count }, () => randomUUID());
    await db.insert(issues).values(issueIds.map((id, index) => ({
      id,
      companyId,
      identifier: `R${companyId.slice(0, 6)}-${index + 1}`,
      title: `Old review ${index + 1}`,
      status: "in_review",
      priority: "medium",
      assigneeUserId: "board-user",
      createdByAgentId: agentId,
      createdAt: old,
      updatedAt: old,
    })));
    return { companyId, agentId, issueIds };
  }

  const boardActor = (companyId: string) => ({
    type: "board" as const,
    source: "local_implicit" as const,
    userId: "board-user",
    companyIds: [companyId],
    isInstanceAdmin: true,
  });
  const mutationActor = {
    actorType: "user" as const,
    actorId: "board-user",
    agentId: null,
    userId: "board-user",
    runId: null,
    agentApiKeyId: null,
    responsibleUserId: "board-user",
  };

  describe("archive delivery worker", () => {
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    let fixture: Awaited<ReturnType<typeof seedReviewItems>>;
    let service: ReturnType<typeof decisionRetentionService>;
    let draining: boolean;
    const errors: unknown[] = [];
    const notify = vi.fn(async (_batch: unknown) => {});

    beforeEach(async () => {
      await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
      fixture = await seedReviewItems(1); draining = false; errors.length = 0; notify.mockReset();
      service = decisionRetentionService(db, { notifyOriginAgent: notify });
      stopWorker = async () => {
        await coordinator?.stop(); coordinator = undefined;
        vi.useRealTimers(); vi.restoreAllMocks();
        await db.execute(sql`drop trigger if exists archive_delivery_fail on decision_archive_notification_outbox`);
        await db.execute(sql`drop function if exists archive_delivery_fail()`);
        expect(errors).toEqual([]);
      };
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    });
    async function start() {
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining,
        canReconcile: () => true, onError: error => errors.push(error) });
      await registerDecisionArchiveDeliveryWork(coordinator, service, () => !draining).ready;
    }
    async function archive(source = db) {
      const feed = await attentionService(source).list(fixture.companyId, { limit: 100 });
      return decisionRetentionService(source).autoArchive({ companyId: fixture.companyId, items: feed.items });
    }
    async function settle(ms = 60_000) {
      await vi.advanceTimersByTimeAsync(ms);
      if (!draining) await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0), { timeout: 5000 });
    }
    async function quiet() {
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(idleWorkSnapshot().active).toBe(0);
        expect(coordinator!.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      const reads = vi.spyOn(db, "select"), executes = vi.spyOn(db, "execute"), writes = vi.spyOn(db, "update");
      await settle(60 * 60_000);
      expect(reads).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
      reads.mockRestore(); executes.mockRestore(); writes.mockRestore();
    }
    async function delivered() {
      const rows = await db.select().from(decisionArchiveNotificationOutbox);
      expect(rows.length).toBeGreaterThan(0); expect(rows.every(row => row.status === "delivered")).toBe(true);
    }

    it("is quiet with configuration, wakes from real auto-archive, and leaves delivered history quiet", async () => {
      await start(); await quiet();
      expect(await archive()).toBe(1); await settle(); await delivered(); await quiet();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toMatchObject({ companyId: fixture.companyId, agentId: fixture.agentId,
        items: [expect.objectContaining({ issueId: fixture.issueIds[0], archiveVersion: 1 })] });
    });

    it("reconstructs pending delivery after restart", async () => {
      await archive(); await start(); await quiet(); await delivered(); expect(notify).toHaveBeenCalledTimes(1);
    });

    it("waits until an existing delivery claim expires", async () => {
      await archive(); const attemptedAt = new Date();
      await db.update(decisionArchiveNotificationOutbox).set({ status: "delivering", lastAttemptAt: attemptedAt, attemptCount: 1 });
      await start(); expect(notify).not.toHaveBeenCalled();
      expect(coordinator!.nextWakeAt()).toBe(attemptedAt.getTime() + 5 * 60_000);
      const reads = vi.spyOn(db, "select"); await settle(4 * 60_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
      await settle(2 * 60_000); await delivered(); await quiet(); expect(notify).toHaveBeenCalledTimes(1);
    });

    it("recovers a legacy delivering row with no attempt timestamp", async () => {
      await archive(); await db.update(decisionArchiveNotificationOutbox).set({ status: "delivering" });
      await start(); await delivered(); await quiet();
    });

    it("retains first enqueue during drain without passive SQL", async () => {
      await start(); await quiet(); draining = true;
      await archive(); await settle();
      const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "update");
      await settle(60 * 60_000); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
      reads.mockRestore(); writes.mockRestore(); expect(notify).not.toHaveBeenCalled();
      draining = false; await settle(); await delivered(); await quiet();
    });

    it("retries failed delivery through drain and then becomes quiet", async () => {
      await archive(); notify.mockRejectedValueOnce(new Error("wake unavailable"));
      await start(); expect(notify).toHaveBeenCalledTimes(1); expect(coordinator!.nextWakeAt()).not.toBeNull();
      draining = true; await settle(60 * 60_000); expect(notify).toHaveBeenCalledTimes(1);
      draining = false;
      await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(30_000); await delivered(); }, { timeout: 5000 });
      await quiet(); expect(notify).toHaveBeenCalledTimes(2);
    });

    it.each([false, true])("waits for the archive's outer transaction (rollback %s)", async rollback => {
      await start(); await quiet();
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const aborted = new Error("fixture rollback");
      const running = db.transaction(async tx => {
        await archive(tx as unknown as typeof db); entered(); await gate; if (rollback) throw aborted;
      }).catch(error => { if (error !== aborted) throw error; });
      await ready;
      try { await vi.advanceTimersByTimeAsync(60_000); expect(notify).not.toHaveBeenCalled(); }
      finally { release(); await running; }
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(30_000); expect(idleWorkSnapshot().active).toBe(0);
        if (rollback) expect(await db.select().from(decisionArchiveNotificationOutbox)).toEqual([]);
        else await delivered();
      }, { timeout: 5000 });
      await quiet(); expect(notify).toHaveBeenCalledTimes(rollback ? 0 : 1);
    });

    it("rolls back archive state when enqueue fails and wakes on a later successful archive", async () => {
      await start(); await quiet();
      await db.execute(sql`create function archive_delivery_fail() returns trigger language plpgsql as $$
        begin raise exception 'archive enqueue fixture failure'; end $$`);
      await db.execute(sql`create trigger archive_delivery_fail before insert on decision_archive_notification_outbox
        for each row execute function archive_delivery_fail()`);
      await expect(archive()).rejects.toThrow();
      await db.execute(sql`drop trigger archive_delivery_fail on decision_archive_notification_outbox`);
      await quiet(); expect(notify).not.toHaveBeenCalled();
      expect(await db.select().from(decisionArchiveNotificationOutbox)).toEqual([]);
      expect((await db.select().from(decisionRetention))[0].archivedAt).toBeNull();
      await archive(); await settle(); await delivered(); await quiet();
    });

    it("keeps an enqueue committed during delivery and drains it on the next pass", async () => {
      await start(); await quiet();
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      notify.mockImplementationOnce(async () => { entered(); await gate; });
      await archive();
      await vi.advanceTimersByTimeAsync(30_000); await ready;
      try {
        fixture = await seedReviewItems(1); await archive();
        expect(notify).toHaveBeenCalledTimes(1);
      } finally { release(); }
      await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(30_000); await delivered(); }, { timeout: 5000 });
      await quiet(); expect(notify).toHaveBeenCalledTimes(2);
    });

    it("does not let an older failed batch starve rows beyond the batch limit", async () => {
      await archive(); const [row] = await db.select().from(decisionArchiveNotificationOutbox);
      await db.insert(decisionArchiveNotificationOutbox).values(Array.from({ length: 501 }, (_, index) => ({
        ...row, id: randomUUID(), sourceId: `additional-${index}` })));
      notify.mockRejectedValueOnce(new Error("first batch unavailable"));
      await start(); expect(notify.mock.calls[0][0]).toMatchObject({ items: expect.any(Array) });
      expect((notify.mock.calls[0][0] as { items: unknown[] }).items).toHaveLength(500);
      await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(30_000); await delivered(); }, { timeout: 5000 });
      await quiet();
      expect((notify.mock.calls[1][0] as { items: unknown[] }).items).toHaveLength(500);
      expect((notify.mock.calls[2][0] as { items: unknown[] }).items).toHaveLength(2);
    });

    it("does not settle a replacement claim from an older delivery result", async () => {
      await archive();
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      notify.mockImplementationOnce(async () => { entered(); await gate; });
      const first = service.deliverNotifications(); await ready;
      const replacementAt = new Date(Date.now() + 6 * 60_000);
      try { await db.update(decisionArchiveNotificationOutbox).set({ lastAttemptAt: replacementAt, attemptCount: 2 }); }
      finally { release(); }
      expect(await first).toEqual({ notifiedAgents: 0, delivered: 0 });
      expect((await db.select().from(decisionArchiveNotificationOutbox))[0]).toMatchObject({ status: "delivering", lastAttemptAt: replacementAt });
      await start(); expect(coordinator!.nextWakeAt()).toBe(replacementAt.getTime() + 5 * 60_000);
      await settle(12 * 60_000); await delivered(); await quiet();
    });
  });

  it("auto-archives, excludes by default, returns archived rows, and revives", async () => {
    const { companyId, issueIds } = await seedReviewItems(1);
    const now = new Date("2026-08-02T00:00:00.000Z");
    const svc = decisionRetentionService(db);
    const before = await attentionService(db, { now: () => now.getTime() }).list(companyId, { limit: 100 });
    expect(before.items).toHaveLength(1);

    expect(await svc.autoArchive({ companyId, items: before.items, now })).toBe(1);
    const current = await attentionService(db, { now: () => now.getTime() }).list(companyId, { limit: 100 });
    expect(current.items).toHaveLength(0);
    const archived = await attentionService(db, { now: () => now.getTime() }).list(companyId, { archived: true, limit: 100 });
    expect(archived.items[0]).toMatchObject({ subject: { id: issueIds[0] }, archivedAt: now.toISOString() });

    await svc.revive({
      companyId,
      sourceKind: "review",
      sourceId: issueIds[0]!,
      authActor: boardActor(companyId),
      actor: mutationActor,
    });
    const revived = await attentionService(db, { now: () => now.getTime() }).list(companyId, { limit: 100 });
    expect(revived.items[0]).toMatchObject({ subject: { id: issueIds[0] }, archivedAt: null });
  });

  it("exempts Keep rows and batches one notification per origin agent", async () => {
    const { companyId, agentId, issueIds } = await seedReviewItems(3);
    const now = new Date("2026-08-02T00:00:00.000Z");
    const notifications: Array<Record<string, unknown>> = [];
    const svc = decisionRetentionService(db, { notifyOriginAgent: async (batch) => notifications.push(batch) });
    await attentionService(db, { now: () => now.getTime() }).list(companyId, { limit: 100 });
    await svc.setKeep({
      companyId,
      sourceKind: "review",
      sourceId: issueIds[0]!,
      keep: true,
      authActor: boardActor(companyId),
      actor: mutationActor,
    });
    const refreshed = await attentionService(db, { now: () => now.getTime() }).list(companyId, { limit: 100 });
    expect(await svc.autoArchive({ companyId, items: refreshed.items, now })).toBe(2);
    expect(await svc.deliverNotifications()).toEqual({ notifiedAgents: 1, delivered: 2 });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ companyId, agentId, items: expect.arrayContaining([
      expect.objectContaining({ issueId: issueIds[1] }),
      expect.objectContaining({ issueId: issueIds[2] }),
    ]) });
    expect((await svc.getState(companyId, "review", issueIds[0]!))?.archivedAt).toBeNull();
  });

  it("fails the whole reviewed manifest when one expected version changes", async () => {
    const { companyId, issueIds } = await seedReviewItems(2);
    const now = Date.parse("2026-08-02T00:00:00.000Z");
    const svc = decisionRetentionService(db);
    const feed = await attentionService(db, { now: () => now }).list(companyId, { limit: 100 });
    const manifest = feed.items.map((item) => ({
      companyId,
      sourceKind: item.sourceKind,
      sourceId: item.subject.id,
      expectedVersion: item.retentionVersion,
      activityAt: item.activityAt,
      reason: "Reviewed as stale",
    }));
    await svc.setKeep({
      companyId,
      sourceKind: "review",
      sourceId: issueIds[0]!,
      keep: true,
      authActor: boardActor(companyId),
      actor: mutationActor,
    });
    await expect(svc.archiveReviewedManifest({
      companyId,
      manifest,
      originActor: boardActor(companyId),
      decidingActor: boardActor(companyId),
      decidedByUserId: "board-user",
    })).rejects.toThrow("archive_proposal_stale");
    expect((await db.select().from(decisionRetention)).every((row) => row.archivedAt === null)).toBe(true);
  });
});
