import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gradeInfrastructureRetry, isHumanRetryRequest, releasedRetryListener, retriesOriginalRun } from "./runtime-infrastructure-retry.js";
function valid() {
  return { scenarioId: "recovery.retry-exhausted", origin: "http://paperclip.test", companyId: "company", leadId: "ceo", agents: [], links: ["/COM/issues/COM-2"], humanQueries: [], reply: "", tasks: [{ id: "website", status: "done" }], activity: [],
    runs: [{ id: "rejected", status: "failed" }, ...["canonical", "retry"].map(id => ({ id, status: "succeeded" }))],
    state: { task: { id: "website", identifier: "COM-2", status: "blocked" }, queryRecoveryRead: true, worker: { id: "morgan" },
      failure: { id: "rejected", companyId: "company", agentId: "morgan", status: "failed", errorCode: "native_provider_model_rejected" }, freshContinuationsBefore: 0, successorRunsBefore: 0,
      queryReply: "Use Try again on the Website task once Morgan's model is fixed.", retryVisible: true,
      refusedRetryStatus: 409, refusalCode: "native_provider_model_still_unavailable", refusalNamedRejectedModel: true, refusalLinksModelSetting: true,
      noRunWhileModelUnavailable: true, taskBlockedAfterRefusal: true,
      modelFixedByHuman: true, fixedRetryStatus: 202, retryRunCount: 1, retryBoundToOriginal: true, retryAdmissionAfterFix: true, retryUsedFixedModel: true,
      originalFailureRetained: true, actualRetryResult: true } };
}
it("accepts a refused Try again while the model is rejected, then one retry after the fix that completes the task", () => expect(gradeInfrastructureRetry(valid()).passed).toBe(true));
it("accepts reworded guidance on the same saved evidence", () => { const o = valid(); o.state.queryReply = "Fix the model in Morgan's settings and press Try again on COM-2."; expect(gradeInfrastructureRetry(o).passed).toBe(true); });
it("rejects guidance whose run never read the saved recovery record", () => { const o = valid(); o.state.queryRecoveryRead = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects guidance that does not link the original task", () => { const o = valid(); o.links = []; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects a model failure with no visible Try again", () => { const o = valid(); o.state.retryVisible = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects a Try again that starts a doomed run while the rejected model is still selected", () => {
  const accepted = valid(); accepted.state.refusedRetryStatus = 202; expect(gradeInfrastructureRetry(accepted).passed).toBe(false);
  const started = valid(); started.state.noRunWhileModelUnavailable = false; expect(gradeInfrastructureRetry(started).passed).toBe(false);
});
it("rejects a refusal for another reason, or one that does not name the model or link its setting", () => {
  const code = valid(); code.state.refusalCode = "conflict"; expect(gradeInfrastructureRetry(code).passed).toBe(false);
  const named = valid(); named.state.refusalNamedRejectedModel = false; expect(gradeInfrastructureRetry(named).passed).toBe(false);
  const linked = valid(); linked.state.refusalLinksModelSetting = false; expect(gradeInfrastructureRetry(linked).passed).toBe(false);
});
it("rejects a refusal that unblocks the task", () => { const o = valid(); o.state.taskBlockedAfterRefusal = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects a retry the fixed model never reached", () => {
  const unfixed = valid(); unfixed.state.modelFixedByHuman = false; expect(gradeInfrastructureRetry(unfixed).passed).toBe(false);
  const model = valid(); model.state.retryUsedFixedModel = false; expect(gradeInfrastructureRetry(model).passed).toBe(false);
  const early = valid(); early.state.retryAdmissionAfterFix = false; expect(gradeInfrastructureRetry(early).passed).toBe(false);
});
it("rejects a refused retry after the fix", () => { for (const status of [200, 409, 500]) { const o = valid(); o.state.fixedRetryStatus = status; expect(gradeInfrastructureRetry(o).passed).toBe(false); } });
it("rejects retrying a different task or failed attempt", () => { const o = valid(); o.state.retryBoundToOriginal = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects duplicate or missing retries", () => {
  const two = valid(); two.state.retryRunCount = 2; expect(gradeInfrastructureRetry(two).passed).toBe(false);
  const none = valid(); none.state.retryRunCount = 0; expect(gradeInfrastructureRetry(none).passed).toBe(false);
  const extra = valid(); extra.runs.push({ id: "again", status: "succeeded" }); expect(gradeInfrastructureRetry(extra).passed).toBe(false);
});
it("rejects rewriting the failed attempt into success", () => { const o = valid(); o.state.originalFailureRetained = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects completion without the actual retry's saved output", () => { const o = valid(); o.state.actualRetryResult = false; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects an unfinished task", () => { const o = valid(); o.tasks[0]!.status = "blocked"; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects absent native retry evidence", () => expect(gradeInfrastructureRetry(undefined).passed).toBe(false));

it("rejects an infrastructure loss, which continues automatically, in place of a person-owned failure", () => { const o = valid(); o.state.failure.errorCode = "native_runner_process_exited"; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects a person-owned failure the system continued without the person", () => {
  const continued = valid(); continued.state.freshContinuationsBefore = 1; expect(gradeInfrastructureRetry(continued).passed).toBe(false);
  const started = valid(); started.state.successorRunsBefore = 1; expect(gradeInfrastructureRetry(started).passed).toBe(false);
});
it("rejects a failed task that is not waiting for the person", () => { const o = valid(); o.state.task.status = "todo"; expect(gradeInfrastructureRetry(o).passed).toBe(false); });
it("rejects another agent's or company's failure", () => {
  const agent = valid(); agent.state.failure.agentId = "riley"; expect(gradeInfrastructureRetry(agent).passed).toBe(false);
  const company = valid(); company.state.failure.companyId = "other"; expect(gradeInfrastructureRetry(company).passed).toBe(false);
});

it("accepts the task's own Retry request as the human Retry, for this task and assignee only", () => {
  const request = (method: string, path: string) => ({ method: () => method, url: () => `http://paperclip.test${path}` });
  expect(isHumanRetryRequest(request("POST", "/api/issues/website/retry"), "website", "morgan")).toBe(true);
  expect(isHumanRetryRequest(request("POST", "/api/agents/morgan/wakeup"), "website", "morgan")).toBe(true);
  expect(isHumanRetryRequest(request("POST", "/api/issues/other/retry"), "website", "morgan")).toBe(false);
  expect(isHumanRetryRequest(request("POST", "/api/agents/ceo/wakeup"), "website", "morgan")).toBe(false);
  expect(isHumanRetryRequest(request("GET", "/api/issues/website/retry"), "website", "morgan")).toBe(false);
  expect(isHumanRetryRequest(request("POST", "/api/issues/website/retry-workspace-export"), "website", "morgan")).toBe(false);
});
it("binds the brief to the released Retry's own workspace, and only that one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "retry-listener-")), outside = await mkdtemp(path.join(tmpdir(), "retry-outside-"));
  try {
    const fresh = path.join(root, "isolated-workspace-attempts", "retry"); await mkdir(fresh, { recursive: true });
    await writeFile(path.join(fresh, "brief.txt.waiting"), "waiting");
    await writeFile(path.join(outside, "brief.txt.waiting"), "waiting");
    const expected = { companyId: "company", workerId: "morgan", taskId: "website", originalRunId: "exhausted", gateName: "brief.txt" };
    const run = (cwd: string, patch: Record<string, unknown> = {}) => ({ id: "retry", companyId: "company", agentId: "morgan", retryOfRunId: null, startedAt: new Date(Date.now() - 60_000).toISOString(),
      contextSnapshot: { issueId: "website", previousRunId: "exhausted", executionContinuation: { trigger: { reason: "task_retry", sourceRunId: "exhausted" } } }, runnerProfileJson: { nativeExecutionInput: { workspace: { cwd }, binding: { executionWorkspaceId: "fresh-ws" } } }, ...patch }) as never;
    expect(await releasedRetryListener(run(fresh), expected, root)).toEqual({ gate: path.join(await import("node:fs/promises").then(fs => fs.realpath(fresh)), "brief.txt"), workspaceId: "fresh-ws" });
    expect(await releasedRetryListener(run(fresh, { contextSnapshot: { issueId: "website", previousRunId: "other",
      executionContinuation: { trigger: { reason: "task_retry", sourceRunId: "other" } } } }), expected, root)).toBeNull();
    expect(await releasedRetryListener(run(fresh, { agentId: "ceo" }), expected, root)).toBeNull();
    expect(await releasedRetryListener(run(fresh, { contextSnapshot: { issueId: "other" } }), expected, root)).toBeNull();
    expect(await releasedRetryListener(run(outside), expected, root)).toBeNull();
    expect(await releasedRetryListener(run(fresh), { ...expected, gateName: "missing.txt" }, root)).toBeNull();
    expect(await releasedRetryListener(run(fresh, { startedAt: new Date(Date.now() + 60_000).toISOString() }), expected, root)).toBeNull();
    expect(await releasedRetryListener(run(fresh, { startedAt: null }), expected, root)).toBeNull();
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
