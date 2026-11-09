import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, issues, routineRuns, routines } from "@paperclipai/db";
import { routineService } from "../services/routines.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping routine status database tests: ${support.reason}`);
(support.supported ? describe : describe.skip)("routine status reconciliation", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("routine-status-"); db = createDb(database.connectionString); }, 60_000);
  afterEach(async () => { vi.restoreAllMocks(); await db.execute(sql`SET client_min_messages = warning; TRUNCATE companies CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function seed(status = "blocked") {
    const companyId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Routine fixture", issuePrefix: `T${companyId.slice(0, 6)}` });
    const [routine] = await db.insert(routines).values({ companyId, title: "Routine fixture" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Execution fixture", status,
      originKind: "routine_execution", originId: routine!.id, originRunId: runId }).returning();
    const [run] = await db.insert(routineRuns).values({ id: runId, companyId, routineId: routine!.id,
      linkedIssueId: issue!.id, source: "schedule", status: "issue_created", triggerPayload: { retainedInput: true } }).returning();
    return { companyId, routine: routine!, issue: issue!, run: run! };
  }
  it.each(["done", "blocked", "cancelled"])("repairs missed %s status using normal owning-service transitions", async status => {
    const f = await seed(status); const service = routineService(db);
    expect(await service.reconcileExecutionRunStatuses()).toEqual({ scanned: 1, settled: 1, deferred: 0 });
    const [run] = await db.select().from(routineRuns);
    expect(run!.status).toBe(status === "done" ? "completed" : "failed");
    expect(run!.completedAt).toBeInstanceOf(Date); expect(run!.triggerPayload).toMatchObject({ retainedInput: true });
    expect((await db.select().from(issues))[0]).toEqual(f.issue);
    expect(await service.reconcileExecutionRunStatuses()).toEqual({ scanned: 0, settled: 0, deferred: 0 });
    if (status !== "done") {
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issue.id));
      await service.syncRunStatusForIssue(f.issue.id);
      expect((await db.select().from(routineRuns))[0]).toMatchObject({ status: "issue_created", completedAt: null });
    }
  });
  it.each(["active_issue", "wrong_origin", "wrong_routine", "wrong_run", "wrong_company", "wrong_routine_company", "different_status"])("does not settle an unsupported handoff: %s", async mode => {
    const f = await seed();
    if (mode === "active_issue") await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issue.id));
    if (mode === "wrong_origin") await db.update(issues).set({ originKind: "manual" }).where(eq(issues.id, f.issue.id));
    if (mode === "wrong_routine") await db.update(issues).set({ originId: randomUUID() }).where(eq(issues.id, f.issue.id));
    if (mode === "wrong_run") await db.update(issues).set({ originRunId: randomUUID() }).where(eq(issues.id, f.issue.id));
    if (mode === "wrong_company") { const other = await seed("done"); await db.update(routineRuns).set({ companyId: other.companyId }).where(eq(routineRuns.id, f.run.id)); }
    if (mode === "wrong_routine_company") { const other = await seed("done");
      await db.update(routineRuns).set({ routineId: other.routine.id }).where(eq(routineRuns.id, f.run.id));
      await db.update(issues).set({ originId: other.routine.id }).where(eq(issues.id, f.issue.id)); }
    if (mode === "different_status") await db.update(routineRuns).set({ status: "received" }).where(eq(routineRuns.id, f.run.id));
    const before = await db.select().from(routineRuns);
    const result = await routineService(db).reconcileExecutionRunStatuses();
    expect(result.settled).toBe(["wrong_company", "wrong_routine_company"].includes(mode) ? 1 : 0);
    expect((await db.select().from(routineRuns)).find(row => row.id === f.run.id)).toEqual(before.find(row => row.id === f.run.id));
    if (mode === "wrong_routine_company") await expect(routineService(db).syncRunStatusForIssue(f.issue.id)).resolves.toBeNull();
  });
  it.each(["resume", "retarget", "routine_transfer"])("rechecks %s after candidate selection and before repair", async mode => {
    const f = await seed(); const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(async callback => {
      if (mode === "routine_transfer") {
        const otherId = randomUUID(); await db.insert(companies).values({ id: otherId, name: "Other fixture", issuePrefix: `T${otherId.slice(0, 6)}` });
        await db.update(routines).set({ companyId: otherId }).where(eq(routines.id, f.routine.id));
      } else await db.update(issues).set(mode === "resume" ? { status: "in_progress" } : { originRunId: randomUUID() }).where(eq(issues.id, f.issue.id));
      return transaction(callback);
    });
    expect(await routineService(db).reconcileExecutionRunStatuses()).toEqual({ scanned: 1, settled: 0, deferred: 0 });
    expect((await db.select().from(routineRuns))[0]).toEqual(f.run);
  });
  it("repairs another routine while one row is locked, then retries the deferred owner", async () => {
    const [held, other] = [await seed(), await seed()].sort((a, b) => a.run.id.localeCompare(b.run.id));
    let entered!: () => void, release!: () => void;
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = db.transaction(async tx => {
      await tx.select().from(routines).where(eq(routines.id, held!.routine.id)).for("update");
      entered(); await gate;
    });
    try {
      await Promise.race([locked, holding.then(() => { throw new Error("Lock transaction ended before entry"); })]);
      const service = routineService(db);
      expect(await service.reconcileExecutionRunStatuses()).toEqual({ scanned: 2, settled: 1, deferred: 1 });
      expect((await db.select().from(routineRuns)).find(row => row.id === other!.run.id)?.status).toBe("failed");
      expect((await db.select().from(routineRuns)).find(row => row.id === held!.run.id)?.status).toBe("issue_created");
      release(); await holding;
      expect(await service.reconcileExecutionRunStatuses()).toEqual({ scanned: 1, settled: 1, deferred: 0 });
    } finally { release(); await holding; }
  });
});
