import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createRunDispatch } from "../modules/run-dispatch/index.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { issueService } from "../services/issues.js";
import { projectService } from "../services/projects.js";
import { reserveRunBudget } from "../services/budget-reservations.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("review submission generation", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("review-submission-generation-");
    db = createDb(fixture.connectionString);
    await db.insert(authUsers).values({ id: "board", name: "Review sponsor", email: "sponsor@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), authorId = randomUUID(), issueId = randomUUID(), stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Consumer fixture", issuePrefix: "C" + companyId.slice(0, 7), defaultResponsibleUserId: "board" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board",
      membershipRole: "operator", status: "active" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
      { id: authorId, companyId, name: "Author", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
    ]);
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Pending review", status: "in_review",
      responsibleUserId: "board", assigneeAgentId: agentId,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId }, returnAssignee: { type: "agent", agentId: authorId },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 2,
        reviewRequest: { instructions: "Review the same submission" } } }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: authorId, status: "cancelled",
      errorCode: "issue_reassigned", finishedAt: new Date(), responsibleUserId: "board", contextSnapshot: { issueId },
      resultJson: { executionCancellation: { state: "acknowledged" }, reassignmentStopConfirmed: true } }).returning();
    return { companyId, agentId, issueId, source, issue };
  }

  it.each(["queued", "preparing"])("rejects an older submission at the %s execution gate", async stage => {
    const f = await seed();
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    const service = heartbeatService(db);
    const run = await service.wakeup(f.agentId, { source: "assignment", reason: "execution_review_requested",
      payload: { issueId: f.issueId }, requestedByActorType: "agent", requestedByActorId: f.source.agentId });
    expect(run).toBeTruthy();
    await db.update(issues).set({ executionState: { ...f.issue.executionState!, reviewRequest: { instructions: "A new submission" } } }).where(eq(issues.id, f.issueId));
    const invoke = vi.fn(async () => null);
    try {
      if (stage === "queued") {
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
        await service.resumeQueuedRuns();
      } else {
        await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
        await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, f.issueId));
        const reservation = await reserveRunBudget(db, f.companyId, run!.id, null);
        expect(await createRunDispatch(db).dispatchResolvedInteractionIfCurrent({ companyId: f.companyId, runId: run!.id,
          expectedStatus: "running", reservationId: reservation.id, enforceContinuationOwnership: false, dispatch: invoke }))
          .toMatchObject({ dispatched: false, cancellation: { outcome: "cancelled" } });
      }
      const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(after).toMatchObject({ status: "cancelled", errorCode: "issue_review_participant_changed" });
      expect(invoke).not.toHaveBeenCalled();
    } finally { await service.drainActiveRunExecutions(); }
  });
  it.each((["none", "question", "tree", "dependency", "authority", "project", "recovery", "agent chain"] as const)
    .flatMap(kind => [false, true].map(crossAgent => [kind, crossAgent] as const)))("rechecks a new %s hold before handoff (cross-agent: %s)", async (kind, crossAgent) => {
    const f = await seed();
    if (crossAgent) await db.update(issues).set({ assigneeAgentId: f.source.agentId }).where(eq(issues.id, f.issueId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const run = await heartbeatService(db).wakeup(f.agentId, { source: "assignment", reason: "execution_review_requested",
      payload: { issueId: f.issueId }, requestedByActorType: "agent", requestedByActorId: f.source.agentId });
    expect(run).toBeTruthy();
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
    if (!crossAgent) await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, f.issueId));
    const reservation = await reserveRunBudget(db, f.companyId, run!.id, null);
    let mutated = false;
    const observed = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return async (...args: Parameters<typeof db.transaction>) => {
        const result = await Reflect.apply(target.transaction, target, args);
        if (!mutated && result?.kind === "value" && result.value?.claim) {
          mutated = true;
          if (kind === "tree") await issueTreeControlService(db).createHold(f.companyId, f.issueId,
            { mode: "pause", actor: { actorType: "system", actorId: "fixture" } });
          else if (kind === "dependency") {
            const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "New dependency", status: "todo" }).returning();
            await issueService(db).update(f.issueId, { blockedByIssueIds: [blocker.id] });
          } else if (kind === "authority") await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.companyId, f.companyId));
          else if (kind === "question") await issueThreadInteractionService(db).create({ id: f.issueId, companyId: f.companyId }, {
            kind: "ask_user_questions", addresseeUserId: "board", sourceRunId: f.source.id, continuationPolicy: "wake_assignee",
            payload: { version: 1, questions: [{ id: "permission", prompt: "Continue?", selectionMode: "single", required: true,
              options: [{ id: "yes", label: "Continue" }] }] },
          }, { userId: "board" });
          else if (kind === "project") {
            vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
            const project = await projectService(db).create(f.companyId, { name: "Restricted", visibility: "private" });
            await issueService(db).update(f.issueId, { projectId: project.id });
          } else if (kind === "agent chain") {
            await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.source.agentId));
            await db.update(agents).set({ reportsTo: f.source.agentId }).where(eq(agents.id, f.agentId));
          } else if (kind === "recovery") await db.insert(issueRecoveryActions).values({ companyId: f.companyId,
            sourceIssueId: f.issueId, kind: "active_run_watchdog", status: "resolved", outcome: "blocked", ownerType: "board",
            returnOwnerAgentId: f.agentId, cause: "legacy_execution_requires_reconciliation", fingerprint: f.source.id,
            nextAction: "Inspect before continuing", evidence: { runId: f.source.id,
              automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
        }
        return result;
      };
    } });
    const invoke = vi.fn(async () => null);
    const result = await createRunDispatch(observed).dispatchResolvedInteractionIfCurrent({ companyId: f.companyId, runId: run!.id,
      expectedStatus: "running", reservationId: reservation.id, enforceContinuationOwnership: false, dispatch: invoke });
    expect(mutated).toBe(true);
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task.executionState).toEqual(f.issue.executionState);
    if (kind === "none") {
      expect(result).toMatchObject({ dispatched: true });
      expect(invoke).toHaveBeenCalledOnce();
      return;
    }
    expect(result).toMatchObject({ dispatched: false });
    expect(invoke).not.toHaveBeenCalled();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0].status).toBe("cancelled");
  });

});
