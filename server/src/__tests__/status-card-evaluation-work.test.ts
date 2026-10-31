import { budgetService } from "../services/budgets.js";
import { documentService } from "../services/documents.js";
import { projectService } from "../services/projects.js";
import * as companySearch from "../services/company-search.js";
import { setImmediate as immediate } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, agents, approvals, budgetIncidents, budgetPolicies, costEvents, companies, companyMemberships, createDb, documents, withDedicatedDbConnection,
  heartbeatRuns, instanceSettings, issueComments, issueWorkProducts, issues, projects, statusCards, statusCardUpdates, documentRevisions } from "@paperclipai/db";
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
  const evaluations = new Set<Promise<unknown>>();
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
    await db.delete(instanceSettings); await db.delete(projects); await db.delete(agents); await db.delete(companyMemberships); await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function start(service = statusCardEvaluationService(db, { wakeup })) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true,
      onError: error => errors.push(error) });
    await registerStatusCardEvaluationWork(coordinator, { ...service, run: signal => {
      const work = service.run(signal);
      evaluations.add(work);
      void work.then(() => evaluations.delete(work), () => evaluations.delete(work));
      return work;
    } }, () => !draining).ready;
  }
  async function settled() {
    // Do not leap across PostgreSQL connect timers while real I/O is pending.
    // Await actual domain work, then require several settled event-loop turns
    // so a transient zero hold cannot stand in for transaction reconciliation.
    for (let turn = 0; turn < 3; turn++) {
      await vi.waitFor(async () => {
        await Promise.allSettled([...evaluations]);
        await vi.advanceTimersByTimeAsync(500);
        await Promise.allSettled([...evaluations]);
        expect(idleWorkSnapshot().active).toBe(0);
      }, { timeout: 5000 });
      await immediate();
    }
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
    if (!coordinator && mode === "reactive") await cards.tickDueStatusCards();
    return cards.getById(created.id).then(row => row!);
  }

  it("settles empty, disabled, configured manual and unchanged reactive history without recurring SQL", async () => {
    await start(); await quiet();
    await card("manual"); await card("reactive"); await quiet();
    await instanceSettingsService(db).updateExperimental({ enableStatusCards: false }); await quiet();
    expect(errors).toEqual([]);
  });

  it("keeps mixed-search card preview, startup and ordinary issue delivery on issue-only pages", async () => {
    const target = await issueService(db).create(companyId, { title: "Launch blocker", status: "blocked", priority: "medium" });
    await vi.advanceTimersByTimeAsync(1_000);
    const project = await projectService(db).create(companyId, { name: "Launch project" });
    await db.insert(agents).values({ companyId, name: "Launch agent", role: "general", status: "idle", adapterType: "process" });
    const holder = await issueService(db).create(companyId, { title: "Artifact holder", status: "todo", priority: "medium" });
    await db.insert(issueWorkProducts).values({ companyId, issueId: holder.id, type: "artifact", provider: "paperclip",
      title: "Launch artifact", status: "ready" });
    compiledQuery = companySearchQuerySchema.parse({ q: "launch", scope: "all", sort: "updated", limit: 1 });
    const created = await card();
    expect(Object.keys(created.fingerprint!)).toEqual([target.id]);
    const cards = statusCardService(db);
    const [preview] = await cards.dryRun(created);
    expect(preview!.result.results.map(row => row.id)).toEqual([target.id]);
    await start(); await quiet();
    await issueService(db).update(target.id, { status: "done" });
    await settled();
    const pending = (await cards.getById(created.id))!;
    expect(pending.pendingChangeCount).toBe(1);
    await vi.advanceTimersByTimeAsync(Math.max(0, pending.nextEvalAt!.getTime() - Date.now()));
    await settled();
    const generating = (await cards.getById(created.id))!;
    expect(wakeup).toHaveBeenCalledOnce();
    await writeback(created.id, generating.generatingIssueId!); await quiet();
    await projectService(db).update(project.id, { name: "Launch project renamed" });
    const updated = (await cards.getById(created.id))!;
    expect((await cards.dryRun(updated))[0]!.result.results.map(row => row.id)).toEqual([target.id]);
    expect(updated.fingerprint![target.id]!.status).toBe("done");
    await quiet();
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

  it.each([true, false])("rechecks source hints consumed during summary writeback without forcing unchanged generation (relevant=%s)", async relevant => {
    const evaluation = statusCardEvaluationService(db, { wakeup });
    const runs = vi.spyOn(evaluation, "run"), hints = vi.spyOn(evaluation, "changed");
    await start(evaluation);
    const created = await card();
    await quiet();
    const cards = statusCardService(db);
    const generation = await cards.requestRefresh(created.id, { trigger: "manual", actor });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
    await db.update(issues).set({ checkoutRunId: run!.id }).where(eq(issues.id, generation.generatingIssue!.id));
    const writer = { agentId, runId: run!.id };
    await settled();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const factory = companySearch.companySearchService;
    let hold = true;
    const searchedCompanies: string[] = [];
    vi.spyOn(companySearch, "companySearchService").mockImplementation(owner => {
      const search = factory(owner), actual = search.search;
      search.search = async (...args) => {
        searchedCompanies.push(args[0]);
        const result = await actual(...args);
        if (hold) { hold = false; entered.resolve(); await release.promise; }
        return result;
      };
      return search;
    });
    const writing = cards.writeSummary(created.id, { markdown: "Current blockers", changeSummary: "Completed before source change", generationIssueId: generation.generatingIssue!.id }, writer);
    await entered.promise;
    const passes = runs.mock.calls.length;
    hints.mockClear();
    try {
      await issueService(db).create(companyId, { title: "Source committed after summary search", status: relevant ? "blocked" : "backlog", priority: "medium" });
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(500);
        await Promise.allSettled([...evaluations]);
        expect(hints.mock.calls.some(([scope]) => scope?.has(`changes:${companyId}`))).toBe(true);
        expect(runs.mock.calls.length).toBeGreaterThan(passes);
      }, { timeout: 5000 });
      expect((await cards.getById(created.id))!.generatingIssueId).toBe(generation.generatingIssue!.id);
      expect(await evaluation.next()).toBeNull();
      expect(wakeup).not.toHaveBeenCalled();
      expect(searchedCompanies).toEqual([companyId]);
    } finally { release.resolve(); }
    await writing;
    await settled();
    if (relevant) {
      const pending = (await cards.getById(created.id))!;
      expect(pending.generatingIssueId).toBeNull();
      expect(pending.pendingChangeCount).toBe(1);
      expect(pending.nextEvalAt).toBeInstanceOf(Date);
      expect(wakeup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(Math.max(0, pending.nextEvalAt!.getTime() - Date.now()));
      await settled();
      const generated = (await cards.getById(created.id))!;
      expect(generated.generatingIssueId).toBeTruthy();
      expect(wakeup).toHaveBeenCalledOnce();
      expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
      await writeback(created.id, generated.generatingIssueId!);
      expect((await db.select().from(statusCardUpdates).where(eq(statusCardUpdates.generationIssueId, generated.generatingIssueId!))))
        .toMatchObject([{ status: "ok", finishedAt: expect.any(Date) }]);
    }
    await quiet();
    expect(wakeup).toHaveBeenCalledTimes(relevant ? 1 : 0);
    if (!relevant) expect(searchedCompanies).toEqual([companyId, companyId]);
    expect(new Set(searchedCompanies)).toEqual(new Set([companyId]));
    expect(errors).toEqual([]);
  });

  it("rolls back the summary and its post-commit recheck obligation together", async () => {
    await start(); const created = await card(); await quiet();
    const cards = statusCardService(db);
    const generation = await cards.requestRefresh(created.id, { trigger: "manual", actor });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
    await db.update(issues).set({ checkoutRunId: run!.id }).where(eq(issues.id, generation.generatingIssue!.id));
    await settled();
    const before = (await cards.getById(created.id))!;
    const revisions = await cards.listSummaryRevisions(created.id);
    await expect(db.transaction(async tx => {
      await statusCardService(tx as unknown as typeof db).writeSummary(created.id, { markdown: "Rolled back summary", changeSummary: "Rollback", generationIssueId: generation.generatingIssue!.id }, { agentId, runId: run!.id });
      throw new Error("summary rollback");
    })).rejects.toThrow("summary rollback");
    await quiet();
    expect((await cards.getById(created.id))!).toMatchObject({ generatingIssueId: before.generatingIssueId, nextEvalAt: before.nextEvalAt, nextEvalReason: before.nextEvalReason });
    expect(await cards.listSummaryRevisions(created.id)).toEqual(revisions);
    expect(wakeup).not.toHaveBeenCalled(); expect(errors).toEqual([]);
  });

  it.each(["manual", "interval"] as const)("preserves %s writeback cadence without a reactive recheck", async mode => {
    const created = await card(mode), cards = statusCardService(db);
    const generation = await cards.requestRefresh(created.id, { trigger: "manual", actor });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
    await db.update(issues).set({ checkoutRunId: run!.id }).where(eq(issues.id, generation.generatingIssue!.id));
    const result = await cards.writeSummary(created.id, { markdown: "Current blockers", changeSummary: "Complete", generationIssueId: generation.generatingIssue!.id }, { agentId, runId: run!.id });
    expect(result.card.generatingIssueId).toBeNull();
    expect(result.card.nextEvalAt?.getTime() ?? null).toBe(mode === "interval" ? result.card.lastGeneratedAt!.getTime() + 15 * 60_000 : null);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("keeps card deletion scoped to its company and a missing deletion quiet", async () => {
    const removed = await card();
    await card();
    const ownCompany = companyId, ownAgent = agentId;
    companyId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Other", issuePrefix: `O${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Other summarizer", role: "general", status: "idle", adapterType: "process", adapterConfig: {} });
    const other = await card();
    companyId = ownCompany; agentId = ownAgent;
    const factory = companySearch.companySearchService;
    const searchedCompanies: string[] = [];
    vi.spyOn(companySearch, "companySearchService").mockImplementation(owner => {
      const search = factory(owner), actual = search.search;
      search.search = async (...args) => { searchedCompanies.push(args[0]); return actual(...args); };
      return search;
    });
    await start(); await quiet(); searchedCompanies.length = 0;
    const cards = statusCardService(db);
    expect(await cards.remove(removed.id)).toMatchObject({ id: removed.id, companyId: ownCompany });
    await settled();
    // Deleting a card only reconstructs deadlines; it is not an issue change
    // that warrants re-running any unchanged reactive card's saved search.
    expect(searchedCompanies).toEqual([]);
    expect(await cards.getById(other.id)).toMatchObject({ nextEvalAt: null, generatingIssueId: null, pendingChangeCount: 0 });
    expect(wakeup).not.toHaveBeenCalled();
    searchedCompanies.length = 0;
    expect(await cards.remove(removed.id)).toBeNull();
    await quiet();
    expect(searchedCompanies).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("coalesces one hundred committed source writes without delaying another company's saved deadline", async () => {
    const reactive = await card();
    const originalCompany = companyId, originalAgent = agentId;
    companyId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Other", issuePrefix: `O${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Other summarizer", role: "general", status: "idle", adapterType: "process", adapterConfig: {} });
    const other = await card("interval");
    const otherIssue = await issueService(db).create(companyId, { title: "Other interval blocker", status: "blocked", priority: "medium" });
    const otherReactive = await card();
    companyId = originalCompany; agentId = originalAgent;
    const service = statusCardEvaluationService(db, { wakeup });
    const originalRun = service.run;
    let running: Promise<unknown> | undefined;
    const run = vi.spyOn(service, "run").mockImplementation(signal => {
      const result = originalRun(signal); running = result; return result;
    });
    await start(service); await settled();
    await vi.advanceTimersByTimeAsync(1000);
    // Give each committed producer and any actual domain work time to settle.
    // This prevents incidental overlap from hiding per-write reconstruction.
    const flush = async () => {
      for (let i = 0; i < 10; i++) {
        await running; await immediate();
      }
    };
    await flush();
    const select = vi.spyOn(db, "select");
    const factory = companySearch.companySearchService;
    const searchedCompanies: string[] = [];
    vi.spyOn(companySearch, "companySearchService").mockImplementation(owner => {
      const search = factory(owner);
      const actual = search.search;
      search.search = async (...args) => { searchedCompanies.push(args[0]); return actual(...args); };
      return search;
    });
    run.mockClear();
    const burstStarted = Date.now();
    for (let i = 0; i < 50; i++) {
      const issue = await issueService(db).create(companyId, { title: `Burst blocker ${i}`, status: "blocked", priority: "medium" });
      await flush();
      await issueService(db).addComment(issue.id, `Human update ${i}`, { userId: "board-user" });
      await flush();
    }
    await flush();
    // One eager reconciliation after idle and one bounded batched continuation.
    // Each pass reads candidates once; evaluating its one changed card also
    // reads that card's revision for generation CAS. Bound both query classes
    // independently; the producers are not counted as background SQL.
    const dueReads = () => select.mock.calls.filter(([fields]) => fields && "card" in fields && fields.card === statusCards && !("revision" in fields)).length;
    const revisionReads = () => select.mock.calls.filter(([fields]) => fields && "card" in fields && fields.card === statusCards && "revision" in fields).length;
    const nextReads = () => select.mock.calls.filter(([fields]) => fields && "at" in fields && fields.at === statusCards.nextEvalAt).length;
    const elapsedMs = Date.now() - burstStarted;
    const maximum = Math.ceil(elapsedMs / 1000) + 2;
    console.info("status-card burst", { elapsedMs, maximum, runs: run.mock.calls.length, due: dueReads(), revisions: revisionReads(), next: nextReads(), searches: searchedCompanies.length });
    expect(run.mock.calls.length).toBeLessThanOrEqual(maximum);
    expect(dueReads()).toBeLessThanOrEqual(maximum); expect(nextReads()).toBeLessThanOrEqual(maximum);
    expect(revisionReads()).toBeLessThanOrEqual(maximum);
    expect(searchedCompanies.length).toBeLessThanOrEqual(maximum);
    expect(searchedCompanies.length).toBeGreaterThan(0);
    expect(new Set(searchedCompanies)).toEqual(new Set([originalCompany]));
    expect(wakeup).not.toHaveBeenCalled();
    // Re-register with an existing durable deadline inside the coalescing
    // window. A company hint must not make that real deadline wait one second.
    await coordinator!.stop(); coordinator = undefined;
    const dueAt = Date.now() + 500;
    await db.update(statusCards).set({ nextEvalAt: new Date(dueAt), nextEvalReason: "refresh" }).where(eq(statusCards.id, other.id));
    await start(service); await flush();
    await issueService(db).addComment(otherIssue.id, "Another company's coalesced human update", { userId: "board-user" });
    await issueService(db).addComment((await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, originalCompany)))[0]!.id,
      "More changes while another company is due", { userId: "board-user" });
    await flush();
    await vi.advanceTimersByTimeAsync(500); await flush();
    await vi.waitFor(() => expect(wakeup).toHaveBeenCalledOnce());
    expect(Date.now()).toBeLessThan(dueAt + 500);
    expect(wakeup.mock.calls[0]![0]).not.toBe(originalAgent);
    const generated = (await statusCardService(db).getById(other.id))!;
    expect(generated.generatingIssueId).toBeTruthy();
    expect((await statusCardService(db).getById(reactive.id))!.pendingChangeCount).toBeGreaterThan(0);
    expect((await statusCardService(db).getById(otherReactive.id))!.pendingChangeCount).toBeGreaterThan(0);
    expect(searchedCompanies).toContain(other.companyId);
    // Complete all ordinary results, then prove there is no recurring batch
    // timer once the requested work has settled.
    companyId = other.companyId; agentId = other.agentId!;
    await writeback(other.id, generated.generatingIssueId!);
    await statusCardService(db).update((await statusCardService(db).getById(other.id))!, { archived: true }, actor);
    companyId = originalCompany; agentId = originalAgent;
    await vi.advanceTimersByTimeAsync(120_000); await settled(); await flush();
    await vi.waitFor(async () => expect((await statusCardService(db).getById(reactive.id))!.generatingIssueId).toBeTruthy());
    const pending = (await statusCardService(db).getById(reactive.id))!;
    expect(pending.generatingIssueId).toBeTruthy();
    await writeback(reactive.id, pending.generatingIssueId!);
    const otherPending = (await statusCardService(db).getById(otherReactive.id))!;
    expect(otherPending.generatingIssueId).toBeTruthy();
    companyId = other.companyId; agentId = other.agentId!;
    await writeback(otherReactive.id, otherPending.generatingIssueId!);
    companyId = originalCompany; agentId = originalAgent;
    select.mockRestore();
    await quiet(); expect(errors).toEqual([]);
  }, 30_000);

  it("bounds active-hours conversion work across twenty cards and repeated ordinary company writes", async () => {
    vi.setSystemTime(new Date("2026-11-02T18:00:00Z"));
    const hoursPolicy = { ...policy(), activeHours: { start: "09:00", end: "17:00", timezone: "UTC" } };
    const cards = [];
    for (let i = 0; i < 20; i++) cards.push(await card("reactive", hoursPolicy));
    await start(); await quiet();
    const RealFormatter = Intl.DateTimeFormat;
    const actualParts = RealFormatter.prototype.formatToParts;
    let constructions = 0, conversions = 0;
    const constructor = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      if (args[0] === "en-GB" && args[1]?.hourCycle === "h23") constructions++;
      return new RealFormatter(...args);
    } as unknown as typeof Intl.DateTimeFormat);
    const parts = vi.spyOn(RealFormatter.prototype, "formatToParts").mockImplementation(function (this: Intl.DateTimeFormat, date) {
      if (this.resolvedOptions().locale === "en-GB" && this.resolvedOptions().hourCycle === "h23") conversions++;
      return actualParts.call(this, date);
    });
    const target = await issueService(db).create(companyId, { title: "Closed-hours blocker", status: "blocked", priority: "medium" });
    await settled();
    expect(constructions).toBeLessThanOrEqual(1);
    expect(conversions).toBeLessThanOrEqual(1000);
    const cold = { constructions, conversions };
    constructions = 0; conversions = 0;
    for (let i = 0; i < 10; i++) {
      await issueService(db).addComment(target.id, `Closed-hours human update ${i}`, { userId: "board-user" });
      await settled();
    }
    expect(constructions).toBe(0);
    expect(conversions).toBeGreaterThanOrEqual(200);
    expect(conversions).toBeLessThanOrEqual(800);
    expect(wakeup).not.toHaveBeenCalled();
    const opening = new Date("2026-11-03T09:00:00Z");
    for (const created of cards) expect((await statusCardService(db).getById(created.id)))
      .toMatchObject({ state: "paused_hours", pendingChangeCount: 1, nextEvalAt: opening });
    process.stdout.write(JSON.stringify({ measurement: "status-card company active-hours workload", cards: 20,
      sourceWrites: 11, cold, warm: { constructions, conversions } }) + "\n");
    constructor.mockRestore(); parts.mockRestore();
    await vi.advanceTimersByTimeAsync(opening.getTime() - Date.now()); await settled();
    expect(wakeup).toHaveBeenCalledTimes(20);
    for (const created of cards) {
      const generated = (await statusCardService(db).getById(created.id))!;
      expect(generated.generatingIssueId).toBeTruthy();
      await writeback(created.id, generated.generatingIssueId!);
    }
    await quiet(); expect(errors).toEqual([]);
  }, 60_000);

  it("cancels archived or disabled future work and replaces an earlier interval deadline", async () => {
    await start(); let created = await card("interval"); await settled();
    const old = coordinator!.nextWakeAt();
    created = await statusCardService(db).update(created, { refreshPolicy: { ...policy("interval"), intervalMinutes: 1 } }, actor);
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(100);
      await Promise.allSettled([...evaluations]);
      expect(coordinator!.nextWakeAt()).toBeLessThan(old!);
    });
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

  it("finishes generation and writeback with a one-connection pool and releases dedicated locks", async () => {
    vi.useRealTimers();
    const previousDb = db;
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    try {
      const created = await card("reactive", { ...policy(), debounceSeconds: 1 });
      const countLocks = async () => Number((await db.execute<{ count: string }>(sql`
        select count(*) from pg_stat_activity where datname = current_database()
        and application_name = 'paperclip-workspace-finalization-lock'`))[0]!.count);
      const baseline = await countLocks();
      await issueService(db).create(companyId, { title: "Pool-one blocker", status: "blocked", priority: "medium" });
      const service = statusCardEvaluationService(db, { wakeup });
      const acquired = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const holder = withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${created.id}, 0))`);
        acquired.resolve(); await release.promise;
      }));
      await acquired.promise;
      try {
        await service.run(new AbortController().signal);
        expect(wakeup).not.toHaveBeenCalled();
        expect(await service.next()).toBeGreaterThan(Date.now());
      } finally { release.resolve(); await holder; }
      await service.run(new AbortController().signal);
      expect((await statusCardService(db).getById(created.id))!.pendingChangeCount).toBeGreaterThan(0);
      await vi.waitFor(async () => {
        await service.run(new AbortController().signal);
        expect(wakeup).toHaveBeenCalledOnce();
      }, { timeout: 5000, interval: 100 });
      await writeback(created.id, (await statusCardService(db).getById(created.id))!.generatingIssueId!);
      await service.run(new AbortController().signal);
      expect(await service.next()).toBeNull();
      expect(idleWorkSnapshot().active).toBe(0);
      await vi.waitFor(async () => expect(await countLocks()).toBe(baseline));
      // Failure exits also release the physical connection and advisory lock.
      await db.update(statusCards).set({ queries: [{ scope: "invalid" } as never], nextEvalAt: new Date() }).where(eq(statusCards.id, created.id));
      await service.run(new AbortController().signal);
      expect((await statusCardService(db).getById(created.id))!.nextEvalReason).toBe("retry");
      await vi.waitFor(async () => expect(await countLocks()).toBe(baseline));
      await withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
        expect((await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${created.id}, 0)) as acquired`))[0]!.acquired).toBe(true);
      }));
    } finally { await db.$client.end({ timeout: 1 }); db = previousDb; }
  }, 15_000);

  it.each([false, true])("recovers a lost committed hint before a future membership deadline (legacy=%s)", async legacy => {
    await issueService(db).create(companyId, { title: "Original blocker", status: "blocked", priority: "medium" });
    compiledQuery = companySearchQuerySchema.parse({ scope: "issues", status: ["blocked"], updatedWithin: "1d" });
    const created = await card();
    expect(created.nextEvalReason).toBe("membership");
    const oldExpiry = created.nextEvalAt!.getTime();
    // No coordinator exists to receive this committed source hint. A fresh
    // service has no in-memory hint and must reconstruct from durable truth.
    await issueService(db).create(companyId, { title: "Committed before crash", status: "blocked", priority: "medium" });
    if (legacy) await db.update(statusCards).set({ nextEvalReason: null }).where(eq(statusCards.id, created.id));
    const restarted = statusCardEvaluationService(db, { wakeup });
    await restarted.run(new AbortController().signal);
    const pending = (await statusCardService(db).getById(created.id))!;
    expect(pending.pendingChangeCount).toBe(1);
    expect(pending.nextEvalReason).toBe("policy");
    expect(pending.nextEvalAt!.getTime()).toBeLessThan(oldExpiry);
    expect(wakeup).not.toHaveBeenCalled();
    vi.setSystemTime(pending.nextEvalAt!); await restarted.run(new AbortController().signal);
    expect(wakeup).toHaveBeenCalledOnce();
    await writeback(created.id, (await statusCardService(db).getById(created.id))!.generatingIssueId!);
    await restarted.run(new AbortController().signal);
    expect((await statusCardService(db).getById(created.id))!.nextEvalReason).toBe("membership");
  });

  it("preserves a legacy ambiguous five-minute claim without extending it on restart", async () => {
    const created = await card();
    const retry = new Date(Date.now() + 240_000);
    await db.update(statusCards).set({ nextEvalAt: retry, nextEvalReason: null }).where(eq(statusCards.id, created.id));
    await issueService(db).create(companyId, { title: "Unconsumed source", status: "blocked", priority: "medium" });
    const restarted = statusCardEvaluationService(db, { wakeup });
    await restarted.run(new AbortController().signal);
    expect(await restarted.next()).toBe(retry.getTime());
    vi.setSystemTime(retry); await restarted.run(new AbortController().signal);
    expect((await statusCardService(db).getById(created.id))!.pendingChangeCount).toBeGreaterThan(0);
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

  it("labels an interval writeback by its refresh deadline despite earlier membership expiry", async () => {
    const target = await issueService(db).create(companyId, { title: "Interval blocker", status: "blocked", priority: "medium" });
    const updatedAt = new Date(Date.now() - 59 * 60_000);
    await db.update(issues).set({ updatedAt }).where(eq(issues.id, target.id));
    compiledQuery = companySearchQuerySchema.parse({ scope: "issues", status: ["blocked"], updatedWithin: "1h" });
    let membership: Date | null = null;
    await companySearch.companySearchService(db).search(companyId, compiledQuery, {
      issueResultsOnly: true, onNextMembershipChange: at => { membership = at; },
    });
    expect(membership).toEqual(new Date(updatedAt.getTime() + 3_600_001));
    const created = await card("interval");
    expect(created.nextEvalAt).toEqual(new Date(created.lastGeneratedAt!.getTime() + 15 * 60_000));
    expect(created.nextEvalAt!.getTime()).toBeGreaterThan(updatedAt.getTime() + 3_600_001);
    expect(created.nextEvalReason).toBe("refresh");
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

  it.each([false, true])("rechecks current policy after a committed edit during held search (changes=%s)", async changed => {
    const created = await card();
    if (changed) await issueService(db).create(companyId, { title: "Policy race blocker", status: "blocked", priority: "medium" });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const factory = companySearch.companySearchService;
    let hold = true;
    const searches = vi.fn();
    vi.spyOn(companySearch, "companySearchService").mockImplementation(owner => {
      const service = factory(owner), actual = service.search;
      service.search = async (...args) => {
        searches();
        const result = await actual(...args);
        if (hold) { hold = false; entered.resolve(); await release.promise; }
        return result;
      };
      return service;
    });
    const service = statusCardEvaluationService(db, { wakeup });
    const pass = service.run(new AbortController().signal);
    await entered.promise;
    const cards = statusCardService(db);
    let scheduled!: Date;
    try {
      scheduled = (await cards.update((await cards.getById(created.id))!, { refreshPolicy: policy("interval") }, actor)).nextEvalAt!;
    } finally { release.resolve(); }
    await pass;
    const current = (await cards.getById(created.id))!;
    expect(current.refreshPolicy.mode).toBe("interval");
    expect(current.nextEvalAt!.getTime()).toBe(scheduled.getTime());
    expect(current.nextEvalReason).toBe("refresh");
    expect(searches).toHaveBeenCalledOnce();
    expect(wakeup).not.toHaveBeenCalled();
    const intervalCard = (await cards.getById(created.id))!;
    await issueService(db).create(companyId, { title: "Next interval blocker", status: "blocked", priority: "medium" });
    vi.setSystemTime(intervalCard.nextEvalAt!);
    await service.run(new AbortController().signal);
    expect(wakeup).toHaveBeenCalledOnce();
  });

  it("keeps future failure retries fenced from ordinary company hints and permits explicit policy recovery", async () => {
    const created = await card();
    const factory = companySearch.companySearchService;
    let failing = true;
    const searches = vi.fn();
    vi.spyOn(companySearch, "companySearchService").mockImplementation(owner => {
      const service = factory(owner), actual = service.search;
      service.search = async (...args) => { searches(); if (failing) throw new Error("Controlled search unavailable"); return actual(...args); };
      return service;
    });
    const service = statusCardEvaluationService(db, { wakeup });
    await service.run(new AbortController().signal);
    const failed = (await statusCardService(db).getById(created.id))!;
    expect(failed.nextEvalReason).toBe("retry");
    const retryAt = failed.nextEvalAt!.getTime();
    expect(searches).toHaveBeenCalledOnce();
    for (let index = 0; index < 5; index++) {
      await issueService(db).create(companyId, { title: `Retry blocker ${index}`, status: "blocked", priority: "medium" });
      service.changed(new Set([`changes:${companyId}`]));
      await service.run(new AbortController().signal);
    }
    expect(searches).toHaveBeenCalledOnce();
    expect((await statusCardService(db).getById(created.id))!.nextEvalAt!.getTime()).toBe(retryAt);
    const restarted = statusCardEvaluationService(db, { wakeup });
    restarted.changed(new Set([`changes:${companyId}`]));
    await restarted.run(new AbortController().signal);
    expect(searches).toHaveBeenCalledOnce();
    expect(await restarted.next()).toBe(retryAt);
    vi.setSystemTime(retryAt);
    await restarted.run(new AbortController().signal);
    expect(searches).toHaveBeenCalledTimes(2);
    const cards = statusCardService(db);
    failing = false;
    await cards.update((await cards.getById(created.id))!, { refreshPolicy: { ...policy(), debounceSeconds: 1 } }, actor);
    await restarted.run(new AbortController().signal);
    expect(searches).toHaveBeenCalledTimes(3);
    const pending = (await cards.getById(created.id))!;
    expect(pending.nextEvalReason).toBe("policy");
    vi.setSystemTime(pending.nextEvalAt!);
    await restarted.run(new AbortController().signal);
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
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect((await statusCardService(db).getById(created.id))!.state).toBe("error");
    });
    const failed = (await statusCardService(db).getById(created.id))!;
    expect(failed).toMatchObject({ state: "error", generatingIssueId: null, nextEvalAt: null, nextEvalReason: null });
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
