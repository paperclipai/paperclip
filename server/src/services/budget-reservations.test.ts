import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, budgetReservations, companies, costEvents, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { reserveRunBudget } from "./budget-reservations.js";
import { accountRunCost, readCostAccountingWork } from "./run-cost-accounting.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("capacity-deferred run budget reservation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let directory: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("budget-deferral-");
    db = createDb(database.connectionString);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "budget-deferral-receipts-"));
  }, 60_000);
  async function truncate() {
    await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL client_min_messages = warning`);
      await tx.execute(sql`TRUNCATE companies CASCADE`);
    });
  }
  afterEach(truncate);
  afterAll(async () => { if (directory) await fs.rm(directory, { force: true, recursive: true }); await database?.cleanup(); });

  async function seed(change: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Deferral", issuePrefix: "DEFER" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Deferral", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "timer", status: "scheduled_retry",
      costAccountingPending: true, finishedAt: null,
      usageJson: { accountingReceiptReady: true, billingType: "metered_api", provider: "unknown", model: "unknown", ledgerScope: {} },
      ...change });
    return { companyId, agentId, runId };
  }

  async function hold(companyId: string, agentId: string, runId: string, change: Partial<typeof budgetReservations.$inferInsert> = {}) {
    const [row] = await db.insert(budgetReservations).values({ companyId, runId, agentId, amountCents: "0", state: "held" }).returning();
    if (Object.keys(change).length > 0) {
      const [updated] = await db.update(budgetReservations).set(change).where(eq(budgetReservations.id, row.id)).returning();
      return updated;
    }
    return row;
  }

  it("releases a deferred attempt and re-arms the same row when the run is re-dispatched", async () => {
    const { companyId, agentId, runId } = await seed({ errorCode: "profile_deferred_capacity" });
    const original = await hold(companyId, agentId, runId);

    // A crash between booking the deferral and releasing it stays recoverable.
    expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(true);
    expect(await accountRunCost(db, runId)).toBe(true);

    const [released] = await db.select().from(budgetReservations).where(eq(budgetReservations.id, original.id));
    expect(released.state).toBe("released");
    expect(released.settledAt).not.toBeNull();
    const [deferred] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    // The attempt owes no charge, but the run is neither terminal nor settled.
    expect(deferred.costAccountingPending).toBe(false);
    expect(deferred.costAccountedAt).toBeNull();
    expect(deferred.finishedAt).toBeNull();
    expect(await db.select().from(costEvents)).toHaveLength(0);
    expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(false);

    // Re-admission promotes the same run id and dispatches it again.
    await db.update(heartbeatRuns).set({ status: "queued", errorCode: null, error: null }).where(eq(heartbeatRuns.id, runId));
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    expect(reservation.reused).toBe(false);
    expect(reservation.id).toBe(original.id);
    expect(reservation.state).toBe("held");
    expect(reservation.settledAt).toBeNull();
    expect(await db.select().from(budgetReservations)).toHaveLength(1);
    const [redispatched] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(redispatched.costAccountingPending).toBe(true);

    // The re-armed attempt settles normally; the ledger holds one row throughout.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(),
      usageJson: { accountingReceiptReady: true, provider: "test", model: "test", billingType: "metered_api", costUsd: 0.01, ledgerScope: {} },
    }).where(eq(heartbeatRuns.id, runId));
    expect(await accountRunCost(db, runId)).toBe(true);
    const [settled] = await db.select().from(budgetReservations).where(eq(budgetReservations.id, original.id));
    expect(settled.state).toBe("settled");
    expect(await db.select().from(costEvents)).toHaveLength(1);
  });

  it("still fences a duplicate dispatch while a reservation is held or settled", async () => {
    for (const state of ["held", "settled"] as const) {
      const { companyId, agentId, runId } = await seed({ status: "queued", errorCode: null });
      await hold(companyId, agentId, runId, { state, settledAt: state === "settled" ? new Date() : null });
      await expect(reserveRunBudget(db, companyId, runId, null))
        .rejects.toThrow("Provider dispatch has already reserved this run");
      expect(await db.select().from(budgetReservations)).toHaveLength(1);
      await truncate();
    }
  });

  it("keeps terminal runs on their existing accounting path and finish time", async () => {
    for (const status of ["timed_out", "cancelled"] as const) {
      const finishedAt = new Date("2026-10-01T12:00:00.000Z");
      const { companyId, agentId, runId } = await seed({ status, finishedAt, errorCode: status === "timed_out" ? "timeout" : "cancelled",
        usageJson: { accountingReceiptReady: true, provider: "test", model: "test", billingType: "metered_api", costUsd: 0.01, ledgerScope: {} } });
      const original = await hold(companyId, agentId, runId);

      expect(await accountRunCost(db, runId)).toBe(true);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(run.finishedAt?.toISOString()).toBe(finishedAt.toISOString());
      expect(run.costAccountedAt).not.toBeNull();
      const [reservation] = await db.select().from(budgetReservations).where(eq(budgetReservations.id, original.id));
      expect(reservation.state).toBe("settled");
      expect(await db.select().from(costEvents)).toHaveLength(1);
      await truncate();
    }
  });
});
