import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, createDb, environmentLeases, environments, heartbeatRuns,
  issueComments, issueRecoveryActions, issues, issueThreadInteractions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { prepareAutomaticSandboxContinuation } from "./automatic-sandbox-continuation.js";
import { heartbeatService, type HeartbeatEnvironmentRuntime } from "./heartbeat.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { buildExecutionContinuation } from "./execution-continuation.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("automatic sandbox conversation recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("automatic-sandbox-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: "recovery-owner", name: "Owner", email: "recovery@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed(confirmed = true) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const prefix = `R${companyId.slice(0, 7)}`;
    await db.insert(companies).values({ id: companyId, name: "Recovery", issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "recovery-owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "idle",
      adapterType: "claude_local", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue approved work", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: "recovery-owner", issueNumber: 1, identifier: `${prefix}-1` });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
      authorUserId: "recovery-owner", body: "Proceed with the approved work." }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId,
      status: "failed", errorCode: "process_lost", error: "Process lost", responsibleUserId: "recovery-owner",
      createdAt: new Date(Date.now() - 60_000), startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(),
      contextSnapshot: { issueId, wakeReason: "issue_assigned", commentId: comment.id },
      // Deliberately no invocation event, session, or adapter evidence: pre-upgrade startup.
    }).returning();
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: runId,
      status: "resolved", outcome: "blocked", nextAction: "Execution needs reconciliation",
      evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    const [environment] = await db.insert(environments).values({ name: `Sandbox ${runId}`, driver: "sandbox" }).returning();
    const identity = { id: randomUUID(), companyId, heartbeatRunId: runId, provider: "daytona", providerLeaseId: `sandbox-${runId}` };
    await db.insert(environmentLeases).values({ ...identity, environmentId: environment.id, status: "released",
      leasePolicy: "ephemeral", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { driver: "sandbox", ...(confirmed ? { remoteExecutionTermination: remoteTerminationReceipt(identity,
        { providerLeaseId: identity.providerLeaseId, state: "destroyed" }) } : {}) } });
    return { companyId, agentId, issueId, run, identity, environmentId: environment.id };
  }
  async function successors(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
  }
  it("automatically resumes a historical startup failure after exact provider termination", async () => {
    const f = await seed();
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    const [next] = await successors(f.run.id);
    expect(next).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
    expect(next.contextSnapshot).toMatchObject({ issueId: f.issueId, retryOfRunId: f.run.id, commentId: f.run.contextSnapshot!.commentId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const [old] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(old).toMatchObject({ status: "failed", errorCode: "process_lost" });
    expect(old.resultJson?.automaticSandboxRecovery).toMatchObject({ actionOutcomes: "unknown" });
  });
  it("queues missing termination proof for cleanup, then resumes after a restart", async () => {
    const f = await seed(false);
    expect(await prepareAutomaticSandboxContinuation(db, f.run)).toBeNull();
    const [pending] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.identity.id));
    expect(pending.status).toBe("pending_cleanup");
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    expect(await successors(f.run.id)).toHaveLength(0);
    const restarted = heartbeatService(db, { environmentRuntime: {
      retryPendingSandboxTeardown: async ({ lease }: { lease: { providerLeaseId: string } }) => ({ providerLeaseId: lease.providerLeaseId, state: "destroyed" }),
    } as unknown as HeartbeatEnvironmentRuntime });
    await restarted.sweepPendingCleanupLeases();
    await restarted.resumeInterruptedSandboxRuns();
    expect(await successors(f.run.id)).toHaveLength(1);
  });
  it("does not reclaim a historical reusable resource that can be resuming elsewhere", async () => {
    const f = await seed(false);
    await db.update(environmentLeases).set({ leasePolicy: "reuse_by_environment" }).where(eq(environmentLeases.id, f.identity.id));
    expect(await prepareAutomaticSandboxContinuation(db, f.run)).toBeNull();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.identity.id));
    expect(lease.status).toBe("released");
    expect(await successors(f.run.id)).toHaveLength(0);
  });
  it("does not terminate a resource with a later lease", async () => {
    const f = await seed(false);
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environmentId,
      provider: f.identity.provider, providerLeaseId: f.identity.providerLeaseId, status: "active",
      acquiredAt: new Date(Date.now() + 1000), leasePolicy: "ephemeral" });
    expect(await prepareAutomaticSandboxContinuation(db, f.run)).toBeNull();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.identity.id));
    expect(lease.status).toBe("released");
  });
  it("creates one successor under concurrent sweeps and repeated restarts", async () => {
    const f = await seed();
    await Promise.all([heartbeatService(db).resumeInterruptedSandboxRuns(), heartbeatService(db).resumeInterruptedSandboxRuns()]);
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    expect(await successors(f.run.id)).toHaveLength(1);
  });
  it("finishes delivery after a crash between retiring the hold and scheduling", async () => {
    const f = await seed();
    expect(await prepareAutomaticSandboxContinuation(db, f.run)).not.toBeNull();
    expect(await successors(f.run.id)).toHaveLength(0);
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    expect(await successors(f.run.id)).toHaveLength(1);
  });
  it("uses provider proof rather than probing a remote PID in the host namespace", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ processPid: process.pid, processGroupId: process.pid }).where(eq(heartbeatRuns.id, f.run.id));
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    expect(await successors(f.run.id)).toHaveLength(1);
  });
  it.each(["paused", "terminated"])("keeps a %s agent from restarting", async status => {
    const f = await seed();
    await db.update(agents).set({ status }).where(eq(agents.id, f.agentId));
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    expect(await successors(f.run.id)).toHaveLength(0);
  });
  it.each(["done", "cancelled"])("does not restart a %s task", async status => {
    const f = await seed();
    await db.update(issues).set({ status }).where(eq(issues.id, f.issueId));
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    expect(await successors(f.run.id)).toHaveLength(0);
  });
  it("honors the budget hard stop", async () => {
    const f = await seed();
    await db.update(companies).set({ status: "paused", pauseReason: "budget" }).where(eq(companies.id, f.companyId));
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    expect(await successors(f.run.id)).toHaveLength(0);
  });
  it("keeps an unanswered confirmation pending", async () => {
    const f = await seed();
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Approve deployment?" },
      createdByAgentId: f.agentId });
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    expect(await successors(f.run.id)).toHaveLength(0);
  });
  it("continues an accepted confirmation without asking for approval again", async () => {
    const f = await seed();
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "request_confirmation", status: "accepted", continuationPolicy: "wake_assignee_on_accept",
      createdByAgentId: f.agentId, resolvedByUserId: "recovery-owner", resolvedAt: new Date(),
      payload: { version: 1, prompt: "Approve the work?" }, result: { version: 1, outcome: "accepted" } }).returning();
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.run.contextSnapshot,
      wakeReason: "issue_interaction_resolved", interactionId: interaction.id, interactionKind: "request_confirmation",
      interactionStatus: "accepted", continuationPolicy: "wake_assignee_on_accept" } }).where(eq(heartbeatRuns.id, f.run.id));
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    const [next] = await successors(f.run.id);
    expect(next.contextSnapshot).toMatchObject({ interactionId: interaction.id, interactionStatus: "accepted" });
    const [saved] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id));
    expect(saved.result).toEqual({ version: 1, outcome: "accepted" });
  });
  it("does not restart work assigned to someone else", async () => {
    const f = await seed();
    await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "recovery-owner" }).where(eq(issues.id, f.issueId));
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    expect(await successors(f.run.id)).toHaveLength(0);
  });
  it("does not replay a failure after a later run already completed the work", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "succeeded", contextSnapshot: { issueId: f.issueId }, finishedAt: new Date() });
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    expect(await successors(f.run.id)).toHaveLength(0);
  });

  it("does not reset an exhausted incident counter after restart", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ scheduledRetryAttempt: 2 }).where(eq(heartbeatRuns.id, f.run.id));
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    expect(await successors(f.run.id)).toHaveLength(0);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(run.resultJson?.automaticSandboxRecovery).toMatchObject({ state: "attempts_exhausted" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });
  it("does not turn a known process adapter into an automatic conversation retry", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "process" } } }).where(eq(heartbeatRuns.id, f.run.id));
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    expect(await successors(f.run.id)).toHaveLength(0);
  });
  it("preserves the latest user direction in the resumed conversation", async () => {
    const f = await seed();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "recovery-owner", body: "Use the blue design." });
    await heartbeatService(db).resumeInterruptedSandboxRuns();
    const [next] = await successors(f.run.id);
    const history = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, context: next.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect(JSON.stringify(history)).toContain("Use the blue design.");
    expect(JSON.stringify(history)).toContain("Proceed with the approved work.");
  });
  it("rejects a foreign company source", async () => {
    const f = await seed();
    expect(await prepareAutomaticSandboxContinuation(db, { ...f.run, companyId: randomUUID() })).toBeNull();
    expect(await successors(f.run.id)).toHaveLength(0);
  });
});
