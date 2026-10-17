import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, afterAll, afterEach, describe, it, expect } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases, heartbeatRuns, issueRecoveryActions, issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { heartbeatService } from "./heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();

// Agent A hands its issue to agent B from inside its own run. The reassignment
// cancels A's run, and B's assignment wake arrives while A's environment lease
// is still being released. Admission stores that wake as a terminal `skipped`
// execution wait. Once A's cleanup has released the lease, B must get exactly
// one run, and nothing else may start.
(support.supported ? describe : describe.skip)("handoff wake blocked by the outgoing run's lease", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("lease-handoff-readmit-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), outgoingId = randomUUID(), ownerId = randomUUID(), otherId = randomUUID();
    const issueId = randomUUID(), outgoingRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Handoff", defaultResponsibleUserId: "board",
      issuePrefix: `L${companyId.slice(0, 6)}` });
    const agent = (id: string, name: string) => ({ id, companyId, name, role: "engineer", adapterType: "hermes_local",
      status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(agents).values([agent(outgoingId, "Builder"), agent(ownerId, "Reviewer"), agent(otherId, "Other")]);
    // The PATCH has already handed the issue to the reviewer.
    await db.insert(issues).values({ id: issueId, companyId, title: "Hand-back for review", status: "todo",
      assigneeAgentId: ownerId });
    // The builder's run was stopped by the reassignment; no process remains.
    await db.insert(heartbeatRuns).values({ id: outgoingRunId, companyId, agentId: outgoingId,
      runtimeMode: "legacy", status: "cancelled", errorCode: "issue_reassigned",
      runnerProfileJson: { adapterDispatch: { adapterType: "hermes_local" } },
      contextSnapshot: { issueId }, finishedAt: new Date() });
    // Its lease is released a few milliseconds later, by the executor's cleanup.
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: outgoingRunId,
      status: "active", provider: "local" }).returning();
    // Saturate the reviewer elsewhere so an admitted wake stays `queued`.
    await db.insert(heartbeatRuns).values({ companyId, agentId: ownerId, status: "running" });
    return { companyId, outgoingId, ownerId, otherId, issueId, outgoingRunId, leaseId: lease!.id };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  // The wake the issue update route sends the new assignee (no comment).
  const handoffWake = (f: Fixture) => ({
    source: "assignment" as const, triggerDetail: "system" as const, reason: "issue_assigned",
    payload: { issueId: f.issueId, mutation: "update", interruptedRunId: f.outgoingRunId },
    requestedByActorType: "agent" as const, requestedByActorId: f.outgoingId,
    contextSnapshot: { issueId: f.issueId, source: "issue.update", interruptedRunId: f.outgoingRunId },
  });

  const outgoingRun = (f: Fixture) => ({ id: f.outgoingRunId, companyId: f.companyId, agentId: f.outgoingId });
  const releaseLease = (f: Fixture) => db.update(environmentLeases)
    .set({ status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" })
    .where(eq(environmentLeases.id, f.leaseId));
  const issueRuns = (f: Fixture, agentId = f.ownerId) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, agentId)))
    .then(rows => rows.filter(row => (row.contextSnapshot as { issueId?: string } | null)?.issueId === f.issueId));
  const receiptFor = async (f: Fixture) => {
    const rows = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.ownerId),
      eq(agentWakeupRequests.reason, "execution_reconciliation_required")));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };

  async function strand(f: Fixture) {
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({
      cause: "execution_owner_active", runId: f.outgoingRunId,
    });
    await heartbeatService(db).wakeup(f.ownerId, handoffWake(f));
    const receipt = await receiptFor(f);
    expect(receipt).toMatchObject({ status: "skipped", runId: null });
    expect(await issueRuns(f)).toHaveLength(0);
    return receipt;
  }

  it("starts the new owner exactly once after the outgoing lease is released", async () => {
    const f = await seed();
    const receipt = await strand(f);
    await releaseLease(f);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();

    // Two cleanups racing each other admit one continuation between them.
    await Promise.all([
      heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId),
      heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId),
    ]);
    const runs = await issueRuns(f);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("queued");
    expect(runs[0]!.contextSnapshot).toMatchObject({
      issueId: f.issueId, wakeReason: "issue_assigned", interruptedRunId: f.outgoingRunId,
    });
    const [retired] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
    expect((retired!.payload as { executionWait?: { readmittedAt?: string } }).executionWait?.readmittedAt).toBeTruthy();

    // A later pass adds nothing.
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    expect(await issueRuns(f)).toHaveLength(1);
  });

  it("leaves the receipt alone while the lease is still held", async () => {
    const f = await seed();
    const receipt = await strand(f);
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    expect(await issueRuns(f)).toHaveLength(0);
    const [kept] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
    expect((kept!.payload as { executionWait?: { readmittedAt?: string } }).executionWait?.readmittedAt).toBeUndefined();
    // Cleanup then finishes and the same hook delivers the handoff.
    await releaseLease(f);
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    expect(await issueRuns(f)).toHaveLength(1);
  });

  it("does not wake a stale owner after the issue moved on", async () => {
    const f = await seed();
    await strand(f);
    await releaseLease(f);
    await db.update(issues).set({ assigneeAgentId: f.otherId }).where(eq(issues.id, f.issueId));
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    expect(await issueRuns(f)).toHaveLength(0);
    expect(await issueRuns(f, f.otherId)).toHaveLength(0);
  });

  it("does not wake anyone on a closed issue", async () => {
    for (const status of ["done", "cancelled"] as const) {
      const f = await seed();
      await strand(f);
      await releaseLease(f);
      await db.update(issues).set({ status }).where(eq(issues.id, f.issueId));
      await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
      expect(await issueRuns(f)).toHaveLength(0);
    }
  });

  it("keeps a genuine recovery hold in place", async () => {
    const f = await seed();
    const receipt = await strand(f);
    await releaseLease(f);
    await db.insert(issueRecoveryActions).values({
      companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", ownerType: "board",
      cause: "uncertain_provider_action", status: "active", fingerprint: randomUUID(),
      evidence: { runId: f.outgoingRunId }, nextAction: "Check what the stopped run did.",
    });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ cause: "uncertain_provider_action" });
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    expect(await issueRuns(f)).toHaveLength(0);
    const [kept] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
    expect((kept!.payload as { executionWait?: { readmittedAt?: string } }).executionWait?.readmittedAt).toBeUndefined();
  });

  it("adds nothing when the owner already received a later wake", async () => {
    const f = await seed();
    await strand(f);
    await releaseLease(f);
    // A board comment woke the owner in the meantime.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.ownerId, status: "succeeded",
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented" }, finishedAt: new Date() });
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    expect(await issueRuns(f)).toHaveLength(1);
  });

  it("only answers for the run whose cleanup released the lease", async () => {
    const f = await seed();
    await strand(f);
    await releaseLease(f);
    const unrelatedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: unrelatedRunId, companyId: f.companyId, agentId: f.otherId,
      runtimeMode: "legacy", status: "succeeded", contextSnapshot: { issueId: f.issueId }, finishedAt: new Date() });
    await heartbeatService(db).readmitLeaseBlockedHandoffs(
      { id: unrelatedRunId, companyId: f.companyId, agentId: f.otherId }, f.issueId);
    expect(await issueRuns(f)).toHaveLength(0);
  });

  it("never promotes the stopped agent's own wake", async () => {
    const f = await seed();
    await strand(f);
    await releaseLease(f);
    // The issue went back to the builder before its cleanup finished.
    await db.update(issues).set({ assigneeAgentId: f.outgoingId }).where(eq(issues.id, f.issueId));
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    expect((await issueRuns(f, f.outgoingId)).filter(row => row.id !== f.outgoingRunId)).toHaveLength(0);
    expect(await issueRuns(f)).toHaveLength(0);
  });
});

// Review follow-up: the changes-requested direction, a failed or
// interrupted admission, and exactly one continuation however the attempts
// interleave. Admission stamps the receipt in its issue-locked transaction, so
// the stamp and the wake commit together; there is no claim that can expire.
(support.supported ? describe : describe.skip)("lease-blocked handoff: retries and exactly once", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("lease-handoff-retry-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });

  const KEY = "lease-handoff-readmit:";
  const OPEN = ["todo", "in_progress", "in_review", "blocked"];
  const STAGE = randomUUID();

  type Direction = "plain" | "reviewer" | "changes_requested";
  async function seed(direction: Direction = "plain") {
    const companyId = randomUUID(), outgoingId = randomUUID(), ownerId = randomUUID(), otherId = randomUUID();
    const issueId = randomUUID(), outgoingRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Handoff retry", defaultResponsibleUserId: "board",
      issuePrefix: `R${companyId.slice(0, 6)}` });
    const agent = (id: string, name: string) => ({ id, companyId, name, role: "engineer", adapterType: "hermes_local",
      status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(agents).values([agent(outgoingId, "Outgoing"), agent(ownerId, "Owner"), agent(otherId, "Other")]);
    const principal = (agentId: string) => ({ type: "agent", agentId });
    // reviewer: the producer handed to a reviewer (the stage waits on the owner).
    // changes_requested: the reviewer handed back; the owner is the return assignee
    // and the reviewer stays the current participant.
    const executionState = direction === "plain" ? null : {
      status: direction === "reviewer" ? "pending" : "changes_requested",
      currentStageId: STAGE, currentStageType: "review",
      currentParticipant: principal(direction === "reviewer" ? ownerId : outgoingId),
      returnAssignee: principal(direction === "reviewer" ? outgoingId : ownerId),
      lastDecisionOutcome: direction === "reviewer" ? null : "changes_requested",
    };
    await db.insert(issues).values({ id: issueId, companyId, title: "Handoff", assigneeAgentId: ownerId,
      status: direction === "plain" ? "todo" : direction === "reviewer" ? "in_review" : "in_progress",
      executionState });
    await db.insert(heartbeatRuns).values({ id: outgoingRunId, companyId, agentId: outgoingId,
      runtimeMode: "legacy", status: "cancelled", errorCode: "issue_reassigned",
      runnerProfileJson: { adapterDispatch: { adapterType: "hermes_local" } },
      contextSnapshot: { issueId }, finishedAt: new Date() });
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: outgoingRunId,
      status: "active", provider: "local" }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId: ownerId, status: "running" });
    return { companyId, outgoingId, ownerId, otherId, issueId, outgoingRunId, leaseId: lease!.id, direction,
      short: ownerId.replace(/-/g, "").slice(0, 12) };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  // The wake the issue route sends the new owner, for each direction.
  const handoffWake = (f: Fixture, extraPayload: Record<string, unknown> = {}) => {
    if (f.direction === "plain") return {
      source: "assignment" as const, triggerDetail: "system" as const, reason: "issue_assigned",
      payload: { issueId: f.issueId, mutation: "update", interruptedRunId: f.outgoingRunId, ...extraPayload },
      requestedByActorType: "agent" as const, requestedByActorId: f.outgoingId,
      contextSnapshot: { issueId: f.issueId, source: "issue.update", interruptedRunId: f.outgoingRunId },
    };
    const executor = f.direction === "changes_requested";
    const reason = executor ? "execution_changes_requested" : "execution_review_requested";
    const executionStage = { wakeRole: executor ? "executor" : "reviewer", stageId: STAGE, stageType: "review",
      allowedActions: executor ? ["address_changes", "resubmit"] : ["approve", "request_changes"] };
    return {
      source: "assignment" as const, triggerDetail: "system" as const, reason,
      payload: { issueId: f.issueId, mutation: "update", executionStage, interruptedRunId: f.outgoingRunId,
        ...extraPayload },
      requestedByActorType: "agent" as const, requestedByActorId: f.outgoingId,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: reason, source: "issue.execution_stage",
        executionStage, interruptedRunId: f.outgoingRunId },
    };
  };
  const outgoingRun = (f: Fixture) => ({ id: f.outgoingRunId, companyId: f.companyId, agentId: f.outgoingId });
  const releaseLease = (f: Fixture) => db.update(environmentLeases)
    .set({ status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" })
    .where(eq(environmentLeases.id, f.leaseId));
  const issueRuns = (f: Fixture, agentId = f.ownerId) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, agentId)))
    .then(rows => rows.filter(row => (row.contextSnapshot as { issueId?: string } | null)?.issueId === f.issueId));
  const keyedWakes = (f: Fixture) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.ownerId)))
    .then(rows => rows.filter(row => row.idempotencyKey?.startsWith(KEY) && row.status !== "skipped"));
  const receiptRow = async (f: Fixture, id: string) =>
    (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
  const waitOf = (row: { payload: unknown }) =>
    ((row.payload as { executionWait?: Record<string, unknown> }).executionWait ?? {});

  async function strand(f: Fixture, extraPayload: Record<string, unknown> = {}) {
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({
      cause: "execution_owner_active", runId: f.outgoingRunId,
    });
    await heartbeatService(db).wakeup(f.ownerId, handoffWake(f, extraPayload));
    const rows = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.ownerId),
      eq(agentWakeupRequests.reason, "execution_reconciliation_required")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "skipped", runId: null });
    expect(await issueRuns(f)).toHaveLength(0);
    return rows[0]!;
  }

  // Exactly what a re-admission attempt sends to admission, built from the
  // receipt the way readmitLeaseBlockedHandoffs builds it. Used to replay an
  // attempt that was delayed between its selection and its admission.
  async function admissionOf(f: Fixture, receipt: typeof agentWakeupRequests.$inferSelect) {
    const [issue] = await db.select({ statusVersion: issues.statusVersion }).from(issues)
      .where(eq(issues.id, f.issueId));
    const { executionWait: _w, _paperclipWakeContext: context, ...payload } =
      receipt.payload as Record<string, unknown>;
    const ctx = context as Record<string, unknown>;
    return {
      source: receipt.source as "assignment", triggerDetail: (receipt.triggerDetail ?? undefined) as "system",
      reason: ctx.wakeReason as string, payload, contextSnapshot: ctx,
      requestedByActorType: (receipt.requestedByActorType ?? undefined) as "agent",
      requestedByActorId: receipt.requestedByActorId,
      issueStateGuard: { assigneeAgentId: f.ownerId, statuses: OPEN, statusVersion: issue!.statusVersion },
      idempotencyKey: `${KEY}${receipt.id}`,
      leaseHandoffReceiptId: receipt.id,
    };
  }

  // A trigger on the owner's re-admission insert, to fail it or hold it open
  // inside the admission transaction (which holds the issue lock).
  async function onKeyedInsert(f: Fixture, body: string) {
    const name = `handoff_readmit_${f.short}`;
    await db.execute(sql.raw(`create sequence if not exists ${name}_seq`));
    await db.execute(sql.raw(`create or replace function ${name}() returns trigger language plpgsql as $$
      begin
        if new.agent_id = '${f.ownerId}' and new.idempotency_key like '${KEY}%' then ${body} end if;
        return new;
      end $$`));
    await db.execute(sql.raw(`create trigger ${name} before insert on agent_wakeup_requests
      for each row execute function ${name}()`));
    return async () => {
      await db.execute(sql.raw(`drop trigger if exists ${name} on agent_wakeup_requests`));
      await db.execute(sql.raw(`drop function if exists ${name}()`));
    };
  }
  const failInserts = (f: Fixture) => onKeyedInsert(f, "raise exception 'injected insert failure';");
  const holdFirstInsert = (f: Fixture, seconds: number) =>
    onKeyedInsert(f, `if nextval('handoff_readmit_${f.short}_seq') = 1 then perform pg_sleep(${seconds}); end if;`);
  async function waitForSleeper(f: Fixture) {
    for (let i = 0; i < 200; i += 1) {
      const rows = await db.execute(sql.raw(
        `select pid from pg_stat_activity where wait_event = 'PgSleep' and state = 'active'`)) as unknown as
        Array<{ pid: number }>;
      if (rows.length > 0) return rows[0]!.pid;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("the held admission never started");
  }

  // 1
  it("re-admits a changes-requested return to the producer exactly once", async () => {
    const f = await seed("changes_requested");
    const receipt = await strand(f);
    await releaseLease(f);
    await Promise.all([
      heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId),
      heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId),
    ]);
    const runs = await issueRuns(f);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.contextSnapshot).toMatchObject({ issueId: f.issueId, wakeReason: "execution_changes_requested",
      executionStage: { wakeRole: "executor", stageId: STAGE } });
    expect(waitOf(await receiptRow(f, receipt.id)).readmittedAt).toBeTruthy();
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(await issueRuns(f)).toHaveLength(1);
  });

  it("still re-admits the reviewer direction (control for the role check)", async () => {
    const f = await seed("reviewer");
    await strand(f);
    await releaseLease(f);
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    expect(await issueRuns(f)).toHaveLength(1);
  });

  // 2
  it("refuses a changes-requested receipt after the producer re-submitted", async () => {
    const f = await seed("changes_requested");
    const receipt = await strand(f);
    await releaseLease(f);
    await db.update(issues).set({ executionState: { status: "pending", currentStageId: STAGE,
      currentStageType: "review", currentParticipant: { type: "agent", agentId: f.outgoingId },
      returnAssignee: { type: "agent", agentId: f.ownerId } } }).where(eq(issues.id, f.issueId));
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(await issueRuns(f)).toHaveLength(0);
    expect(waitOf(await receiptRow(f, receipt.id)).readmittedAt).toBeUndefined();
  });

  // 3
  it("refuses a changes-requested receipt whose return assignee is no longer the owner", async () => {
    const f = await seed("changes_requested");
    await strand(f);
    await releaseLease(f);
    await db.update(issues).set({ executionState: { status: "changes_requested", currentStageId: STAGE,
      currentStageType: "review", currentParticipant: { type: "agent", agentId: f.outgoingId },
      returnAssignee: { type: "agent", agentId: f.otherId } } }).where(eq(issues.id, f.issueId));
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(await issueRuns(f)).toHaveLength(0);
    expect(await issueRuns(f, f.otherId)).toHaveLength(0);
  });

  // 4
  it("retries an admission whose insert failed, once", async () => {
    const f = await seed();
    const receipt = await strand(f);
    await releaseLease(f);
    const restore = await failInserts(f);
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    await restore();
    expect(await issueRuns(f)).toHaveLength(0);
    // The failed transaction took its stamp with it; the attempt is counted.
    expect(waitOf(await receiptRow(f, receipt.id))).toMatchObject({ readmitAttempts: 1 });
    expect(waitOf(await receiptRow(f, receipt.id)).readmittedAt).toBeUndefined();
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(await issueRuns(f)).toHaveLength(1);
    expect(await keyedWakes(f)).toHaveLength(1);
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(await issueRuns(f)).toHaveLength(1);
  });

  // 5
  it("adds nothing when a keyed wake already exists for an unstamped receipt", async () => {
    const f = await seed();
    const receipt = await strand(f);
    await releaseLease(f);
    // A wake landed under this receipt's key, but the receipt was never stamped
    // (as a pre-fix build could leave it). Admission must see the keyed wake.
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.ownerId,
      source: "assignment", reason: "issue_assigned", status: "completed", idempotencyKey: `${KEY}${receipt.id}`,
      payload: { issueId: f.issueId }, requestedAt: new Date(receipt.requestedAt.getTime() - 1000) });
    await heartbeatService(db).wakeup(f.ownerId, await admissionOf(f, receipt));
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(await issueRuns(f)).toHaveLength(0);
    expect(await keyedWakes(f)).toHaveLength(1);
  });

  // 6
  it("starts one run when the cleanup hook and the retry pass race", async () => {
    const f = await seed();
    await strand(f);
    await releaseLease(f);
    await Promise.all([
      heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId),
      heartbeatService(db).retryLeaseHandoffReadmits(),
      heartbeatService(db).retryLeaseHandoffReadmits(),
    ]);
    expect(await issueRuns(f)).toHaveLength(1);
    expect(await keyedWakes(f)).toHaveLength(1);
  });

  // 7
  it("re-admits a handoff whose cleanup ran while scheduling was suppressed, once suppression lifts", async () => {
    const f = await seed();
    const receipt = await strand(f);
    await releaseLease(f);
    const suppressed = heartbeatService(db, { runtimeEnv: { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "true" } });
    await suppressed.readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    await suppressed.retryLeaseHandoffReadmits();
    expect(await issueRuns(f)).toHaveLength(0);
    expect(waitOf(await receiptRow(f, receipt.id)).readmitAttempts).toBeUndefined();
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(await issueRuns(f)).toHaveLength(1);
  });

  // 8
  it("never selects a receipt older than the window, or one without a stored wake context", async () => {
    const old = await seed();
    const oldReceipt = await strand(old);
    await releaseLease(old);
    await db.execute(sql`update agent_wakeup_requests set requested_at = now() - interval '16 minutes'
      where id = ${oldReceipt.id}`);
    const legacy = await seed();
    const legacyReceipt = await strand(legacy);
    await releaseLease(legacy);
    await db.execute(sql`update agent_wakeup_requests set payload = payload - '_paperclipWakeContext'
      where id = ${legacyReceipt.id}`);
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(await issueRuns(old)).toHaveLength(0);
    expect(await issueRuns(legacy)).toHaveLength(0);
    expect(waitOf(await receiptRow(old, oldReceipt.id)).readmitAttempts).toBeUndefined();
  });

  // 9
  it("stops after three failed attempts", async () => {
    const f = await seed();
    const receipt = await strand(f);
    await releaseLease(f);
    const restore = await failInserts(f);
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    await heartbeatService(db).retryLeaseHandoffReadmits();
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(waitOf(await receiptRow(f, receipt.id))).toMatchObject({ readmitAttempts: 3 });
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(waitOf(await receiptRow(f, receipt.id))).toMatchObject({ readmitAttempts: 3 });
    await restore();
    await heartbeatService(db).retryLeaseHandoffReadmits();
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    expect(await issueRuns(f)).toHaveLength(0);
  });

  // 10
  it("replays the server-derived wake context, not one a caller put in the payload", async () => {
    const f = await seed();
    await strand(f, { _paperclipWakeContext: { issueId: randomUUID(), wakeReason: "forged_reason", forged: true } });
    await releaseLease(f);
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    const runs = await issueRuns(f);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.contextSnapshot).toMatchObject({ issueId: f.issueId, wakeReason: "issue_assigned" });
    expect((runs[0]!.contextSnapshot as Record<string, unknown>).forged).toBeUndefined();
  });

  // Exactly once: a delayed attempt resuming after another
  // attempt already admitted the handoff adds no second continuation.
  it("adds nothing when a delayed attempt reaches admission after another attempt admitted", async () => {
    const f = await seed();
    const receipt = await strand(f);
    await releaseLease(f);
    // The delayed attempt had already selected the receipt: this is what it sends.
    const delayed = await admissionOf(f, receipt);
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    expect(await issueRuns(f)).toHaveLength(1);
    // It resumes much later (well past any claim lifetime) with its stale options.
    expect(await heartbeatService(db).wakeup(f.ownerId, delayed)).toBeNull();
    expect(await issueRuns(f)).toHaveLength(1);
    expect(await keyedWakes(f)).toHaveLength(1);
    // The keyed check alone also refuses it, if the stamp were lost.
    await db.execute(sql`update agent_wakeup_requests
      set payload = payload #- '{executionWait,readmittedAt}' where id = ${receipt.id}`);
    expect(await heartbeatService(db).wakeup(f.ownerId, delayed)).toBeNull();
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(await issueRuns(f)).toHaveLength(1);
    expect(await keyedWakes(f)).toHaveLength(1);
  });

  it("makes a retry wait for an admission held open past any claim lifetime, then add nothing", async () => {
    const f = await seed();
    await strand(f);
    await releaseLease(f);
    const restore = await holdFirstInsert(f, 2);
    try {
      let firstDone = false;
      const first = heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId)
        .then(() => { firstDone = true; });
      await waitForSleeper(f);
      // The retry runs while the first admission is still inside its transaction.
      const retry = heartbeatService(db).retryLeaseHandoffReadmits();
      const delayed = heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
      await Promise.all([first, retry, delayed]);
      expect(firstDone).toBe(true);
    } finally {
      await restore();
    }
    expect(await issueRuns(f)).toHaveLength(1);
    expect(await keyedWakes(f)).toHaveLength(1);
  });

  it("recovers an admission whose database session died mid-transaction, exactly once", async () => {
    const f = await seed();
    const receipt = await strand(f);
    await releaseLease(f);
    const restore = await holdFirstInsert(f, 30);
    try {
      const first = heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
      const pid = await waitForSleeper(f);
      await db.execute(sql`select pg_terminate_backend(${pid})`);
      await first;
    } finally {
      await restore();
    }
    expect(await issueRuns(f)).toHaveLength(0);
    expect(waitOf(await receiptRow(f, receipt.id)).readmittedAt).toBeUndefined();
    await heartbeatService(db).retryLeaseHandoffReadmits();
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(await issueRuns(f)).toHaveLength(1);
    expect(await keyedWakes(f)).toHaveLength(1);
  });

  it("recovers a crash between counting the attempt and admission, exactly once", async () => {
    const f = await seed();
    const receipt = await strand(f);
    await releaseLease(f);
    // What the selection transaction leaves behind when the process dies before admission.
    await db.execute(sql`update agent_wakeup_requests
      set payload = jsonb_set(payload, '{executionWait,readmitAttempts}', '1'::jsonb) where id = ${receipt.id}`);
    await heartbeatService(db).retryLeaseHandoffReadmits();
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(await issueRuns(f)).toHaveLength(1);
    expect(waitOf(await receiptRow(f, receipt.id))).toMatchObject({ readmitAttempts: 2 });
  });

  it("keeps every gate closed on the retry path", async () => {
    // Lease still held, recovery hold, reassigned, closed, later run: the retry pass adds nothing.
    const held = await seed();
    await strand(held);
    const hold = await seed();
    await strand(hold);
    await releaseLease(hold);
    await db.insert(issueRecoveryActions).values({
      companyId: hold.companyId, sourceIssueId: hold.issueId, kind: "active_run_watchdog", ownerType: "board",
      cause: "uncertain_provider_action", status: "active", fingerprint: randomUUID(),
      evidence: { runId: hold.outgoingRunId }, nextAction: "Check what the stopped run did.",
    });
    const moved = await seed();
    await strand(moved);
    await releaseLease(moved);
    await db.update(issues).set({ assigneeAgentId: moved.otherId }).where(eq(issues.id, moved.issueId));
    const closed = await seed();
    await strand(closed);
    await releaseLease(closed);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, closed.issueId));
    const later = await seed();
    await strand(later);
    await releaseLease(later);
    await db.insert(heartbeatRuns).values({ companyId: later.companyId, agentId: later.ownerId, status: "succeeded",
      contextSnapshot: { issueId: later.issueId, wakeReason: "issue_commented" }, finishedAt: new Date() });
    await heartbeatService(db).retryLeaseHandoffReadmits();
    await heartbeatService(db).retryLeaseHandoffReadmits();
    for (const f of [held, hold, moved, closed]) expect(await issueRuns(f)).toHaveLength(0);
    expect(await issueRuns(moved, moved.otherId)).toHaveLength(0);
    expect(await issueRuns(later)).toHaveLength(1);
    // A forged admission (key and receipt disagree, or another agent's receipt) adds nothing.
    const forged = await seed();
    const forgedReceipt = await strand(forged);
    await releaseLease(forged);
    const options = await admissionOf(forged, forgedReceipt);
    expect(await heartbeatService(db).wakeup(forged.ownerId,
      { ...options, idempotencyKey: `${KEY}${randomUUID()}` })).toBeNull();
    expect(await heartbeatService(db).wakeup(forged.otherId,
      { ...options, issueStateGuard: undefined })).toBeNull();
    expect(await issueRuns(forged)).toHaveLength(0);
    expect(await issueRuns(forged, forged.otherId)).toHaveLength(0);
    // A re-admission that lost its issue is refused before any run can start.
    const agentRuns = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, forged.ownerId));
    const before = (await agentRuns()).length;
    expect(await heartbeatService(db).wakeup(forged.ownerId, { ...options, payload: {}, contextSnapshot: {},
      issueStateGuard: undefined })).toBeNull();
    expect(await agentRuns()).toHaveLength(before);
    expect(waitOf(await receiptRow(forged, forgedReceipt.id)).readmittedAt).toBeUndefined();
  });

  it("admits once when a stale attempt and a fresh one queue behind the same issue lock", async () => {
    const f = await seed();
    const receipt = await strand(f);
    await releaseLease(f);
    const stale = await admissionOf(f, receipt);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select id from issues where id = ${f.issueId} for update`);
      locked();
      await gate;
    });
    await isLocked;
    const lockWaiters = async (n: number) => {
      for (let i = 0; i < 200; i += 1) {
        const rows = await db.execute(sql.raw(
          `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'`)) as unknown as
          Array<{ n: number }>;
        if (rows[0]!.n >= n) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`fewer than ${n} attempts are waiting on the issue lock`);
    };
    // A fresh attempt queues first: its selection passes once the lock frees,
    // because the receipt is not stamped until an admission commits.
    const fresh = heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    await lockWaiters(1);
    // The stale attempt (selected long ago) reaches admission behind it.
    const late = heartbeatService(db).wakeup(f.ownerId, stale);
    await lockWaiters(2);
    release();
    await holder;
    await Promise.all([fresh, late]);
    expect(await issueRuns(f)).toHaveLength(1);
    expect(await keyedWakes(f)).toHaveLength(1);
    expect(waitOf(await receiptRow(f, receipt.id)).readmittedAt).toBeTruthy();
  });

  it("leaves a receipt alone while its interrupted run has not finished", async () => {
    const f = await seed();
    await strand(f);
    await releaseLease(f);
    // The outgoing run is still live: its own cleanup will re-admit the handoff.
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null })
      .where(eq(heartbeatRuns.id, f.outgoingRunId));
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(await issueRuns(f)).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, f.outgoingRunId));
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(await issueRuns(f)).toHaveLength(1);
  });

  it("never re-admits a receipt that a re-admission itself left behind", async () => {
    const f = await seed();
    const receipt = await strand(f);
    await releaseLease(f);
    // A re-admission met a new block: admission stored its own skipped receipt
    // under the re-admission key. That is a different wait, not this handoff.
    await db.update(agentWakeupRequests).set({ idempotencyKey: `${KEY}${randomUUID()}` })
      .where(eq(agentWakeupRequests.id, receipt.id));
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(await issueRuns(f)).toHaveLength(0);
  });
});

// The retry pass reads a bounded page of receipts. Receipts it cannot act on,
// because their interrupted run is still live or because a later gate refuses
// them, must not hide a newer handoff that is ready, and must stay as they are.
(support.supported ? describe : describe.skip)("lease-blocked handoff: the retry page", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("lease-handoff-page-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });
  // Each case starts with no receipt of an earlier case in the retry window.
  afterEach(async () => {
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.reason, "execution_reconciliation_required"));
  });

  const KEY = "lease-handoff-readmit:";
  const STAGE = randomUUID();

  async function seed() {
    const companyId = randomUUID(), outgoingId = randomUUID(), ownerId = randomUUID(), otherId = randomUUID();
    const issueId = randomUUID(), outgoingRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Handoff page", defaultResponsibleUserId: "board",
      issuePrefix: `P${companyId.slice(0, 6)}` });
    const agent = (id: string, name: string) => ({ id, companyId, name, role: "engineer", adapterType: "hermes_local",
      status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(agents).values([agent(outgoingId, "Outgoing"), agent(ownerId, "Owner"), agent(otherId, "Other")]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Ready handoff", status: "todo",
      assigneeAgentId: ownerId });
    await db.insert(heartbeatRuns).values({ id: outgoingRunId, companyId, agentId: outgoingId,
      runtimeMode: "legacy", status: "cancelled", errorCode: "issue_reassigned",
      runnerProfileJson: { adapterDispatch: { adapterType: "hermes_local" } },
      contextSnapshot: { issueId }, finishedAt: new Date() });
    await db.insert(heartbeatRuns).values({ companyId, agentId: ownerId, status: "running" });
    return { companyId, outgoingId, ownerId, otherId, issueId, outgoingRunId };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  // The ready handoff: a real receipt from admission, then the lease released.
  async function strandReady(f: Fixture) {
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: f.outgoingRunId, status: "active", provider: "local" }).returning();
    await heartbeatService(db).wakeup(f.ownerId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: f.issueId, mutation: "update", interruptedRunId: f.outgoingRunId },
      requestedByActorType: "agent", requestedByActorId: f.outgoingId,
      contextSnapshot: { issueId: f.issueId, source: "issue.update", interruptedRunId: f.outgoingRunId },
    });
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" })
      .where(eq(environmentLeases.id, lease!.id));
    const rows = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.ownerId),
      eq(agentWakeupRequests.reason, "execution_reconciliation_required"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issueId}`));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  // Receipts of the same shape admission stores, for issues of their own.
  // One statement, so they share one requested_at to the microsecond.
  async function receipts(f: Fixture, issueIds: string[], runOf: string | ((issueId: string) => string),
    extra: (issueId: string) => Record<string, unknown> = () => ({}), requestedAt?: Date) {
    const run = (id: string) => typeof runOf === "string" ? runOf : runOf(id);
    return db.insert(agentWakeupRequests).values(issueIds.map(id => ({ id, runId: run(id) })).map(({ id, runId }) => ({
      companyId: f.companyId, agentId: f.ownerId, source: "assignment", triggerDetail: "system",
      reason: "execution_reconciliation_required", status: "skipped", ...(requestedAt ? { requestedAt } : {}),
      payload: { issueId: id, mutation: "update", interruptedRunId: runId, ...extra(id),
        executionWait: { cause: "execution_owner_active", runId },
        _paperclipWakeContext: { issueId: id, wakeReason: "issue_assigned", interruptedRunId: runId } },
    }))).returning();
  }
  const newIssues = async (f: Fixture, n: number, values: Record<string, unknown> = {}) => {
    const ids: string[] = Array.from({ length: n }, () => randomUUID());
    await db.insert(issues).values(ids.map(id => ({ id, companyId: f.companyId, title: "Refused handoff",
      status: "todo", assigneeAgentId: f.ownerId, ...values })));
    return ids;
  };
  const runsOn = (f: Fixture, issueIds: string[]) => db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.companyId, f.companyId))
    .then(rows => rows.filter(row => issueIds.includes(
      (row.contextSnapshot as { issueId?: string } | null)?.issueId ?? "") && row.agentId !== f.outgoingId));
  const keyedWakes = (f: Fixture, issueIds: string[]) => db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.companyId, f.companyId))
    .then(rows => rows.filter(row => row.idempotencyKey?.startsWith(KEY) && row.status !== "skipped" &&
      issueIds.includes((row.payload as { issueId?: string }).issueId ?? "")));
  const snapshot = (ids: string[]) => db.select({
    id: agentWakeupRequests.id, status: agentWakeupRequests.status, runId: agentWakeupRequests.runId,
    payload: agentWakeupRequests.payload, updatedAt: agentWakeupRequests.updatedAt,
    idempotencyKey: agentWakeupRequests.idempotencyKey,
  }).from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, ids)).orderBy(agentWakeupRequests.id);

  // 100 is a full page; 99 leaves one place for the ready handoff (the control).
  it.each([100, 99])("reaches a ready handoff behind %i receipts whose interrupted runs are still live", async (n) => {
    const f = await seed();
    const liveRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: liveRunId, companyId: f.companyId, agentId: f.outgoingId,
      status: "running", runtimeMode: "legacy" });
    const liveIssues = await newIssues(f, n);
    const live = await receipts(f, liveIssues, liveRunId, () => ({}), new Date(Date.now() - 60_000));
    const before = await snapshot(live.map(r => r.id));
    await strandReady(f);
    // A new service each pass: nothing carried between passes is needed here.
    const first = await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(first.attempted).toBe(1);
    expect(await runsOn(f, [f.issueId])).toHaveLength(1);
    await heartbeatService(db).retryLeaseHandoffReadmits();
    await heartbeatService(db).retryLeaseHandoffReadmits();
    expect(await runsOn(f, [f.issueId])).toHaveLength(1);
    expect(await keyedWakes(f, [f.issueId])).toHaveLength(1);
    // The live run's receipts are untouched, and nothing started for them.
    expect(await snapshot(live.map(r => r.id))).toEqual(before);
    expect(await runsOn(f, liveIssues)).toHaveLength(0);
    expect(await keyedWakes(f, liveIssues)).toHaveLength(0);
  });

  it("reaches a ready handoff behind 100 finished-run receipts that later gates refuse, and leaves them unchanged", async () => {
    const f = await seed();
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: f.companyId, agentId: f.otherId,
      status: "running", runtimeMode: "legacy" });
    // Each refused for a different reason, all with the finished outgoing run.
    const closed = await newIssues(f, 17, { status: "done" });
    const moved = await newIssues(f, 17, { assigneeAgentId: f.otherId });
    const owned = await newIssues(f, 16, { executionRunId: otherRunId });
    const leased = await newIssues(f, 17);
    const staged = await newIssues(f, 17, { status: "in_review", executionState: {
      status: "pending", currentStageId: randomUUID(), currentStageType: "review",
      currentParticipant: { type: "agent", agentId: f.ownerId }, returnAssignee: { type: "agent", agentId: f.outgoingId },
    } });
    const superseded = await newIssues(f, 16);
    const refusedIssues = [...closed, ...moved, ...owned, ...leased, ...staged, ...superseded];
    expect(refusedIssues).toHaveLength(100);
    // Leased: each has its own finished run whose environment lease is not released yet.
    const leasedRuns = new Map(leased.map(issueId => [issueId, randomUUID()]));
    await db.insert(heartbeatRuns).values(leased.map(issueId => ({ id: leasedRuns.get(issueId)!,
      companyId: f.companyId, agentId: f.outgoingId, runtimeMode: "legacy", status: "cancelled",
      errorCode: "issue_reassigned", runnerProfileJson: { adapterDispatch: { adapterType: "hermes_local" } },
      contextSnapshot: { issueId }, finishedAt: new Date() })));
    const refused = await receipts(f, refusedIssues, id => leasedRuns.get(id) ?? f.outgoingRunId,
      id => staged.includes(id) ? { executionStage: { stageId: STAGE, wakeRole: "reviewer", stageType: "review" } } : {});
    const leases = await db.insert(environmentLeases).values(leased.map(issueId => ({ companyId: f.companyId, issueId,
      heartbeatRunId: leasedRuns.get(issueId)!, status: "active", provider: "local" }))).returning();
    // Superseded: half got a later run, half have a wake still queued.
    await db.insert(heartbeatRuns).values(superseded.slice(0, 8).map(issueId => ({ companyId: f.companyId,
      agentId: f.ownerId, status: "succeeded", contextSnapshot: { issueId, wakeReason: "issue_commented" },
      finishedAt: new Date() })));
    await db.insert(agentWakeupRequests).values(superseded.slice(8).map(issueId => ({ companyId: f.companyId,
      agentId: f.ownerId, source: "automation", reason: "issue_commented", status: "queued",
      payload: { issueId } })));
    const refusedIds = refused.map(r => r.id);
    const before = await snapshot(refusedIds);
    const supersededRuns = (await runsOn(f, refusedIssues)).length;
    await strandReady(f);

    const heartbeat = heartbeatService(db);
    const passes = [];
    for (let i = 0; i < 2; i += 1) passes.push(await heartbeat.retryLeaseHandoffReadmits());
    for (const pass of passes) expect(pass.attempted).toBeLessThanOrEqual(100);
    expect(await runsOn(f, [f.issueId])).toHaveLength(1);
    expect(await keyedWakes(f, [f.issueId])).toHaveLength(1);
    // Later passes go round again and add nothing.
    for (let i = 0; i < 3; i += 1) await heartbeat.retryLeaseHandoffReadmits();
    expect(await runsOn(f, [f.issueId])).toHaveLength(1);
    expect(await keyedWakes(f, [f.issueId])).toHaveLength(1);
    // Every refused receipt is exactly as it was; nothing started for any of them.
    expect(await snapshot(refusedIds)).toEqual(before);
    expect(await runsOn(f, refusedIssues)).toHaveLength(supersededRuns);
    expect(await keyedWakes(f, refusedIssues)).toHaveLength(0);
    expect((await runsOn(f, moved)).filter(run => run.agentId === f.otherId)).toHaveLength(0);

    // Going round again reaches the older receipts too: once their own lease
    // is released, the leased ones are re-admitted, each exactly once.
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" })
      .where(inArray(environmentLeases.id, leases.map(l => l.id)));
    for (let i = 0; i < 3; i += 1) await heartbeat.retryLeaseHandoffReadmits();
    expect(await keyedWakes(f, leased)).toHaveLength(leased.length);
    expect(await runsOn(f, leased)).toHaveLength(leased.length);
    expect(await keyedWakes(f, [...closed, ...moved, ...owned, ...staged, ...superseded])).toHaveLength(0);
    expect(await runsOn(f, [f.issueId])).toHaveLength(1);
  });

  it("reaches a ready handoff behind live-run and refused receipts together", async () => {
    const f = await seed();
    const liveRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: liveRunId, companyId: f.companyId, agentId: f.outgoingId,
      status: "running", runtimeMode: "legacy" });
    const liveIssues = await newIssues(f, 100);
    await receipts(f, liveIssues, liveRunId, () => ({}), new Date(Date.now() - 120_000));
    const closed = await newIssues(f, 150, { status: "done" });
    await receipts(f, closed, f.outgoingRunId, () => ({}), new Date(Date.now() - 60_000));
    await strandReady(f);
    const heartbeat = heartbeatService(db);
    const passes = [];
    for (let i = 0; i < 2; i += 1) passes.push(await heartbeat.retryLeaseHandoffReadmits());
    expect(passes.map(pass => pass.attempted)).toEqual([100, 51]);
    expect(await runsOn(f, [f.issueId])).toHaveLength(1);
    expect(await runsOn(f, [...liveIssues, ...closed])).toHaveLength(0);
  });
});
