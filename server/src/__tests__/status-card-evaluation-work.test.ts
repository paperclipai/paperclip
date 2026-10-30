import { budgetService } from "../services/budgets.js";
import { documentService } from "../services/documents.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, agents, approvals, budgetIncidents, budgetPolicies, costEvents, companies, companyMemberships, createDb, documents,
  heartbeatRuns, instanceSettings, issueComments, issues, statusCards, statusCardUpdates, documentRevisions } from "@paperclipai/db";
import { companySearchQuerySchema, statusCardRefreshPolicySchema } from "@paperclipai/shared";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerStatusCardEvaluationWork, statusCardEvaluationService } from "../services/status-card-evaluation.js";
import { statusCardService } from "../services/status-cards.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_STATUS_CARD_EVALUATION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("status-card evaluation work", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let draining = false;
  let companyId: string, agentId: string;
  const errors: unknown[] = [];
  let compiledQuery = companySearchQuerySchema.parse({ scope: "issues", status: ["blocked"] });
  const actor = { agentId: null, userId: "board-user" };
  const policy = (mode: "manual" | "reactive" | "interval" = "reactive") => statusCardRefreshPolicySchema.parse({
    mode, debounceSeconds: 60, intervalMinutes: 15,
  });
  // Controlled provider boundary: assignment persists a queued wake, and tests
  // explicitly run the authorized summarizer writeback. No model/provider runs.
  const wakeup = vi.fn(async (id: string, options: { payload?: Record<string, unknown> | null; reason?: string | null }) => {
    const [agent] = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, id));
    return db.insert(agentWakeupRequests).values({ companyId: agent!.companyId, agentId: id, source: "assignment",
      reason: options.reason, payload: options.payload, status: "queued" }).returning();
  });

  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("status-card-evaluation-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 30_000);
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); draining = false; errors.length = 0; wakeup.mockReset();
    compiledQuery = companySearchQuerySchema.parse({ scope: "issues", status: ["blocked"] });
    await db.insert(companies).values({ id: companyId, name: "Status", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Summarizer", role: "general", status: "idle", adapterType: "process", adapterConfig: {} });
    await instanceSettingsService(db).updateExperimental({ enableStatusCards: true });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(budgetIncidents); await db.delete(budgetPolicies); await db.delete(approvals); await db.delete(costEvents);
    await db.delete(agentWakeupRequests); await db.delete(statusCardUpdates); await db.delete(statusCards);
    await db.delete(documentRevisions); await db.delete(documents); await db.delete(activityLog);
    await db.delete(issueComments); await db.delete(issues); await db.delete(heartbeatRuns);
    await db.delete(instanceSettings); await db.delete(agents); await db.delete(companyMemberships); await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true,
      onError: error => errors.push(error) });
    await registerStatusCardEvaluationWork(coordinator, statusCardEvaluationService(db, { wakeup }), () => !draining).ready;
  }
  async function settled() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 5000 });
  }
  async function quiet() {
    await settled();
    expect(coordinator!.nextWakeAt()).toBeNull();
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "update"), executes = vi.spyOn(db, "execute");
    const calls = wakeup.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled();
    expect(wakeup).toHaveBeenCalledTimes(calls);
    reads.mockRestore(); writes.mockRestore(); executes.mockRestore();
  }
  async function writeback(cardId: string, generationIssueId: string, compile = false) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
    await db.update(issues).set({ checkoutRunId: run!.id }).where(eq(issues.id, generationIssueId));
    const writer = { agentId, runId: run!.id };
    const cards = statusCardService(db);
    if (compile) await cards.writeQuery(cardId, { queries: [compiledQuery],
      title: "Blockers", changeSummary: "Compiled", generationIssueId }, writer);
    await cards.writeSummary(cardId, { markdown: "Current blockers", changeSummary: "Updated", generationIssueId }, writer);
    await issueService(db).update(generationIssueId, { status: "done" });
  }
  async function card(mode: "manual" | "reactive" | "interval" = "reactive", refreshPolicy = policy(mode)) {
    const cards = statusCardService(db);
    const created = await cards.create(companyId, { interestPrompt: "Blockers", titlePinned: false, agentId, refreshPolicy }, actor);
    const compile = await cards.requestCompile(created.id, actor);
    await writeback(created.id, compile.generatingIssue.id, true);
    return cards.getById(created.id).then(row => row!);
  }

  it("settles empty, disabled, configured manual and unchanged reactive history without recurring SQL", async () => {
    await start(); await quiet();
    await card("manual"); await card("reactive"); await quiet();
    await instanceSettingsService(db).updateExperimental({ enableStatusCards: false }); await quiet();
    expect(errors).toEqual([]);
  });

  it("ordinary issue change schedules debounce, assigns one durable wake, writes a result and becomes quiet", async () => {
    await start(); const created = await card(); await quiet();
    const changed = await issueService(db).create(companyId, { title: "New blocker", status: "blocked", priority: "medium", createdByUserId: "board-user" });
    await vi.waitFor(async () => {
      expect((await statusCardService(db).getById(created.id))?.pendingChangeCount).toBeGreaterThan(0);
    }, { timeout: 5000 });
    const pending = await statusCardService(db).getById(created.id);
    expect(pending?.pendingChangeCount).toBeGreaterThan(0);
    expect(pending?.nextEvalAt).toBeInstanceOf(Date);
    expect(wakeup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000); await settled();
    const generating = await statusCardService(db).getById(created.id);
    expect(generating?.generatingIssueId).toBeTruthy();
    const durable = await db.select().from(agentWakeupRequests);
    expect(durable).toHaveLength(1); expect(durable[0]?.payload?.issueId).toBe(generating?.generatingIssueId);
    expect(changed.companyId).toBe(companyId);
    await writeback(created.id, generating!.generatingIssueId!); await quiet();
    expect(await db.select().from(statusCardUpdates).then(rows => rows.filter(row => row.generationIssueId === generating?.generatingIssueId)))
      .toMatchObject([{ status: "ok", finishedAt: expect.any(Date) }]);
    expect(errors).toEqual([]);
  });

  it("cancels archived or disabled future work and replaces an earlier interval deadline", async () => {
    await start(); let created = await card("interval"); await settled();
    const old = coordinator!.nextWakeAt();
    created = await statusCardService(db).update(created, { refreshPolicy: { ...policy("interval"), intervalMinutes: 1 } }, actor);
    await settled(); expect(coordinator!.nextWakeAt()).toBeLessThan(old!);
    await statusCardService(db).update(created, { archived: true }, actor); await quiet();
    expect(wakeup).not.toHaveBeenCalled(); expect(errors).toEqual([]);
  });

  it("restores overdue debt after the feature is disabled across its saved deadline", async () => {
    await start(); const created = await card(); await quiet();
    await issueService(db).create(companyId, { title: "Disabled blocker", status: "blocked", priority: "medium" });
    await vi.waitFor(async () => expect((await statusCardService(db).getById(created.id))?.pendingChangeCount).toBeGreaterThan(0));
    const pending = (await statusCardService(db).getById(created.id))!;
    await instanceSettingsService(db).updateExperimental({ enableStatusCards: false }); await quiet();
    expect(wakeup).not.toHaveBeenCalled();
    expect((await statusCardService(db).getById(created.id))!.nextEvalAt).toEqual(pending.nextEvalAt);
    await instanceSettingsService(db).updateExperimental({ enableStatusCards: true });
    await vi.waitFor(() => expect(wakeup).toHaveBeenCalledOnce());
    await writeback(created.id, (await statusCardService(db).getById(created.id))!.generatingIssueId!); await quiet();
  });

  it("does not react to rolled-back or nested uncommitted card configuration", async () => {
    await start(); const created = await card("manual"); await quiet();
    await expect(db.transaction(async tx => {
      await statusCardService(tx as unknown as typeof db).update(created, { refreshPolicy: policy("interval") }, actor);
      await vi.advanceTimersByTimeAsync(30_000); expect(wakeup).not.toHaveBeenCalled();
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await quiet(); expect((await statusCardService(db).getById(created.id))?.nextEvalAt).toBeNull();
    await db.transaction(async tx => {
      await tx.transaction(async nested => {
        await statusCardService(nested as unknown as typeof db).update(created, { refreshPolicy: policy("interval") }, actor);
      });
      expect(coordinator!.nextWakeAt()).not.toBeNull();
      expect((await statusCardService(db).getById(created.id))?.nextEvalAt).toBeNull();
    });
    await settled(); expect(coordinator!.nextWakeAt()).not.toBeNull(); expect(errors).toEqual([]);
  });

  it("serializes competing connections when one source event preempts a future evaluation", async () => {
    const created = await card();
    await db.update(statusCards).set({ nextEvalAt: new Date(Date.now() + 3_600_000) }).where(eq(statusCards.id, created.id));
    await issueService(db).create(companyId, { title: "Concurrent blocker", status: "blocked", priority: "medium", createdByUserId: "board-user" });
    const first = statusCardEvaluationService(db, { wakeup });
    const second = statusCardEvaluationService(db, { wakeup });
    first.changed(new Set([`changes:${companyId}`])); second.changed(new Set([`changes:${companyId}`]));
    await Promise.all([first.run(new AbortController().signal), second.run(new AbortController().signal)]);
    const pending = await statusCardService(db).getById(created.id);
    expect(pending?.pendingChangeCount).toBeGreaterThan(0);
    expect(pending?.nextEvalAt?.getTime()).toBeLessThan(Date.now() + 3_600_000);
    expect(wakeup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([first.run(new AbortController().signal), second.run(new AbortController().signal)]);
    const updated = await statusCardService(db).getById(created.id);
    expect(updated?.generatingIssueId).toBeTruthy(); expect(wakeup).toHaveBeenCalledOnce();
    expect(await db.select().from(statusCardUpdates).then(rows => rows.filter(row => row.generationIssueId === updated?.generatingIssueId)))
      .toHaveLength(1);
  });

  it.each(["debounce", "hours", "rate", "budget"] as const)("restores pending %s eligibility after restart without advancing it or acting early", async gate => {
    vi.setSystemTime(new Date("2026-11-02T18:00:00Z"));
    const refreshPolicy = { ...policy(), ...(gate === "hours" ? { activeHours: { start: "09:00", end: "17:00", timezone: "UTC" } } : {}),
      ...(gate === "rate" ? { maxUpdatesPerHour: 1 } : {}), ...(gate === "budget" ? { dailyTokenCap: 100 } : {}) };
    const created = await card("reactive", refreshPolicy);
    if (gate === "rate" || gate === "budget") await db.insert(statusCardUpdates).values({ cardId: created.id, kind: "full", trigger: "reactive",
      status: "ok", startedAt: new Date(Date.now() - (gate === "rate" ? 30 * 60_000 : 60_000)), finishedAt: new Date(), inputTokens: gate === "budget" ? 100 : 0 });
    await issueService(db).create(companyId, { title: "Saved blocker", status: "blocked", priority: "medium", createdByUserId: "board-user" });
    const service = statusCardEvaluationService(db, { wakeup });
    await service.run(new AbortController().signal);
    const pending = (await statusCardService(db).getById(created.id))!;
    expect(pending.pendingChangeCount).toBeGreaterThan(0); expect(pending.nextEvalAt!.getTime()).toBeGreaterThan(Date.now());
    const restarted = statusCardEvaluationService(db, { wakeup });
    await restarted.run(new AbortController().signal);
    expect(await restarted.next()).toBe(pending.nextEvalAt!.getTime());
    expect((await statusCardService(db).getById(created.id))!.nextEvalAt).toEqual(pending.nextEvalAt);
    vi.setSystemTime(pending.nextEvalAt!.getTime() - 1); await restarted.run(new AbortController().signal);
    expect(wakeup).not.toHaveBeenCalled();
    vi.setSystemTime(pending.nextEvalAt!); await restarted.run(new AbortController().signal);
    expect(wakeup).toHaveBeenCalledOnce();
  });

  it("unions startup reconstruction with a scoped source change in another company", async () => {
    const firstCompany = companyId;
    const first = await card();
    await issueService(db).create(companyId, { title: "First blocker", status: "blocked", priority: "medium" });
    companyId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Other", issuePrefix: `X${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Other summarizer", role: "general", status: "idle", adapterType: "process", adapterConfig: {} });
    const second = await card();
    await issueService(db).create(companyId, { title: "Second blocker", status: "blocked", priority: "medium" });
    const service = statusCardEvaluationService(db, { wakeup });
    service.changed(new Set([`changes:${companyId}`]));
    await service.run(new AbortController().signal);
    const cards = statusCardService(db);
    expect((await cards.getById(first.id))?.companyId).toBe(firstCompany);
    expect((await cards.getById(first.id))?.pendingChangeCount).toBeGreaterThan(0);
    expect((await cards.getById(second.id))?.pendingChangeCount).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(60_000); await service.run(new AbortController().signal);
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(new Set(await db.select().from(agentWakeupRequests).then(rows => rows.map(row => row.companyId))))
      .toEqual(new Set([firstCompany, companyId]));
  });

  it("keeps ignored issue activity quiet and reacts to human comments and document search membership", async () => {
    await start(); await card(); await quiet();
    await issueService(db).create(companyId, { title: "Ignored todo", status: "todo", priority: "medium" });
    await quiet(); expect(wakeup).not.toHaveBeenCalled();
    compiledQuery = companySearchQuerySchema.parse({ scope: "all", q: "launch" });
    const searchCard = await card(); await quiet();
    const target = await issueService(db).create(companyId, { title: "Ordinary task", status: "todo", priority: "medium" });
    await quiet();
    await documentService(db).upsertIssueDocument({ issueId: target.id, key: "plan", format: "markdown", body: "launch evidence", createdByUserId: "board-user" });
    await vi.waitFor(async () => expect((await statusCardService(db).getById(searchCard.id))?.pendingChangeCount).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(60_000); await settled(); expect(wakeup).toHaveBeenCalledOnce();
    await writeback(searchCard.id, (await statusCardService(db).getById(searchCard.id))!.generatingIssueId!); await quiet();
    await issueService(db).addComment(target.id, "A human launch update", { userId: "board-user" });
    await vi.waitFor(async () => expect((await statusCardService(db).getById(searchCard.id))?.pendingChangeCount).toBeGreaterThan(0));
  });

  it("retains relative query membership expiry across restart and emits the eventual removal", async () => {
    const now = new Date();
    const target = await issueService(db).create(companyId, { title: "Expiring blocker", status: "blocked", priority: "medium" });
    await db.update(issues).set({ updatedAt: now }).where(eq(issues.id, target.id));
    compiledQuery = companySearchQuerySchema.parse({ scope: "issues", status: ["blocked"], updatedWithin: "1h" });
    const created = await card();
    const expires = now.getTime() + 3_600_001;
    expect(created.nextEvalAt?.getTime()).toBe(expires);
    const restarted = statusCardEvaluationService(db, { wakeup });
    await restarted.run(new AbortController().signal);
    expect(await restarted.next()).toBe(expires);
    vi.setSystemTime(expires - 1); await restarted.run(new AbortController().signal); expect(wakeup).not.toHaveBeenCalled();
    vi.setSystemTime(expires); await restarted.run(new AbortController().signal);
    const pending = (await statusCardService(db).getById(created.id))!;
    expect(pending.pendingChangeCount).toBe(1); expect(pending.nextEvalAt!.getTime()).toBe(expires + 60_000);
    vi.setSystemTime(pending.nextEvalAt!); await restarted.run(new AbortController().signal);
    expect(wakeup).toHaveBeenCalledOnce();
  });

  it("uses expiry of an off-page candidate to refresh offset-ranked query membership", async () => {
    const now = new Date();
    const tasks = await Promise.all((["critical", "high", "medium"] as const).map(priority => issueService(db).create(companyId, {
      title: `${priority} blocker`, priority, status: "blocked",
    })));
    await db.update(issues).set({ updatedAt: new Date(now.getTime() - 59 * 60_000) }).where(eq(issues.id, tasks[0]!.id));
    for (const task of tasks.slice(1)) await db.update(issues).set({ updatedAt: now }).where(eq(issues.id, task.id));
    compiledQuery = companySearchQuerySchema.parse({ scope: "issues", status: ["blocked"], updatedWithin: "1h", sort: "priority", limit: 1, offset: 1 });
    const created = await card();
    expect(Object.keys(created.fingerprint!)).toEqual([tasks[1]!.id]);
    const expires = now.getTime() + 60_001;
    expect(created.nextEvalAt?.getTime()).toBe(expires);
    const service = statusCardEvaluationService(db, { wakeup });
    vi.setSystemTime(expires); await service.run(new AbortController().signal);
    const pending = (await statusCardService(db).getById(created.id))!;
    expect(pending.pendingChangeCount).toBe(2); expect(wakeup).not.toHaveBeenCalled();
    vi.setSystemTime(pending.nextEvalAt!); await service.run(new AbortController().signal);
    expect(wakeup).toHaveBeenCalledOnce();
    const [update] = await db.select().from(statusCardUpdates).where(eq(statusCardUpdates.generationIssueId, (await statusCardService(db).getById(created.id))!.generatingIssueId!));
    expect(new Set(update!.changes.map(change => change.issueId))).toEqual(new Set([tasks[1]!.id, tasks[2]!.id]));
  });

  it("retains a scoped retry while another evaluator owns the card lock", async () => {
    const created = await card();
    await issueService(db).create(companyId, { title: "Locked blocker", status: "blocked", priority: "medium" });
    const acquired = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const holder = db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${created.id}, 0))`);
      acquired.resolve(); await release.promise;
    });
    await acquired.promise;
    const service = statusCardEvaluationService(db, { wakeup });
    service.changed(new Set([`changes:${companyId}`]));
    try {
      await service.run(new AbortController().signal);
      expect(await service.next()).toBeGreaterThan(Date.now());
      expect((await statusCardService(db).getById(created.id))!.nextEvalAt).toBeNull();
      expect(wakeup).not.toHaveBeenCalled();
    } finally { release.resolve(); await holder; }
    await vi.advanceTimersByTimeAsync(30_000); await service.run(new AbortController().signal);
    const pending = (await statusCardService(db).getById(created.id))!;
    expect(pending.pendingChangeCount).toBeGreaterThan(0);
    vi.setSystemTime(pending.nextEvalAt!); await service.run(new AbortController().signal);
    expect(wakeup).toHaveBeenCalledOnce();
  });

  it("retains the durable five-minute retry after evaluation failure across restart and drain", async () => {
    const created = await card();
    await db.update(statusCards).set({ queries: [{ scope: "invalid" } as never], nextEvalAt: new Date() }).where(eq(statusCards.id, created.id));
    const service = statusCardEvaluationService(db, { wakeup });
    await service.run(new AbortController().signal);
    const failed = (await statusCardService(db).getById(created.id))!;
    const retryAt = failed.nextEvalAt!.getTime();
    expect(retryAt).toBeGreaterThan(Date.now() + 299_000); expect(wakeup).not.toHaveBeenCalled();
    await start(); expect(coordinator!.nextWakeAt()).toBe(retryAt);
    draining = true; await vi.advanceTimersByTimeAsync(5 * 60_000); await settled(); expect(wakeup).not.toHaveBeenCalled();
    // Repair the controlled malformed stored-query fault; no tested result is precreated.
    await db.update(statusCards).set({ queries: [compiledQuery] }).where(eq(statusCards.id, created.id));
    draining = false; await vi.advanceTimersByTimeAsync(30_000); await quiet();
    expect((await statusCardService(db).getById(created.id))!.nextEvalAt).toBeNull();
  });

  it("cancels failed assignments without rerunning a completed generation and settles after retry", async () => {
    await start(); const created = await card(); await quiet();
    wakeup.mockRejectedValueOnce(new Error("assignment unavailable"));
    await issueService(db).create(companyId, { title: "Assignment blocker", status: "blocked", priority: "medium" });
    await vi.waitFor(async () => expect((await statusCardService(db).getById(created.id))?.pendingChangeCount).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(60_000); await settled();
    const failed = (await statusCardService(db).getById(created.id))!;
    expect(failed).toMatchObject({ state: "error", generatingIssueId: null, nextEvalAt: null });
    expect(errors.length).toBeGreaterThan(0);
    const history = await db.select().from(statusCardUpdates).where(eq(statusCardUpdates.cardId, created.id));
    const ledger = history.find(row => row.status === "failed")!;
    expect(ledger.finishedAt).toBeInstanceOf(Date);
    expect((await db.select().from(issues).where(eq(issues.id, ledger.generationIssueId!)))[0]?.status).toBe("cancelled");
    const count = wakeup.mock.calls.length; await quiet(); expect(wakeup).toHaveBeenCalledTimes(count);
    // An explicit ordinary refresh is still the user's supported retry action.
    const retry = await statusCardService(db).requestRefresh(created.id, { trigger: "manual", actor });
    expect(retry.generatingIssue).toBeTruthy(); await writeback(created.id, retry.generatingIssue!.id); await quiet();
    expect((await statusCardService(db).getById(created.id))!.state).toBe("active");
  });

  it("budget-owned company resume reactivates reactive work committed while paused", async () => {
    await start(); const created = await card(); await quiet();
    const budgets = budgetService(db);
    await budgets.upsertPolicy(companyId, { scopeType: "company", scopeId: companyId, amount: 100, hardStopEnabled: true, notifyEnabled: false }, "board-user");
    const [cost] = await db.insert(costEvents).values({ companyId, agentId, provider: "openai", biller: "openai", billingType: "metered_api", model: "test",
      costCents: 200, occurredAt: new Date() }).returning();
    await budgets.evaluateCostEvent(cost!);
    expect((await db.select().from(companies).where(eq(companies.id, companyId)))[0]?.status).toBe("paused");
    await quiet();
    await issueService(db).create(companyId, { title: "Paused blocker", status: "blocked", priority: "medium" }); await quiet();
    expect(wakeup).not.toHaveBeenCalled();
    await budgets.upsertPolicy(companyId, { scopeType: "company", scopeId: companyId, amount: 1000 }, "board-user");
    expect((await db.select().from(companies).where(eq(companies.id, companyId)))[0]?.status).toBe("active");
    await vi.waitFor(async () => expect((await statusCardService(db).getById(created.id))?.pendingChangeCount).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(60_000); await settled(); expect(wakeup).toHaveBeenCalledOnce();
  });

  it("preserves the first write during drain until resume", async () => {
    await start(); const created = await card("manual"); await quiet();
    draining = true;
    await statusCardService(db).update(created, { refreshPolicy: policy("interval") }, actor);
    await settled(); expect(wakeup).not.toHaveBeenCalled();
    draining = false; await vi.advanceTimersByTimeAsync(30_000); await settled();
    expect(coordinator!.nextWakeAt()).not.toBeNull(); expect(errors).toEqual([]);
  });
});
