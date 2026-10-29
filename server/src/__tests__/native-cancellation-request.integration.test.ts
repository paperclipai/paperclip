import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { rethrowNativeCancellationLockConflict, nativeRetryCancellationCommitCondition, cancellationIntentId, claimCancellationRequest, startupCancellationFence } from "../services/native-runtime/native-cancellation-request.js";

describe("atomic caller cancellation request ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let cancelNativeSession: typeof import("../services/native-runtime/native-session-executor.js").cancelNativeSession;
  beforeAll(async () => {
    ({ cancelNativeSession } = await import("../services/native-runtime/native-session-executor.js"));
    database = await startEmbeddedPostgresTestDatabase("caller-stop-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stop claims", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Stop target" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "running", runtimeMode: "native" });
    return { companyId, runId, agentId };
  }
  const defaultFence = (runId: string) => db.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || jsonb_build_object('startupCancellation', ${startupCancellationFence(new Date().toISOString())})` }).where(eq(heartbeatRuns.id, runId));
  it("allows exactly one of two concurrent identities and idempotent same-ID retries", async () => {
    const { companyId, runId } = await fixture(), a = randomUUID(), b = randomUUID();
    const results = await Promise.allSettled([claimCancellationRequest(db, runId, companyId, a, "board-user"), claimCancellationRequest(db, runId, companyId, b, "board-user")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const winner = results[0].status === "fulfilled" ? a : b;
    await expect(claimCancellationRequest(db, runId, companyId, winner, "other-board-user")).rejects.toMatchObject({ status: 409 });
    const copies = await Promise.all([claimCancellationRequest(db, runId, companyId, winner, "board-user"), claimCancellationRequest(db, runId, companyId, winner, "board-user")]);
    expect(copies[0].resultJson).toEqual(copies[1].resultJson);
    await expect(claimCancellationRequest(db, runId, randomUUID(), winner, "board-user")).rejects.toMatchObject({ status: 409 });
  });
  it("does not overwrite a caller claim when default Stop races after it", async () => {
    const { companyId, runId } = await fixture(), id = randomUUID();
    const claimed = await claimCancellationRequest(db, runId, companyId, id, "board-user");
    await Promise.all([defaultFence(runId), claimCancellationRequest(db, runId, companyId, id, "board-user")]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.resultJson).toEqual(claimed.resultJson);
  });
  it("rejects a default Stop that won first, without replacing its marker", async () => {
    const { companyId, runId } = await fixture(); await defaultFence(runId);
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await expect(claimCancellationRequest(db, runId, companyId, randomUUID(), "board-user")).rejects.toMatchObject({ status: 409 });
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(after.resultJson).toEqual(before.resultJson);
  });
  it("accepts only the original acknowledged identity on a terminal run", async () => {
    const { companyId, runId } = await fixture(), id = randomUUID();
    const run = await claimCancellationRequest(db, runId, companyId, id, "board-user");
    await db.update(heartbeatRuns).set({ status: "cancelled", resultJson: { ...run.resultJson, nativeCancellation: { schema: "paperclip.native-cancellation.v1", intentId: cancellationIntentId(id), runId, companyId, scope: "run", dispatched: true, dispatchState: "acknowledged", intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() } } }).where(eq(heartbeatRuns.id, runId));
    await expect(claimCancellationRequest(db, runId, companyId, id, "board-user")).resolves.toMatchObject({ status: "cancelled" });
    await expect(claimCancellationRequest(db, runId, companyId, randomUUID(), "board-user")).rejects.toMatchObject({ status: 409 });
    await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, nativeCancellation: { intentId: cancellationIntentId(id) } } }).where(eq(heartbeatRuns.id, runId));
    await expect(claimCancellationRequest(db, runId, companyId, id, "board-user")).rejects.toMatchObject({ status: 409 });
  });
  async function retryFixture(phase = "retryable_failure") {
    const f = await fixture(), issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Native retry", status: "in_progress", assigneeAgentId: f.agentId });
    await db.update(heartbeatRuns).set({ nativeIssueId: issueId, status: "failed" }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(nativeRunFinalizations).values({ runId: f.runId, companyId: f.companyId, issueId, phase, nextAttemptAt: new Date(Date.now() + 30_000) });
    return { ...f, issueId };
  }
  it("admits a failed retry and recovers the same caller after audited native cancellation disables it", async () => {
    const f = await retryFixture(), id = randomUUID();
    await claimCancellationRequest(db, f.runId, f.companyId, id, "board-user");
    // No provider is attached: exercise the actual durable cancellation path.
    const outcome = await cancelNativeSession(f.runId, "Stop", { db, scope: "run", cancellationRequestId: id });
    expect(outcome.auditId).toBeTruthy();
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator).toMatchObject({ phase: "terminal_failure", failureCode: "native_retry_cancelled", nextAttemptAt: null });
    const retried = await claimCancellationRequest(db, f.runId, f.companyId, id, "board-user");
    expect(retried.resultJson?.nativeCancellation).toMatchObject({ intentId: cancellationIntentId(id), dispatchState: "acknowledged" });
    await expect(claimCancellationRequest(db, f.runId, f.companyId, randomUUID(), "board-user")).rejects.toMatchObject({ status: 409 });
    await expect(claimCancellationRequest(db, f.runId, f.companyId, id, "other-actor")).rejects.toMatchObject({ status: 409 });
    await expect(cancelNativeSession(f.runId, "Stop", { db, scope: "run", cancellationRequestId: id })).resolves.toMatchObject({ auditId: outcome.auditId });
  });
  it.each(["observed", "terminal_failure", "committed"])("does not claim a failed run whose coordinator advanced to %s", async phase => {
    const f = await retryFixture(phase);
    await expect(claimCancellationRequest(db, f.runId, f.companyId, randomUUID(), "board-user")).rejects.toMatchObject({ status: 409 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.resultJson?.startupCancellation).toBeUndefined();
  });
  it("rejects a coordinator-only concurrent claim, then observes its committed phase without installing a Stop fence", async () => {
    const f = await retryFixture(), id = randomUUID();
    let release!: () => void, locked!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const advance = db.transaction(async tx => {
      await tx.update(nativeRunFinalizations).set({ phase: "observed", nextAttemptAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
      locked(); await hold;
    });
    try {
      await acquired;
      await expect(claimCancellationRequest(db, f.runId, f.companyId, id, "board-user")).rejects.toMatchObject({ status: 409, message: "Native retry cancellation is busy; retry the same request" });
    } finally { release(); await advance; }
    await expect(claimCancellationRequest(db, f.runId, f.companyId, id, "board-user")).rejects.toMatchObject({ status: 409 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.resultJson?.startupCancellation).toBeUndefined();
  });

  it.each(["failed", "running"])("preserves a %s terminal/recovery outcome that wins after reservation", async status => {
    const f = await retryFixture(), id = randomUUID();
    await claimCancellationRequest(db, f.runId, f.companyId, id, "board-user");
    await db.update(nativeRunFinalizations).set({ phase: status === "failed" ? "terminal_failure" : "observed",
      failureCode: "board_recovery", nextAttemptAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(heartbeatRuns).set({ status, errorCode: "board_recovery" }).where(eq(heartbeatRuns.id, f.runId));
    await expect(cancelNativeSession(f.runId, "Stop", { db, scope: "run", cancellationRequestId: id })).rejects.toMatchObject({ status: 409 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run).toMatchObject({ status, errorCode: "board_recovery" });
    expect(run.resultJson?.nativeCancellation).toBeUndefined();
  });
  it("does not overwrite a coordinator-only terminal change after acknowledgement", async () => {
    const f = await retryFixture(), id = randomUUID();
    await claimCancellationRequest(db, f.runId, f.companyId, id, "board-user");
    await cancelNativeSession(f.runId, "Stop", { db, scope: "run", cancellationRequestId: id });
    const [acknowledged] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const commit = () => db.update(heartbeatRuns).set({ status: "cancelled" }).where(and(eq(heartbeatRuns.id, f.runId),
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry", "failed"]), nativeRetryCancellationCommitCondition(acknowledged.resultJson))).returning();
    let release!: () => void, locked!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const advance = db.transaction(async tx => {
      await tx.update(nativeRunFinalizations).set({ failureCode: "board_recovery" }).where(eq(nativeRunFinalizations.runId, f.runId));
      locked(); await hold;
    });
    try { await acquired; await expect(commit().catch(rethrowNativeCancellationLockConflict)).rejects.toMatchObject({ status: 409, message: "Native retry cancellation is busy; retry the same request" }); }
    finally { release(); await advance; }
    expect(await commit()).toEqual([]);
    const [preserved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(preserved).toMatchObject({ status: "failed", resultJson: acknowledged.resultJson });
  });
  it.each(["running", "queued", "scheduled_retry"])("preserves a status-only advance to %s after acknowledgement", async status => {
    const f = await retryFixture(), id = randomUUID();
    await claimCancellationRequest(db, f.runId, f.companyId, id, "board-user");
    await cancelNativeSession(f.runId, "Stop", { db, scope: "run", cancellationRequestId: id });
    const [acknowledged] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.runId));
    // Match heartbeat's broader candidate list: the production retry predicate,
    // not a test-only failed-status filter, must preserve the newer state.
    const committed = await db.update(heartbeatRuns).set({ status: "cancelled" }).where(and(eq(heartbeatRuns.id, f.runId),
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry", "failed"]),
      nativeRetryCancellationCommitCondition(acknowledged.resultJson))).returning();
    expect(committed).toEqual([]);
    const [preserved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(preserved).toMatchObject({ status, resultJson: acknowledged.resultJson });
  });
  it("commits an unchanged acknowledged retry but preserves a newer run result", async () => {
    const f = await retryFixture(), id = randomUUID();
    await claimCancellationRequest(db, f.runId, f.companyId, id, "board-user");
    await cancelNativeSession(f.runId, "Stop", { db, scope: "run", cancellationRequestId: id });
    const [acknowledged] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const commit = () => db.update(heartbeatRuns).set({ status: "cancelled" }).where(and(eq(heartbeatRuns.id, f.runId),
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry", "failed"]), nativeRetryCancellationCommitCondition(acknowledged.resultJson))).returning();
    await db.update(heartbeatRuns).set({ resultJson: { ...acknowledged.resultJson, boardRecovery: "new-outcome" } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await commit()).toEqual([]);
    await db.update(heartbeatRuns).set({ resultJson: acknowledged.resultJson }).where(eq(heartbeatRuns.id, f.runId));
    expect(await commit()).toMatchObject([{ status: "cancelled" }]);
  });

});
