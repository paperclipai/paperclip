import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authUsers, companyMemberships, agents, approvals, budgetIncidents, budgetPolicies, companies, createDb, applyPendingMigrations, decisionArchiveNotificationOutbox,
  decisionRetention, decisions, costEvents, heartbeatRunEvents, heartbeatRuns, issueApprovals, issueRecoveryActions,
  issueRelations, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { attentionRetentionService, registerAttentionRetentionWork } from "../services/attention-retention.js";
import { budgetService } from "../services/budgets.js";
import { writeExecutionControl } from "../services/execution-control-notifications.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { attentionService } from "../services/attention.js";
import { companyService } from "../services/companies.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { decisionRetentionService, DEFAULT_DECISION_ARCHIVE_DAYS } from "../services/decision-retention.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { issueService } from "../services/issues.js";
import { notifyAttentionRetentionWork } from "../services/retention-work-notifications.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATTENTION_RETENTION_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const delay = DEFAULT_DECISION_ARCHIVE_DAYS * 86_400_000;
(support.supported ? describe : describe.skip)("remaining attention retention", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let companyId: string, agentId: string, draining = false;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const errors: unknown[] = [];
  const statements: string[] = [];
  beforeAll(async () => {
    if (externalUrl) await applyPendingMigrations(externalUrl);
    else temporary = await startEmbeddedPostgresTestDatabase("attention-retention-");
    db = createDb(externalUrl ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    db.$client.options.onnotice = () => {};
    db.$client.options.debug = (_connection, query) => statements.push(query);
  }, 30_000);
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); draining = false; errors.length = 0;
    await db.insert(companies).values({ id: companyId, name: "Retention", issuePrefix: `A${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: "board", name: "Board", email: "board@retention.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board", membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Origin", role: "engineer", status: "active" });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.transaction(async tx => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`drop trigger if exists attention_retention_fail on decision_retention`);
      await tx.execute(sql`drop function if exists attention_retention_fail()`);
      await tx.execute(sql`truncate companies cascade`);
    });
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  const old = () => new Date(Date.now() - delay - 600_000);
  async function insertIssue(status = "todo", values: Partial<typeof issues.$inferInsert> = {}, database: Db = db) {
    const [row] = await database.insert(issues).values({ companyId, title: randomUUID(), status,
      createdByAgentId: agentId, createdAt: old(), updatedAt: old(), ...values }).returning();
    return row;
  }
  async function change<T>(write: (tx: Db) => PromiseLike<T>, scope = { companyId }) {
    return db.transaction(async tx => { await notifyAttentionRetentionWork(tx, scope); return write(tx as unknown as Db); });
  }
  const state = (kind: string, id: string) => db.select().from(decisionRetention).where(and(
    eq(decisionRetention.companyId, companyId), eq(decisionRetention.sourceKind, kind), eq(decisionRetention.sourceId, id)))
    .then(rows => rows[0] ?? null);
  async function settle() {
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); }, { timeout: 15_000 });
  }
  async function quiet() {
    await settle(); expect(coordinator!.nextWakeAt()).toBeNull();
    const select = vi.spyOn(db, "select"), execute = vi.spyOn(db, "execute"), transaction = vi.spyOn(db, "transaction");
    statements.length = 0;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(statements).toEqual([]);
    expect(select).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
    select.mockRestore(); execute.mockRestore(); transaction.mockRestore();
  }
  async function start(service = attentionRetentionService(db)) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true, onError: error => errors.push(error) });
    await registerAttentionRetentionWork(coordinator, service, () => !draining).ready;
    return service;
  }
  async function archived(kind: string, id: string) {
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect((await state(kind, id))?.archivedAt).toBeInstanceOf(Date); }, { timeout: 15_000 });
  }
  async function loadAll(service = attentionRetentionService(db)) {
    const entries = [];
    for (;;) { const page = await service.load({ companyId }); entries.push(...page.rows ?? []); if (page.complete) return entries; }
  }
  const mutation = (sourceKind: "review", sourceId: string) => ({ companyId, sourceKind, sourceId,
    authActor: { type: "board" as const, source: "local_implicit" as const, userId: "board", companyIds: [companyId], isInstanceAdmin: true },
    actor: { actorType: "user" as const, actorId: "board", userId: "board", agentId: null, runId: null, agentApiKeyId: null, responsibleUserId: "board" } });

  it("records the aggregate baseline SQL across old ticks and eliminates it after settlement", async () => {
    await insertIssue("done");
    const ticks: number[] = [];
    for (let tick = 0; tick < 3; tick++) {
      statements.length = 0;
      const feed = await attentionService(db).list(companyId, { includeDismissed: true, excludeSources: ["approval", "join_request"], all: true, allowUnscopedAll: true });
      await decisionRetentionService(db).autoArchive({ companyId, items: feed.items });
      ticks.push(statements.length);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(ticks.every(count => count > 0)).toBe(true);
    process.stdout.write(JSON.stringify({ baselineStatementsPer30sTick: ticks, treatmentIdle300s: 0 }) + "\n");
    await start(); await quiet();
  });

  it("has no recurring SQL when empty or when terminal source history remains", async () => {
    await insertIssue("done"); await insertIssue("cancelled");
    await start(); await quiet();
  });

  it("wakes from the ordinary task producer, waits until due, archives with an outbox, and settles", async () => {
    await start(); await quiet();
    const row = await issueService(db).create(companyId, { title: "Review a delivered result", status: "in_review", assigneeUserId: "board", createdByAgentId: agentId });
    await settle();
    const [saved] = await db.select({ at: sql<number>`ceil(extract(epoch from ${issues.updatedAt}) * 1000)`.mapWith(Number) }).from(issues).where(eq(issues.id, row.id));
    const due = saved.at + delay;
    expect(coordinator!.nextWakeAt()).toBe(due); expect(await state("review", row.id)).toBeNull();
    const select = vi.spyOn(db, "select"), execute = vi.spyOn(db, "execute");
    await vi.advanceTimersByTimeAsync(due - Date.now() - 1000);
    expect(select).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); select.mockRestore(); execute.mockRestore();
    await vi.advanceTimersByTimeAsync(2000); await archived("review", row.id); await quiet();
    const outbox = await db.select().from(decisionArchiveNotificationOutbox);
    expect(outbox).toHaveLength(1); expect(outbox[0]).toMatchObject({ companyId, sourceKind: "review", sourceId: row.id, originAgentId: agentId, originIssueId: row.id });
    expect((await db.select().from(issues).where(eq(issues.id, row.id)))[0].status).toBe("in_review");
    await coordinator!.stop(); coordinator = undefined; await start(); await quiet();
  });

  it("registers the ordinary createChild blocker path inside its relation transaction", async () => {
    const parent = await issueService(db).create(companyId, { title: "Parent", status: "in_progress", assigneeAgentId: agentId, createdByAgentId: agentId });
    await start(); await quiet();
    const { issue: child, parentBlockerAdded } = await issueService(db).createChild(parent.id, {
      title: "Child needs review", status: "in_review", assigneeUserId: "board", createdByAgentId: agentId,
      blockParentUntilDone: true,
    });
    expect(parentBlockerAdded).toBe(true);
    expect(await db.select().from(issueRelations).where(and(eq(issueRelations.issueId, child.id),
      eq(issueRelations.relatedIssueId, parent.id)))).toHaveLength(1);
    await settle(); expect(coordinator!.nextWakeAt()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(delay + 2000); await archived("review", child.id); await quiet();
    expect(await db.select().from(decisionArchiveNotificationOutbox).where(eq(decisionArchiveNotificationOutbox.sourceId, child.id))).toHaveLength(1);
  });

  it("batches a full page of maintained reviews and confirmations by company", async () => {
    const rows = await db.insert(issues).values(Array.from({ length: 100 }, () => ({ companyId,
      title: randomUUID(), status: "in_review", assigneeAgentId: agentId, updatedAt: old() }))).returning();
    await db.insert(issueThreadInteractions).values(rows.map(row => ({ companyId, issueId: row.id,
      kind: "request_confirmation", addresseeAgentId: agentId, payload: { version: 1, prompt: "Agent verdict" } })));
    statements.length = 0;
    const page = await attentionRetentionService(db).load({ companyId, sourceKind: "review" });
    expect(page.rows).toEqual([]); expect(page.complete).toBe(false);
    expect(statements.length).toBeLessThanOrEqual(20);
    expect(statements.filter(query => query.includes('from "agents"')).length).toBeLessThanOrEqual(1);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    statements.length = 0;
    const interactions = await attentionRetentionService(db).load({ companyId, sourceKind: "issue_thread_interaction" });
    expect(interactions.rows).toHaveLength(100); expect(interactions.complete).toBe(false);
    expect(statements.length).toBeLessThanOrEqual(6);
    expect(statements.filter(query => query.includes('from "agents"'))).toHaveLength(1);
  });

  it("scopes ordinary execution-control writes to their company", async () => {
    const otherCompany = randomUUID();
    await db.insert(companies).values({ id: otherCompany, name: "Other", issuePrefix: "OTHER" });
    await db.insert(issues).values(Array.from({ length: 125 }, () => ({ companyId: otherCompany,
      title: randomUUID(), status: "in_review", assigneeUserId: "board", updatedAt: old() })));
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
    const service = attentionRetentionService(db), load = vi.spyOn(service, "load");
    await start(service); await quiet(); load.mockClear();
    for (let count = 0; count < 3; count++) {
      await writeExecutionControl(db, DELIVERY_QUEUES.executionFinalization,
        tx => tx.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, run.id)), { companyId });
      await quiet();
    }
    expect(load).toHaveBeenCalled();
    expect(load.mock.calls.every(([scope]) => scope?.companyId === companyId)).toBe(true);
  });

  it("registers and cancels budget deadlines through ordinary policy and incident producers", async () => {
    const service = budgetService(db);
    await service.upsertPolicy(companyId, { scopeType: "agent", scopeId: agentId, amount: 100,
      warnPercent: 85, hardStopEnabled: false, notifyEnabled: true }, "board");
    const retention = attentionRetentionService(db), load = vi.spyOn(retention, "load");
    await start(retention); await quiet(); load.mockClear();
    const [event] = await db.insert(costEvents).values({ companyId, agentId, provider: "openai", biller: "openai",
      billingType: "metered_api", model: "fixture", inputTokens: 100, outputTokens: 20,
      costCents: 90, occurredAt: new Date() }).returning();
    await service.evaluateCostEvent(event);
    await settle(); expect(coordinator!.nextWakeAt()).not.toBeNull();
    const [incident] = await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, companyId));
    expect(incident).toMatchObject({ status: "open", thresholdType: "soft" });
    expect(await state("budget_alert", incident.id)).toBeNull();
    await service.upsertPolicy(companyId, { scopeType: "agent", scopeId: agentId, amount: 200 }, "board");
    await quiet();
    expect((await db.select().from(budgetIncidents).where(eq(budgetIncidents.id, incident.id)))[0].status).toBe("resolved");
    expect(load.mock.calls.every(([scope]) => scope?.companyId === companyId)).toBe(true);
  });

  it("matches the existing feed across all eight remaining source kinds and exclusion variants", async () => {
    const origin = await insertIssue();
    const review = await insertIssue("in_review", { assigneeUserId: "board" });
    const blocker = await insertIssue("blocked", { unblockDescriptor: { owner: "board", action: "Choose a dependency" }, blockedTransitionAt: old() });
    await insertIssue("in_review", { hiddenAt: old(), assigneeUserId: "board" });
    const hidden = await insertIssue("todo", { hiddenAt: old() });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", contextSnapshot: { issueId: origin.id }, createdAt: old(), updatedAt: old(), finishedAt: old() }).returning();
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: run.id, seq: 1, eventType: "lifecycle", message: "Bounded retry exhausted: fixture" });
    await db.insert(decisions).values({ companyId, originAgentId: agentId, originIssueId: origin.id, originRunId: run.id,
      title: "Decision", body: "Choose", options: [], signedSpec: "fixture", targetSnapshots: {}, expiresAt: new Date(Date.now() + 86_400_000), updatedAt: old() });
    await db.insert(issueThreadInteractions).values([
      { companyId, issueId: origin.id, kind: "ask_user_questions", payload: { questions: [] }, updatedAt: old() },
      { companyId, issueId: origin.id, kind: "ask_user_questions", payload: { questions: [] }, addresseeAgentId: agentId, updatedAt: old() },
      { companyId, issueId: origin.id, kind: "ask_user_questions", payload: { questions: [] }, addresseeUserId: "board", updatedAt: old() },
      { companyId, issueId: hidden.id, kind: "ask_user_questions", payload: { questions: [] }, updatedAt: old() },
    ]);
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: origin.id, kind: "execution", ownerType: "board", cause: "fixture", fingerprint: "fixture", nextAction: "Choose", updatedAt: old() });
    const [policy] = await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId, windowKind: "calendar_month_utc", amount: 100 }).returning();
    await db.insert(budgetIncidents).values({ companyId, policyId: policy.id, scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "calendar_month_utc", windowStart: old(), windowEnd: new Date(), thresholdType: "hard", amountLimit: 100, amountObserved: 100, updatedAt: old() });
    await db.insert(agents).values({ companyId, name: "Error", role: "engineer", status: "error", updatedAt: old() });
    const feed = await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true, includeDismissed: true, excludeSources: ["approval", "join_request"] });
    const expected = [...new Set(feed.items.map(item => `${item.sourceKind}:${item.subject.id}`))].sort();
    const actual = [...new Set((await loadAll()).map(item => `${item.sourceKind}:${item.sourceId}`))].sort();
    expect(new Set(feed.items.map(item => item.sourceKind)).size).toBe(8); expect(actual).toEqual(expected);
    expect(actual).toContain(`review:${review.id}`); expect(actual).toContain(`blocker_attention:${blocker.id}`);
    await start(); for (const item of feed.items) await archived(item.sourceKind, item.subject.id); await quiet();
  });

  it("keeps unseen sources, cancels their deadline, and reactivates when unkept or revived", async () => {
    const row = await insertIssue("in_review", { assigneeUserId: "board" });
    await decisionRetentionService(db).setKeep({ ...mutation("review", row.id), keep: true });
    await start(); await quiet(); expect((await state("review", row.id))?.archivedAt).toBeNull();
    await decisionRetentionService(db).setKeep({ ...mutation("review", row.id), keep: false });
    await archived("review", row.id); await quiet();
    await decisionRetentionService(db).revive(mutation("review", row.id)); await archived("review", row.id); await quiet();
  });

  it("moves deadlines on source activity and cancels when the source leaves attention", async () => {
    const row = await insertIssue("in_review", { assigneeUserId: "board", updatedAt: new Date() });
    await start(); await settle(); const first = coordinator!.nextWakeAt()!;
    await change(tx => tx.update(issues).set({ updatedAt: new Date(Date.now() - delay + 600_000) }).where(eq(issues.id, row.id)));
    await settle(); expect(coordinator!.nextWakeAt()).toBeLessThan(first);
    await issueService(db).update(row.id, { status: "todo" }); await quiet(); expect(await state("review", row.id)).toBeNull();
  });

  it("preserves outer transaction ownership and first writes during drain", async () => {
    await start(); await quiet(); draining = true;
    let id: string | undefined;
    await db.transaction(async outer => {
      await outer.transaction(async nested => {
        await notifyAttentionRetentionWork(nested, { companyId });
        id = (await insertIssue("in_review", { assigneeUserId: "board" }, nested as unknown as Db)).id;
      });
      await vi.advanceTimersByTimeAsync(60_000); expect(await state("review", id!)).toBeNull();
    });
    await vi.advanceTimersByTimeAsync(120_000); expect(await state("review", id!)).toBeNull();
    draining = false; await vi.advanceTimersByTimeAsync(30_000); await archived("review", id!); await quiet();
    await expect(db.transaction(async outer => {
      await outer.transaction(async nested => { await notifyAttentionRetentionWork(nested, { companyId }); await insertIssue("in_review", { assigneeUserId: "board" }, nested as unknown as Db); });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await quiet(); expect(await db.select().from(decisionRetention)).toHaveLength(1);
  });

  it("isolates companies, catches up at activation, and bounds retained-history pages", async () => {
    const other = randomUUID(); await db.insert(companies).values({ id: other, name: "Paused", issuePrefix: "RP", status: "paused" });
    const row = await insertIssue("in_review", { companyId: other, assigneeUserId: "board" });
    await db.insert(issues).values(Array.from({ length: 1000 }, () => ({ companyId, title: randomUUID(), status: "done", updatedAt: old() })));
    const service = attentionRetentionService(db); const page = await service.load({ companyId });
    expect(page).toEqual({ rows: [], complete: true });
    await start(service); await quiet(); expect(await db.select().from(decisionRetention)).toHaveLength(0);
    await companyService(db).update(other, { status: "active" });
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(await db.select().from(decisionRetention)).toHaveLength(1); });
    expect((await db.select().from(decisionRetention))[0]).toMatchObject({ companyId: other, sourceId: row.id }); await quiet();
  });
  it("preserves terminal blocker source identity and its own activity deadline", async () => {
    const root = await insertIssue("blocked", { unblockDescriptor: { owner: "board", action: "Pick an owner" }, blockedTransitionAt: old() });
    const terminal = await insertIssue("backlog", { assigneeAgentId: agentId, updatedAt: new Date(old().getTime() + 60_000) });
    await db.insert(issueRelations).values({ companyId, issueId: terminal.id, relatedIssueId: root.id, type: "blocks" });
    const feed = await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true });
    const entries = await loadAll();
    const expected = feed.items.filter(item => item.sourceKind === "blocker_attention")
      .map(item => `${item.subject.id}:${new Date(item.activityAt).toISOString()}`).sort();
    expect(entries.filter(item => item.sourceKind === "blocker_attention")
      .map(item => `${item.sourceId}:${new Date(item.activityAt).toISOString()}`).sort()).toEqual(expected);
    expect(expected).toContain(`${terminal.id}:${terminal.updatedAt.toISOString()}`);
    await start(); await archived("blocker_attention", terminal.id); await archived("blocker_attention", root.id); await quiet();
    expect((await state("blocker_attention", terminal.id))?.sourceActivityAt).toEqual(terminal.updatedAt);
    expect((await state("blocker_attention", root.id))?.sourceActivityAt).toEqual(root.blockedTransitionAt);
  });

  it("matches newest confirmations, independent gates, org invokability, and conversation visibility", async () => {
    const origin = await insertIssue();
    const conversation = await insertIssue("in_review", { conversationAgentId: agentId, conversationUserId: "board", conversationState: "waiting", assigneeAgentId: agentId });
    const hidden = await insertIssue("todo", { hiddenAt: old() });
    const [paused, manager, unhealthy] = await db.insert(agents).values([
      { companyId, name: "Paused", role: "engineer", status: "paused" },
      { companyId, name: "Terminated", role: "manager", status: "terminated" },
      { companyId, name: "Unhealthy", role: "engineer", status: "active" },
    ]).returning();
    await db.update(agents).set({ reportsTo: manager.id }).where(eq(agents.id, unhealthy.id));
    const common = { companyId, issueId: origin.id, kind: "request_confirmation", payload: { prompt: "Approve?" }, createdAt: old(), updatedAt: old() };
    const [older, newest, independent] = await db.insert(issueThreadInteractions).values([
      common, { ...common, createdAt: new Date(old().getTime() + 1000) },
      { ...common, payload: { prompt: "Independent", qualityReview: { artifactKey: "copy" } } },
      { ...common, createdAt: new Date(), addresseeUserId: "board" },
      { ...common, addresseeAgentId: agentId },
      { ...common, issueId: hidden.id },
      { ...common, issueId: conversation.id, kind: "ask_user_questions", payload: { questions: [] } },
      { ...common, issueId: conversation.id, addresseeAgentId: paused.id },
      { ...common, issueId: conversation.id, addresseeAgentId: unhealthy.id, kind: "ask_user_questions", payload: { questions: [] } },
    ] as typeof issueThreadInteractions.$inferInsert[]).returning();
    const feed = await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true });
    const expected = [...new Set(feed.items.map(item => `${item.sourceKind}:${item.subject.id}`))].sort();
    expect([...new Set((await loadAll()).map(item => `${item.sourceKind}:${item.sourceId}`))].sort()).toEqual(expected);
    expect(expected).not.toContain(`issue_thread_interaction:${older.id}`);
    expect(expected).toContain(`issue_thread_interaction:${newest.id}`); expect(expected).toContain(`issue_thread_interaction:${independent.id}`);
    await start(); await archived("issue_thread_interaction", newest.id); await archived("issue_thread_interaction", independent.id); await quiet();
    await change(tx => tx.update(issueThreadInteractions).set({ status: "cancelled" }).where(eq(issueThreadInteractions.id, newest.id)));
    await archived("issue_thread_interaction", older.id); await quiet();
  });

  it("excludes maintained reviews until a pending approval creates human attention", async () => {
    const row = await insertIssue("in_review", { assigneeAgentId: agentId });
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId, issueId: row.id,
      kind: "request_confirmation", addresseeAgentId: agentId, payload: { prompt: "Agent verdict" } }).returning();
    expect((await loadAll()).some(entry => entry.sourceKind === "review")).toBe(false);
    const [approval] = await db.insert(approvals).values({ companyId, type: "hire_agent", payload: {}, status: "pending" }).returning();
    await db.insert(issueApprovals).values({ companyId, issueId: row.id, approvalId: approval.id });
    const feed = await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true });
    expect(feed.items.some(item => item.sourceKind === "review" && item.subject.id === row.id)).toBe(true);
    await start(); await archived("review", row.id); await quiet();
    expect(await state("issue_thread_interaction", interaction.id)).toBeNull();
  });

  it("reactivates an exhausted failed run through the ordinary durable event producer", async () => {
    const origin = await insertIssue();
    const [run, newer] = await db.insert(heartbeatRuns).values([
      { companyId, agentId, status: "failed", contextSnapshot: { issueId: origin.id }, createdAt: old(), finishedAt: old() },
      { companyId, agentId, status: "succeeded", contextSnapshot: { issueId: origin.id }, createdAt: new Date(old().getTime() + 1000), finishedAt: old() },
    ]).returning();
    await start(); await quiet();
    await appendHeartbeatRunEvent(db, { companyId, agentId, runId: run.id, eventType: "lifecycle", message: "Bounded retry exhausted after 3 attempts" });
    await quiet(); expect(await state("failed_run", run.id)).toBeNull();
    await change(tx => tx.delete(heartbeatRuns).where(eq(heartbeatRuns.id, newer.id)));
    await archived("failed_run", run.id); await quiet();
  });

  it("cancels an agent error deadline through ordinary clearError", async () => {
    await db.update(agents).set({ status: "error", updatedAt: new Date() }).where(eq(agents.id, agentId));
    await start(); await settle(); expect(coordinator!.nextWakeAt()).not.toBeNull();
    await createAgentLifecycle(db).clearError(agentId); await quiet();
    expect(await state("agent_error_alert", agentId)).toBeNull();
  });

  it("drains a paged backlog with source-scoped self notifications and leaves completed history quiet", async () => {
    await db.insert(issues).values(Array.from({ length: 225 }, () => ({ companyId, title: randomUUID(), status: "in_review", assigneeUserId: "board", updatedAt: old() })));
    const service = attentionRetentionService(db);
    const load = vi.spyOn(service, "load");
    await start(service);
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(await db.select().from(decisionRetention)).toHaveLength(225); }, { timeout: 30_000 });
    await quiet();
    const scopes = load.mock.calls.map(([scope]) => scope);
    expect(scopes.filter(scope => !scope)).toHaveLength(3);
    expect(scopes.filter(scope => scope && !scope.sourceId)).toHaveLength(0);
    expect(scopes.filter(scope => scope?.sourceId).length).toBeLessThanOrEqual(225);
    expect(new Set((await db.select().from(decisionRetention)).map(row => row.sourceId)).size).toBe(225);
  });

  it("retries a failed atomic archive across drain and preserves notifications during a scan", async () => {
    const row = await insertIssue("in_review", { assigneeUserId: "board" });
    await db.execute(sql`create function attention_retention_fail() returns trigger language plpgsql as $$ begin raise exception 'retention injected'; end $$`);
    await db.execute(sql`create trigger attention_retention_fail before insert on decision_retention for each row execute function attention_retention_fail()`);
    await start(); expect(errors).toHaveLength(1); errors.length = 0;
    expect(await state("review", row.id)).toBeNull(); expect(await db.select().from(decisionArchiveNotificationOutbox)).toHaveLength(0);
    draining = true; await db.execute(sql`drop trigger attention_retention_fail on decision_retention`);
    statements.length = 0; await vi.advanceTimersByTimeAsync(120_000);
    expect(statements.length).toBeLessThanOrEqual(1);
    expect(statements.every(query => query.includes("pg_xact_status"))).toBe(true);
    statements.length = 0; await vi.advanceTimersByTimeAsync(300_000); expect(statements).toEqual([]);
    draining = false; await vi.advanceTimersByTimeAsync(30_000); await archived("review", row.id); await quiet();
    await coordinator!.stop(); coordinator = undefined;
    let release!: () => void; let scanned!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { scanned = resolve; });
    const service = attentionRetentionService(db), original = service.load;
    vi.spyOn(service, "load").mockImplementationOnce(async (...args) => { const result = await original(...args); scanned(); await gate; return result; });
    const starting = start(service); await entered;
    const next = await change(async tx => insertIssue("in_review", { assigneeUserId: "board" }, tx));
    release(); await starting; await archived("review", next.id); await quiet();
  });

  it("registers and cancels a deadline through ordinary interaction creation and withdrawal", async () => {
    const origin = await insertIssue(); await start(); await quiet();
    const service = issueThreadInteractionService(db);
    const interaction = await service.create(origin, { kind: "request_confirmation", payload: { version: 1, prompt: "Approve the result?" } }, { userId: "board" });
    await settle(); expect(coordinator!.nextWakeAt()).not.toBeNull(); expect(await state("issue_thread_interaction", interaction.id)).toBeNull();
    await service.withdrawInteraction(origin, interaction.id, { reason: "No longer needed" }, { userId: "board" }); await quiet();
  });

});
