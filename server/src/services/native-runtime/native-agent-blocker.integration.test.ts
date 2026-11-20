import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issueRelations, issues,
  nativeRunFinalizations, statusDecisions } from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PrpStructuredRunResult, PrpTerminalState } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()), executeNativeSession: provider.execute,
}));
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { NATIVE_ENVIRONMENT_BLOCKER_CODE, NATIVE_ENVIRONMENT_BLOCKER_HINT, NATIVE_ENVIRONMENT_BLOCKER_MESSAGE } from "./native-environment-blocker.js";
import { NATIVE_AGENT_BLOCKER_CONTINUATION_CODE, NATIVE_AGENT_BLOCKER_HANDOFF_CODE, NATIVE_AGENT_BLOCKER_HINT } from "./native-agent-blocker.js";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";
import { requestTaskRetry } from "../task-retry.js";
import { heartbeatService } from "../heartbeat.js";
import { attentionService } from "../attention.js";
import * as statusCommitter from "./status-decision-committer.js";
import * as evidenceClassifier from "./evidence-classifier.js";

type Blocker = NonNullable<PrpStructuredRunResult["blocker"]>;

const toolOutputBlocker: Blocker = {
  owner: { kind: "system", name: "execution environment" }, scope: "task_wide", reasonCode: "tool_output_failure",
  unblockAction: "Resolve the persistent tool-output failure ('cryptic' returned for every tool call) and/or provide the current contents of the ledger file.",
};
const selfBlocker: Blocker = {
  owner: { kind: "agent", name: "ledger worker" }, scope: "task_wide", reasonCode: "work_incomplete",
  unblockAction: "Re-read the ledger file and save the ledger document.",
};

describe("native run that reports a task-wide blocker it owns", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), boardUserId = "ledger-board-user";
  const namedUserId = "named-dependency-reviewer";
  const foreignCompanyId = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-agent-blocker-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Agent blocker regression", issuePrefix: "AGB" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Ledger worker", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "opencode", model: "test-model" } });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: boardUserId, status: "active", membershipRole: "member" });
    await db.insert(authUsers).values({ id: namedUserId, name: "Dependency Reviewer", email: "reviewer@example.test",
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: namedUserId, status: "active", membershipRole: "member" });
    await db.insert(companies).values({ id: foreignCompanyId, name: "Other company", issuePrefix: "OTHER" });
    for (const [id, name, membershipCompany, status] of [
      ["foreign-reviewer", "Foreign Reviewer", foreignCompanyId, "active"],
      ["inactive-reviewer", "Inactive Reviewer", companyId, "inactive"],
      ["ambiguous-reviewer-one", "Shared Reviewer", companyId, "active"],
      ["ambiguous-reviewer-two", "Shared Reviewer", companyId, "active"],
    ]) {
      await db.insert(authUsers).values({ id, name, email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId: membershipCompany, principalType: "user", principalId: id, status, membershipRole: "member" });
    }
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function createTask() {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Ledger task", status: "in_progress", workMode: "standard",
      assigneeAgentId: agentId, createdByUserId: boardUserId, responsibleUserId: boardUserId });
    return issueId;
  }

  async function runTurn(issueId: string, report: { blocker: Blocker } | { done: true }, runId: string = randomUUID(),
    beforeFinalize?: () => Promise<unknown>, expectedPhase: "committed" | "terminal_failure" = "committed") {
    const [existing] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    if (!existing) await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: boardUserId, contextSnapshot: { issueId } });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [run] = await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: issueId, startedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId)).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const contractInput = buildNativeCompletionContract(issue, { revision: contract.revision });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1", binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "codex", model: "test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Continue the task using its history.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: contractInput },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    const disposition = "blocker" in report ? "blocked" as const : "done" as const;
    const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: disposition };
    const result: PrpStructuredRunResult = "blocker" in report
      ? { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "blocked",
        summary: "All rounds ran, but every tool call returned 'cryptic', so the ledger could not be read.",
        completionClaim: { contractRevision: contractInput.revision, objectiveSatisfied: false,
          criteria: contractInput.criteria.map(criterion => ({ criterionId: criterion.id, status: "not_satisfied" as const, evidenceRefs: [] })),
          remainingWork: [{ description: "Save the ledger document", blocksCompletion: true }] },
        evidence: [], verification: [], attentionRequests: [], blocker: report.blocker }
      : { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "done", summary: "Saved the ledger and posted the comment.",
        completionClaim: { contractRevision: contractInput.revision, objectiveSatisfied: true,
          criteria: contractInput.criteria.map(criterion => ({ criterionId: criterion.id, status: "satisfied" as const, evidenceRefs: [] })),
          remainingWork: [] },
        evidence: [], verification: [], attentionRequests: [] };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun({ identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock", sourceInstanceId: native.runnerInstanceId });
      await options.controlPlane.completeRun({ result, terminal, turnId: native.turnId });
      return { result, terminal, turnId: native.turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "fixture-session", driverKind: "codex_app_server", driverVersion: "fixture", nativeEventCount: 0, highestContiguousSourceSeq: 0, usage: null };
    });
    const unexpected = async () => { throw new Error("Unexpected provider call"); };
    await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: { descriptor: unexpected, openSession: unexpected } });
    await beforeFinalize?.();
    for (let replay = 0; replay < (expectedPhase === "committed" ? 2 : 1); replay++) {
      const finalized = await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      expect(finalized?.phase).toBe(expectedPhase);
    }
    if (expectedPhase === "terminal_failure") await expect(finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" }))
      .rejects.toThrow("native_finalization_terminal_failure");
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
    const retries = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId)));
    const [settled] = await db.select().from(issues).where(eq(issues.id, issueId));
    return { runId, decision: decision!, retries, issue: settled! };
  }

  const ownerWakes = async (issueId: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
    .filter(wake => wake.payload?.issueId === issueId && wake.requestedByActorId === "native-status-committer");

  it.each(["task_wide", "current_track"] as const)("routes a %s human blocker to the named company member through finalization and replay", async scope => {
    const issueId = await createTask();
    const blocked = await runTurn(issueId, { blocker: { ...selfBlocker, scope,
      owner: { kind: "user", name: "Dependency Reviewer" }, unblockAction: "Decide whether to defer this dependency upgrade." } });
    expect(blocked.issue).toMatchObject({ status: "blocked", unblockDescriptor: {
      owner: { userId: namedUserId }, action: "Decide whether to defer this dependency upgrade." } });
    expect(blocked.retries).toEqual([]);
    expect(await ownerWakes(issueId)).toEqual([]);
    const mine = await attentionService(db).list(companyId, { userId: namedUserId, view: "mine" });
    expect(mine.items).toEqual(expect.arrayContaining([expect.objectContaining({
      sourceKind: "blocker_attention", subject: expect.objectContaining({ id: issueId }),
      audience: expect.objectContaining({ kind: "user", userId: namedUserId }),
    })]));
    const others = await attentionService(db).list(companyId, { userId: boardUserId, view: "mine" });
    expect(others.items.some(item => item.dedupKey.startsWith("blocked-owner:") && item.subject.id === issueId)).toBe(false);
  }, 120_000);

  it("preserves a typed human unblock owner saved by an API call during the turn", async () => {
    const issueId = await createTask();
    const blocked = await runTurn(issueId, { blocker: { ...selfBlocker,
      owner: { kind: "user", name: "the decision owner" } } }, randomUUID(), async () => {
      await db.update(issues).set({ status: "blocked", unblockDescriptor: {
        owner: { userId: namedUserId }, action: selfBlocker.unblockAction } }).where(eq(issues.id, issueId));
    });
    expect(blocked.issue.unblockDescriptor?.owner).toEqual({ userId: namedUserId });
    expect(await ownerWakes(issueId)).toEqual([]);
  }, 120_000);

  it("rebuilds a board assessment when a human owner is bound before the authoritative issue read", async () => {
    const issueId = await createTask();
    const classify = evidenceClassifier.classifyNativeEvidence;
    let bound = false;
    const spy = vi.spyOn(evidenceClassifier, "classifyNativeEvidence").mockImplementation(async input => {
      const assessment = await classify(input);
      if (!bound && input.issueId === issueId) {
        bound = true;
        await db.update(issues).set({ status: "blocked", statusVersion: 1, unblockDescriptor: {
          owner: { userId: namedUserId }, action: selfBlocker.unblockAction } }).where(eq(issues.id, issueId));
      }
      return assessment;
    });
    try {
      const blocked = await runTurn(issueId, { blocker: { ...selfBlocker, owner: { kind: "user", name: "the decision owner" } } });
      expect(bound).toBe(true);
      expect(blocked.issue.unblockDescriptor?.owner).toEqual({ userId: namedUserId });
      expect(await ownerWakes(issueId)).toEqual([]);
    } finally { spy.mockRestore(); }
  }, 120_000);

  it("rechecks a board fallback when its human owner changes without changing the status version", async () => {
    const issueId = await createTask();
    await db.update(issues).set({ status: "blocked", unblockDescriptor: {
      owner: "board", action: selfBlocker.unblockAction } }).where(eq(issues.id, issueId));
    const commit = statusCommitter.commitNativeStatusDecision;
    let rebound = false;
    const spy = vi.spyOn(statusCommitter, "commitNativeStatusDecision").mockImplementation(async input => {
      if (!rebound && input.issueId === issueId && input.decision.unblockDescriptor?.owner === "board") {
        rebound = true;
        await db.update(issues).set({ unblockDescriptor: {
          owner: { userId: namedUserId }, action: selfBlocker.unblockAction } }).where(eq(issues.id, issueId));
      }
      return commit(input);
    });
    try {
      const blocked = await runTurn(issueId, { blocker: { ...selfBlocker, owner: { kind: "user", name: "the decision owner" } } });
      expect(rebound).toBe(true);
      expect(blocked.issue.unblockDescriptor?.owner).toEqual({ userId: namedUserId });
      expect(await ownerWakes(issueId)).toEqual([]);
    } finally { spy.mockRestore(); }
  }, 120_000);

  it("keeps an unknown human blocker with the board instead of assigning the task creator", async () => {
    const blocked = await runTurn(await createTask(), { blocker: { ...selfBlocker,
      owner: { kind: "user", name: "Unknown Reviewer" } } });
    expect(blocked.issue.unblockDescriptor?.owner).toBe("board");
    expect(blocked.retries).toEqual([]);
  }, 120_000);

  it.each([false, true])("refuses human blocker routing when the agent cannot assign tasks to humans (dependency: %s)", async dependency => {
    const issueId = await createTask();
    if (dependency) await db.insert(issueRelations).values({ companyId, issueId: await createTask(), relatedIssueId: issueId, type: "blocks" });
    await db.update(agents).set({ permissions: { interactions: { canAssignTasksToHumans: false } } }).where(eq(agents.id, agentId));
    try {
      const blocked = await runTurn(issueId, { blocker: { ...selfBlocker,
        owner: { kind: "user", name: "Dependency Reviewer" } } }, undefined, undefined, "terminal_failure");
      expect(blocked.issue.unblockDescriptor).toBeNull();
      expect(blocked.decision).toBeUndefined();
      const [finalized] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, blocked.runId));
      expect(finalized).toMatchObject({ phase: "terminal_failure", failureCode: "agent_interaction_denied", nextAttemptAt: null });
      const feed = await attentionService(db).list(companyId, { userId: namedUserId, view: "mine" });
      expect(feed.items.some(item => item.dedupKey.startsWith("blocked-owner:") && item.subject.id === issueId)).toBe(false);
    } finally { await db.update(agents).set({ permissions: {} }).where(eq(agents.id, agentId)); }
  }, 120_000);

  it.each(["Foreign Reviewer", "Inactive Reviewer", "Shared Reviewer"])("does not route a human blocker through an unsafe name: %s", async name => {
    const blocked = await runTurn(await createTask(), { blocker: { ...selfBlocker, owner: { kind: "user", name } } });
    expect(blocked.issue.unblockDescriptor?.owner).toBe("board");
  }, 120_000);

  it("uses an explicit opaque member ID and does not guess a replacement for an invalid ID", async () => {
    for (const userId of [namedUserId, "foreign-reviewer", "inactive-reviewer", "", 42]) {
      const blocked = await runTurn(await createTask(), { blocker: { ...selfBlocker,
        owner: { kind: "user", name: "Dependency Reviewer", ...{ userId } } } });
      expect(blocked.issue.unblockDescriptor?.owner).toEqual(userId === namedUserId ? { userId: namedUserId } : "board");
    }
  }, 120_000);

  it("reclassifies a human owner whose membership is revoked between assessment and commit", async () => {
    const commit = statusCommitter.commitNativeStatusDecision;
    let revoked = false;
    const spy = vi.spyOn(statusCommitter, "commitNativeStatusDecision").mockImplementation(async input => {
      if (!revoked && typeof input.decision.unblockDescriptor?.owner === "object"
          && "userId" in input.decision.unblockDescriptor.owner) {
        revoked = true;
        await db.update(companyMemberships).set({ status: "inactive" }).where(and(
          eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, namedUserId)));
      }
      return commit(input);
    });
    try {
      const blocked = await runTurn(await createTask(), { blocker: { ...selfBlocker,
        owner: { kind: "user", name: "Dependency Reviewer" } } });
      expect(revoked).toBe(true);
      expect(blocked.issue.unblockDescriptor?.owner).toBe("board");
    } finally {
      spy.mockRestore();
      await db.update(companyMemberships).set({ status: "active" }).where(and(
        eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, namedUserId)));
    }
  }, 120_000);

  it("continues a tool-output blocker in a fresh session, and the continuation finishes the task", async () => {
    const issueId = await createTask();
    const first = await runTurn(issueId, { blocker: toolOutputBlocker });
    expect(first.decision.reasonCode).toBe(NATIVE_ENVIRONMENT_BLOCKER_CODE);
    expect(first.issue).toMatchObject({ status: "in_progress", unblockDescriptor: null });
    expect(first.retries).toHaveLength(1);
    expect(first.retries[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: NATIVE_ENVIRONMENT_BLOCKER_CODE,
      error: NATIVE_ENVIRONMENT_BLOCKER_MESSAGE,
      contextSnapshot: { forceFreshSession: true, livenessContinuationInstruction: NATIVE_ENVIRONMENT_BLOCKER_HINT } });
    expect(NATIVE_ENVIRONMENT_BLOCKER_MESSAGE).not.toContain("unavailable");
    expect(NATIVE_ENVIRONMENT_BLOCKER_HINT).toContain("Check whether that blocker still applies");
    expect(await ownerWakes(issueId)).toEqual([]);
    const second = await runTurn(issueId, { done: true }, first.retries[0]!.id);
    expect(second.issue.status).toBe("done");
  }, 120_000);

  it("continues a blocker the agent owns once, then hands a repeated one to a person instead of retrying again", async () => {
    const issueId = await createTask();
    const first = await runTurn(issueId, { blocker: selfBlocker });
    expect(first.decision.reasonCode).toBe(NATIVE_AGENT_BLOCKER_CONTINUATION_CODE);
    expect(first.issue).toMatchObject({ status: "in_progress", unblockDescriptor: null });
    expect(first.retries).toHaveLength(1);
    expect(first.retries[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: NATIVE_AGENT_BLOCKER_CONTINUATION_CODE,
      scheduledRetryAttempt: 1, contextSnapshot: { forceFreshSession: true, livenessContinuationInstruction: NATIVE_AGENT_BLOCKER_HINT } });
    expect(await taskInterruptionPresentation(db, first.issue)).toMatchObject({ canRetry: false });
    const second = await runTurn(issueId, { blocker: selfBlocker }, first.retries[0]!.id);
    expect(second.decision.reasonCode).toBe(NATIVE_AGENT_BLOCKER_HANDOFF_CODE);
    expect(second.retries).toHaveLength(0);
    expect(second.issue).toMatchObject({ status: "blocked", unblockDescriptor: { owner: "board", action: selfBlocker.unblockAction } });
    expect(await ownerWakes(issueId)).toEqual([]);
  }, 120_000);

  it("hands a system blocker that needs a credential to a person without automatic retries", async () => {
    const issueId = await createTask();
    const blocked = await runTurn(issueId, { blocker: { ...toolOutputBlocker, reasonCode: "credential_missing",
      unblockAction: "Connect the deploy account." } });
    expect(blocked.decision.reasonCode).toBe(NATIVE_AGENT_BLOCKER_HANDOFF_CODE);
    expect(blocked.retries).toHaveLength(0);
    expect(blocked.issue).toMatchObject({ status: "blocked", unblockDescriptor: { owner: "board", action: "Connect the deploy account." } });
  }, 120_000);

  it("hands a blocker that only a person can resolve to the board with a Retry that starts the task again", async () => {
    const issueId = await createTask();
    const blocked = await runTurn(issueId, { blocker: { ...selfBlocker, owner: { kind: "external", name: "deploy key holder" },
      reasonCode: "credential_missing", unblockAction: "Add the deploy key to the project." } });
    expect(blocked.decision.reasonCode).toBe(NATIVE_AGENT_BLOCKER_HANDOFF_CODE);
    expect(blocked.retries).toHaveLength(0);
    expect(blocked.issue).toMatchObject({ status: "blocked", unblockDescriptor: { owner: "board", action: "Add the deploy key to the project." } });
    expect(await ownerWakes(issueId)).toEqual([]);
    expect(await taskInterruptionPresentation(db, blocked.issue)).toMatchObject({ responsibility: "user", state: "waiting_for_user",
      userAction: "unblock", canRetry: true, observedRunId: blocked.runId });
    const receipt = await requestTaskRetry({ db, companyId, issueId, actorId: boardUserId, actorSource: "session",
      idempotencyKey: randomUUID(), observedRunId: blocked.runId });
    expect(receipt).toMatchObject({ accepted: true, stale: false });
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeTaskRetry(companyId, receipt.requestId!);
    const retried = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .filter(run => run.contextSnapshot?.issueId === issueId && run.contextSnapshot?.taskRetryRequestId === receipt.requestId);
    expect(retried).toHaveLength(1);
    await heartbeat.drainActiveRunExecutions();
  }, 120_000);
});
