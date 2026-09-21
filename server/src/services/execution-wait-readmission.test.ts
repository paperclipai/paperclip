import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { heartbeatService } from "./heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();

// A wake parked by conversation ownership carries no recovery action, so the
// recovery-backed sweep never sees it. Once the former owner's process exits
// the gate is gone, and the wake must re-enter ordinary admission instead of
// staying `deferred_issue_execution` while the task sits in `todo`.
(support.supported ? describe : describe.skip)("re-admission of unblocked execution waits", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("execution-wait-readmit-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Readmit", defaultResponsibleUserId: "board",
      issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer",
      adapterType: "claude_local", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Measure demo data", status: "todo",
      assigneeAgentId: agentId });
    // The previous owner's run row is already cancelled, but its process is
    // still alive: exactly the state a same-second reassignment leaves behind.
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, runtimeMode: "legacy",
      status: "cancelled", errorCode: "issue_reassigned", processPid: process.pid,
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      contextSnapshot: { issueId }, finishedAt: new Date("2026-09-21T10:00:00Z") });
    // Saturate this agent's concurrency with unrelated work so an admitted
    // wake stops at `queued` and the assertion reads admission, not dispatch.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" });
    // The board's reassignment comment is what makes this wake durable, which
    // is the exact shape seen in production for a same-second reassignment.
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user",
      authorUserId: "board", body: "Taking this over." });
    return { companyId, agentId, issueId, sourceRunId, commentId };
  }

  async function park(f: Awaited<ReturnType<typeof seed>>) {
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({
      cause: "execution_owner_active", recoveryActionId: null, runId: f.sourceRunId,
    });
    await heartbeatService(db).wakeup(f.agentId, { source: "automation", triggerDetail: "system",
      reason: "issue_assigned", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, commentId: f.commentId },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId } });
    const [parked] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(parked).toMatchObject({ status: "deferred_issue_execution" });
    expect(parked.payload?.executionWait).toBeTruthy();
    return parked;
  }

  const makeDue = (id: string) => db.update(agentWakeupRequests)
    .set({ updatedAt: new Date(0) }).where(eq(agentWakeupRequests.id, id));
  const clearGate = (runId: string) => db.update(heartbeatRuns)
    .set({ processPid: 999999999 }).where(eq(heartbeatRuns.id, runId));
  const queuedRuns = (companyId: string) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")));

  it("re-admits a wake left parked by a gate that has disappeared, exactly once", async () => {
    const f = await seed();
    const parked = await park(f);

    // The recovery-backed sweep cannot see this wake, and the gate is still up.
    await makeDue(parked.id);
    await heartbeatService(db).resumeExecutionWaitComments();
    await heartbeatService(db).readmitUnblockedExecutionWaits();
    expect(await queuedRuns(f.companyId)).toHaveLength(0);
    expect((await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, parked.id)))[0].status).toBe("deferred_issue_execution");

    await clearGate(f.sourceRunId);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    await makeDue(parked.id);
    await Promise.all([
      heartbeatService(db).readmitUnblockedExecutionWaits(),
      heartbeatService(db).readmitUnblockedExecutionWaits(),
    ]);

    const runs = await queuedRuns(f.companyId);
    expect(runs).toHaveLength(1);
    expect(runs[0].contextSnapshot).toMatchObject({ issueId: f.issueId });
    const [retired] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parked.id));
    expect(retired.status).toBe("skipped");
    // The replacement wake records the re-admission key. A later pass reads it
    // as proof that this receipt was already handed to admission.
    expect(await db.select().from(agentWakeupRequests).where(eq(
      agentWakeupRequests.idempotencyKey, `execution-wait-readmit:${parked.id}`))).toHaveLength(1);
    // A second pass over the same task must not stack another run on top.
    await heartbeatService(db).readmitUnblockedExecutionWaits();
    expect(await queuedRuns(f.companyId)).toHaveLength(1);
  });

  it("keeps the receipt held when admission fails, and re-admits it on a later pass", async () => {
    const f = await seed();
    const parked = await park(f);
    await clearGate(f.sourceRunId);
    await makeDue(parked.id);
    // Stand in for a server that dies during admission: the run insert fails
    // after the receipt was claimed.
    await db.execute(sql`create or replace function readmit_block_run() returns trigger as $$
      begin raise exception 'admission interrupted'; end; $$ language plpgsql`);
    await db.execute(sql`create trigger readmit_block_run before insert on heartbeat_runs
      for each row execute function readmit_block_run()`);
    await heartbeatService(db).readmitUnblockedExecutionWaits();
    await db.execute(sql`drop trigger readmit_block_run on heartbeat_runs`);

    // The wake is still queued for a later pass. It is never silently retired,
    // which is the very defect this pass exists to prevent.
    expect((await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, parked.id)))[0].status).toBe("deferred_issue_execution");
    expect(await queuedRuns(f.companyId)).toHaveLength(0);

    await makeDue(parked.id);
    await heartbeatService(db).readmitUnblockedExecutionWaits();
    expect(await queuedRuns(f.companyId)).toHaveLength(1);
  });

  it("does not start a second run when the retire is interrupted after admission", async () => {
    const f = await seed();
    const parked = await park(f);
    await clearGate(f.sourceRunId);
    await makeDue(parked.id);
    // Stand in for a server that dies after admission commits but before the
    // receipt is retired: the retire update fails, so the receipt stays held.
    await db.execute(sql.raw(`create or replace function readmit_block_retire() returns trigger as $$
      begin raise exception 'retire interrupted'; end; $$ language plpgsql`));
    await db.execute(sql.raw(`create trigger readmit_block_retire before update on agent_wakeup_requests
      for each row when (new.id = '${parked.id}'::uuid and new.status = 'skipped')
      execute function readmit_block_retire()`));
    await expect(heartbeatService(db).readmitUnblockedExecutionWaits()).rejects.toThrow();
    await db.execute(sql.raw(`drop trigger readmit_block_retire on agent_wakeup_requests`));

    const firstRuns = await queuedRuns(f.companyId);
    expect(firstRuns).toHaveLength(1);
    expect((await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, parked.id)))[0].status).toBe("deferred_issue_execution");

    // The admitted run finishes, so no live run or execution lock hides the
    // held receipt from the next pass.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, firstRuns[0].id));
    await makeDue(parked.id);
    await heartbeatService(db).readmitUnblockedExecutionWaits();

    // The replacement wake carries the re-admission key, so the held receipt is
    // retired instead of producing a second run for the same wake.
    expect(await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`,
      eq(heartbeatRuns.status, "queued")))).toHaveLength(0);
    expect((await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, parked.id)))[0].status).toBe("skipped");
  });

  it("refuses a task that changed hands between selection and admission", async () => {
    const f = await seed();
    const parked = await park(f);
    const nextAgentId = randomUUID();
    await db.insert(agents).values({ id: nextAgentId, companyId: f.companyId, name: "Next", role: "engineer",
      adapterType: "claude_local", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await clearGate(f.sourceRunId);
    await makeDue(parked.id);
    // Selection reads the task outside the admission lock. Move the task to
    // another agent in that exact window, when the receipt is claimed.
    // A parameter placeholder is a literal inside a dollar-quoted body, so the
    // generated ids are inlined here.
    await db.execute(sql.raw(`create or replace function readmit_reassign() returns trigger as $$
      begin update issues set assignee_agent_id = '${nextAgentId}'::uuid where id = '${f.issueId}'::uuid;
      return null; end; $$ language plpgsql`));
    await db.execute(sql.raw(`create trigger readmit_reassign after update on agent_wakeup_requests
      for each row when (new.id = '${parked.id}'::uuid) execute function readmit_reassign()`));
    await heartbeatService(db).readmitUnblockedExecutionWaits();
    await db.execute(sql`drop trigger readmit_reassign on agent_wakeup_requests`);

    expect(await queuedRuns(f.companyId)).toHaveLength(0);
    const guarded = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.reason, "issue_state_guard_mismatch")));
    expect(guarded).toHaveLength(1);
  });

  it.each(["closed_issue", "reassigned_issue", "held_execution", "recovery_backed", "too_recent"])(
    "leaves a parked wake alone: %s", async kind => {
      const f = await seed();
      const parked = await park(f);
      await clearGate(f.sourceRunId);
      if (kind === "closed_issue") {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      }
      if (kind === "reassigned_issue") {
        const other = randomUUID();
        await db.insert(agents).values({ id: other, companyId: f.companyId, name: "Other", role: "engineer",
          adapterType: "claude_local", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
        await db.update(issues).set({ assigneeAgentId: other }).where(eq(issues.id, f.issueId));
      }
      if (kind === "held_execution") {
        await db.update(issues).set({ executionRunId: f.sourceRunId }).where(eq(issues.id, f.issueId));
      }
      if (kind === "recovery_backed") {
        // A wait behind a recorded recovery action belongs to
        // `resumeExecutionWaitComments`; this pass must not step over it.
        await db.update(agentWakeupRequests).set({
          payload: { ...parked.payload, executionWait: {
            ...(parked.payload?.executionWait ?? {}), recoveryActionId: randomUUID() } },
        }).where(eq(agentWakeupRequests.id, parked.id));
      }
      if (kind !== "too_recent") await makeDue(parked.id);

      await heartbeatService(db).readmitUnblockedExecutionWaits();
      expect(await queuedRuns(f.companyId)).toHaveLength(0);
      expect((await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, parked.id)))[0].status).toBe("deferred_issue_execution");
    },
  );
});
