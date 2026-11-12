import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gradeInfrastructureRetry, isHumanRetryRequest, releasedRetryListener, retriesOriginalRun } from "./runtime-infrastructure-retry.js";
function valid() {
  return { scenarioId: "recovery.retry-exhausted", origin: "http://paperclip.test", companyId: "company", leadId: "ceo", agents: [], links: ["/COM/issues/COM-2"], humanQueries: [], reply: "", tasks: [{ id: "website", status: "done" }], activity: [],
    runs: [{ id: "exhausted", status: "failed" }, ...["canonical", "held", "retry", "final"].map(id => ({ id, status: "succeeded" }))],
    state: { task: { id: "website", identifier: "COM-2" }, queryRecoveryRead: true, heldRecoveryRead: true, finalRecoveryRead: true, worker: { id: "morgan" }, failure: { id: "exhausted", status: "failed", nativePhase: "terminal_failure" },
      recoveryBefore: { id: "recovery", companyId: "company", sourceIssueId: "website", kind: "active_run_watchdog", cause: "native_session_retry_exhausted", ownerType: "board", ownerAgentId: null, returnOwnerAgentId: "morgan", recoveryIssueId: null,
        evidence: { runId: "exhausted", coordinatorAttempt: 3, recoveryDisposition: "native_session_retry_exhausted" }, maxAttempts: 3, wakePolicy: null, nextAction: "Inspect provider trace and explicitly choose replacement." }, queryReply: "Use the Retry button on the original failed run; this requires your human board session and rechecks current gates.", retryVisible: true,
      budgetHeldBeforeRetry: true, heldRetryStatus: 202, noDuplicateRetryWhileHeld: true, noAdmissionUnderBudget: true, failedRunVisibleWhileHeld: true, heldReplyAttributed: true,
      heldReply: "The retry could not start because Morgan's current budget hold blocks admission. The previous native failure remains visible.",
      budgetRestoredByHuman: true, retryBoundToOriginal: true, retryRunCount: 1, retryAdmissionAfterGateClear: true,
      originalFailureRetained: true, actualRetryResult: true, finalReplyAttributed: true, finalReply: "Website is complete after the eligible retry. The original exhausted attempt remains inspectable." } };
}
it("accepts actual budget rejection, one eligible retry and retained failure", () => expect(gradeInfrastructureRetry(valid()).passed).toBe(true));
it("accepts substantive natural human guidance and later factual reports", () => { const o = valid(); o.state.queryReply = "You can try again using the task's supported Retry control. It checks today's execution conditions."; o.state.heldReply = "Morgan has reached the spending cap, so no new execution was admitted."; o.state.finalReply = "The Website delivery is ready; its earlier failed attempts remain in the run history."; expect(gradeInfrastructureRetry(o).passed).toBe(true); });
it("rejects guidance whose run never read the saved recovery record", () => { const o = valid(); o.state.queryRecoveryRead = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects guidance that does not link the original task", () => { const o = valid(); o.links = []; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects a retry admitted under the actual hard stop", () => { const o = valid(); o.state.noAdmissionUnderBudget = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects a hidden original failure while Retry cannot start", () => { const o = valid(); o.state.failedRunVisibleWhileHeld = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects a held-phase answer that never read the task's runs", () => { const o = valid(); o.state.heldRecoveryRead = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects a final answer that never read the task's runs", () => { const o = valid(); o.state.finalRecoveryRead = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects an unbound held-phase reply", () => { const o = valid(); o.state.heldReplyAttributed = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects retrying a different task or failed attempt", () => { const o = valid(); o.state.retryBoundToOriginal = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects duplicate eligible retries", () => { const o = valid(); o.state.retryRunCount = 2; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects admission predating actual gate restoration", () => { const o = valid(); o.state.retryAdmissionAfterGateClear = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects rewriting the exhausted attempt into success", () => { const o = valid(); o.state.originalFailureRetained = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects completion without the actual retry's saved output", () => { const o = valid(); o.state.actualRetryResult = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects borrowing the pre-retry reply for final completion", () => { const o = valid(); o.state.finalReplyAttributed = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects absent native retry evidence", () => expect(gradeInfrastructureRetry(undefined).passed).toBe(false));

it("rejects substituting a terminal model failure for actual infrastructure exhaustion", () => { const o = valid(); o.state.recoveryBefore.cause = "native_provider_model_rejected"; expect(gradeInfrastructureRetry(o).passed).toBe(false); });

it("accepts the task's own Retry request as the human Retry, for this task and assignee only", () => {
  const request = (method: string, path: string) => ({ method: () => method, url: () => `http://paperclip.test${path}` });
  expect(isHumanRetryRequest(request("POST", "/api/issues/website/retry"), "website", "morgan")).toBe(true);
  expect(isHumanRetryRequest(request("POST", "/api/agents/morgan/wakeup"), "website", "morgan")).toBe(true);
  expect(isHumanRetryRequest(request("POST", "/api/issues/other/retry"), "website", "morgan")).toBe(false);
  expect(isHumanRetryRequest(request("POST", "/api/agents/ceo/wakeup"), "website", "morgan")).toBe(false);
  expect(isHumanRetryRequest(request("GET", "/api/issues/website/retry"), "website", "morgan")).toBe(false);
  expect(isHumanRetryRequest(request("POST", "/api/issues/website/retry-workspace-export"), "website", "morgan")).toBe(false);
});
it("requires the one held Retry to have been accepted, not refused", () => {
  for (const status of [200, 409, 500]) { const o = valid(); o.state.heldRetryStatus = status; expect(gradeInfrastructureRetry(o).passed).toBe(false); }
});
it("rejects a held Retry that dispatches before the gate clears", () => {
  const early = valid(); early.state.noAdmissionUnderBudget = false; expect(gradeInfrastructureRetry(early).passed).toBe(false);
  const predates = valid(); predates.state.retryAdmissionAfterGateClear = false; expect(gradeInfrastructureRetry(predates).passed).toBe(false);
});
it("rejects a held Retry that never dispatches after the gate clears", () => { const o = valid(); o.state.retryRunCount = 0; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects a second Retry control offered while the saved Retry waits", () => { const o = valid(); o.state.noDuplicateRetryWhileHeld = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });


it("binds the brief to the released Retry's own workspace, and only that one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "retry-listener-")), outside = await mkdtemp(path.join(tmpdir(), "retry-outside-"));
  try {
    const fresh = path.join(root, "isolated-workspace-attempts", "retry"); await mkdir(fresh, { recursive: true });
    await writeFile(path.join(fresh, "brief.txt.waiting"), "waiting");
    await writeFile(path.join(outside, "brief.txt.waiting"), "waiting");
    const expected = { companyId: "company", workerId: "morgan", taskId: "website", originalRunId: "exhausted", gateName: "brief.txt" };
    const run = (cwd: string, patch: Record<string, unknown> = {}) => ({ id: "retry", companyId: "company", agentId: "morgan", retryOfRunId: null,
      contextSnapshot: { issueId: "website", previousRunId: "exhausted", executionContinuation: { trigger: { reason: "task_retry", sourceRunId: "exhausted" } } }, runnerProfileJson: { nativeExecutionInput: { workspace: { cwd }, binding: { executionWorkspaceId: "fresh-ws" } } }, ...patch }) as never;
    expect(await releasedRetryListener(run(fresh), expected, root)).toEqual({ gate: path.join(await import("node:fs/promises").then(fs => fs.realpath(fresh)), "brief.txt"), workspaceId: "fresh-ws" });
    expect(await releasedRetryListener(run(fresh, { contextSnapshot: { issueId: "website", previousRunId: "other",
      executionContinuation: { trigger: { reason: "task_retry", sourceRunId: "other" } } } }), expected, root)).toBeNull();
    expect(await releasedRetryListener(run(fresh, { agentId: "ceo" }), expected, root)).toBeNull();
    expect(await releasedRetryListener(run(fresh, { contextSnapshot: { issueId: "other" } }), expected, root)).toBeNull();
    expect(await releasedRetryListener(run(outside), expected, root)).toBeNull();
    expect(await releasedRetryListener(run(fresh), { ...expected, gateName: "missing.txt" }, root)).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

it("binds a Retry to the original run through its task-retry continuation or retryOfRunId only", () => {
  const taskRetry = { retryOfRunId: null, contextSnapshot: { previousRunId: "exhausted", executionContinuation: { trigger: { reason: "task_retry", sourceRunId: "exhausted" } } } } as never;
  expect(retriesOriginalRun(taskRetry, "exhausted")).toBe(true);
  expect(retriesOriginalRun({ retryOfRunId: "exhausted", contextSnapshot: {} } as never, "exhausted")).toBe(true);
  expect(retriesOriginalRun({ retryOfRunId: null, contextSnapshot: { previousRunId: "exhausted" } } as never, "exhausted")).toBe(false);
  expect(retriesOriginalRun({ retryOfRunId: null, contextSnapshot: { previousRunId: "exhausted", executionContinuation: { trigger: { reason: "issue_commented", sourceRunId: "exhausted" } } } } as never, "exhausted")).toBe(false);
  expect(retriesOriginalRun({ retryOfRunId: null, contextSnapshot: { previousRunId: "other", executionContinuation: { trigger: { reason: "task_retry", sourceRunId: "exhausted" } } } } as never, "exhausted")).toBe(false);
});
