import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issues, nativeRunFinalizations, statusDecisions } from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PrpEvent, PrpTerminalState } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { readNativeContinuationSource } from "./native-continuation-delivery.js";
import { NATIVE_RUN_FAILED_CONTINUATION_EXHAUSTED_ACTION } from "./status-arbiter.js";
import { heartbeatService } from "../heartbeat.js";
import { requestTaskRetry } from "../task-retry.js";

type FailureCode = "opencode_server_exited" | "opencode_empty_response";

// Seen on a staging deployment: an OpenCode turn
// failed (its server was killed, or it ended without an answer). The accepted
// result kept the task in_progress and the arbiter scheduled a retry, but the
// dispatcher refused that wake (`chat_control_recovery_proof_unresolved`), so
// the task sat for hours with no owner and no queued work.
describe("native failed-turn continuation", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-failed-turn-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Native failed turn", issuePrefix: "NFT" });
    await db.insert(agents).values({ id: agentId, companyId, name: "OpenCode agent", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: "openrouter/test-model" } });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "member" });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function failTurn(issueId: string, code: FailureCode, context: Record<string, unknown> = {}, dispatchedFrom?: string) {
    const runId = randomUUID();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    // A dispatched continuation carries the dispatcher's own receipt for its intent.
    const [receipt] = dispatchedFrom ? await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation",
      triggerDetail: "system", reason: "issue_status_changed", status: "claimed", requestedByActorType: "system",
      requestedByActorId: `native-status-wake-dispatch:${dispatchedFrom}`, payload: { issueId } }).returning() : [];
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, responsibleUserId: "board-user", invocationSource: "automation", triggerDetail: "system", wakeupRequestId: receipt?.id ?? null, contextSnapshot: { issueId, ...context } }).returning();
    if (receipt) await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, receipt.id));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const completionInput = buildNativeCompletionContract(issue, { revision: contract.revision });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "opencode", model: "openrouter/test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Review the PR.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "opencode_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: completionInput },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId,
      turnId: native.turnId, sourceInstanceId: native.runnerInstanceId, sourceEventId: "turn-terminal", sourceSeq: 1,
      sourceKind: "runner", eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
      payload: code === "opencode_server_exited"
        ? { status: "failed", error: { code, message: "OpenCode stopped while the turn was running.", opencodeFailure: { kind: "server_exited", signal: "SIGKILL", connectionError: "ECONNREFUSED" } } }
        : { status: "failed", error: { code, message: "OpenCode ended without a final answer.", retryable: false } },
    };
    const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "needs_review" };
    const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "needs_review" as const,
      completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: completionInput.revision } };
    const openInput = { identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock" as const, sourceInstanceId: native.runnerInstanceId };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun(openInput);
      await options.controlPlane.appendEvent(event);
      await options.controlPlane.completeRun({ result, terminal, turnId: native.turnId });
      return { result, terminal, turnId: native.turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "fixture-provider-session", driverKind: execution.session.driverKind, driverVersion: "fixture", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: {
      descriptor: async () => { throw new Error("Unexpected provider call"); },
      openSession: async () => { throw new Error("Unexpected provider call"); },
    } });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [failedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(failedRun.status).toBe("failed");
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
    return { runId, decision };
  }

  const issueWakes = async (issueId: string) => (await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.companyId, companyId))).filter(wake => wake.payload?.issueId === issueId);

  it.each(["opencode_server_exited", "opencode_empty_response"] as const)("continues the task once after %s, then hands it to Retry", async (code) => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Review a PR", status: "in_progress", workMode: "standard", assigneeAgentId: agentId, createdByUserId: "board-user", responsibleUserId: "board-user" });
    const first = await failTurn(issueId, code);
    expect(first.decision.reasonCode).toBe("run_failed_partial_evidence_preserved");

    const heartbeat = heartbeatService(db);
    expect(await heartbeat.dispatchPendingNativeStatusWakeups({ companyId })).toMatchObject({ dispatched: 1 });
    const wakes = await issueWakes(issueId);
    expect(wakes.filter(wake => wake.status === "skipped")).toEqual([]);
    const intent = wakes.find(wake => wake.requestedByActorId === "native-status-committer")!;
    expect(intent.payload).toMatchObject({ retryCause: "native_run_failed" });
    const [continuation] = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .filter(r => r.id !== first.runId && r.contextSnapshot?.issueId === issueId);
    expect(continuation?.contextSnapshot?.nativeStatusWakeIntentId).toBe(intent.id);
    expect(["queued", "running"]).toContain(continuation.status);
    // The continuation keeps the failed run as its conversation source.
    expect(await readNativeContinuationSource(db, { companyId, issueId, runId: continuation.id })).toBe(first.runId);
    // The fixture cannot launch a real runner; let the dispatched run settle.
    await heartbeat.drainActiveRunExecutions();
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task.assigneeAgentId).toBe(agentId);

    // The continuation's own turn fails the same way: no second automatic
    // wake, and a board blocker whose Retry restarts the work.
    await db.update(issues).set({ status: "in_progress", executionRunId: null, checkoutRunId: null }).where(eq(issues.id, issueId));
    const before = (await issueWakes(issueId)).length;
    const second = await failTurn(issueId, code, { nativeStatusWakeIntentId: intent.id }, intent.id);
    expect(second.decision).toMatchObject({ reasonCode: "native_run_failed_continuation_exhausted", toStatus: "blocked" });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect((await issueWakes(issueId)).length).toBe(before + 1); // only the fixture dispatch receipt
    const [blocked] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(blocked).toMatchObject({ status: "blocked", unblockDescriptor: { owner: "board", action: NATIVE_RUN_FAILED_CONTINUATION_EXHAUSTED_ACTION } });
    // The visible Retry is accepted and starts a new run of the task.
    const receipt = await requestTaskRetry({ db, companyId, issueId, actorId: "board-user", actorSource: "session",
      idempotencyKey: randomUUID(), observedRunId: second.runId });
    expect(receipt).toMatchObject({ accepted: true, stale: false });
    await heartbeat.resumeTaskRetry(companyId, receipt.requestId!);
    const retried = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .filter(r => r.contextSnapshot?.issueId === issueId && r.contextSnapshot?.taskRetryRequestId === receipt.requestId);
    expect(retried).toHaveLength(1);
    await heartbeat.drainActiveRunExecutions();
  }, 120_000);

  it("does not treat a copied retry intent id as a used continuation", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Review another PR", status: "in_progress", workMode: "standard", assigneeAgentId: agentId, createdByUserId: "board-user", responsibleUserId: "board-user" });
    const first = await failTurn(issueId, "opencode_empty_response");
    expect(first.decision.reasonCode).toBe("run_failed_partial_evidence_preserved");
    const intent = (await issueWakes(issueId)).find(wake => wake.requestedByActorId === "native-status-committer")!;
    // A real intent id copied into a run that the dispatcher did not start.
    await db.update(issues).set({ status: "in_progress", executionRunId: null, checkoutRunId: null }).where(eq(issues.id, issueId));
    const copied = await failTurn(issueId, "opencode_empty_response", { nativeStatusWakeIntentId: intent.id });
    expect(copied.decision.reasonCode).toBe("run_failed_partial_evidence_preserved");
  }, 120_000);
});
