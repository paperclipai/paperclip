import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, agents, companies, companyMemberships, createDb, documents,
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
  const actor = { agentId: null, userId: "board-user" };
  const policy = (mode: "manual" | "reactive" | "interval" = "reactive") => statusCardRefreshPolicySchema.parse({
    mode, debounceSeconds: 60, intervalMinutes: 15,
  });
  // Controlled provider boundary: assignment persists a queued wake, and tests
  // explicitly run the authorized summarizer writeback. No model/provider runs.
  const wakeup = vi.fn(async (id: string, options: { payload?: Record<string, unknown> | null; reason?: string | null }) => {
    return db.insert(agentWakeupRequests).values({ companyId, agentId: id, source: "assignment",
      reason: options.reason, payload: options.payload, status: "queued" }).returning();
  });

  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("status-card-evaluation-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 30_000);
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); draining = false; errors.length = 0; wakeup.mockClear();
    await db.insert(companies).values({ id: companyId, name: "Status", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Summarizer", role: "general", status: "idle", adapterType: "process", adapterConfig: {} });
    await instanceSettingsService(db).updateExperimental({ enableStatusCards: true });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
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
    if (compile) await cards.writeQuery(cardId, { queries: [companySearchQuerySchema.parse({ scope: "issues", status: ["blocked"] })],
      title: "Blockers", changeSummary: "Compiled", generationIssueId }, writer);
    await cards.writeSummary(cardId, { markdown: "Current blockers", changeSummary: "Updated", generationIssueId }, writer);
    await issueService(db).update(generationIssueId, { status: "done" });
  }
  async function card(mode: "manual" | "reactive" | "interval" = "reactive") {
    const cards = statusCardService(db);
    const created = await cards.create(companyId, { interestPrompt: "Blockers", titlePinned: false, agentId, refreshPolicy: policy(mode) }, actor);
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

  it("preserves the first write during drain until resume", async () => {
    await start(); const created = await card("manual"); await quiet();
    draining = true;
    await statusCardService(db).update(created, { refreshPolicy: policy("interval") }, actor);
    await settled(); expect(wakeup).not.toHaveBeenCalled();
    draining = false; await vi.advanceTimersByTimeAsync(30_000); await settled();
    expect(coordinator!.nextWakeAt()).not.toBeNull(); expect(errors).toEqual([]);
  });
});
