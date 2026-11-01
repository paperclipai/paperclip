import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, approvals, companies, createDb, applyPendingMigrations, decisionQueueItems, decisionQueues, decisionRetention, decisionTriageEvents, issueApprovals, issues, issueWorkProducts, subscribeDatabaseWork, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { approvalRecords } from "../services/approvals.js";
import { approvalRetentionService } from "../services/approval-retention.js";
import { approvalQueueSeedingService, registerApprovalQueueSeedingWork } from "../services/approval-queue-seeding-work.js";
import { attentionService } from "../services/attention.js";
import { companyService } from "../services/companies.js";
import { decisionQueueService } from "../services/decision-queues.js";
import { issueApprovalService } from "../services/issue-approvals.js";
import { issueService } from "../services/issues.js";
import { workProductService } from "../services/work-products.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_APPROVAL_QUEUE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("approval queue seeding", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>, companyId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let draining = false;
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else temporary = await startEmbeddedPostgresTestDatabase("approval-queue-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 30_000);
  beforeEach(async () => {
    companyId = randomUUID(); draining = false; errors.length = 0;
    await db.insert(companies).values({ id: companyId, name: "Approval queue", issuePrefix: `Q${companyId.slice(0, 6)}` });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.execute(sql`drop trigger if exists approval_queue_delete_gate on decision_queue_items`);
    await db.execute(sql`drop function if exists approval_queue_delete_gate()`);
    await db.execute(sql`drop trigger if exists approval_queue_fail on decision_queue_items`);
    await db.execute(sql`drop function if exists approval_queue_fail()`);
    await db.delete(decisionTriageEvents); await db.delete(decisionQueueItems); await db.delete(decisionQueues);
    await db.delete(decisionRetention); await db.delete(activityLog); await db.delete(issueApprovals);
    await db.delete(issueWorkProducts); await db.delete(approvals); await db.delete(issues); await db.delete(companies);
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  const authActor = () => ({ type: "board" as const, source: "local_implicit" as const, userId: "board-user", companyIds: [companyId], isInstanceAdmin: true });
  const actor = { actorType: "user" as const, actorId: "board-user", agentId: null, userId: "board-user", runId: null, agentApiKeyId: null, responsibleUserId: "board-user" };
  const mutation = () => ({ companyId, key: "prs", authActor: authActor(), actor });
  const memberships = () => db.select().from(decisionQueueItems).where(eq(decisionQueueItems.companyId, companyId));
  const createApproval = (database: Db = db) => approvalRecords(database).create(companyId, { type: "request_board_approval", payload: {} });
  async function issue(hiddenAt: Date | null = null) {
    const [row] = await db.insert(issues).values({ companyId, title: "Review PR", status: "todo", hiddenAt }).returning();
    return row;
  }
  const product = (issueId: string, type = "pull_request") => workProductService(db).createForIssue(issueId, companyId, { type, provider: "github", title: "PR", status: "open" });
  async function pending(target?: string) {
    const targetId = target ?? (await issue()).id;
    if (!target) await product(targetId);
    const approval = await createApproval();
    await issueApprovalService(db).link(targetId, approval.id);
    return approval;
  }
  async function start(service = approvalQueueSeedingService(db)) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true, onError: error => errors.push(error) });
    await registerApprovalQueueSeedingWork(coordinator, service, () => !draining).ready;
    return service;
  }
  async function settle() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 5000 });
  }
  async function seeded(id: string) {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await memberships()).toEqual(expect.arrayContaining([expect.objectContaining({ sourceKind: "approval", sourceId: id })]));
    }, { timeout: 5000 });
  }
  async function quiet() {
    await settle(); expect(coordinator!.nextWakeAt()).toBeNull();
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction"), executes = vi.spyOn(db, "execute");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore(); executes.mockRestore();
  }

  it("retains a company commit arriving during its final empty read", async () => {
    const service = approvalQueueSeedingService(db);
    await service.sweep();
    expect(await service.next()).toBeNull();
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.approvalQueueSeeding, (event, hints) => {
      if (event === "settled") service.request(hints);
    });
    const select = db.select.bind(db);
    let release!: () => void, observed!: () => void;
    const observedEmpty = new Promise<void>(resolve => { observed = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let intercepted = false;
    const reads = vi.spyOn(db, "select").mockImplementation((...args: any[]) => {
      const query = (select as any)(...args);
      const from = query.from.bind(query);
      query.from = (...tables: any[]) => {
        const builder = from(...tables);
        const limit = builder.limit.bind(builder);
        builder.limit = (count: number) => {
          const result = limit(count);
          if (count === 1 && !intercepted) {
            intercepted = true;
            const then = result.then.bind(result);
            result.then = (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
              then(async (rows: unknown[]) => { observed(); await barrier; return resolve(rows); }, reject);
          }
          return result;
        };
        return builder;
      };
      return query;
    });
    service.request(new Set([companyId]));
    const sweep = service.sweep();
    try {
      await observedEmpty;
      const approval = await pending();
      release(); await sweep; reads.mockRestore();
      expect(await service.next()).not.toBeNull();
      await service.sweep();
      expect(await memberships()).toEqual([expect.objectContaining({ sourceId: approval.id })]);
      expect(await service.next()).toBeNull();
    } finally { release(); await sweep; reads.mockRestore(); unsubscribe(); }
  });

  it("does not let a company write reconcile another company's approvals", async () => {
    await start(); await quiet();
    const foreignId = randomUUID();
    await db.insert(companies).values({ id: foreignId, name: "Other tenant", issuePrefix: `F${foreignId.slice(0, 6)}` });
    const [foreignIssue] = await db.insert(issues).values({ companyId: foreignId, title: "Other PR", status: "todo" }).returning();
    const [foreignApproval] = await db.insert(approvals).values({ companyId: foreignId, type: "request_board_approval", payload: {} }).returning();
    await db.insert(issueApprovals).values({ companyId: foreignId, issueId: foreignIssue.id, approvalId: foreignApproval.id });
    await db.insert(issueWorkProducts).values({ companyId: foreignId, issueId: foreignIssue.id, type: "pull_request", provider: "github", title: "Other PR", status: "open" });
    const ownApproval = await pending(); await seeded(ownApproval.id); await quiet();
    expect(await db.select().from(decisionQueueItems).where(eq(decisionQueueItems.companyId, foreignId))).toEqual([]);
    await companyService(db).update(foreignId, { status: "paused" }); await settle();
    await companyService(db).update(foreignId, { status: "active" });
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(await db.select().from(decisionQueueItems).where(eq(decisionQueueItems.companyId, foreignId)))
        .toEqual([expect.objectContaining({ sourceId: foreignApproval.id })]);
    });
    await quiet();
  });

  it("populates the PR queue without an attention reader after approvals leave retention maintenance", async () => {
    await start(); await quiet();
    const approval = await pending();
    await approvalRetentionService(db).sweep();
    await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true, excludeSources: ["approval", "join_request"] });
    await seeded(approval.id);
    expect((await decisionQueueService(db).list(companyId, authActor())).map(queue => queue.key)).toContain("prs");
    expect(await decisionQueueService(db).listItems(companyId, "prs", authActor())).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKind: "approval", sourceId: approval.id }),
    ]));
    await quiet();
  });

  it("recovers startup projection debt and stays quiet with already seeded and completed history", async () => {
    const first = await pending(), completed = await pending();
    await approvalRecords(db).resolveApproval(completed.id, "approved", "board-user", null);
    await start(); await seeded(first.id); await quiet();
    expect((await memberships()).map(row => row.sourceId)).toEqual([first.id]);
    await coordinator!.stop(); coordinator = undefined;
    await start(); await quiet();
    expect(await db.select().from(decisionTriageEvents).where(eq(decisionTriageEvents.action, "queue_item.seeded"))).toHaveLength(1);
  });

  it("wakes when a work product creates the first PR match", async () => {
    const target = await issue(), approval = await pending(target.id);
    await start(); await quiet(); expect(await memberships()).toEqual([]);
    const row = await product(target.id, "artifact"); await quiet();
    await workProductService(db).update(row!.id, { type: "pull_request" });
    await seeded(approval.id); await quiet();
  });

  it("wakes from batch-imported PR work products", async () => {
    const target = await issue(), approval = await pending(target.id);
    await start(); await quiet();
    await workProductService(db).createManyForImport([{ companyId, issueId: target.id, type: "pull_request", provider: "github", title: "Imported PR", status: "open", reviewState: "none", isPrimary: false, healthStatus: "unknown" }]);
    await seeded(approval.id); await quiet();
  });

  it("honors hidden targets and wakes when visibility changes", async () => {
    const target = await issue(new Date()); await product(target.id); const approval = await pending(target.id);
    await start(); await quiet(); expect(await memberships()).toEqual([]);
    await issueService(db).update(target.id, { hiddenAt: null }); await seeded(approval.id); await quiet();
  });

  it("uses the first linked issue and reevaluates after unlink", async () => {
    const first = await issue(), second = await issue();
    const [withoutPr, withPr] = [first, second].sort((a, b) => a.id.localeCompare(b.id));
    await product(withPr.id);
    const approval = await pending(withoutPr.id); await issueApprovalService(db).link(withPr.id, approval.id);
    await start(); await quiet(); expect(await memberships()).toEqual([]);
    await issueApprovalService(db).unlink(withoutPr.id, approval.id); await seeded(approval.id); await quiet();
  });

  it("does not infer PRs from a later link or another company's work product", async () => {
    const target = await issue(), approval = await pending(target.id);
    const foreignId = randomUUID(); await db.insert(companies).values({ id: foreignId, name: "Other", issuePrefix: "OTHER" });
    await db.insert(issueWorkProducts).values({ companyId: foreignId, issueId: target.id, type: "pull_request", provider: "github", title: "Invalid foreign product", status: "open" });
    await start(); await quiet(); expect(await memberships()).toEqual([]);
    await product(target.id); await seeded(approval.id); await quiet();
  });

  it("keeps disabled seeds quiet and wakes when the queue rule is enabled", async () => {
    await db.insert(decisionQueues).values({ companyId, key: "prs", title: "PRs", createdByType: "system", seedRulesEnabled: false });
    const approval = await pending(); await start(); await quiet(); expect(await memberships()).toEqual([]);
    await decisionQueueService(db).update({ ...mutation(), patch: { seedRulesEnabled: true } });
    await seeded(approval.id); await quiet();
  });

  it("waits for company activation", async () => {
    const approval = await pending(); await companyService(db).update(companyId, { status: "paused" });
    await start(); await quiet(); expect(await memberships()).toEqual([]);
    await companyService(db).update(companyId, { status: "active" }); await seeded(approval.id); await quiet();
  });

  it("waits for resubmission and never removes retained membership after approval", async () => {
    const approval = await pending(); await approvalRecords(db).requestRevision(approval.id, "board-user");
    await start(); await quiet(); expect(await memberships()).toEqual([]);
    await approvalRecords(db).resubmit(approval.id); await seeded(approval.id);
    await approvalRecords(db).resolveApproval(approval.id, "approved", "board-user", null); await quiet();
    expect(await memberships()).toHaveLength(1);
  });

  it("waits for outer commit and discards rolled-back producers", async () => {
    const target = await issue(); await product(target.id); await start(); await quiet();
    await expect(db.transaction(async tx => {
      const approval = await createApproval(tx as unknown as Db);
      await issueApprovalService(tx as unknown as Db).link(target.id, approval.id);
      await vi.advanceTimersByTimeAsync(5_000); expect(await memberships()).toEqual([]);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await quiet();
    let id = "";
    await db.transaction(async tx => {
      id = (await createApproval(tx as unknown as Db)).id;
      await issueApprovalService(tx as unknown as Db).link(target.id, id);
      await vi.advanceTimersByTimeAsync(5_000); expect(await memberships()).toEqual([]);
    });
    await seeded(id); await quiet();
  });

  it("retains the first write during drain without passive SQL", async () => {
    await start(); await quiet(); draining = true;
    const approval = await pending();
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore();
    expect(await memberships()).toEqual([]); draining = false;
    await seeded(approval.id); await quiet();
  });

  it("recovers a failed projection after drain and stops retrying once it commits", async () => {
    const service = approvalQueueSeedingService(db), sweep = service.sweep;
    let running = false;
    service.sweep = async signal => { running = true; try { await sweep(signal); } finally { running = false; } };
    await start(service); await quiet();
    await db.execute(sql`create function approval_queue_fail() returns trigger language plpgsql as $$ begin raise exception 'projection unavailable'; end $$`);
    await db.execute(sql`create trigger approval_queue_fail before insert on decision_queue_items for each row execute function approval_queue_fail()`);
    const approval = await pending();
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1_000); expect(errors.length).toBeGreaterThan(0); }, { timeout: 5000 });
    draining = true;
    await vi.waitFor(() => expect(running).toBe(false), { timeout: 5000 });
    const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(60_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    await db.execute(sql`drop trigger approval_queue_fail on decision_queue_items`); errors.length = 0;
    draining = false; await seeded(approval.id); await quiet();
  });

  it("backs off persistent projection failures without forgetting the owed membership", async () => {
    const service = approvalQueueSeedingService(db);
    await service.sweep();
    const approval = await pending();
    service.request(new Set([companyId]));
    await db.execute(sql`create function approval_queue_fail() returns trigger language plpgsql as $$ begin raise exception 'projection unavailable'; end $$`);
    await db.execute(sql`create trigger approval_queue_fail before insert on decision_queue_items for each row execute function approval_queue_fail()`);
    const transactions = vi.spyOn(db, "transaction");
    try {
      for (let second = 0; second < 120; second++) {
        service.request(new Set([companyId]));
        await service.sweep().catch(() => undefined);
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(transactions.mock.calls.length).toBeLessThanOrEqual(8);
      expect(transactions.mock.calls.length).toBeGreaterThan(1);
      expect(await memberships()).toEqual([]);
      expect(await service.next()).not.toBeNull();
    } finally {
      transactions.mockRestore();
      await db.execute(sql`drop trigger approval_queue_fail on decision_queue_items`);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    await service.sweep();
    expect(await memberships()).toEqual([expect.objectContaining({ sourceId: approval.id })]);
    expect(await service.next()).toBeNull();
  });

  it("resets consecutive failure backoff after a successful batch with remaining debt", async () => {
    const target = await issue(); await product(target.id);
    const rows = await db.insert(approvals).values(Array.from({ length: 101 }, () => ({
      companyId, type: "request_board_approval", payload: {},
    }))).returning();
    await db.insert(issueApprovals).values(rows.map(row => ({ companyId, issueId: target.id, approvalId: row.id })));
    const service = approvalQueueSeedingService(db);
    await db.execute(sql`create function approval_queue_fail() returns trigger language plpgsql as $$ begin raise exception 'projection unavailable'; end $$`);
    const fail = () => db.execute(sql`create trigger approval_queue_fail before insert on decision_queue_items for each row execute function approval_queue_fail()`);
    await fail();
    for (let attempt = 0; attempt < 7; attempt++) {
      await expect(service.sweep()).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await db.execute(sql`drop trigger approval_queue_fail on decision_queue_items`);
    await service.sweep();
    expect(await memberships()).toHaveLength(1); expect(service.next()).not.toBeNull();
    await fail();
    const at = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      await expect(service.sweep()).rejects.toThrow("Approval queue seeding failed");
      expect(service.next()).toBe(at + 1000);
    } finally { clock.mockRestore(); }
    await db.execute(sql`drop trigger approval_queue_fail on decision_queue_items`);
    await vi.advanceTimersByTimeAsync(60_000); await service.sweep();
    expect(service.next()).not.toBeNull(); await service.sweep();
    expect(await memberships()).toHaveLength(101); expect(service.next()).toBeNull();
  });

  it("preserves outage backoff across an empty cursor rollover", async () => {
    const target = await issue(); await product(target.id);
    const rows = await db.insert(approvals).values(Array.from({ length: 100 }, () => ({
      companyId, type: "request_board_approval", payload: {},
    }))).returning();
    await db.insert(issueApprovals).values(rows.map(row => ({ companyId, issueId: target.id, approvalId: row.id })));
    const service = approvalQueueSeedingService(db);
    await db.execute(sql`create function approval_queue_fail() returns trigger language plpgsql as $$ begin raise exception 'projection unavailable'; end $$`);
    await db.execute(sql`create trigger approval_queue_fail before insert on decision_queue_items for each row execute function approval_queue_fail()`);
    await expect(service.sweep()).rejects.toThrow("Approval queue seeding failed");
    await vi.advanceTimersByTimeAsync(1000); await service.sweep();
    expect(await memberships()).toEqual([]); expect(service.next()).not.toBeNull();
    const at = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      await expect(service.sweep()).rejects.toThrow("Approval queue seeding failed");
      expect(service.next()).toBe(at + 2000);
    } finally { clock.mockRestore(); }
    await db.execute(sql`drop trigger approval_queue_fail on decision_queue_items`);
    await vi.advanceTimersByTimeAsync(60_000); await service.sweep(); await service.sweep();
    expect(await memberships()).toHaveLength(100); expect(service.next()).toBeNull();
  });

  it("keeps backoff SQL-quiet while another company's committed work proceeds", async () => {
    const service = approvalQueueSeedingService(db), sweep = service.sweep;
    let running = false;
    service.sweep = async signal => { running = true; try { await sweep(signal); } finally { running = false; } };
    await start(service); await quiet();
    await db.execute(sql`create function approval_queue_fail() returns trigger language plpgsql as $$ begin
      if new.company_id::text = TG_ARGV[0] then raise exception 'projection unavailable'; end if; return new; end $$`);
    await db.execute(sql`create trigger approval_queue_fail before insert on decision_queue_items for each row execute function approval_queue_fail(${sql.raw("'" + companyId + "'")})`);
    const approval = await pending();
    for (let count = 1; count <= 7; count++) {
      await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(errors.length).toBeGreaterThanOrEqual(count); }, { timeout: 5000 });
      await vi.waitFor(() => expect(running).toBe(false));
    }
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore();
    const otherId = randomUUID();
    await db.insert(companies).values({ id: otherId, name: "Healthy tenant", issuePrefix: `H${otherId.slice(0, 6)}` });
    const [otherIssue] = await db.insert(issues).values({ companyId: otherId, title: "Other PR", status: "todo" }).returning();
    await workProductService(db).createForIssue(otherIssue.id, otherId, { type: "pull_request", provider: "github", title: "Other PR", status: "open" });
    const otherApproval = await approvalRecords(db).create(otherId, { type: "request_board_approval", payload: {} });
    await issueApprovalService(db).link(otherIssue.id, otherApproval.id);
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(await db.select().from(decisionQueueItems).where(eq(decisionQueueItems.companyId, otherId)))
        .toEqual([expect.objectContaining({ sourceId: otherApproval.id })]);
    }, { timeout: 5000 });
    expect(await memberships()).toEqual([]);
    await db.execute(sql`drop trigger approval_queue_fail on decision_queue_items`); errors.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    await seeded(approval.id); await quiet();
  });

  it("drains multiple pages without duplicating memberships or audit events", async () => {
    const target = await issue(); await product(target.id);
    const rows = await db.insert(approvals).values(Array.from({ length: 101 }, () => ({ companyId, type: "request_board_approval", payload: {} }))).returning();
    await db.insert(issueApprovals).values(rows.map(row => ({ companyId, issueId: target.id, approvalId: row.id })));
    await start();
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1_000); expect(await memberships()).toHaveLength(101); }, { timeout: 10_000 });
    await quiet();
    await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true }); await quiet();
    expect(await memberships()).toHaveLength(101);
    expect(await db.select().from(decisionTriageEvents).where(eq(decisionTriageEvents.action, "queue_item.seeded"))).toHaveLength(101);
  });

  it("preserves the seed rule after manual removal of a still-matching item", async () => {
    const approval = await pending(); await start(); await seeded(approval.id); await quiet();
    await decisionQueueService(db).removeItem({ ...mutation(), sourceKind: "approval", sourceId: approval.id });
    await seeded(approval.id); await quiet(); expect(await memberships()).toHaveLength(1);
  });
  it("pages past failed projections and revisits them after recovery", async () => {
    const target = await issue(); await product(target.id);
    const rows = await db.insert(approvals).values(Array.from({ length: 101 }, () => ({ companyId, type: "request_board_approval", payload: {} }))).returning();
    await db.insert(issueApprovals).values(rows.map(row => ({ companyId, issueId: target.id, approvalId: row.id })));
    const last = rows.map(row => row.id).sort().at(-1)!;
    await db.execute(sql`create function approval_queue_fail() returns trigger language plpgsql as $$ begin
      if new.source_id <> TG_ARGV[0] then raise exception 'projection unavailable'; end if; return new; end $$`);
    await db.execute(sql`create trigger approval_queue_fail before insert on decision_queue_items for each row execute function approval_queue_fail(${sql.raw("'" + last + "'")})`);
    const service = approvalQueueSeedingService(db);
    await expect(service.sweep()).rejects.toThrow("Approval queue seeding failed");
    await vi.advanceTimersByTimeAsync(1000);
    await service.sweep(); expect((await memberships()).map(row => row.sourceId)).toEqual([last]);
    await db.execute(sql`drop trigger approval_queue_fail on decision_queue_items`);
    await service.sweep(); expect(await memberships()).toHaveLength(101); expect(await service.next()).toBeNull();
  });

  it("retries a failed membership while new matching pages keep arriving", async () => {
    const target = await issue(); await product(target.id);
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const append = async (start: number, count: number) => {
      const rows = await db.insert(approvals).values(Array.from({ length: count }, (_, offset) => ({
        id: id(start + offset), companyId, type: "request_board_approval", payload: {},
      }))).returning();
      await db.insert(issueApprovals).values(rows.map(row => ({ companyId, issueId: target.id, approvalId: row.id })));
    };
    const service = approvalQueueSeedingService(db); await service.sweep();
    await append(1, 101); service.request(new Set([companyId]));
    await db.execute(sql`create function approval_queue_fail() returns trigger language plpgsql as $$ begin
      if new.source_id = TG_ARGV[0] then raise exception 'projection unavailable'; end if; return new; end $$`);
    await db.execute(sql`create trigger approval_queue_fail before insert on decision_queue_items for each row execute function approval_queue_fail(${sql.raw("'" + id(1) + "'")})`);
    await expect(service.sweep()).rejects.toThrow("Failed query");
    await append(102, 100); service.request(new Set([companyId]));
    await vi.advanceTimersByTimeAsync(1000); await service.sweep();
    await append(202, 100); service.request(new Set([companyId]));
    await db.execute(sql`drop trigger approval_queue_fail on decision_queue_items`);
    await service.sweep();
    expect((await memberships()).some(row => row.sourceId === id(1))).toBe(true);
    for (let pass = 0; pass < 4 && service.next() !== null; pass++) await service.sweep();
    expect(await memberships()).toHaveLength(301); expect(service.next()).toBeNull();
  });

  it("rechecks the approval after a concurrent resolution commits", async () => {
    const approval = await pending(); let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), admitted = new Promise<void>(resolve => { locked = resolve; });
    const write = db.transaction(async tx => {
      await tx.execute(sql`select id from approvals where id = ${approval.id} for update`); locked(); await gate;
      await approvalRecords(tx as unknown as Db).resolveApproval(approval.id, "approved", "board-user", null);
    });
    await admitted; const sweep = approvalQueueSeedingService(db).sweep();
    await vi.advanceTimersByTimeAsync(100); release(); await write; await sweep;
    expect(await memberships()).toEqual([]);
  });

  it("preserves startup debt during drain and reconstructs unprocessed work after shutdown", async () => {
    const approval = await pending(); draining = true; await start();
    const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(60_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    await coordinator!.stop(); coordinator = undefined;
    expect(await memberships()).toEqual([]);
    draining = false; await start(); await seeded(approval.id); await quiet();
  });

  it("preserves seeding for kept and archived approvals", async () => {
    const approval = await pending();
    await db.insert(decisionRetention).values({ companyId, sourceKind: "approval", sourceId: approval.id,
      sourceActivityAt: approval.updatedAt, keep: true, archivedAt: new Date() });
    await start(); await seeded(approval.id); await quiet();
  });

  it("waits for an admitted transaction on shutdown and leaves the next row recoverable", async () => {
    await pending(); await pending();
    let release!: () => void, admitted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { admitted = resolve; });
    const transaction = db.transaction.bind(db);
    const intercepted = vi.spyOn(db, "transaction").mockImplementationOnce(async callback => {
      admitted(); await gate; return transaction(callback);
    });
    const started = start(); await entered;
    let stopped = false;
    const stopping = coordinator!.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(100); expect(stopped).toBe(false);
    release(); await started; await stopping; coordinator = undefined; intercepted.mockRestore();
    expect(await memberships()).toHaveLength(1);
    await start(); await quiet(); expect(await memberships()).toHaveLength(2);
  });

  it("serializes manual removal and automatic seeding without a queue/item lock cycle", async () => {
    const approval = await pending();
    const [link] = await db.select().from(issueApprovals).where(eq(issueApprovals.approvalId, approval.id));
    const queues = decisionQueueService(db);
    const seed = () => queues.materializeSeedSources(companyId, [{ sourceKind: "approval", sourceId: approval.id, issueId: link.issueId }]);
    await seed();
    await db.execute(sql`create function approval_queue_delete_gate() returns trigger language plpgsql as $$ begin
      perform pg_advisory_xact_lock(hashtext(TG_ARGV[0])); return old; end $$`);
    await db.execute(sql`create trigger approval_queue_delete_gate after delete on decision_queue_items for each row execute function approval_queue_delete_gate(${sql.raw("'" + companyId + "'")})`);
    const blocker = await db.$client.reserve();
    await blocker`select pg_advisory_lock(hashtext(${companyId}))`;
    let complete: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const removed = queues.removeItem({ ...mutation(), sourceKind: "approval", sourceId: approval.id });
      await vi.waitFor(async () => {
        const [row] = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity
          where datname = current_database() and state = 'active' and wait_event = 'advisory'`);
        expect(row.count).toBeGreaterThan(0);
      }, { timeout: 5000 });
      complete = Promise.allSettled([removed, seed()]);
      await vi.waitFor(async () => {
        const [row] = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity
          where datname = current_database() and state = 'active' and wait_event_type = 'Lock' and wait_event <> 'advisory'`);
        expect(row.count).toBeGreaterThan(0);
      }, { timeout: 5000 });
    } finally {
      await blocker`select pg_advisory_unlock_all()`; blocker.release();
    }
    const results = await complete!;
    expect(results.map(result => result.status), results.filter(result => result.status === "rejected").map(result => String(result.reason?.cause?.message ?? result.reason)).join("; ")).toEqual(["fulfilled", "fulfilled"]);
    expect(await memberships()).toHaveLength(1);
  });

});
