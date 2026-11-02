import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeDatabaseWork, authUsers, companyMemberships, agents, approvals, budgetIncidents, budgetPolicies, companies, createDb, applyPendingMigrations, decisionArchiveNotificationOutbox,
  decisionRetention, decisions, costEvents, heartbeatRunEvents, heartbeatRuns, issueApprovals, issueRecoveryActions,
  issueRelations, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { attentionRetentionService, registerAttentionRetentionWork } from "../services/attention-retention.js";
import { workspaceOperationService } from "../services/workspace-operations.js";
import * as workspaceOperationLogs from "../services/workspace-operation-log-store.js";
import { budgetService } from "../services/budgets.js";
import { writeExecutionControl } from "../services/execution-control-notifications.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { attentionService } from "../services/attention.js";
import { companyService } from "../services/companies.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { decisionRetentionService, DEFAULT_DECISION_ARCHIVE_DAYS } from "../services/decision-retention.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { buildIssueGraphLivenessIncidentKey, RECOVERY_ORIGIN_KINDS } from "../services/recovery/origins.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { BLOCKER_ATTENTION_MAX_DEPTH, BLOCKER_ATTENTION_MAX_NODES, issueService } from "../services/issues.js";
import { notifyAttentionRetentionWork, notifyIssueAttentionRetentionWork } from "../services/retention-work-notifications.js";
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
  const parameterCounts: number[] = [];
  let captureBlockerPlan = false;
  let blockerPlanQuery: { query: string; parameters: unknown[] } | undefined;
  beforeAll(async () => {
    if (externalUrl) await applyPendingMigrations(externalUrl);
    else temporary = await startEmbeddedPostgresTestDatabase("attention-retention-");
    db = createDb(externalUrl ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    db.$client.options.onnotice = () => {};
    db.$client.options.debug = (_connection, query, parameters) => {
      statements.push(query); parameterCounts.push(parameters.length);
      if (captureBlockerPlan && !blockerPlanQuery && query.includes("latest_blocker_operation") && query.includes("issue_relations"))
        blockerPlanQuery = { query, parameters: [...parameters] };
    };
  }, 30_000);
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); draining = false; errors.length = 0;
    captureBlockerPlan = false; blockerPlanQuery = undefined;
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
    // SQL assigns updatedAt using the database clock, independently of the fake
    // scheduler clock. Cross the saved deadline rather than a fixed duration.
    await vi.advanceTimersByTimeAsync(Math.max(0, child.updatedAt.getTime() + delay - Date.now()) + 2000);
    await archived("review", child.id); await quiet();
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

  it("batches decision and recovery source links and rechecks a late hidden origin", async () => {
    const origins = await db.insert(issues).values(Array.from({ length: 100 }, () => ({ companyId,
      title: randomUUID(), status: "todo", updatedAt: old() }))).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded" }).returning();
    const decisionRows = await db.insert(decisions).values(origins.map(origin => ({ companyId,
      originAgentId: agentId, originIssueId: origin.id, originRunId: run.id, title: "Decision", body: "Choose",
      options: [], signedSpec: "fixture", targetSnapshots: {}, expiresAt: new Date(Date.now() + 86_400_000), updatedAt: old() }))).returning();
    const recoveryRows = await db.insert(issueRecoveryActions).values(origins.map(origin => ({ companyId,
      sourceIssueId: origin.id, kind: "execution", ownerType: "board", cause: "fixture", fingerprint: "fixture",
      nextAction: "Choose", updatedAt: old() }))).returning();
    const service = attentionRetentionService(db);
    const pages = [];
    for (const sourceKind of ["decision", "recovery_action"] as const) {
      statements.length = 0;
      const page = await service.load({ companyId, sourceKind });
      expect(page.rows).toHaveLength(100); expect(page.complete).toBe(false);
      expect(statements.length).toBeLessThanOrEqual(3);
      pages.push(page.rows!);
    }
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, origins[99].id));
    const hiddenDecision = pages[0].find(entry => entry.sourceId === decisionRows[99].id)!;
    const hiddenRecovery = pages[1].find(entry => entry.sourceId === recoveryRows[99].id)!;
    expect(await service.check(hiddenDecision)).toBeNull(); expect(await service.check(hiddenRecovery)).toBeNull();
    expect(await state("decision", hiddenDecision.sourceId)).toBeNull(); expect(await state("recovery_action", hiddenRecovery.sourceId)).toBeNull();
    expect(await db.select().from(decisionArchiveNotificationOutbox)).toHaveLength(0);
  });

  it("batches 100 failed runs and rechecks late visibility and supersession before archive", async () => {
    const origins = await db.insert(issues).values(Array.from({ length: 100 }, () => ({ companyId,
      title: randomUUID(), status: "todo", updatedAt: old() }))).returning();
    const runs = await db.insert(heartbeatRuns).values(origins.map(origin => ({ companyId, agentId,
      status: "failed", contextSnapshot: { issueId: origin.id }, createdAt: old(), finishedAt: old() }))).returning();
    await db.insert(heartbeatRunEvents).values(runs.map(run => ({ companyId, agentId, runId: run.id,
      seq: 1, eventType: "lifecycle", message: "Bounded retry exhausted: batch fixture" })));
    const service = attentionRetentionService(db), scope = { companyId, sourceKind: "failed_run" as const };
    statements.length = 0;
    const page = await service.load(scope);
    expect(page.rows).toHaveLength(100); expect(page.complete).toBe(false);
    expect(statements.length).toBeLessThanOrEqual(6);
    const hiddenRun = runs[98], supersededRun = runs[99];
    const hidden = page.rows!.find(entry => entry.sourceId === hiddenRun.id)!;
    const superseded = page.rows!.find(entry => entry.sourceId === supersededRun.id)!;
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, origins[98].id));
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded",
      contextSnapshot: { issueId: origins[99].id }, createdAt: new Date(old().getTime() + 60_000), finishedAt: old() });
    expect(await service.check(hidden)).toBeNull(); expect(await service.check(superseded)).toBeNull();
    expect(await state("failed_run", hiddenRun.id)).toBeNull(); expect(await state("failed_run", supersededRun.id)).toBeNull();
    expect(await db.select().from(decisionArchiveNotificationOutbox)).toHaveLength(0);
    expect((await service.load(scope)).complete).toBe(true);
    const refreshed = await service.load(scope);
    expect(refreshed.rows).toHaveLength(98);
    expect(refreshed.rows!.some(entry => [hiddenRun.id, supersededRun.id].includes(entry.sourceId))).toBe(false);
  });

  it("batches 100 blocker graphs with exact terminal timestamps and fresh terminal visibility", async () => {
    const roots = await db.insert(issues).values(Array.from({ length: 100 }, () => ({ companyId,
      title: randomUUID(), status: "blocked", updatedAt: old(), blockedTransitionAt: old(),
      unblockDescriptor: { owner: "board", action: "Pick an owner" } }))).returning();
    const terminals = await db.insert(issues).values(Array.from({ length: 100 }, () => ({ companyId,
      title: randomUUID(), status: "backlog", assigneeAgentId: agentId, updatedAt: old() }))).returning();
    await db.insert(issueRelations).values(roots.map((root, index) => ({ companyId,
      issueId: terminals[index].id, relatedIssueId: root.id, type: "blocks" })));
    await db.execute(sql`update issues set updated_at = updated_at + interval '0.000321 seconds' where id = ${terminals[99].id}::uuid`);
    const service = attentionRetentionService(db), scope = { companyId, sourceKind: "blocker_attention" as const };
    statements.length = 0;
    const page = await service.load(scope);
    const queries = [...statements];
    expect(page.rows).toHaveLength(200); expect(page.complete).toBe(false);
    const retentionReads = queries.filter(query => query.includes('from "decision_retention"'));
    expect(retentionReads).toHaveLength(200);
    expect(queries.length - retentionReads.length).toBeLessThanOrEqual(30);
    const terminal = page.rows!.find(entry => entry.rootId === roots[99].id && entry.variant === "terminal")!;
    expect(terminal.sourceId).toBe(terminals[99].id);
    const [expected] = await db.execute(sql`select updated_at::text as at,
      ceil(extract(epoch from updated_at) * 1000 + ${delay}) as due from issues where id = ${terminals[99].id}::uuid`);
    expect(terminal.activityAt).toBe(expected.at); expect(terminal.dueAt).toBe(Number(expected.due));
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, terminals[99].id));
    expect(await service.check(terminal)).toBeNull();
    expect(await state("blocker_attention", terminals[99].id)).toBeNull();
    expect(await db.select().from(decisionArchiveNotificationOutbox)).toHaveLength(0);
    expect((await service.load(scope)).complete).toBe(true);
    const refreshed = await service.load(scope);
    expect(refreshed.rows!.some(entry => entry.sourceId === terminals[99].id)).toBe(false);
  });

  it.each(["depth", "nodes"] as const)("preserves shallow terminal selection when an unrelated graph hits its %s limit", async limit => {
    const root = await insertIssue("blocked", { updatedAt: new Date() });
    const middle = await insertIssue("todo", { updatedAt: new Date() });
    const terminal = await insertIssue("backlog", { assigneeAgentId: agentId });
    const heavy = await insertIssue("blocked", { updatedAt: new Date() });
    const count = limit === "depth" ? BLOCKER_ATTENTION_MAX_DEPTH + 1 : BLOCKER_ATTENTION_MAX_NODES;
    const heavyNodes = await db.insert(issues).values(Array.from({ length: count }, () => ({ companyId,
      title: randomUUID(), status: "todo", updatedAt: new Date() }))).returning();
    await db.insert(issueRelations).values([
      { companyId, issueId: middle.id, relatedIssueId: root.id, type: "blocks" },
      { companyId, issueId: terminal.id, relatedIssueId: middle.id, type: "blocks" },
      ...heavyNodes.map((node, index) => ({ companyId, issueId: node.id,
        relatedIssueId: limit === "nodes" || index === 0 ? heavy.id : heavyNodes[index - 1].id, type: "blocks" })),
    ]);
    const owner = issueService(db);
    const expected = (await owner.listBlockerAttention(companyId, [root])).get(root.id)!;
    const limited = (await owner.listBlockerAttention(companyId, [heavy])).get(heavy.id)!;
    expect(expected.terminalBlockerIssueId).toBe(terminal.id);
    expect(limited.terminalBlockerIssueId).toBe(limited.directBlockerIssueId);
    for (const input of [[root, heavy], [heavy, root]]) {
      const batch = await owner.listBlockerAttentionBatch(companyId, input);
      if (!batch.deferredRootIds.has(root.id)) expect(batch.attention.get(root.id)).toEqual(expected);
      if (!batch.deferredRootIds.has(heavy.id)) expect(batch.attention.get(heavy.id)).toEqual(limited);
      expect(batch.nodeCount).toBeLessThanOrEqual(BLOCKER_ATTENTION_MAX_NODES);
      if (limit === "depth") expect(batch.deferredRootIds.has(root.id)).toBe(false);
    }
    const page = await attentionRetentionService(db).load({ companyId, sourceKind: "blocker_attention" });
    const entry = page.rows!.find(item => item.rootId === root.id && item.variant === "terminal")!;
    expect(entry.dueAt).toBeLessThanOrEqual(Date.now());
    if (limit === "depth") expect(entry.sourceId).toBe(terminal.id);
    await attentionRetentionService(db).check(entry);
    expect((await state("blocker_attention", terminal.id))?.archivedAt).toBeInstanceOf(Date);
    expect(await db.select().from(decisionArchiveNotificationOutbox).where(eq(decisionArchiveNotificationOutbox.sourceId, terminal.id))).toHaveLength(1);
  });

  it("keeps root-specific reachability and cycle budgets when another root explores farther", async () => {
    const root = await insertIssue("blocked");
    const chain = await db.insert(issues).values(Array.from({ length: BLOCKER_ATTENTION_MAX_DEPTH + 1 }, (_, index) => ({
      companyId, title: randomUUID(), status: index === BLOCKER_ATTENTION_MAX_DEPTH ? "in_progress"
        : index === BLOCKER_ATTENTION_MAX_DEPTH - 2 ? "blocked" : "todo", updatedAt: old() }))).returning();
    const overlapping = chain[BLOCKER_ATTENTION_MAX_DEPTH - 2];
    const cycle = await insertIssue("blocked");
    const leaf = await insertIssue("backlog", { assigneeAgentId: agentId });
    await db.insert(issueRelations).values([
      ...chain.map((node, index) => ({ companyId, issueId: node.id, relatedIssueId: index ? chain[index - 1].id : root.id, type: "blocks" })),
      { companyId, issueId: leaf.id, relatedIssueId: cycle.id, type: "blocks" },
      { companyId, issueId: cycle.id, relatedIssueId: leaf.id, type: "blocks" },
    ]);
    const owner = issueService(db), roots = [root, overlapping, cycle];
    const singles = new Map();
    for (const item of roots) singles.set(item.id, (await owner.listBlockerAttention(companyId, [item])).get(item.id));
    expect(singles.get(root.id).blockingTreeLive).toBe(false);
    expect(singles.get(overlapping.id).blockingTreeLive).toBe(true);
    for (const input of [roots, [...roots].reverse()]) {
      const batch = await owner.listBlockerAttention(companyId, input);
      for (const item of roots) expect(batch.get(item.id)).toEqual(singles.get(item.id));
    }
  });

  it("keeps deferred roots visible in the ordinary attention feed above the root cap", async () => {
    await db.execute(sql`insert into issues (id, company_id, title, status, updated_at)
      select gen_random_uuid(), ${companyId}::uuid, 'overflow-root-' || n, 'blocked', ${new Date().toISOString()}::timestamptz
      from generate_series(1, ${BLOCKER_ATTENTION_MAX_NODES + 1}) n`);
    const roots = await db.select().from(issues).where(eq(issues.companyId, companyId));
    const batch = await issueService(db).listBlockerAttentionBatch(companyId, roots);
    expect(batch.deferredRootIds.size).toBeGreaterThan(0);
    expect(batch.nodeCount).toBeLessThanOrEqual(BLOCKER_ATTENTION_MAX_NODES);
    for (const rootId of batch.deferredRootIds) expect(batch.attention.get(rootId)).toMatchObject({
      state: "needs_attention", reason: "attention_required", terminalBlockerIssueId: rootId,
    });
    const listed = await issueService(db).list(companyId, { status: "blocked", includeBlockedBy: true });
    expect(listed).toHaveLength(roots.length);
    for (const root of listed) expect(root.blockerAttention).toMatchObject({ state: "needs_attention", terminalBlockerIssueId: root.id });
    const feed = await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true });
    const visible = new Set(feed.items.filter(item => item.sourceKind === "blocker_attention").map(item => item.subject.id));
    expect(visible).toEqual(new Set(roots.map(root => root.id)));
  });

  it("bounds every graph query when independent root trees contain over 65535 unfinished nodes", async () => {
    await db.execute(sql`insert into issues (id, company_id, title, status, updated_at)
      select gen_random_uuid(), ${companyId}::uuid, 'parameter-root-' || n, 'blocked', ${old().toISOString()}::timestamptz
      from generate_series(1, 70) n`);
    await db.execute(sql`insert into issues (id, company_id, parent_id, title, status, updated_at)
      select gen_random_uuid(), ${companyId}::uuid, root.id, 'parameter-branch-' || n, 'todo', ${old().toISOString()}::timestamptz
      from issues root cross join generate_series(1, 10) n
      where root.company_id = ${companyId}::uuid and root.status = 'blocked'`);
    await db.execute(sql`insert into issues (id, company_id, parent_id, title, status, assignee_agent_id, updated_at)
      select gen_random_uuid(), ${companyId}::uuid, branch.id, 'parameter-leaf-' || n, 'backlog', ${agentId}::uuid, ${old().toISOString()}::timestamptz
      from issues branch cross join generate_series(1, 99) n
      where branch.company_id = ${companyId}::uuid and branch.title like 'parameter-branch-%'`);
    const completed = await insertIssue("blocked");
    const shallow = await insertIssue("blocked", { updatedAt: new Date() });
    const middle = await insertIssue("todo", { updatedAt: new Date() });
    const overdue = await insertIssue("backlog", { assigneeAgentId: agentId });
    await db.insert(issueRelations).values([
      { companyId, issueId: middle.id, relatedIssueId: shallow.id, type: "blocks" },
      { companyId, issueId: overdue.id, relatedIssueId: middle.id, type: "blocks" },
    ]);
    const roots = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked")));
    parameterCounts.length = 0;
    const result = await issueService(db).listBlockerAttentionBatch(companyId, roots).catch(error => {
      throw new Error(`Large graph failed: ${String(error.cause?.message ?? error.message).slice(0, 300)}`);
    });
    expect(result.attention.size).toBe(72);
    expect(result.deferredRootIds.has(completed.id)).toBe(false);
    expect(result.attention.get(completed.id)?.terminalBlockerIssueId).toBe(completed.id);
    expect([...result.attention.values()].every(item => item.state === "needs_attention" && item.terminalBlockerIssueId)).toBe(true);
    expect(Math.max(...parameterCounts)).toBeLessThanOrEqual(1100);
    expect(parameterCounts.length).toBeLessThanOrEqual(100);
    expect(result.nodeCount).toBeLessThanOrEqual(BLOCKER_ATTENTION_MAX_NODES);
    expect(result.edgeCount).toBeLessThanOrEqual(BLOCKER_ATTENTION_MAX_NODES * 2);
    expect(result.fetchedRows).toBeLessThanOrEqual(BLOCKER_ATTENTION_MAX_NODES * 6);
    expect(result.deferredRootIds.has(shallow.id)).toBe(true);
    const service = attentionRetentionService(db);
    const page = await service.load({ companyId, sourceKind: "blocker_attention" });
    const immediate = page.rows!.find(entry => entry.rootId === shallow.id && entry.variant === "terminal")!;
    expect(immediate.dueAt).toBeLessThanOrEqual(Date.now());
    await service.check(immediate);
    expect((await state("blocker_attention", overdue.id))?.archivedAt).toBeInstanceOf(Date);
  }, 120_000);

  it("preserves observed live work when a single large root exhausts shared fetch capacity", async () => {
    const root = await insertIssue("blocked");
    const live = await insertIssue("in_progress", { assigneeAgentId: agentId });
    await db.insert(issueRelations).values({ companyId, issueId: live.id, relatedIssueId: root.id, type: "blocks" });
    await db.execute(sql`insert into issues (id, company_id, parent_id, title, status, assignee_agent_id, updated_at)
      select gen_random_uuid(), ${companyId}::uuid, ${root.id}::uuid, 'bounded-leaf-' || n, 'backlog', ${agentId}::uuid, ${old().toISOString()}::timestamptz
      from generate_series(1, 3000) n`);
    const batch = await issueService(db).listBlockerAttentionBatch(companyId, [root]);
    expect(batch.deferredRootIds.has(root.id)).toBe(true);
    expect(batch.attention.get(root.id)?.blockingTreeLive).toBe(true);
    const service = attentionRetentionService(db), page = await service.load({ companyId, sourceKind: "blocker_attention" });
    const entry = page.rows!.find(item => item.rootId === root.id && item.variant === "terminal")!;
    expect(await service.check(entry)).toBeNull();
    expect(await state("blocker_attention", root.id)).toBeNull();
    expect(await db.select().from(decisionArchiveNotificationOutbox)).toHaveLength(0);
  });

  it.each(["in_progress", "run", "confirmation"])("preserves observed child live evidence (%s) after explicit blockers fill the node budget", async (kind) => {
    const root = await insertIssue("blocked");
    await db.execute(sql`with blockers as (
      insert into issues (id, company_id, title, status, assignee_agent_id, updated_at)
      select gen_random_uuid(), ${companyId}::uuid, 'explicit-leaf-' || n, 'backlog', ${agentId}::uuid, ${old().toISOString()}::timestamptz
      from generate_series(1, 1999) n returning id)
      insert into issue_relations (company_id, issue_id, related_issue_id, type)
      select ${companyId}::uuid, id, ${root.id}::uuid, 'blocks' from blockers`);
    const child = await insertIssue(kind === "in_progress" ? "in_progress" : "todo", { parentId: root.id, assigneeAgentId: agentId });
    if (kind === "run") {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
      await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, child.id));
    } else if (kind === "confirmation") {
      await db.insert(issueThreadInteractions).values({ companyId, issueId: child.id, kind: "request_confirmation", status: "pending", payload: { prompt: "Approve?" } });
    }
    parameterCounts.length = 0;
    const batch = await issueService(db).listBlockerAttentionBatch(companyId, [root]);
    expect(batch.nodeCount).toBeLessThanOrEqual(BLOCKER_ATTENTION_MAX_NODES);
    expect(batch.edgeCount).toBeLessThanOrEqual(BLOCKER_ATTENTION_MAX_NODES * 2);
    expect(batch.fetchedRows).toBeLessThanOrEqual(BLOCKER_ATTENTION_MAX_NODES * 6);
    expect(parameterCounts.length).toBeLessThanOrEqual(100);
    expect(Math.max(...parameterCounts)).toBeLessThanOrEqual(1100);
    expect(batch.deferredRootIds.has(root.id)).toBe(true);
    expect(batch.attention.get(root.id)?.blockingTreeLive).toBe(true);
    const service = attentionRetentionService(db), page = await service.load({ companyId, sourceKind: "blocker_attention" });
    const entry = page.rows!.find(item => item.rootId === root.id && item.variant === "terminal")!;
    expect(await service.check(entry)).toBeNull();
    expect(await db.select().from(decisionRetention)).toHaveLength(0);
    expect(await db.select().from(decisionArchiveNotificationOutbox)).toHaveLength(0);
  });

  it.each(["running", "run", "confirmation", "completed"] as const)("filters completed blocker history before bounded %s attention and archive checks", async kind => {
    const root = await insertIssue("blocked"), workspaceId = randomUUID();
    await db.execute(sql`insert into execution_workspaces (id, company_id, name, mode, strategy_type)
      values (${workspaceId}::uuid, ${companyId}::uuid, 'Finalized shared history', 'shared', 'project_primary')`);
    await db.execute(sql`insert into workspace_operations (company_id, execution_workspace_id, phase, status, started_at)
      values (${companyId}::uuid, ${workspaceId}::uuid, 'workspace_finalize', 'succeeded', ${old().toISOString()}::timestamptz)`);
    await db.execute(sql`with history as (
      insert into issues (id, company_id, title, status, updated_at, execution_workspace_id)
      select ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
        ${companyId}::uuid, 'completed-blocker-' || n, 'done', ${old().toISOString()}::timestamptz, ${workspaceId}::uuid
      from generate_series(1, 2100) n returning id)
      insert into issue_relations (company_id, issue_id, related_issue_id, type)
      select ${companyId}::uuid, id, ${root.id}::uuid, 'blocks' from history`);
    if (kind !== "completed") {
      const live = await insertIssue(kind === "running" ? "in_progress" : "todo", { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", assigneeAgentId: agentId });
      await db.insert(issueRelations).values({ companyId, issueId: live.id, relatedIssueId: root.id, type: "blocks" });
      if (kind === "run") {
        const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
        await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, live.id));
      } else if (kind === "confirmation") await db.insert(issueThreadInteractions).values({ companyId, issueId: live.id,
        kind: "request_confirmation", status: "pending", payload: { prompt: "Still waiting" } });
    }
    statements.length = 0; parameterCounts.length = 0;
    captureBlockerPlan = kind === "completed";
    const batch = await issueService(db).listBlockerAttentionBatch(companyId, [root]);
    captureBlockerPlan = false;
    if (kind === "completed") {
      expect(blockerPlanQuery).toBeTruthy();
      const explain = await db.$client.unsafe("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + blockerPlanQuery!.query,
        blockerPlanQuery!.parameters as never[]);
      type Plan = { "Relation Name"?: string; "Actual Rows": number; "Actual Loops": number; "Rows Removed by Filter"?: number; Plans?: Plan[] };
      const rootPlan = (explain[0]!["QUERY PLAN"] as Array<{ Plan: Plan }>)[0]!.Plan;
      const visit = (node: Plan): void => {
        if (node["Relation Name"] === "issues" && node["Actual Loops"] > 1) {
          expect(node["Actual Rows"]).toBeLessThanOrEqual(1);
          expect(node["Rows Removed by Filter"] ?? 0).toBe(0);
        }
        node.Plans?.forEach(visit);
      };
      visit(rootPlan);
      process.stdout.write(JSON.stringify({ completedBlockerHistoryPlan: explain }) + "\n");
    }
    expect(batch.nodeCount).toBeLessThanOrEqual(BLOCKER_ATTENTION_MAX_NODES);
    expect(batch.edgeCount).toBeLessThanOrEqual(BLOCKER_ATTENTION_MAX_NODES * 2);
    const service = attentionRetentionService(db), page = await service.load({ companyId, sourceKind: "blocker_attention" });
    const entry = page.rows!.find(row => row.rootId === root.id && row.variant === "terminal");
    if (kind !== "completed") {
      // Exercise the authoritative fresh check even if discovery correctly omits the live root.
      await service.check(entry ?? { id: `blocker_attention:${root.id}:terminal`, companyId, sourceKind: "blocker_attention",
        sourceId: root.id, rootId: root.id, issueId: root.id, variant: "terminal", activityAt: old().toISOString(), deadlineAt: Date.now(), dueAt: Date.now() });
      expect(await state("blocker_attention", root.id)).toBeNull();
      expect(await db.select().from(decisionArchiveNotificationOutbox)).toHaveLength(0);
    } else {
      expect(entry).toBeTruthy(); await service.check(entry!);
      expect((await state("blocker_attention", root.id))?.archivedAt).toBeInstanceOf(Date);
      expect(await db.select().from(decisionArchiveNotificationOutbox)).toHaveLength(1);
    }
    expect(batch.fetchedRows).toBeLessThanOrEqual(4);
    expect(batch.deferredRootIds.size).toBe(0);
    expect(Boolean(batch.attention.get(root.id)?.blockingTreeLive)).toBe(kind !== "completed");
    expect(parameterCounts.length).toBeLessThanOrEqual(100);
  });

  it("does not archive an unknown truncated blocker tree during its fresh check", async () => {
    const root = await insertIssue("blocked");
    await db.execute(sql`with blockers as (
      insert into issues (company_id, title, status, updated_at)
      select ${companyId}::uuid, 'unresolved-' || n, 'backlog', ${old().toISOString()}::timestamptz
      from generate_series(1, 2100) n returning id)
      insert into issue_relations (company_id, issue_id, related_issue_id, type)
      select ${companyId}::uuid, id, ${root.id}::uuid, 'blocks' from blockers`);
    const service = attentionRetentionService(db), page = await service.load({ companyId, sourceKind: "blocker_attention" });
    const entry = page.rows!.find(row => row.rootId === root.id && row.variant === "terminal")!;
    expect(entry).toBeTruthy(); expect(await service.check(entry)).toBeNull();
    expect(await db.select().from(decisionRetention)).toHaveLength(0);
    expect(await db.select().from(decisionArchiveNotificationOutbox)).toHaveLength(0);
    await start(); await quiet();
  });

  function simulateRecorderLogStorage() {
    // The recorder lifecycle and SQL are real; only its log-storage boundary is simulated.
    vi.spyOn(workspaceOperationLogs, "getWorkspaceOperationLogStore").mockReturnValue({
      begin: async () => ({ store: "local_file", logRef: "retention-finalize-proof" }),
      append: async () => {}, finalize: async () => ({ bytes: 0, compressed: false }), read: async () => ({ content: "" }),
    });
  }

  it.each(["issue", "workspace"] as const)("publishes retention intent from ordinary no-run %s finalization", async scope => {
    simulateRecorderLogStorage();
    const source = await insertIssue(), workspaceId = randomUUID();
    await db.execute(sql`insert into execution_workspaces (id, company_id, name, mode, strategy_type)
      values (${workspaceId}::uuid, ${companyId}::uuid, 'Finalize producer', 'shared', 'project_primary')`);
    await start(); await quiet();
    const committedHints: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.attentionRetention, (event, hints) => {
      if (event === "settled") committedHints.push(...hints ?? []);
    });
    try {
      const result = await workspaceOperationService(db).createRecorder({ companyId,
        executionWorkspaceId: scope === "workspace" ? workspaceId : undefined,
        issueId: scope === "issue" ? source.id : undefined,
      }).recordOperation({ phase: "workspace_finalize", run: async () => ({ status: "succeeded" }) });
      expect(result.status).toBe("succeeded");
      expect(committedHints.length).toBeGreaterThan(0);
      expect(committedHints.map(hint => JSON.parse(hint).companyId).every(id => id === companyId)).toBe(true);
      await quiet();
      if (scope === "workspace") {
        committedHints.length = 0;
        await workspaceOperationService(db).createRecorder({ companyId })
          .recordOperation({ phase: "workspace_finalize", run: async () => ({ status: "succeeded" }) });
        expect(committedHints).toEqual([]); await quiet();
      }
    } finally { unsubscribe(); }
  });

  describe("no-run finalization with an incomplete blocker graph", () => {
    let rootIds: string[], workspaceId: string, subjectId: string;
    let loadedScopes: Array<Parameters<ReturnType<typeof attentionRetentionService>["load"]>[0]>;
    beforeEach(async () => {
      const began = performance.now();
      simulateRecorderLogStorage();
      const roots = await Promise.all([insertIssue("blocked"), insertIssue("blocked")]);
      rootIds = roots.map(root => root.id); workspaceId = randomUUID();
      await db.execute(sql`insert into execution_workspaces (id, company_id, name, mode, strategy_type)
        values (${workspaceId}::uuid, ${companyId}::uuid, 'Pending shared export', 'shared', 'project_primary')`);
      await workspaceOperationService(db).createRecorder({ companyId, executionWorkspaceId: workspaceId })
        .recordOperation({ phase: "workspace_provision", run: async () => ({ status: "succeeded" }) });
      await db.execute(sql`with history as (
        insert into issues (company_id, title, status, updated_at, execution_workspace_id)
        select ${companyId}::uuid, 'waiting-for-export-' || n, 'done', ${old().toISOString()}::timestamptz, ${workspaceId}::uuid
        from generate_series(1, 2100) n returning id)
        insert into issue_relations (company_id, issue_id, related_issue_id, type)
        select ${companyId}::uuid, history.id, root.id, 'blocks' from history
        cross join (values (${rootIds[0]}::uuid), (${rootIds[1]}::uuid)) root(id)`);
      const [subject] = await db.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "done"))).limit(1);
      subjectId = subject!.id;
      const review = await insertIssue("in_review", { assigneeUserId: "board" });
      await decisionRetentionService(db).setKeep({ ...mutation("review", review.id), keep: true });
      const service = attentionRetentionService(db), load = service.load.bind(service); loadedScopes = [];
      vi.spyOn(service, "load").mockImplementation((scope, signal) => { loadedScopes.push(scope); return load(scope, signal); });
      process.stdout.write(JSON.stringify({ incompleteFinalizePhase: "seeded", setupMs: performance.now() - began }) + "\n");
      await start(service); await quiet();
      for (const rootId of rootIds) expect(await state("blocker_attention", rootId)).toBeNull();
      process.stdout.write(JSON.stringify({ incompleteFinalizeFixtureRows: 2100, incompleteRoots: 2, setupMs: performance.now() - began }) + "\n");
    }, 30_000);
    it("archives only after the ordinary workspace-only finalize commits, then settles quiet", async () => {
      const finish = (database: Db) => workspaceOperationService(database).createRecorder({ companyId, executionWorkspaceId: workspaceId, issueId: subjectId })
        .recordOperation({ phase: "workspace_finalize", run: async () => ({ status: "succeeded" }) });
      await expect(db.transaction(async tx => {
        await finish(tx as unknown as Db); throw new Error("rollback finalization");
      })).rejects.toThrow("rollback finalization");
      await settle(); for (const rootId of rootIds) expect(await state("blocker_attention", rootId)).toBeNull();
      loadedScopes.length = 0;
      expect((await finish(db)).status).toBe("succeeded");
      for (const rootId of rootIds) await archived("blocker_attention", rootId);
      await quiet();
      expect(loadedScopes.length).toBeGreaterThan(0);
      expect(loadedScopes.every(scope => scope?.companyId === companyId && scope.sourceKind === "blocker_attention")).toBe(true);
      expect(await db.select().from(decisionArchiveNotificationOutbox)).toHaveLength(2);
    });
  });

  it("disarms finite deferred-root checks when large retained graphs have no archive obligation", async () => {
    await db.execute(sql`insert into issues (id, company_id, title, status, updated_at)
      select gen_random_uuid(), ${companyId}::uuid, 'held-root-' || n, 'blocked', ${old().toISOString()}::timestamptz
      from generate_series(1, 4) n`);
    await db.execute(sql`insert into issues (id, company_id, parent_id, title, status, assignee_agent_id, updated_at)
      select gen_random_uuid(), ${companyId}::uuid, root.id, 'held-leaf-' || n, 'backlog', ${agentId}::uuid, ${old().toISOString()}::timestamptz
      from issues root cross join generate_series(1, 600) n
      where root.company_id = ${companyId}::uuid and root.status = 'blocked'`);
    await db.execute(sql`insert into decision_retention (company_id, source_kind, source_id, source_activity_at, keep)
      select company_id, 'blocker_attention', id::text, updated_at, true from issues
      where company_id = ${companyId}::uuid and status = 'backlog'`);
    const service = attentionRetentionService(db), check = vi.spyOn(service, "check");
    await start(service); await quiet();
    expect(check).toHaveBeenCalledTimes(4);
    expect(await db.select().from(decisionArchiveNotificationOutbox)).toHaveLength(0);
  });

  it("bounds high-fanin ordinary issue writes to one coalescible hint", async () => {
    const service = attentionRetentionService(db), original = service.load, load = vi.spyOn(service, "load");
    await start(service); await settle(); load.mockClear();
    const leaf = await insertIssue("in_review", { updatedAt: new Date(), assigneeUserId: "board" });
    await db.execute(sql`with parents as (
      insert into issues (id, company_id, title, status)
      select gen_random_uuid(), ${companyId}::uuid, 'fan-in-' || n, 'todo'
      from generate_series(1, 2100) n returning id)
      insert into issue_relations (company_id, issue_id, related_issue_id, type)
      select ${companyId}::uuid, ${leaf.id}::uuid, id, 'blocks' from parents`);
    const hints: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.attentionRetention, (event, values) => {
      if (event === "settled") hints.push(...values ?? []);
    });
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    load.mockImplementationOnce(async (...args) => { const page = await original(...args); entered = true; await gate; return page; });
    statements.length = 0;
    try {
      await issueService(db).update(leaf.id, { title: "High fan-in ordinary edit 0" });
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 15_000 });
      for (let n = 1; n < 8; n++) await issueService(db).update(leaf.id, { title: `High fan-in ordinary edit ${n}` });
    } finally { release(); unsubscribe(); }
    expect(statements.filter(query => query.includes("with recursive affected"))).toHaveLength(8);
    expect(hints).toHaveLength(8);
    expect(new Set(hints)).toEqual(new Set([JSON.stringify({ companyId })]));
    await settle();
    expect(load.mock.calls.length).toBeLessThanOrEqual(3);
    expect(load.mock.calls.every(([scope]) => scope?.companyId === companyId && !scope.issueId && !scope.issueIds)).toBe(true);
    let query!: Parameters<typeof db.execute>[0], returned = 0;
    await db.transaction(async tx => {
      const execute = tx.execute.bind(tx);
      vi.spyOn(tx, "execute").mockImplementation(async statement => {
        const result = await execute(statement);
        if (new PgDialect().sqlToQuery(statement as SQL).sql.includes("with recursive affected")) {
          query = statement; returned = result.length;
        }
        return result;
      });
      await notifyIssueAttentionRetentionWork(tx, { companyId, issueId: leaf.id });
    });
    expect(returned).toBe(101);
    const plans = await db.execute(sql`explain (analyze, format json) ${query as SQL}`);
    const plan = (plans[0]["QUERY PLAN"] as any)[0].Plan;
    expect(plan["Node Type"]).toBe("Limit");
    expect(plan["Actual Rows"]).toBe(101);
    const nodes: any[] = [], collect = (node: any) => { nodes.push(node); for (const child of node.Plans ?? []) collect(child); };
    collect(plan);
    const recursive = nodes.filter(node => node["Node Type"] === "Recursive Union");
    const relations = nodes.filter(node => node["Relation Name"] === "issue_relations");
    expect(recursive).toHaveLength(1);
    expect(recursive[0]["Actual Rows"]).toBe(101);
    expect(relations.length).toBeGreaterThan(0);
    expect(relations.every(node => node["Actual Rows"] * node["Actual Loops"] <= 101)).toBe(true);
    process.stdout.write(JSON.stringify({ reverseFanInPlan: plan }) + "\n");
  });

  it("retains far ancestor deadlines when a cyclic chain exceeds the precise hint budget", async () => {
    const service = attentionRetentionService(db), load = vi.spyOn(service, "load");
    await start(service); await settle(); load.mockClear();
    await db.execute(sql`insert into issues (id, company_id, title, status, updated_at, assignee_user_id)
      select gen_random_uuid(), ${companyId}::uuid, 'chain-' || n,
        case when n = 150 then 'in_review' else 'todo' end,
        case when n = 150 then ${new Date(Date.now() - delay + 15_000).toISOString()}::timestamptz else now() end,
        case when n = 150 then 'board' else null end
      from generate_series(0, 150) n`);
    await db.execute(sql`update issues child set parent_id = parent.id from issues parent
      where child.company_id = ${companyId}::uuid and parent.company_id = child.company_id
        and parent.title = 'chain-' || ((substring(child.title from 7)::integer + 1) % 151)`);
    const [leaf, far] = await Promise.all([db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.title, "chain-0"))).then(rows => rows[0]),
      db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.title, "chain-150"))).then(rows => rows[0])]);
    await issueService(db).update(leaf.id, { title: "Ordinary deep chain edit" });
    await settle();
    expect(load.mock.calls.some(([scope]) => scope?.companyId === companyId && !scope.issueId && !scope.issueIds)).toBe(true);
    expect(await state("review", far.id)).toBeNull();
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    await archived("review", far.id);
    await quiet();
  });

  it("canonicalizes a complete cyclic affected set into one bounded batch hint", async () => {
    const a = await insertIssue(), b = await insertIssue(), c = await insertIssue();
    await db.update(issues).set({ parentId: b.id }).where(eq(issues.id, a.id));
    await db.update(issues).set({ parentId: c.id }).where(eq(issues.id, b.id));
    await db.update(issues).set({ parentId: a.id }).where(eq(issues.id, c.id));
    const hints: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.attentionRetention, (event, values) => {
      if (event === "settled") hints.push(...values ?? []);
    });
    try {
      await db.transaction(tx => notifyIssueAttentionRetentionWork(tx, { companyId, issueId: a.id }));
      await db.transaction(tx => notifyIssueAttentionRetentionWork(tx, { companyId, issueId: c.id }));
      const wide = { companyId, issueIds: [b.id, a.id, c.id, a.id], ignored: {} as unknown };
      wide.ignored = wide;
      await db.transaction(tx => notifyAttentionRetentionWork(tx, wide));
    } finally { unsubscribe(); }
    expect(hints).toHaveLength(3);
    expect(new Set(hints)).toEqual(new Set([JSON.stringify({ companyId, issueIds: [a.id, b.id, c.id].sort() })]));
  });

  it("canonicalizes wide circular notification variables to the supported identity fields", async () => {
    const sourceId = randomUUID(), issueId = randomUUID(), hints: string[] = [];
    const wide = { companyId, sourceKind: "review" as const, sourceId, issueId, ignored: {} as unknown };
    wide.ignored = wide;
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.attentionRetention, (event, values) => {
      if (event === "settled") hints.push(...values ?? []);
    });
    try { await db.transaction(tx => notifyAttentionRetentionWork(tx, wide)); } finally { unsubscribe(); }
    expect(hints).toEqual([JSON.stringify({ companyId, sourceKind: "review", sourceId, issueId })]);
  });

  it("keeps held, burst and sustained ordinary issue writes scoped while an unrelated deadline fires", async () => {
    const row = await issueService(db).create(companyId, { title: "Active review", status: "in_review", assigneeUserId: "board", createdByAgentId: agentId });
    const urgent = await insertIssue("in_review", { assigneeUserId: "board", updatedAt: new Date(Date.now() - delay + 10_000) });
    const otherCompany = randomUUID();
    await db.insert(companies).values({ id: otherCompany, name: "Unrelated", issuePrefix: "BURST" });
    const foreign = await db.insert(issues).values(Array.from({ length: 125 }, () => ({ companyId: otherCompany,
      title: randomUUID(), status: "in_review", assigneeUserId: "board", updatedAt: old() }))).returning();
    await db.insert(decisionRetention).values(foreign.map(issue => ({ companyId: otherCompany, sourceKind: "review", sourceId: issue.id, sourceActivityAt: issue.updatedAt, keep: true })));
    const service = attentionRetentionService(db), original = service.load, load = vi.spyOn(service, "load");
    await start(service); await settle(); load.mockClear();
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    load.mockImplementationOnce(async (...args) => { const page = await original(...args); entered = true; await gate; return page; });
    statements.length = 0;
    await issueService(db).update(row.id, { title: "Held mutation" });
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 15_000 });
    await Promise.all(Array.from({ length: 5 }, (_, index) => issueService(db).update(row.id, { title: `Burst ${index}` })));
    release(); await settle();
    for (let index = 0; index < 8; index++) {
      await issueService(db).update(row.id, { title: `Steady ${index}` }); await vi.advanceTimersByTimeAsync(1000); await settle();
    }
    await archived("review", urgent.id);
    const routine = load.mock.calls.map(([scope]) => scope).filter(scope => !scope?.sourceId);
    expect(routine.length).toBeGreaterThan(0);
    expect(routine.every(scope => scope?.companyId === companyId && scope.issueId === row.id)).toBe(true);
    const scans = statements.filter(query => query.includes("with source_candidates"));
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.every(query => !query.includes("budget_incidents") && !query.includes("agent_error_alert"))).toBe(true);
    expect(await state("review", row.id)).toBeNull();
  });

  it("wakes all linked issue sources when an ordinary visibility mutation reveals their origin", async () => {
    const origin = await insertIssue("in_review", { hiddenAt: old(), assigneeUserId: "board", responsibleUserId: "board" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", contextSnapshot: { issueId: origin.id }, createdAt: old(), finishedAt: old() }).returning();
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: run.id, seq: 1, eventType: "lifecycle", message: "Bounded retry exhausted: visibility" });
    const [decision] = await db.insert(decisions).values({ companyId, originAgentId: agentId, originIssueId: origin.id, originRunId: run.id,
      title: "Decision", body: "Choose", options: [], signedSpec: "fixture", targetSnapshots: {}, expiresAt: new Date(Date.now() + 86_400_000), updatedAt: old() }).returning();
    const [recovery] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: origin.id, kind: "execution", ownerType: "board", cause: "fixture", fingerprint: "fixture", nextAction: "Choose", updatedAt: old() }).returning();
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId, issueId: origin.id, kind: "ask_user_questions", payload: { questions: [] }, updatedAt: old() }).returning();
    await start(); await quiet();
    await issueService(db).update(origin.id, { hiddenAt: null });
    for (const [kind, id] of [["decision", decision.id], ["recovery_action", recovery.id], ["failed_run", run.id], ["issue_thread_interaction", interaction.id]]) await archived(kind, id);
    await settle(); expect(await state("review", origin.id)).toBeNull(); expect(coordinator!.nextWakeAt()).not.toBeNull();
  });

  it("invalidates old and new parents, terminal visibility and repointed blocker relations", async () => {
    const oldParent = await insertIssue("blocked", { updatedAt: new Date(), responsibleUserId: "board" });
    const newParent = await insertIssue("blocked", { updatedAt: new Date(), responsibleUserId: "board" });
    const terminal = await insertIssue("backlog", { parentId: oldParent.id, hiddenAt: old(), assigneeAgentId: agentId, responsibleUserId: "board" });
    const service = attentionRetentionService(db), load = vi.spyOn(service, "load"); await start(service); await settle(); load.mockClear();
    await issueService(db).update(terminal.id, { parentId: newParent.id }); await settle();
    const ids = load.mock.calls.flatMap(([scope]) => scope?.issueIds ?? (scope?.issueId ? [scope.issueId] : []));
    expect(ids).toEqual(expect.arrayContaining([oldParent.id, newParent.id, terminal.id]));
    load.mockClear();
    await issueService(db).update(terminal.id, { hiddenAt: null }); await settle();
    expect(await state("blocker_attention", terminal.id)).toBeNull();
    const visible = await service.load({ companyId, issueId: newParent.id });
    expect(visible.rows!.some(entry => entry.sourceId === terminal.id && entry.dueAt > Date.now())).toBe(true);
    expect(load.mock.calls.some(([scope]) => scope?.issueId === newParent.id || scope?.issueIds?.includes(newParent.id))).toBe(true);
    const next = await insertIssue("backlog", { assigneeAgentId: agentId });
    await issueService(db).update(oldParent.id, { blockedByIssueIds: [next.id] }); await archived("blocker_attention", next.id);
  });

  it("cancels and reactivates a blocker deadline through ordinary liveness incident creation and hiding", async () => {
    const root = await insertIssue("blocked");
    const terminal = await insertIssue("backlog", { assigneeAgentId: agentId, updatedAt: new Date(Date.now() - delay + 10_000) });
    await db.insert(issueRelations).values({ companyId, issueId: terminal.id, relatedIssueId: root.id, type: "blocks" });
    await start(); await settle(); expect(coordinator!.nextWakeAt()).not.toBeNull();
    const incident = await issueService(db).create(companyId, { title: "Resolve liveness", status: "todo", assigneeUserId: "board",
      createdByUserId: "board", originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
      originId: buildIssueGraphLivenessIncidentKey({ companyId, issueId: root.id, state: "needs_attention", blockerIssueId: terminal.id }) });
    await quiet(); expect(await state("blocker_attention", terminal.id)).toBeNull();
    await issueService(db).update(incident.id, { hiddenAt: new Date() });
    await archived("blocker_attention", terminal.id); await quiet();
  });

  it("resolves opaque run issue references through trusted company issue rows", async () => {
    const issue = await insertIssue();
    const [valid, opaque] = await db.insert(heartbeatRuns).values([
      { companyId, agentId, status: "succeeded", contextSnapshot: { issueId: issue.id } },
      { companyId, agentId, status: "succeeded", contextSnapshot: { issueId: "none" } },
    ]).returning();
    const hints: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.attentionRetention, (event, values) => {
      if (event === "settled") hints.push(...values ?? []);
    });
    try {
      await db.transaction(tx => notifyIssueAttentionRetentionWork(tx, { companyId, runId: valid.id }));
      await db.transaction(tx => notifyIssueAttentionRetentionWork(tx, { companyId, runId: opaque.id }));
    } finally { unsubscribe(); }
    expect(hints).toEqual([JSON.stringify({ companyId, issueId: issue.id }), JSON.stringify({ companyId })]);
  });

  it("accepts ordinary liveness incident creation and completion with a none leaf sentinel", async () => {
    const source = await insertIssue("blocked", { responsibleUserId: "board" });
    const service = issueService(db);
    const incident = await service.create(companyId, { title: "Invalid participant", status: "todo", assigneeUserId: "board",
      createdByUserId: "board", originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
      originId: `harness_liveness:${companyId}:${source.id}:invalid_review_participant:none` });
    await service.update(source.id, { blockedByIssueIds: [incident.id] });
    await service.update(incident.id, { status: "done" });
    expect((await service.getById(incident.id))?.status).toBe("done");
    expect((await service.getRelationSummaries(source.id)).blockedBy).toEqual([]);
  });

  it.each(["hidden", "done"] as const)("reactivates an older review when moved stranded recovery is %s", async transition => {
    const review = await insertIssue("in_review", { assigneeAgentId: agentId, responsibleUserId: "board" });
    const parent = await insertIssue("todo", { responsibleUserId: "board" });
    const recovery = await insertIssue("todo", { parentId: review.id, originKind: RECOVERY_ORIGIN_KINDS.strandedIssueRecovery,
      originId: review.id, assigneeUserId: "board", responsibleUserId: "board" });
    await issueService(db).update(recovery.id, { parentId: parent.id });
    expect((await issueService(db).listReviewAttention(companyId, [review])).get(review.id)?.state).not.toBe("stalled");
    await start(); await quiet();
    await issueService(db).update(recovery.id, transition === "hidden" ? { hiddenAt: new Date() } : { status: "done" });
    await settle();
    expect((await state("review", review.id))?.archivedAt).toBeInstanceOf(Date);
    expect(await db.select().from(decisionArchiveNotificationOutbox).where(eq(decisionArchiveNotificationOutbox.sourceId, review.id))).toHaveLength(1);
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
