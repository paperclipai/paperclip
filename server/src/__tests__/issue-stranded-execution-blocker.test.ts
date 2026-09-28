/**
 * A settled automatic no-replay hold (`evidence.automaticRecovery.replay
 * === "blocked"`) used to park every later wake as `deferred_issue_execution`
 * with no run, so an issue that was plainly re-runnable never ran again and the
 * board had no action to resolve. These cases pin the fix:
 *
 *  T1  settled no-replay hold + `todo` issue + invokable agent owner + a fresh
 *      assignment wake made by a person → a run is created once and the hold is
 *      released (marked, never deleted)
 *  T1b the same wake declared by the agent itself (the wakeup API lets an agent
 *      wake itself) stays parked: an agent cannot retire its own hold
 *  T1c the same wake requested by a plugin for the already-assigned agent stays
 *      parked: a system wake is not a new assignment decision
 *  T1d a user-attributed wake that only *claims* the `assignment` source — the
 *      shape `POST /agents/:id/wakeup` builds from its request body — stays
 *      parked: a declared source is not evidence that the assignment changed
 *  T1e an assignee change committed by the issue update route releases the hold
 *      and creates the run for the new assignee
 *  T1f an update that both reassigns the issue and moves its execution stage
 *      still releases the hold: the stage wake that supersedes the assignment
 *      wake carries the assignment decision
 *  T2  an open (`active`) action still parks the wake
 *  T3  a human owner (`assigneeUserId`) still parks the wake — a person decides
 *  T4  an issue that is not `todo`/`blocked` still parks the wake
 *  T5  GET /issues/:id/recovery-actions surfaces the settled action referenced
 *      by `executionBlocker` (Patch A)
 *  T6  a board resolve *with* the reconciled execution evidence releases the
 *      hold, closes the action with the operator's decision, and resumes the
 *      task; a resolve without that evidence stays a replay no-op
 *  T7  an agent resolve of the same action is still a replay no-op: only the
 *      board decides
 *  T8  a settled hold that is not a plain no-replay hold (an unsafe workspace
 *      archive) is reported as not resolvable, so the board is never offered a
 *      control the release helper would refuse
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping stranded execution-blocker tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue stranded by a settled no-replay hold", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("issue-stranded-blocker-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(companyId: string, agentId?: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = agentId
        ? { type: "agent", agentId, runId: randomUUID(), companyId, source: "session" }
        : {
            type: "board",
            userId: "blocker-owner",
            source: "session",
            companyId,
            companyIds: [companyId],
            memberships: [{ companyId, status: "active", membershipRole: "operator" }],
            isInstanceAdmin: false,
          };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  /** Issue with an execution-blocking recovery action on it. */
  async function seedBlockedIssue(opts: {
    issueStatus?: string;
    recoveryStatus?: "active" | "escalated" | "resolved";
    replay?: "blocked" | null;
    assigneeUserId?: string | null;
    includeAssignee?: boolean;
    unsafeWorkspace?: boolean;
    terminalSourceRun?: boolean;
    executionState?: Record<string, unknown> | null;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Stranded Co",
      issuePrefix: `S${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "blocker-owner",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "blocker-owner",
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Infra",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      // Cap concurrency at 1 and occupy the slot below: admission stays real
      // (a run is created) but no provider is ever launched by these cases.
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `S-${issueId.slice(0, 4)}`,
      title: "Stranded issue",
      status: opts.issueStatus ?? "todo",
      assigneeAgentId: opts.includeAssignee === false ? null : agentId,
      assigneeUserId: opts.assigneeUserId ?? null,
      ...(opts.executionState ? { executionState: opts.executionState } : {}),
    });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "active_run_watchdog",
      ownerType: "board",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${sourceRunId}`,
      status: opts.recoveryStatus ?? "resolved",
      outcome: "blocked",
      nextAction: "Reconcile the stopped run before continuing.",
      evidence: {
        runId: sourceRunId,
        ...(opts.unsafeWorkspace
          ? { workspaceRestoreFailure: "restore_unsafe_archive" }
          : {}),
        ...(opts.replay ? { automaticRecovery: { replay: opts.replay, actionOutcome: "blocked" } } : {}),
      },
    }).returning();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "running",
      processPid: process.pid,
    });
    if (opts.terminalSourceRun) {
      // The run the hold records, already stopped with no live process.
      await db.insert(heartbeatRuns).values({
        id: sourceRunId,
        companyId,
        agentId,
        status: "failed",
        processPid: 999999999,
        contextSnapshot: { issueId },
      });
    }
    return { companyId, issueId, agentId, sourceRunId, actionId: action!.id };
  }

  const wakeIssue = (
    agentId: string,
    issueId: string,
    requestedByActorType: "user" | "agent" | "system" = "user",
    requestedByActorId = requestedByActorType === "user" ? "blocker-owner" : "assignment",
    opts: { reason?: string; recordedAssignmentDecision?: boolean } = {},
  ) =>
    heartbeatService(db).wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: opts.reason ?? "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId },
      requestedByActorType,
      requestedByActorId,
      // The issue update route sets this when it commits an assignee change.
      // A wake that only claims `source: "assignment"` does not.
      recordedAssignmentDecision: opts.recordedAssignmentDecision === true,
    });

  const runsForIssue = async (issueId: string) =>
    db
      .select()
      .from(heartbeatRuns)
      .then((rows) => rows.filter((row) => row.contextSnapshot?.issueId === issueId));

  const executionWaits = async (agentId: string) =>
    db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) =>
        rows.filter(
          (row) => row.payload?.executionWait !== undefined || row.reason === "execution_reconciliation_required",
        ),
      );

  it("T1: releases a settled no-replay hold once and starts a run instead of parking", async () => {
    const seed = await seedBlockedIssue({ issueStatus: "todo", replay: "blocked" });
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();

    // The shape the issue update route emits after it commits an assignee
    // change: a person's fresh assignment decision for this issue.
    const run = await wakeIssue(seed.agentId, seed.issueId, "user", "blocker-owner", {
      recordedAssignmentDecision: true,
    });

    // The wake produced a real run instead of a parked receipt.
    expect(run).toMatchObject({ status: "queued", agentId: seed.agentId });
    const issueRuns = await runsForIssue(seed.issueId);
    expect(issueRuns).toHaveLength(1);
    expect(issueRuns[0]).toMatchObject({ status: "queued", contextSnapshot: { issueId: seed.issueId } });
    expect(await executionWaits(seed.agentId)).toHaveLength(0);

    // The hold is released in place: bookkeeping and the recorded no-replay
    // decision survive, only the release marker is added.
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).toBeNull();
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, seed.actionId));
    expect(action).toMatchObject({ status: "resolved", outcome: "blocked" });
    expect(action!.evidence.automaticRecovery).toMatchObject({ replay: "blocked" });
    expect(action!.evidence.settledNoReplayHoldReleasedAt).toEqual(expect.any(String));
    expect(action!.evidence.settledNoReplayHoldRelease).toMatchObject({
      cause: "legacy_execution_requires_reconciliation",
      sourceRunId: seed.sourceRunId,
      agentId: seed.agentId,
      actorType: "user",
    });

    // A second wake on the now-released issue neither re-releases nor re-parks.
    const releasedAt = action!.evidence.settledNoReplayHoldReleasedAt;
    await wakeIssue(seed.agentId, seed.issueId);
    const [after] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, seed.actionId));
    expect(after!.evidence.settledNoReplayHoldReleasedAt).toBe(releasedAt);
    expect(await executionWaits(seed.agentId)).toHaveLength(0);
  });

  it("T1b: an agent's own assignment wake cannot retire the hold", async () => {
    const seed = await seedBlockedIssue({ issueStatus: "todo", replay: "blocked" });

    await wakeIssue(seed.agentId, seed.issueId, "agent");

    const waits = await executionWaits(seed.agentId);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ status: "skipped", reason: "execution_reconciliation_required" });
    expect(await runsForIssue(seed.issueId)).toHaveLength(0);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, seed.actionId));
    expect(action!.evidence.settledNoReplayHoldReleasedAt).toBeUndefined();
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
  });

  it("T1c: a plugin's assignment wake for the already-assigned agent cannot retire the hold", async () => {
    const seed = await seedBlockedIssue({ issueStatus: "todo", replay: "blocked" });

    // The shape measured in server/src/services/plugin-host-services.ts: a plugin
    // requests an assignment wake for the agent that is already assigned.
    await wakeIssue(seed.agentId, seed.issueId, "system", "plugin-fixture", {
      reason: "plugin_issue_wakeup_requested",
    });

    const waits = await executionWaits(seed.agentId);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ status: "skipped", reason: "execution_reconciliation_required" });
    expect(await runsForIssue(seed.issueId)).toHaveLength(0);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, seed.actionId));
    expect(action!.evidence.settledNoReplayHoldReleasedAt).toBeUndefined();
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
  });

  it("T1d: a wake that only claims an assignment source cannot retire the hold", async () => {
    const seed = await seedBlockedIssue({ issueStatus: "todo", replay: "blocked" });

    // The shape `POST /agents/:id/wakeup` produces: the caller declares
    // `source: "assignment"` (and even the `issue_assigned` reason) in the
    // request body, but the control plane never recorded an assignment decision
    // for this issue — its assignment did not change.
    await wakeIssue(seed.agentId, seed.issueId, "user", "blocker-owner", {
      reason: "issue_assigned",
    });

    const waits = await executionWaits(seed.agentId);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ status: "skipped", reason: "execution_reconciliation_required" });
    expect(await runsForIssue(seed.issueId)).toHaveLength(0);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, seed.actionId));
    expect(action!.evidence.settledNoReplayHoldReleasedAt).toBeUndefined();
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
  });

  it("T1e: an assignee change committed by the issue route releases the hold", async () => {
    const seed = await seedBlockedIssue({ issueStatus: "todo", replay: "blocked" });
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId: seed.companyId,
      name: "Replacement",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      permissions: {},
    });

    // A person assigning the issue to another agent is the new execution
    // decision the hold waits for; the route's own wake must carry it.
    const response = await request(app(seed.companyId))
      .patch(`/api/issues/${seed.issueId}`)
      .send({ assigneeAgentId: replacementAgentId });
    expect(response.status).toBe(200);

    await vi.waitFor(async () => {
      expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).toBeNull();
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seed.issueId));
    expect(issue!.assigneeAgentId).toBe(replacementAgentId);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, seed.actionId));
    expect(action!.evidence.settledNoReplayHoldRelease).toMatchObject({
      agentId: replacementAgentId,
      actorType: "user",
    });
    const replacementRuns = (await runsForIssue(seed.issueId))
      .filter(run => run.agentId === replacementAgentId);
    expect(replacementRuns).toHaveLength(1);
  });

  it("T1f: a reassignment that arrives with a stage change still releases the hold", async () => {
    const stageParticipantId = randomUUID();
    const seed = await seedBlockedIssue({
      issueStatus: "todo",
      replay: "blocked",
      executionState: {
        status: "pending",
        currentStageId: "review-1",
        currentStageIndex: 1,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: stageParticipantId },
        returnAssignee: { type: "agent", agentId: null },
        completedStageIds: ["review-0"],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    const replacementAgentId = randomUUID();
    for (const agentId of [stageParticipantId, replacementAgentId]) {
      await db.insert(agents).values({
        id: agentId,
        companyId: seed.companyId,
        name: agentId === replacementAgentId ? "Replacement" : "Stage participant",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
        permissions: {},
      });
    }

    // One board update that both reassigns the issue and moves its execution
    // stage: the stage wake supersedes the assignment wake for the same agent,
    // so it has to carry the assignment decision itself.
    const response = await request(app(seed.companyId))
      .patch(`/api/issues/${seed.issueId}`)
      .send({
        assigneeAgentId: replacementAgentId,
        executionState: {
          status: "pending",
          currentStageId: "review-1",
          currentStageIndex: 1,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: replacementAgentId },
          returnAssignee: { type: "agent", agentId: null },
          completedStageIds: ["review-0"],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      });
    expect(response.status).toBe(200);

    await vi.waitFor(async () => {
      expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).toBeNull();
    });
    const replacementRuns = (await runsForIssue(seed.issueId))
      .filter(run => run.agentId === replacementAgentId);
    expect(replacementRuns).toHaveLength(1);
  });

  it("T2: an open recovery action still parks the wake", async () => {
    const seed = await seedBlockedIssue({ issueStatus: "todo", recoveryStatus: "active", replay: "blocked" });
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();

    await wakeIssue(seed.agentId, seed.issueId);

    const waits = await executionWaits(seed.agentId);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      status: "skipped",
      reason: "execution_reconciliation_required",
      payload: { executionWait: { recoveryActionId: seed.actionId } },
    });
    expect(await runsForIssue(seed.issueId)).toHaveLength(0);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, seed.actionId));
    expect(action!.status).toBe("active");
    expect(action!.evidence.settledNoReplayHoldReleasedAt).toBeUndefined();
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
  });

  it("T3: a human owner still parks the wake — a person decides", async () => {
    const seed = await seedBlockedIssue({ issueStatus: "blocked", replay: "blocked", assigneeUserId: randomUUID() });

    await wakeIssue(seed.agentId, seed.issueId);

    const waits = await executionWaits(seed.agentId);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ status: "skipped", reason: "execution_reconciliation_required" });
    expect(await runsForIssue(seed.issueId)).toHaveLength(0);
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
  });

  it("T4: an issue outside todo/blocked still parks the wake", async () => {
    const seed = await seedBlockedIssue({ issueStatus: "in_progress", replay: "blocked" });

    await wakeIssue(seed.agentId, seed.issueId);

    expect(await runsForIssue(seed.issueId)).toHaveLength(0);
    expect(await executionWaits(seed.agentId)).toHaveLength(1);
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
  });

  it("T5: recovery-actions surfaces the settled action referenced by executionBlocker", async () => {
    const seed = await seedBlockedIssue({ issueStatus: "blocked", replay: "blocked" });

    const response = await request(app(seed.companyId)).get(`/api/issues/${seed.issueId}/recovery-actions`);

    expect(response.status).toBe(200);
    expect(response.body.active).toBeNull();
    expect(response.body.actions.map((action: { id: string }) => action.id)).toEqual([seed.actionId]);
    expect(response.body.referencedByExecutionBlocker).toBe(seed.actionId);
    // A plain no-replay hold is exactly what the release helper retires.
    expect(response.body.referencedByExecutionBlockerResolvable).toBe(true);
    // Surfacing is read-only: the blocker is untouched by the read.
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
  });

  const resolveSettledAction = (
    companyId: string,
    issueId: string,
    actionId: string,
    opts: { agentId?: string; executionReconciliation?: Record<string, unknown> } = {},
  ) =>
    request(app(companyId, opts.agentId))
      .post(`/api/issues/${issueId}/recovery-actions/resolve`)
      .send({
        actionId,
        outcome: "restored",
        sourceIssueStatus: "todo",
        ...(opts.executionReconciliation ? { executionReconciliation: opts.executionReconciliation } : {}),
      });

  const readAction = async (actionId: string) =>
    db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId))
      .then((rows) => rows[0]!);

  it("T6: a board resolve with the reconciled evidence releases the hold and resumes the task", async () => {
    const seed = await seedBlockedIssue({
      issueStatus: "blocked",
      replay: "blocked",
      terminalSourceRun: true,
    });
    const executionReconciliation = {
      runId: seed.sourceRunId,
      providerStopped: true,
      actionOutcome: "not_performed",
      outcomeEvidence: "Provider receipts confirm the stopped run performed no action.",
    };

    // A resolve without new evidence is a replay of the decision the hold
    // already refused: nothing changes and no run starts.
    const replay = await resolveSettledAction(seed.companyId, seed.issueId, seed.actionId);
    expect(replay.status).toBe(200);
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
    expect((await runsForIssue(seed.issueId)).filter(run => run.id !== seed.sourceRunId)).toHaveLength(0);

    // With the reconciled evidence, the operator's decision retires the hold and
    // the task resumes.
    const response = await resolveSettledAction(seed.companyId, seed.issueId, seed.actionId, {
      executionReconciliation,
    });

    expect(response.status).toBe(200);
    // The task is back in `todo` and its owner decides what runs next.
    expect(response.body.issue.status).toBe("todo");
    const action = await readAction(seed.actionId);
    expect(action).toMatchObject({ status: "resolved", outcome: "restored" });
    // The reconciled evidence replaces the no-replay disposition on the record
    // itself, so the release is auditable instead of a deleted decision.
    expect(action.evidence).toMatchObject({
      executionReconciliation: { runId: seed.sourceRunId },
    });
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).toBeNull();
    // The projection stops pointing at the resolved record.
    const projection = await request(app(seed.companyId)).get(
      `/api/issues/${seed.issueId}/recovery-actions`,
    );
    expect(projection.body.referencedByExecutionBlocker).toBeNull();
    expect(projection.body.referencedByExecutionBlockerResolvable).toBe(false);
  });

  it("T7: an agent resolve of the settled action releases nothing", async () => {
    const seed = await seedBlockedIssue({ issueStatus: "blocked", replay: "blocked" });

    const response = await resolveSettledAction(seed.companyId, seed.issueId, seed.actionId, {
      agentId: seed.agentId,
      executionReconciliation: {
        runId: seed.sourceRunId,
        providerStopped: true,
        actionOutcome: "not_performed",
        outcomeEvidence: "Provider receipts confirm the stopped run performed no action.",
      },
    });

    // An agent write is refused before it can reach the settled action; whichever
    // gate refuses it, the hold must survive and no run may start.
    expect(response.status).toBe(403);
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
    const action = await readAction(seed.actionId);
    expect(action.status).toBe("resolved");
    expect(action.evidence.settledNoReplayHoldReleasedAt).toBeUndefined();
    expect((await runsForIssue(seed.issueId)).length).toBe(0);
  });

  it("T8: an unsafe workspace archive is never offered as resolvable", async () => {
    const seed = await seedBlockedIssue({
      issueStatus: "blocked",
      replay: "blocked",
      unsafeWorkspace: true,
      terminalSourceRun: true,
    });

    const projection = await request(app(seed.companyId)).get(
      `/api/issues/${seed.issueId}/recovery-actions`,
    );
    expect(projection.body.referencedByExecutionBlocker).toBe(seed.actionId);
    // The release helper refuses this hold, so the board must not offer it.
    expect(projection.body.referencedByExecutionBlockerResolvable).toBe(false);

    const response = await resolveSettledAction(seed.companyId, seed.issueId, seed.actionId);

    expect(response.status).toBe(200);
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
    const action = await readAction(seed.actionId);
    expect(action.evidence.settledNoReplayHoldReleasedAt).toBeUndefined();
    expect((await runsForIssue(seed.issueId)).filter(run => run.id !== seed.sourceRunId)).toHaveLength(0);
  });
});
