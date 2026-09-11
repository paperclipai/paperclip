import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  approvals, issueApprovals, issueThreadInteractions,
  agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions,
  issues, nativeRunFinalizations, environmentLeases, environments, issueRelations, issueTreeHolds, issueTreeHoldMembers,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";
import { admitExplicitNativeContinuation } from "./explicit-native-continuation.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { heartbeatService } from "./heartbeat.js";
import { getExecutionBlocker } from "./execution-blocker.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("explicit native conversation continuation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("explicit-native-message-"); db = createDb(database.connectionString); }, 30000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const sourceRunId = randomUUID(), successorRunId = randomUUID();
    const commentId: string = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Explicit turn", defaultResponsibleUserId: "board", issuePrefix: `E${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Deploy", status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId,
      nativeIssueId: issueId, runtimeMode: "native", status: "failed", processPid: 999999999,
      contextSnapshot: { issueId }, finishedAt: new Date("2026-09-11T10:00:00Z") });
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId,
      phase: "terminal_failure", attempt: 3, failureDetail: { replacementDenied: "uncertain_external_action" } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "uncertain_external_action", fingerprint: sourceRunId,
      status: "resolved", outcome: "blocked", nextAction: "Automatic recovery stopped.",
      evidence: { runId: sourceRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user",
      authorUserId: "board", body: "What happened?", createdAt: new Date("2026-09-11T11:00:00Z") });
    return { companyId, issueId, agentId, sourceRunId, commentId, successorRunId,
      actorType: "user", actorId: "board", reason: "issue_commented" };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const admit = (f: Fixture, dryRun = false) => db.transaction(async tx => {
    await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
    const result = await admitExplicitNativeContinuation({ ...f, dryRun, db: tx as unknown as typeof db });
    if (result && !dryRun) await tx.insert(heartbeatRuns).values({ id: f.successorRunId, companyId: f.companyId,
      agentId: f.agentId, status: "queued", contextSnapshot: { issueId: f.issueId, previousRunId: result.previousRunId, forceFreshSession: true } });
    return result;
  });
  it("queues the actual user wake with a fresh session and retained source context", async () => {
    const f = await seed();
    // Occupy this agent's only slot so this admission test never starts a provider.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const wake = await heartbeatService(db).wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, commentId: f.commentId },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId },
    });
    expect(wake).toMatchObject({ status: "queued", retryOfRunId: null,
      contextSnapshot: { forceFreshSession: true, previousRunId: f.sourceRunId,
        explicitUserContinuation: { previousRunId: f.sourceRunId, commentId: f.commentId } } });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action.evidence.explicitUserContinuation).toMatchObject({ runId: wake!.id });
    const envelope = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, context: wake!.contextSnapshot!, summary: "Deployment completed.", exposeLowTrustRaw: false });
    expect(envelope.interruptedRunId).toBe(f.sourceRunId);
    expect(envelope.objective).toBe("What happened?");
    expect(envelope.completedWork).toBe("Deployment completed.");
  });

  it.each(["pause", "dependency", "state"])("keeps the existing %s gate on the actual user wake", async gate => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    if (gate === "pause") {
      const holdId = randomUUID();
      await db.insert(issueTreeHolds).values({ id: holdId, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause", status: "active" });
      await db.insert(issueTreeHoldMembers).values({ companyId: f.companyId, holdId, issueId: f.issueId, depth: 0, issueTitle: "Deploy", issueStatus: "blocked" });
    } else if (gate === "dependency") {
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Required approval", status: "todo" });
      await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
    }
    const wake = await heartbeatService(db).wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented", requestedByActorType: "user", requestedByActorId: "board",
      ...(gate === "state" ? { issueStateGuard: { statuses: ["todo"], assigneeAgentId: f.agentId } } : {}),
      payload: { issueId: f.issueId, commentId: f.commentId }, contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId },
    });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    if (gate === "pause" || gate === "state") {
      expect(wake).toBeNull();
      expect(action.evidence.explicitUserContinuation).toBeUndefined();
    } else {
      expect(wake).toMatchObject({ contextSnapshot: { dependencyBlockedInteraction: true, unresolvedBlockerCount: 1 } });
      expect(await db.select().from(issueRelations).where(eq(issueRelations.companyId, f.companyId))).toHaveLength(1);
    }
  });

  it("preflights eligibility without retiring the hold or creating a successor", async () => {
    const f = await seed();
    expect(await admit(f, true)).toMatchObject({ previousRunId: f.sourceRunId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.successorRunId))).toHaveLength(0);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action.evidence.explicitUserContinuation).toBeUndefined();
  });
  it("retains the message receipt without a phantom run when ownership is still live", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const wake = await heartbeatService(db).wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, commentId: f.commentId },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId },
    });
    expect(wake).toBeNull();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(receipt).toMatchObject({ status: "deferred_issue_execution", requestedByActorId: "board", runId: null });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });
  it("lets a new human message continue after exhausted recovery without certifying old actions", async () => {
    const f = await seed();
    expect(await admit(f)).toEqual({ previousRunId: f.sourceRunId, commentId: f.commentId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action.evidence).toMatchObject({ automaticRecovery: { actionOutcome: "unknown" }, explicitUserContinuation: { runId: f.successorRunId, commentId: f.commentId } });
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(source.status).toBe("failed");
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    expect(coordinator.attempt).toBe(3);
    expect(coordinator.failureDetail?.replacementDenied).toBe("explicit_user_continuation");
  });
  it.each(["live_process", "missing_process", "lease", "coordinator", "successor", "agent_message", "old_comment", "wrong_author", "run_authored", "reassigned", "automatic", "approval", "question", "malformed_comment", "legacy_owner"])("keeps the hold for %s", async kind => {
    const f = await seed();
    if (kind === "legacy_owner") await db.insert(heartbeatRuns).values({ companyId: f.companyId,
      agentId: f.agentId, status: "failed", runtimeMode: "legacy", processPid: process.pid,
      contextSnapshot: { issueId: f.issueId }, resultJson: { conversationContinuation: "continue_conversation_v1" } });
    if (kind === "live_process") await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    if (kind === "missing_process") await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, f.sourceRunId));
    if (kind === "coordinator") await db.update(nativeRunFinalizations).set({ leaseOwner: "active-controller" }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    if (kind === "successor") await db.update(nativeRunFinalizations).set({ failureDetail: { successorRunId: randomUUID() } }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    if (kind === "lease") {
      const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
      const environmentId = environment.id;
      await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId, heartbeatRunId: f.sourceRunId, issueId: f.issueId, status: "active", leasePolicy: "ephemeral", provider: "local" });
    }
    if (kind === "question") await db.insert(issueThreadInteractions).values({
      companyId: f.companyId, issueId: f.issueId, kind: "ask_user_questions", status: "pending", payload: { version: 1, questions: [] },
    });
    if (kind === "approval") {
      const approvalId = randomUUID();
      await db.insert(approvals).values({ id: approvalId, companyId: f.companyId, type: "hire_agent", status: "pending", payload: {} });
      await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId });
    }
    if (kind === "malformed_comment") f.commentId = "not-a-uuid";
    if (kind === "agent_message") f.actorType = "agent";
    if (kind === "automatic") f.reason = "issue_continuation_needed";
    if (kind === "wrong_author") f.actorId = "someone-else";
    if (kind === "run_authored") await db.update(issueComments).set({ createdByRunId: f.sourceRunId }).where(eq(issueComments.id, f.commentId));
    if (kind === "old_comment") await db.update(issueComments).set({ createdAt: new Date("2026-09-11T09:00:00Z") }).where(eq(issueComments.id, f.commentId));
    if (kind === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    expect(await admit(f)).toBeNull();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });
  it.each(["foreign_source", "missing_authorization", "nonterminal_source"])("rejects unverified interruption context: %s", async kind => {
    const f = await seed();
    let previousRunId: string = f.sourceRunId;
    if (kind === "foreign_source") previousRunId = (await seed()).sourceRunId;
    if (kind === "nonterminal_source") {
      await admit(f);
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.sourceRunId));
    }
    await expect(buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, context: { previousRunId: f.sourceRunId,
        explicitUserContinuation: { previousRunId, commentId: f.commentId } },
      summary: null, exposeLowTrustRaw: false })).rejects.toThrow("continuation_user_authorization_missing");
  });
  it("keeps one new turn under concurrent delivery of the same message", async () => {
    const f = await seed();
    const results = await Promise.all([admit(f), admit(f)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")))).toHaveLength(1);
  });
  it("retains the source incident through prior rejected message admissions", async () => {
    const f = await seed(), rejectedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: rejectedRunId, companyId: f.companyId, agentId: f.agentId,
      status: "cancelled", errorCode: "execution_reconciliation_required", contextSnapshot: { issueId: f.issueId },
      finishedAt: new Date("2026-09-11T10:30:00Z") });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: rejectedRunId,
      status: "resolved", outcome: "blocked", nextAction: "Could not start", evidence: { runId: rejectedRunId, automaticRecovery: { replay: "blocked" } } });
    expect(await admit(f)).toMatchObject({ previousRunId: f.sourceRunId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });
});
