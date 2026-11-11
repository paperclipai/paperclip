import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issueRecoveryActions,
  issues, nativeRunFinalizations, statusDecisions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { issueService } from "../issues.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { assertCurrentWakeCommentsRead } from "./current-wake-comments.js";
import { recordNativeHumanSelfHandoff } from "./native-human-self-handoff.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION, supersedeHandedOffDecision, type NativeStatusDecision } from "./status-arbiter.js";

describe("handed-off task decision policy", () => {
  const incomplete: NativeStatusDecision = { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "in_progress",
    toStatus: "in_progress", reasonCode: "completion_evidence_incomplete", unblockDescriptor: null,
    effects: [{ kind: "enqueue_continuation", agentId: "agent-a", summary: "Finish", idempotencyKey: "k", continuationKind: "same_agent" }] };
  const person = { status: "in_review", assigneeAgentId: null, assigneeUserId: "user-1" };

  it("preserves a person's task against the outgoing run's decision", () => {
    expect(supersedeHandedOffDecision(incomplete, person)).toEqual({ ...incomplete, statusAction: "preserve",
      toStatus: "in_review", reasonCode: "completion_owner_superseded", effects: [] });
  });
  it.each([
    ["the agent still owns the task", { ...person, assigneeAgentId: "agent-a", assigneeUserId: null }],
    ["the task is unassigned", { ...person, assigneeUserId: null }],
  ])("leaves the decision alone when %s", (_label, issue) => {
    expect(supersedeHandedOffDecision(incomplete, issue)).toBe(incomplete);
  });
  it("keeps a governed request's interaction, without waking the outgoing agent", () => {
    const interaction = { kind: "create_interaction", gate: { kind: "approval", id: "a" } };
    const gated = { ...incomplete, statusAction: "in_review", toStatus: "in_review", reasonCode: "governed_gate_pending",
      effects: [interaction, { kind: "notify_owner", agentId: "agent-a", reason: "governed_gate_pending" }] } as unknown as NativeStatusDecision;
    expect(supersedeHandedOffDecision(gated, person)).toEqual({ ...gated, effects: [interaction] });
  });
  it("drops a failed turn's retry of the outgoing agent from a preserving decision", () => {
    const failedTurn: NativeStatusDecision = { ...incomplete, statusAction: "preserve", toStatus: "in_review",
      reasonCode: "run_failed_partial_evidence_preserved",
      effects: [{ kind: "release_checkout" }, { kind: "schedule_retry", cause: "x", summary: "Retry", agentId: "agent-a" }] };
    expect(supersedeHandedOffDecision(failedTurn, person)).toEqual({ ...failedTurn, effects: [{ kind: "release_checkout" }] });
  });
  it("drops a finalization error that is not a workspace save failure", () => {
    const monitorLost: NativeStatusDecision = { ...incomplete, statusAction: "preserve", toStatus: "in_review",
      reasonCode: "native_monitor_authority_lost", effects: [{ kind: "record_finalization_error",
        cause: "native_monitor_authority_lost", nextAction: "Reschedule", agentId: "agent-a" }] };
    expect(supersedeHandedOffDecision(monitorLost, person)).toEqual({ ...monitorLost, effects: [] });
  });
  it("keeps the workspace repair of a failed finalization, so saved work is not lost", () => {
    const finalizationFailed: NativeStatusDecision = { ...incomplete, statusAction: "preserve", toStatus: "in_review",
      reasonCode: "finalization_failed_claim_preserved", effects: [{ kind: "record_finalization_error",
        cause: "workspace_finalization_failed", nextAction: "Repair", agentId: "agent-a" }] };
    expect(supersedeHandedOffDecision(finalizationFailed, person)).toBe(finalizationFailed);
  });
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_HUMAN_HANDOFF_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

/**
 * A native run that hands its own task to a person keeps running and finishes
 * its turn. The task stays with that person: no execution blocker, no
 * recovery action, and the outgoing run cannot change the task afterward.
 */
describe.skipIf(!support.supported)("native run hands its own task to a person", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("native-human-handoff-");
    db = createDb(external ?? database!.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function runningNativeTask() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    const runId = randomUUID(), sessionId = randomUUID(), runnerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Handoff fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Nibbler", adapterType: "paperclip_runner" });
    await db.insert(authUsers).values({ id: userId, name: "Reviewer", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Draft the plan", status: "in_progress",
      assigneeAgentId: agentId, createdByUserId: userId, description: "Draft the plan and hand it to me for review." });
    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "low", completionAuthority: "agent_claim_policy",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "test", objective: "Draft the plan",
        criteria: [{ id: "objective", requirement: "Complete the task" }] },
      canonicalSha256: `handoff-${issueId}`, createdByActorType: "system", createdByActorId: "test" }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      status: "running", runtimeMode: "native", invocationSource: "assignment", contextSnapshot: { issueId, source: "issue.assigned" } });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const port = new NativeRunCoordinatorStore(db, { companyId, issueId, runId, agentId, normalizedSessionId: sessionId,
      runnerSourceInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      completionContractRevision: "test", completionContractCriterionIds: ["objective"] });
    return { companyId, agentId, issueId, userId, runId, port };
  }

  type Fixture = Awaited<ReturnType<typeof runningNativeTask>>;

  /** The REST PATCH the agent sends through its run token (route exemption applied). */
  /** What the route does for the run's own hand-off: record it on the run, then save the assignment. */
  async function handOffToPerson(f: Fixture, options: { record?: boolean } = {}) {
    if (options.record !== false) {
      expect(await recordNativeHumanSelfHandoff(db, { companyId: f.companyId, runId: f.runId, agentId: f.agentId,
        issueId: f.issueId, assigneeUserId: f.userId })).toBe(true);
    }
    return issueService(db).update(f.issueId, { assigneeAgentId: null, assigneeUserId: f.userId, status: "in_review",
      actorAgentId: f.agentId, actorRunId: f.runId } as never);
  }

  it("lets the run's terminal fence accept the task it handed to a person, and only that hand-off", async () => {
    const binding = (f: Fixture) => ({ companyId: f.companyId, issueId: f.issueId, runId: f.runId, agentId: f.agentId });
    const recorded = await runningNativeTask();
    await handOffToPerson(recorded);
    await expect(assertCurrentWakeCommentsRead(db, binding(recorded), null)).resolves.toBeUndefined();

    // Without the run's record (for example a board reassignment), the fence still refuses.
    const unrecorded = await runningNativeTask();
    await handOffToPerson(unrecorded, { record: false });
    await expect(assertCurrentWakeCommentsRead(db, binding(unrecorded), null)).rejects.toThrow("native_current_wake_comments_binding_changed");

    // A truncated chat wake: after the hand-off the run must still have read the wake it started with.
    const wake = { bindingDigest: "wake-digest" } as unknown as Parameters<typeof assertCurrentWakeCommentsRead>[2];
    // It passes the binding comparison and reaches the read requirement, which it has not met.
    await expect(assertCurrentWakeCommentsRead(db, binding(recorded), wake)).rejects.toThrow("native_current_wake_comments_unread");

    // A later reassignment to someone else is not the hand-off this run made.
    const other = randomUUID();
    await db.insert(authUsers).values({ id: other, name: "Other", email: `${other}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.update(issues).set({ assigneeUserId: other }).where(eq(issues.id, recorded.issueId));
    await expect(assertCurrentWakeCommentsRead(db, binding(recorded), null)).rejects.toThrow("native_current_wake_comments_binding_changed");
  });

  const results = {
    done: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Plan drafted and handed to the reviewer.",
      completionClaim: { contractRevision: "test", objectiveSatisfied: true,
        criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: ["task:self"] }], remainingWork: [] },
      evidence: [{ ref: "task:self" }], verification: [], attentionRequests: [], artifacts: [] },
    needs_review: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "needs_review", summary: "Waiting for the reviewer.",
      completionClaim: { contractRevision: "test", objectiveSatisfied: false,
        criteria: [{ criterionId: "objective", status: "unknown", evidenceRefs: [] }],
        remainingWork: [{ description: "Reviewer decides", blocksCompletion: true }] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] },
  } as const;

  it.each(["done", "needs_review"] as const)("finishes normally after a %s report and leaves no execution blocker", async disposition => {
    const f = await runningNativeTask();
    await handOffToPerson(f);
    const handed = (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!;
    expect(handed).toMatchObject({ status: "in_review", assigneeAgentId: null, assigneeUserId: f.userId, executionRunId: null });
    // The run that handed off is still running; nothing cancelled it.
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toMatchObject({ status: "running", errorCode: null });

    const result = JSON.parse(JSON.stringify(results[disposition]).replaceAll("task:self", `task:${f.issueId}`));
    await f.port.completeRun({ result, terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded",
      turnTerminalState: "completed", reportedWorkDisposition: disposition }, turnId: `handoff-${disposition}` });
    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: false });
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.id, coordinator!.decisionId!));
    expect(decision).toMatchObject({ toStatus: "in_review", reasonCode: "completion_owner_superseded",
      decisionJson: expect.objectContaining({ statusAction: "preserve", effects: [] }) });

    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({
      status: "in_review", assigneeAgentId: null, assigneeUserId: f.userId,
    });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
  });

  it("does not retry the outgoing agent after a failed turn", async () => {
    const f = await runningNativeTask();
    await handOffToPerson(f);
    const result = JSON.parse(JSON.stringify(results.needs_review));
    await f.port.completeRun({ result, terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "failed",
      turnTerminalState: "failed", reportedWorkDisposition: "needs_review" }, turnId: "handoff-failed" });
    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: false });
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.id, coordinator!.decisionId!));
    expect(coordinator!.phase).toBe("committed");
    expect((decision!.decisionJson as { effects: Array<{ kind: string }> }).effects
      .filter(effect => ["schedule_retry", "enqueue_continuation", "record_recovery", "bind_blocker", "notify_owner"].includes(effect.kind)))
      .toEqual([]);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({
      status: "in_review", assigneeAgentId: null, assigneeUserId: f.userId,
    });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
  });

  it("rejects the outgoing native run's later change to the person's task", async () => {
    const f = await runningNativeTask();
    await handOffToPerson(f);
    await expect(issueService(db).update(f.issueId, { status: "done", actorAgentId: f.agentId, actorRunId: f.runId } as never))
      .rejects.toMatchObject({ details: { code: "issue_handed_off" } });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ status: "in_review", assigneeUserId: f.userId });
  });
});
