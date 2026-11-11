import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, completionContracts, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues,
  nativeRunFinalizations, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { nativeResponsePresentationWork } from "./native-response-presentation-work.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../task-admission.js";

// An accepted native task result whose final reply was never published must
// not be abandoned after one refused or failed publication attempt. Retries
// are durable and bounded, never double-post, and an exhausted retry leaves a
// named failure with an owner on the run and the task.
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_RESPONSE_PUBLICATION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("native final reply publication retry", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("native-response-publication-");
    db = createDb(external ?? database!.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  const reply = "Keyboard shortcuts are now available on every plan.";
  async function fixture(options: { companyId?: string; agentId?: string; runId?: string; issueId?: string; contract?: typeof completionContracts.$inferSelect } = {}) {
    const companyId = options.companyId ?? randomUUID(), agentId = options.agentId ?? randomUUID();
    const issueId = options.issueId ?? randomUUID(), runId = options.runId ?? randomUUID();
    const sessionId = randomUUID(), runnerId = randomUUID();
    if (!options.companyId) await db.insert(companies).values({ id: companyId, name: "Reply publication fixture", issuePrefix: companyId.slice(0, 8) });
    if (!options.agentId) await db.insert(agents).values({ id: agentId, companyId, name: "Writer", adapterType: "paperclip_runner" });
    if (!options.issueId) await db.insert(issues).values({ id: issueId, companyId, title: "Short changelog blurb", status: "in_progress", assigneeAgentId: agentId });
    const [contract] = options.contract ? [options.contract] : await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "test", objective: "Write the blurb", criteria: [] },
      canonicalSha256: "fixture-publication-contract", createdByActorType: "system", createdByActorId: "test" }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      status: "running", runtimeMode: "native", contextSnapshot: { issueId, source: "assignment" } });
    await db.update(issues).set({ executionRunId: runId, status: "in_progress" }).where(eq(issues.id, issueId));
    const port = new NativeRunCoordinatorStore(db, { companyId, issueId, runId, agentId, normalizedSessionId: sessionId,
      runnerSourceInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      completionContractRevision: "test", completionContractCriterionIds: [] });
    await port.completeRun({ result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done",
      summary: "Wrote the blurb.", completionClaim: { contractRevision: "test", objectiveSatisfied: true, criteria: [], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] },
      terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "done" },
      turnId: "blurb-turn" });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: false });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0].phase).toBe("committed");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const prpEvent = { runId, normalizedSessionId: sessionId, turnId: "blurb-turn", sourceEventId: "fixture-final-reply",
      payload: { kind: "agentMessage", channel: "final", providerPhase: "final", text: reply } };
    const saveFinalReply = () => db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 170, eventType: "item.completed",
      payload: { prpEvent } });
    return { companyId, issueId, runId, agentId, contract, saveFinalReply };
  }
  const comments = (runId: string) => db.select().from(issueComments).where(eq(issueComments.createdByRunId, runId));
  const run = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
  const receipt = async (runId: string) => ((await run(runId)).resultJson as Record<string, any> | null)?.responsePublication;
  // Advance the saved deadline instead of the clock so the database and the
  // worker agree on "due" without faking timers inside the driver.
  const makeDue = (runId: string) => db.execute(sql`update heartbeat_runs set result_json = jsonb_set(result_json,
    '{responsePublication,nextAttemptAt}', to_jsonb('2000-01-01T00:00:00.000Z'::text)) where id = ${runId}`);

  it("publishes a later-page reply while older publication groups remain contended", async () => {
    const first = await fixture({ runId: "00000000-0000-4000-8000-000000000001" });
    const group = { companyId: first.companyId, agentId: first.agentId };
    const older = [first];
    // A full real SQL page of retained replies shares one publication owner.
    // This is the same grouping boundary as retained replies to one endpoint.
    for (let i = 2; i <= 100; i++) older.push(await fixture({ ...group,
      issueId: first.issueId, contract: first.contract,
      runId: `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}` }));
    const independent = await fixture({ ...group, runId: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    for (const f of [...older, independent]) await f.saveFinalReply();

    let unlock!: () => void, locked!: () => void;
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
        .where(inArray(nativeRunFinalizations.runId, older.map(f => f.runId))).for("update");
      locked();
      await release;
    });
    await acquired;
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      onError: error => errors.push(error) });
    const worker = nativeResponsePresentationWork(db).register(coordinator, () => true);
    let firstPassSettled = false;
    const startup = worker.ready.then(() => { firstPassSettled = true; });
    const debug = db.$client.options.debug;
    let queries = 0;
    db.$client.options.debug = () => { queries++; };
    try {
      await vi.waitFor(async () => expect(await comments(independent.runId)).toHaveLength(1), { timeout: 3000 });
      expect(firstPassSettled).toBe(false);
      expect(await comments(first.runId)).toEqual([]);
      expect((await comments(independent.runId))[0].body).toBe(reply);
      unlock();
      await holder;
      await startup;
      await vi.waitFor(async () => {
        const posted = await db.select({ runId: issueComments.createdByRunId }).from(issueComments)
          .where(eq(issueComments.issueId, first.issueId));
        expect(posted.map(comment => comment.runId).sort()).toEqual(older.map(f => f.runId).sort());
      }, { timeout: 20_000 });
      await vi.waitFor(() => {
        expect(coordinator.nextWakeAt()).toBeNull();
        expect(idleWorkSnapshot().active).toBe(0);
      }, { timeout: 5000 });
      // Neither retained history nor the completed contention owns an idle scan.
      const settledQueries = queries;
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(queries).toBe(settledQueries);
      expect(coordinator.nextWakeAt()).toBeNull();
      vi.useRealTimers();
      expect(await comments(independent.runId)).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers();
      unlock();
      await holder;
      await startup;
      worker.stop();
      await coordinator.stop();
      db.$client.options.debug = debug;
    }
  }, 120_000);

  it("keeps an accepted reply scheduled after a single refused publication and posts it exactly once", async () => {
    const f = await fixture();
    const work = nativeResponsePresentationWork(db);
    const [entry] = await work.load({ companyId: f.companyId, issueId: f.issueId });
    expect(entry).toMatchObject({ id: f.runId });

    // The final reply is not visible yet, so publication is refused once.
    const before = Date.now();
    const rescheduled = await work.check(entry);
    expect(await comments(f.runId)).toEqual([]);
    expect(rescheduled).not.toBeNull();
    expect(rescheduled!.dueAt).toBeGreaterThan(before);
    expect(await receipt(f.runId)).toMatchObject({ state: "retrying", attempts: 1, lastReason: "publication_refused" });
    // A restarted worker reconstructs the saved schedule instead of losing it.
    const [reloaded] = await nativeResponsePresentationWork(db).load({ companyId: f.companyId, issueId: f.issueId });
    expect(reloaded).toMatchObject({ id: f.runId, dueAt: rescheduled!.dueAt });
    // Not yet due: no second attempt.
    await expect(work.check(reloaded)).resolves.toMatchObject({ dueAt: rescheduled!.dueAt });
    expect((await receipt(f.runId)).attempts).toBe(1);

    await f.saveFinalReply();
    await makeDue(f.runId);
    const [due] = await work.load({ companyId: f.companyId, issueId: f.issueId });
    await expect(work.check(due)).resolves.toBeNull();
    expect(await comments(f.runId)).toEqual([expect.objectContaining({ body: reply, authorAgentId: f.agentId })]);
    expect(await receipt(f.runId)).toMatchObject({ state: "resolved", attempts: 1 });
    expect(((await run(f.runId)).resultJson as Record<string, any>).presentationDecision.commentId).toEqual(expect.any(String));
    // Idempotent: nothing left to publish and a repeated check never double-posts.
    expect(await work.load({ companyId: f.companyId, issueId: f.issueId })).toEqual([]);
    await expect(work.check(due)).resolves.toBeNull();
    expect(await comments(f.runId)).toHaveLength(1);
  });

  it("records a single publication error durably and retries it", async () => {
    const f = await fixture();
    await f.saveFinalReply();
    const failure = new Error("fixture-comment-write-failed");
    let injected = false;
    const failing = new Proxy(db, { get(target, key) {
      if (key === "transaction" && !injected) {
        return (callback: Parameters<Db["transaction"]>[0]) => db.transaction(async tx => {
          // The publication transaction is the only one that locks the
          // finalization coordinator; fail exactly that one attempt.
          injected = true; await callback(tx); throw failure;
        });
      }
      return Reflect.get(target, key);
    } });
    const work = nativeResponsePresentationWork(failing as Db);
    const [entry] = await work.load({ companyId: f.companyId, issueId: f.issueId });
    const rescheduled = await work.check(entry);
    expect(rescheduled).not.toBeNull();
    expect(await comments(f.runId)).toEqual([]);
    expect(await receipt(f.runId)).toMatchObject({ state: "retrying", attempts: 1, lastReason: "publication_error",
      lastError: "fixture-comment-write-failed" });
    await makeDue(f.runId);
    await expect(work.check(entry)).resolves.toBeNull();
    expect(await comments(f.runId)).toEqual([expect.objectContaining({ body: reply })]);
  });

  it("records an already posted reply without posting again or reporting a failure", async () => {
    const f = await fixture();
    await f.saveFinalReply();
    // The live path wrote the reply but stopped before recording its decision.
    const [posted] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      createdByRunId: f.runId, body: reply }).returning();
    const work = nativeResponsePresentationWork(db);
    const [entry] = await work.load({ companyId: f.companyId, issueId: f.issueId });
    await expect(work.check(entry)).resolves.toBeNull();
    expect(await comments(f.runId)).toEqual([posted]);
    expect(((await run(f.runId)).resultJson as Record<string, any>).presentationDecision).toMatchObject({
      commentAction: "reuse", commentId: posted.id });
    expect(await receipt(f.runId)).toBeUndefined();
    expect(await work.load({ companyId: f.companyId, issueId: f.issueId })).toEqual([]);
  });

  it("counts one due attempt once when two workers check it concurrently", async () => {
    const f = await fixture();
    const [entry] = await nativeResponsePresentationWork(db).load({ companyId: f.companyId, issueId: f.issueId });
    const results = await Promise.all([nativeResponsePresentationWork(db).check(entry), nativeResponsePresentationWork(db).check(entry)]);
    expect(results.every(result => result !== null)).toBe(true);
    expect(await receipt(f.runId)).toMatchObject({ state: "retrying", attempts: 1 });
    expect(await comments(f.runId)).toEqual([]);
  });

  it("stops after bounded attempts with a named, owned failure on the run and the task", async () => {
    const f = await fixture();
    const work = nativeResponsePresentationWork(db);
    let attempts = 0;
    for (;;) {
      const [entry] = await work.load({ companyId: f.companyId, issueId: f.issueId });
      if (!entry) break;
      attempts += 1;
      expect(attempts).toBeLessThanOrEqual(10);
      await makeDue(f.runId).catch(() => undefined);
      await work.check({ ...entry, dueAt: 0 });
    }
    expect(await comments(f.runId)).toEqual([]);
    const failed = await receipt(f.runId);
    expect(failed).toMatchObject({ state: "failed", reasonCode: "native_response_publication_failed",
      owner: { kind: "agent", agentId: f.agentId } });
    expect(failed.attempts).toBeGreaterThan(1);
    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.runId),
      eq(heartbeatRunEvents.eventType, "run.response_publication.failed")));
    expect(events).toEqual([expect.objectContaining({ level: "error" })]);
    const activity = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId),
      eq(activityLog.action, "issue.response_publication_failed")));
    expect(activity).toEqual([expect.objectContaining({ runId: f.runId, agentId: f.agentId })]);
    // Bounded: the failed reply is no longer rescheduled.
    expect(await work.load({ companyId: f.companyId, issueId: f.issueId })).toEqual([]);
  });
});
