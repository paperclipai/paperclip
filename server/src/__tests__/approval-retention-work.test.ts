import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, approvals, chatConversations, chatEndpoints, companies, createDb, subscribeDatabaseWork, decisionArchiveNotificationOutbox, decisionRetention, issueApprovals, issues, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { approvalRecords } from "../services/approvals.js";
import { approvalRetentionService, registerApprovalRetentionWork } from "../services/approval-retention.js";
import { decisionRetentionService, DEFAULT_DECISION_ARCHIVE_DAYS } from "../services/decision-retention.js";
import { attentionService } from "../services/attention.js";
import { issueApprovalService } from "../services/issue-approvals.js";
import { companyService } from "../services/companies.js";
import { issueService } from "../services/issues.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_APPROVAL_RETENTION_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const delay = DEFAULT_DECISION_ARCHIVE_DAYS * 86_400_000;
(support.supported ? describe : describe.skip)("approval retention worker", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>, companyId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let draining: boolean;
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (!externalUrl) temporary = await startEmbeddedPostgresTestDatabase("approval-retention-");
    db = createDb(externalUrl ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 30_000);
  beforeEach(async () => {
    companyId = randomUUID(); draining = false; errors.length = 0;
    await db.insert(companies).values({ id: companyId, name: "Approval retention", issuePrefix: `A${companyId.slice(0, 6)}` });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.execute(sql`drop trigger if exists approval_retention_fail on decision_retention`);
    await db.execute(sql`drop function if exists approval_retention_fail()`);
    await db.delete(decisionArchiveNotificationOutbox); await db.delete(decisionRetention);
    await db.delete(activityLog); await db.delete(issueApprovals); await db.delete(approvals);
    await db.delete(chatConversations); await db.delete(chatEndpoints);
    await db.delete(toolConnections); await db.delete(toolApplications);
    await db.delete(issues); await db.delete(agents); await db.delete(companies);
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  const create = (at = new Date(), database: Db = db) => approvalRecords(database).create(companyId, {
    type: "request_board_approval", payload: {}, createdAt: at, updatedAt: at,
  });
  const old = () => new Date(Date.now() - delay - 60_000);
  const state = (id: string) => decisionRetentionService(db).getState(companyId, "approval", id);
  const authActor = () => ({ type: "board" as const, source: "local_implicit" as const, userId: "board-user", companyIds: [companyId], isInstanceAdmin: true });
  const actor = { actorType: "user" as const, actorId: "board-user", agentId: null, userId: "board-user", runId: null, agentApiKeyId: null, responsibleUserId: "board-user" };
  const mutation = (id: string) => ({ companyId, sourceKind: "approval" as const, sourceId: id, authActor: authActor(), actor });
  async function start(service = approvalRetentionService(db)) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true, onError: error => errors.push(error) });
    await registerApprovalRetentionWork(coordinator, service, () => !draining).ready;
    return service;
  }
  async function settle() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 5000 });
  }
  async function quiet() {
    await settle();
    expect(coordinator!.nextWakeAt()).toBeNull();
    const reads = vi.spyOn(db, "select"), executes = vi.spyOn(db, "execute"), writes = vi.spyOn(db, "transaction");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(reads).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    reads.mockRestore(); executes.mockRestore(); writes.mockRestore();
  }
  async function archived(id: string) {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await state(id))?.archivedAt).toBeInstanceOf(Date);
    }, { timeout: 5000 });
  }
  async function issue(hiddenAt: Date | null = null) {
    const [row] = await db.insert(issues).values({ companyId, title: "Approval target", status: "todo", hiddenAt }).returning();
    return row;
  }

  it("is quiet with no approvals and archives unseen durable approvals at their actual deadline", async () => {
    await start(); await quiet();
    const deadline = Date.now() + 600_000;
    const row = await create(new Date(deadline - delay));
    await settle();
    expect(await state(row.id)).toBeNull();
    expect(coordinator!.nextWakeAt()).toBe(deadline);
    const quietWindow = deadline - Date.now() - 30_000;
    expect(quietWindow).toBeGreaterThan(0);
    const reads = vi.spyOn(db, "select");
    await vi.advanceTimersByTimeAsync(quietWindow);
    expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    await vi.advanceTimersByTimeAsync(60_000);
    await archived(row.id); await quiet();
    expect((await db.select().from(approvals).where(eq(approvals.id, row.id)))[0].status).toBe("pending");
  });

  it.each(["approved", "rejected", "cancelled"] as const)("wakes parked tool reviews only on terminal %s transition", async outcome => {
    const queues = [DELIVERY_QUEUES.toolReviewExpiry, DELIVERY_QUEUES.toolReviewRecovery,
      DELIVERY_QUEUES.toolReviewInterruption, DELIVERY_QUEUES.toolReviewProjection];
    const events = queues.map(() => [] as string[]);
    const subscriptions = queues.map((queue, index) => subscribeDatabaseWork(db, queue, event => { events[index].push(event); }));
    try {
      const row = await create(), target = await issue();
      for (let pass = 0; pass < 3; pass++) {
        await issueApprovalService(db).link(target.id, row.id);
        await issueApprovalService(db).unlink(target.id, row.id);
      }
      await approvalRecords(db).requestRevision(row.id, "board-user");
      await approvalRecords(db).resubmit(row.id);
      expect(events).toEqual(queues.map(() => []));
      if (outcome === "cancelled") await approvalRecords(db).cancel(row.id, "cancelled by user");
      else await approvalRecords(db).resolveApproval(row.id, outcome, "board-user", null);
      expect(events).toEqual(queues.map(() => ["intent", "settled"]));
    } finally { for (const unsubscribe of subscriptions) unsubscribe(); }
  });

  it("bounds aggregate retention reads to one reconciliation per thirty seconds of sequential tenant writes", async () => {
    const [otherCompany] = await db.insert(companies).values({ name: "Other tenant", issuePrefix: `B${companyId.slice(0, 6)}` }).returning();
    const other = await approvalRecords(db).create(otherCompany.id, { type: "request_board_approval", payload: {} });
    const service = await start(); await settle();
    const sweep = vi.spyOn(service, "sweep"), reads = vi.spyOn(db, "select");
    await create();
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));
    await sweep.mock.results[0].value;
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    const afterFirst = reads.mock.calls.length;
    expect(afterFirst).toBe(2);
    for (let pass = 0; pass < 3; pass++) {
      await create();
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(29_000);
    expect(reads).toHaveBeenCalledTimes(afterFirst);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(afterFirst + 2));
    reads.mockRestore();
    expect((await db.select().from(approvals).where(eq(approvals.id, other.id)))[0].status).toBe("pending");
  });

  it("rounds a submillisecond approval deadline up to the next scheduler millisecond", async () => {
    const row = await create(), floor = Date.now() + 120_000;
    const activity = new Date(floor - delay).toISOString();
    await db.execute(sql`update approvals set updated_at = ${activity}::timestamptz + interval '456 microseconds' where id = ${row.id}`);
    const service = approvalRetentionService(db);
    expect(await service.next()).toBe(floor + 1);
    expect(await service.sweep(new Date(floor))).toEqual({ archived: 0 });
    expect(await state(row.id)).toBeNull();
    expect(await service.sweep(new Date(floor + 1))).toEqual({ archived: 1 });
  });

  it("recovers old unseen approvals on startup and leaves completed history quiet", async () => {
    const due = await create(old()), completed = await create(old());
    await approvalRecords(db).resolveApproval(completed.id, "approved", "board-user", null);
    await start(); await archived(due.id); await quiet();
    expect(await state(completed.id)).toBeNull();
  });

  it("disarms on revision and moves the deadline when resubmitted", async () => {
    await start(); const row = await create(); await settle();
    await approvalRecords(db).requestRevision(row.id, "board-user"); await quiet();
    const resubmitted = await approvalRecords(db).resubmit(row.id); await settle();
    expect(coordinator!.nextWakeAt()).toBe(resubmitted.updatedAt.getTime() + delay);
    await approvalRecords(db).cancel(row.id); await quiet();
  });

  it.each(["keep", "archive", "revive"] as const)("applies %s to an unseen young approval without a feed read", async action => {
    const row = await create();
    expect(await state(row.id)).toBeNull();
    const retention = decisionRetentionService(db);
    const result = action === "keep" ? await retention.setKeep({ ...mutation(row.id), keep: true })
      : action === "archive" ? await retention.archive(mutation(row.id)) : await retention.revive(mutation(row.id));
    expect(result).toMatchObject({ sourceKind: "approval", sourceId: row.id, sourceActivityAt: row.updatedAt, keep: action === "keep" });
    expect(result.archivedAt).toEqual(action === "archive" ? expect.any(Date) : null);
    expect(await state(row.id)).toMatchObject({ id: result.id, keep: action === "keep" });
  });

  it("rolls back on-demand materialization when the manual keep write fails", async () => {
    const row = await create();
    await db.execute(sql`create function approval_retention_fail() returns trigger language plpgsql as $$ begin
      if NEW.keep then raise exception 'manual keep unavailable'; end if; return NEW; end $$`);
    await db.execute(sql`create trigger approval_retention_fail before update on decision_retention for each row execute function approval_retention_fail()`);
    await expect(decisionRetentionService(db).setKeep({ ...mutation(row.id), keep: true }))
      .rejects.toMatchObject({ cause: { message: "manual keep unavailable" } });
    expect(await state(row.id)).toBeNull();
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision_retention.keep_updated"))).toHaveLength(0);
    await db.execute(sql`drop trigger approval_retention_fail on decision_retention`);
    expect(await decisionRetentionService(db).setKeep({ ...mutation(row.id), keep: true })).toMatchObject({ keep: true });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision_retention.keep_updated"))).toHaveLength(1);
  });

  it("honors keep and wakes when an old approval is unkept", async () => {
    const row = await create(old());
    await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true });
    await decisionRetentionService(db).setKeep({ ...mutation(row.id), keep: true });
    await start(); await quiet(); expect((await state(row.id))?.archivedAt).toBeNull();
    await decisionRetentionService(db).setKeep({ ...mutation(row.id), keep: false });
    await archived(row.id); await quiet();
  });

  it("disarms on manual archive and reactivates on revive", async () => {
    const row = await create(old());
    await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true });
    await decisionRetentionService(db).archive(mutation(row.id));
    await start(); await quiet();
    await decisionRetentionService(db).revive(mutation(row.id));
    await archived(row.id); await quiet();
    expect((await state(row.id))?.archivedReason).toBe("idle_ttl");
  });

  it("waits for inactive companies and wakes on company activation", async () => {
    const row = await create(old());
    await companyService(db).update(companyId, { status: "paused" });
    await start(); await quiet(); expect(await state(row.id)).toBeNull();
    await companyService(db).update(companyId, { status: "active" });
    await archived(row.id); await quiet();
  });

  it("excludes hidden linked targets and wakes after unlink", async () => {
    const row = await create(old()), target = await issue(new Date());
    await issueApprovalService(db).link(target.id, row.id);
    await start(); await quiet(); expect(await state(row.id)).toBeNull();
    await issueApprovalService(db).unlink(target.id, row.id);
    await archived(row.id); await quiet();
  });

  it("wakes when the linked target becomes visible", async () => {
    const row = await create(old()), target = await issue(new Date());
    await issueApprovalService(db).link(target.id, row.id);
    await start(); await quiet();
    await issueService(db).update(target.id, { hiddenAt: null });
    await archived(row.id); await quiet();
  });

  it("wakes after deletion cascades the excluded target link", async () => {
    const row = await create(old()), target = await issue(new Date());
    await issueApprovalService(db).link(target.id, row.id);
    await start(); await quiet();
    await issueService(db).remove(target.id);
    await archived(row.id); await quiet();
  });

  it("preserves normal attention reads while excluding approval retention maintenance", async () => {
    const row = await create(old());
    const excluded = await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true, excludeSources: ["approval"] });
    expect(excluded.items.some(item => item.sourceKind === "approval")).toBe(false);
    expect(await state(row.id)).toBeNull();
    const visible = await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true });
    expect(visible.items.some(item => item.subject.id === row.id)).toBe(true);
    expect(await state(row.id)).not.toBeNull();
  });

  it("does not publish work before an outer transaction commits", async () => {
    await start(); await quiet();
    let id = "";
    await db.transaction(async tx => {
      id = (await create(old(), tx as unknown as Db)).id;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await state(id)).toBeNull();
    });
    await archived(id); await quiet();
  });

  it("discharges rolled back nested producers without archiving", async () => {
    await start(); await quiet();
    await expect(db.transaction(async tx => {
      await create(old(), tx as unknown as Db); throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await quiet(); expect(await db.select().from(approvals)).toEqual([]);
  });

  it("retains the first producer during drain and processes it after resume", async () => {
    await start(); await quiet(); draining = true;
    const row = await create(old());
    await vi.advanceTimersByTimeAsync(90_000); expect(await state(row.id)).toBeNull();
    const reads = vi.spyOn(db, "select");
    await vi.advanceTimersByTimeAsync(90_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    draining = false; await archived(row.id); await quiet();
  });

  it("rechecks current source activity after waiting on an approval writer", async () => {
    const row = await create(old());
    let unlock!: () => void, locked!: () => void;
    const barrier = new Promise<void>(resolve => { unlock = resolve; });
    const admitted = new Promise<void>(resolve => { locked = resolve; });
    const write = db.transaction(async tx => {
      await tx.execute(sql`select id from approvals where id = ${row.id} for update`);
      locked(); await barrier;
      await approvalRecords(tx as unknown as Db).requestRevision(row.id, "board-user");
      await approvalRecords(tx as unknown as Db).resubmit(row.id);
    });
    await admitted;
    const sweep = approvalRetentionService(db).sweep();
    await vi.advanceTimersByTimeAsync(100);
    unlock(); await write; await sweep;
    expect(await state(row.id)).toBeNull();
  });

  async function failArchives() {
    await db.execute(sql`create function approval_retention_fail() returns trigger language plpgsql as $$
      begin
        if new.archived_at is not null and exists (
          select 1 from approvals where id::text = new.source_id and payload->>'retentionTestFailure' = 'true'
        ) then raise exception 'injected approval archive failure'; end if;
        return new;
      end $$`);
    await db.execute(sql`create trigger approval_retention_fail before update on decision_retention
      for each row execute function approval_retention_fail()`);
  }

  it("retains failed durable work across drain and resumes recovery", async () => {
    const row = await approvalRecords(db).create(companyId, { type: "request_board_approval",
      payload: { retentionTestFailure: true }, updatedAt: old() });
    await failArchives();
    await start();
    expect(errors.length).toBeGreaterThan(0); errors.length = 0;
    draining = true;
    await vi.advanceTimersByTimeAsync(60_000);
    const reads = vi.spyOn(db, "select");
    await vi.advanceTimersByTimeAsync(120_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    await db.execute(sql`drop trigger approval_retention_fail on decision_retention`);
    draining = false; await archived(row.id); await quiet();
  });

  it("advances bounded pages past a failed row without losing its retry", async () => {
    const at = old();
    await db.insert(approvals).values(Array.from({ length: 101 }, (_, i) => ({ companyId,
      type: "request_board_approval", payload: { retentionTestFailure: i === 0 },
      createdAt: at, updatedAt: new Date(at.getTime() + i),
    })));
    await failArchives();
    const service = approvalRetentionService(db);
    await expect(service.sweep()).rejects.toThrow("Failed query");
    expect(await service.sweep()).toEqual({ archived: 1 });
    expect((await db.select().from(decisionRetention)).filter(row => row.archivedAt)).toHaveLength(100);
    expect(await service.next()).not.toBeNull();
    await db.execute(sql`drop trigger approval_retention_fail on decision_retention`);
    expect(await service.sweep()).toEqual({ archived: 1 }); expect(await service.next()).toBeNull();
  });

  it("retries a failed approval while newer overdue pages keep arriving", async () => {
    const at = old();
    const [failed] = await db.insert(approvals).values({ companyId, type: "request_board_approval",
      payload: { retentionTestFailure: true }, createdAt: at, updatedAt: at }).returning();
    const append = async (offset: number) => db.insert(approvals).values(Array.from({ length: 100 }, (_, i) => ({
      companyId, type: "request_board_approval", payload: {}, createdAt: at,
      updatedAt: new Date(at.getTime() + offset + i),
    })));
    await append(1); await failArchives();
    const service = approvalRetentionService(db);
    await expect(service.sweep()).rejects.toThrow("Failed query");
    await append(1000); await service.sweep();
    await append(2000);
    await db.execute(sql`drop trigger approval_retention_fail on decision_retention`);
    await service.sweep();
    expect((await state(failed.id))?.archivedAt).toBeInstanceOf(Date);
    while (await service.next() !== null) await service.sweep();
    expect(await service.next()).toBeNull();
  });

  it("reconstructs startup obligations while paused and performs no passive SQL", async () => {
    const row = await create(old()); draining = true;
    await start();
    const reads = vi.spyOn(db, "select");
    await vi.advanceTimersByTimeAsync(120_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    expect(await state(row.id)).toBeNull();
    draining = false; await archived(row.id); await quiet();
  });

  it("matches the feed's first linked issue rather than any visible link", async () => {
    const row = await create(old()), one = await issue(), two = await issue();
    const [first, second] = [one, two].sort((a, b) => a.id.localeCompare(b.id));
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, first.id));
    await issueApprovalService(db).linkManyForApproval(row.id, [second.id, first.id]);
    expect((await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true })).items
      .some(item => item.subject.id === row.id)).toBe(false);
    await start(); await quiet();
    await issueApprovalService(db).unlink(first.id, row.id);
    await archived(row.id); await quiet();
  });

  it("keeps a visible first linked issue eligible when a later link is hidden", async () => {
    const row = await create(old()), one = await issue(), two = await issue();
    const [first, second] = [one, two].sort((a, b) => a.id.localeCompare(b.id));
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, second.id));
    await issueApprovalService(db).linkManyForApproval(row.id, [second.id, first.id]);
    expect((await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true })).items
      .some(item => item.subject.id === row.id)).toBe(true);
    await start(); await archived(row.id); await quiet();
  });

  it("joins an admitted sweep on shutdown and skips subsequent deadline queries", async () => {
    const row = await create(old());
    const service = approvalRetentionService(db), original = service.sweep;
    let release!: () => void, admitted!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const admission = new Promise<void>(resolve => { admitted = resolve; });
    vi.spyOn(service, "sweep").mockImplementation(async (now, signal) => {
      admitted(); await barrier; return original(now, signal);
    });
    const next = vi.spyOn(service, "next");
    const starting = start(service); await admission;
    let stopped = false;
    const stopping = coordinator!.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(100); expect(stopped).toBe(false);
    release(); await starting; await stopping; coordinator = undefined;
    expect(next).not.toHaveBeenCalled(); expect(await state(row.id)).toBeNull();
    await start(); await archived(row.id); await quiet();
  });


  it("uses the shared feed eligibility for a waiting Slack conversation with a pending approval", async () => {
    const [agent] = await db.insert(agents).values({ companyId, name: "Origin", role: "engineer", status: "active", adapterType: "codex_local" }).returning();
    const [app] = await db.insert(toolApplications).values({ companyId, name: "Slack", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: app.id, name: "Slack", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection.id, provider: "slack", publicId: randomUUID(), assignedAgentId: agent.id, status: "active" }).returning();
    const target = await issue();
    await db.update(issues).set({ status: "in_review", assigneeAgentId: agent.id }).where(eq(issues.id, target.id));
    await db.insert(chatConversations).values({ companyId, endpointId: endpoint.id, issueId: target.id, externalConversationId: randomUUID(), externalLabel: "Waiting", state: "waiting" });
    const row = await approvalRecords(db).create(companyId, { type: "request_board_approval", payload: {}, requestedByAgentId: agent.id, updatedAt: old() });
    await issueApprovalService(db).link(target.id, row.id);
    const feed = await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true });
    expect(feed.items.some(item => item.subject.id === row.id)).toBe(true);
    await start(); await archived(row.id); await quiet();
    expect(await db.select().from(decisionArchiveNotificationOutbox)).toMatchObject([
      { sourceId: row.id, originIssueId: target.id, originAgentId: agent.id, status: "pending" },
    ]);
  });


  it("advances past a failed page with full database timestamp precision", async () => {
    await db.execute(sql`insert into approvals(company_id, type, payload, updated_at)
      select ${companyId}, 'request_board_approval', jsonb_build_object('retentionTestFailure', n <= 100),
        date_trunc('milliseconds', now() - interval '91 days') + interval '456 microseconds'
          + case when n <= 100 then interval '0 seconds' else interval '1 second' end
      from generate_series(1, 101) n`);
    await failArchives();
    const service = approvalRetentionService(db);
    await expect(service.sweep()).rejects.toThrow("Approval retention failed");
    expect(await service.sweep()).toEqual({ archived: 1 });
    await db.execute(sql`drop trigger approval_retention_fail on decision_retention`);
    expect(await service.sweep()).toEqual({ archived: 100 });
    expect(await service.sweep()).toEqual({ archived: 0 });
    expect(await service.next()).toBeNull();
  });

});
