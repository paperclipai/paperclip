import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
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
