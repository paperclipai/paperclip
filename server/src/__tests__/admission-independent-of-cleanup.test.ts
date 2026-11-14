import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, budgetEvaluationWork, budgetPolicies, budgetReservations, companies, costEvents, createDb, heartbeatRuns, issues,
  nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { budgetService } from "../services/budgets.js";
import { reserveRunBudget } from "../services/budget-reservations.js";
import { hasPendingRunCleanup } from "../services/execution-blocker.js";

/**
 * Phase 3, section D (invariant 3): admitting new work never waits on another
 * run's cleanup or accounting completeness. Only a reached hard stop, an
 * explicit pause or an inactive company refuses it. Each case below was one of
 * the five gates of inventory finding 3; every one refused on master.
 */
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("admission independent of cleanup and accounting", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("admission-independent-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => { await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`TRUNCATE companies CASCADE`);
  }); });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(limit = 1_000, reservationCents = "0") {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Admission lab", issuePrefix: `A${companyId.slice(0, 5)}` });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "paperclip_runner" },
      { id: otherAgentId, companyId, name: "Other", role: "engineer", status: "idle", adapterType: "paperclip_runner" },
    ]);
    await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId, metric: "billed_cents",
      windowKind: "calendar_month_utc", amount: limit, reservationCents, notifyEnabled: false, unpricedUsagePolicy: "allow" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Earlier task", status: "in_progress",
      assigneeAgentId: agentId }).returning();
    const block = () => budgetService(db).getInvocationBlock(companyId, otherAgentId, { projectId: null });
    /** A run of the earlier task that ended without settling its accounting. */
    const pendingRun = async (status: "failed" | "succeeded", options: { recovering?: boolean; reservedCents?: string } = {}) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", scopeKind: "issue",
        issueId: issue.id, nativeIssueId: issue.id, runtimeMode: "native", status, finishedAt: new Date(),
        costAccountingPending: true, usageJson: { accountingReceiptReady: false, billingType: "metered_api",
          ledgerScope: { issueId: issue.id, projectId: null } } }).returning();
      if (options.recovering) await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue.id, runId: run.id,
        phase: "observed", attempt: 1 });
      await db.insert(budgetReservations).values({ companyId, runId: run.id, agentId, amountCents: options.reservedCents ?? "0",
        state: "held", providerStartedAt: new Date() });
      return run;
    };
    const queuedRun = async () => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: otherAgentId, invocationSource: "assignment",
        status: "queued" }).returning();
      return run;
    };
    return { companyId, agentId, otherAgentId, issue, block, pendingRun, queuedRun };
  }

  it("admits new work while a failed run awaits accounting (waitingRunCount gate)", async () => {
    const f = await fixture();
    await f.pendingRun("failed");
    expect(await f.block()).toBeNull();
    await expect(reserveRunBudget(db, f.companyId, (await f.queuedRun()).id, null)).resolves.toMatchObject({ reused: false });
  });

  it("admits new work while a native run recovers its accounting (recoveringRunCount gate)", async () => {
    const f = await fixture();
    await f.pendingRun("failed", { recovering: true });
    expect(await f.block()).toBeNull();
    await expect(reserveRunBudget(db, f.companyId, (await f.queuedRun()).id, null)).resolves.toMatchObject({ reused: false });
  });

  it("admits new work while a budget-owned scope hold awaits reconciliation (scope budget hold gate)", async () => {
    const f = await fixture();
    // The hard stop that set the hold no longer applies; nothing has released it yet.
    await db.update(agents).set({ pauseReason: "budget", lifecycleHolds: ["budget"] }).where(eq(agents.id, f.otherAgentId));
    await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "agent", scopeId: f.otherAgentId,
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 1_000, notifyEnabled: false });
    expect(await f.block()).toBeNull();
  });

  it("admits new work while budget inputs await evaluation (15 s budget_evaluation_work gate)", async () => {
    const f = await fixture();
    await db.insert(budgetEvaluationWork).values({ companyId: f.companyId, createdAt: new Date(Date.now() - 60_000) });
    expect(await f.block()).toBeNull();
    await expect(reserveRunBudget(db, f.companyId, (await f.queuedRun()).id, null)).resolves.toMatchObject({ reused: false });
  });

  it("never holds a successor for a predecessor run row that no longer exists (hasPendingRunCleanup gate)", async () => {
    const f = await fixture();
    const missing = randomUUID();
    expect(await hasPendingRunCleanup(db, f.companyId, missing)).toBe(false);
    // A predecessor that still owns a finalization coordinator holds it.
    const owner = await f.pendingRun("failed");
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, owner.id));
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issue.id, runId: owner.id,
      phase: "observed", attempt: 1, leaseOwner: "live-owner", leaseExpiresAt: new Date(Date.now() + 60_000) });
    expect(await hasPendingRunCleanup(db, f.companyId, owner.id)).toBe(true);
  });

  // Unfinished accounting is exposure: its bounded estimate (the held
  // reservation) still consumes capacity, and a hard stop still refuses.
  it("counts unfinished accounting's bounded estimate as exposure and still refuses a reached hard stop", async () => {
    const f = await fixture(1_000, "400");
    await f.pendingRun("failed", { reservedCents: "400" });
    await f.pendingRun("failed", { reservedCents: "400", recovering: true });
    expect(await f.block()).toBeNull();
    await expect(reserveRunBudget(db, f.companyId, (await f.queuedRun()).id, null))
      .rejects.toThrow(/reserved by unfinished runs/);
    await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.agentId, provider: "openai", model: "gpt",
      costCents: 1_000, occurredAt: new Date() });
    expect((await f.block())?.reason).toMatch(/hard-stop/);
  });

  it("still refuses an explicit pause", async () => {
    const f = await fixture();
    await f.pendingRun("failed");
    await db.update(companies).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() })
      .where(eq(companies.id, f.companyId));
    expect((await f.block())?.reason).toMatch(/paused/);
  });
});
