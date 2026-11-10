import { expect, it } from "vitest";
import { exhaustedSourceRecovery, gradeInfrastructureRecovery, readSourceRecoveryRecord, sameRecoveryAction } from "./runtime-infrastructure.js";
import { savedCall } from "./api-read-receipts.test-fixtures.js";
function valid(id = "recovery.explain-stall") {
  const recovery = { id: "recovery", companyId: "company", sourceIssueId: "website", kind: "active_run_watchdog", cause: "native_session_retry_exhausted", ownerType: "board", ownerAgentId: null,
    returnOwnerAgentId: "morgan", recoveryIssueId: null, evidence: { runId: "run", coordinatorAttempt: 3, recoveryDisposition: "native_session_retry_exhausted" }, maxAttempts: 3, wakePolicy: null, nextAction: "Inspect the provider trace and explicitly choose a replacement run or provider configuration; automatic provider work is stopped." };
  return { scenarioId: id, origin: "http://paperclip.test", companyId: "company", leadId: "ceo", agents: [], links: ["/COM/issues/COM-2"], humanQueries: [], reply: "", tasks: [{ id: "website" }], activity: [],
    runs: [{ id: "run", agentId: "morgan", status: "failed" }, { id: "source", agentId: "ceo", status: "succeeded" }],
    state: { task: { id: "website", identifier: "COM-2" }, queryRecoveryRead: true, worker: { id: "morgan" }, failure: { id: "run", status: "failed", nativePhase: "terminal_failure" }, recoveryBefore: recovery, recoveryAfter: { ...recovery },
      setupFaults: [1, 2, 3].map(pid => ({ runId: "run", pid, errorCode: "native_runner_process_exited" })), sourceRecoveryVisible: true,
      queryReply: "Website stopped after three native Runner infrastructure attempts exhausted recovery. The original task's recovery action belongs to the board: an operator must inspect its provider trace and explicitly choose a replacement run or provider configuration." } };
}
it("accepts actual bounded process failure and truthful source-scoped diagnosis", () => expect(gradeInfrastructureRecovery(valid()).passed).toBe(true));
it("accepts a natural factual explanation", () => { const o = valid(); o.state.queryReply = "The Website's native session hit its limit of 3 resume attempts after process loss. You can open the run details and inspect the provider trace before authorizing a retry; this needs operator action."; expect(gradeInfrastructureRecovery(o).passed).toBe(true); });
it("accepts actual original source recovery identification", () => { const o = valid("recovery.source-action"); o.state.queryReply = "Use the recovery action on the original Website task. Its board owner must inspect the run details and choose an explicit retry. A separate repair task is unnecessary."; expect(gradeInfrastructureRecovery(o).passed).toBe(true); });
it("rejects relabelled unavailable-model failure as infrastructure loss", () => { const o = valid(); o.state.setupFaults[0]!.errorCode = "native_provider_model_rejected"; expect(gradeInfrastructureRecovery(o).passed).toBe(false); });
it("rejects an invented exhaustion counter", () => { const o = valid(); o.state.recoveryBefore.evidence.coordinatorAttempt = 1; expect(gradeInfrastructureRecovery(o).passed).toBe(false); });
it("rejects three receipts for one reused PID", () => { const o = valid(); o.state.setupFaults[1]!.pid = 1; expect(gradeInfrastructureRecovery(o).passed).toBe(false); });
it("rejects silently transferring the action owner", () => { const o = valid(); o.state.recoveryAfter.ownerType = "agent"; expect(gradeInfrastructureRecovery(o).passed).toBe(false); });
it("rejects a foreign source action", () => { const o = valid(); o.state.recoveryAfter.sourceIssueId = "other"; expect(gradeInfrastructureRecovery(o).passed).toBe(false); });
it("does not grade reply wording", () => { const o = valid(); o.state.queryReply = "Short answer: see the task."; expect(gradeInfrastructureRecovery(o).passed).toBe(true); });
it("rejects an answer whose run never read the saved recovery record", () => { const o = valid(); o.state.queryRecoveryRead = false; expect(gradeInfrastructureRecovery(o).passed).toBe(false); });
it("rejects an answer that does not link the original task", () => { const o = valid(); o.links = ["/COM/issues/COM-9"]; expect(gradeInfrastructureRecovery(o).passed).toBe(false); });
it("accepts a genuine call_api recovery read after the port redacts its body, bound to the source task or failed run", () => {
  const read = (operationId: string, pathParams: Record<string, string>, status = 200) => savedCall({ operationId, pathParams }, status, "3", "run-1", { sourceIssueId: "website", runId: "run" });
  expect(readSourceRecoveryRecord(read("GET /api/issues/{id}/recovery-actions", { id: "website" }), "website", "run", "COM-1")).toBe(true);
  expect(readSourceRecoveryRecord(read("GET /api/issues/{id}", { id: "COM-1" }), "website", "run", "COM-1")).toBe(true);
  expect(readSourceRecoveryRecord(read("GET /api/heartbeat-runs/{runId}", { runId: "run" }), "website", "run", "COM-1")).toBe(true);
  expect(readSourceRecoveryRecord(read("GET /api/issues/{id}", { id: "COM-2" }), "website", "run", "COM-1")).toBe(false);
  expect(readSourceRecoveryRecord(read("GET /api/heartbeat-runs/{runId}", { runId: "other" }), "website", "run", "COM-1")).toBe(false);
  expect(readSourceRecoveryRecord(read("GET /api/issues/{id}/recovery-actions", { id: "website" }, 403), "website", "run", "COM-1")).toBe(false);
});
it("reads the recovery record only from exact product tool output", () => {
  const event = (output: string, status = "completed") => ({ eventType: "tool.execution.completed", payload: { prpEvent: { sourceKind: "runner", payload: { status, output } } } });
  const actions = '{"apiOperationId":"GET /api/issues/{id}/recovery-actions","body":{"active":{"sourceIssueId":"website"}}}';
  const run = '{\\"apiOperationId\\": \\"GET /api/heartbeat-runs/{runId}\\", \\"id\\": \\"run\\"}';
  expect(readSourceRecoveryRecord([event(actions)], "website", "run")).toBe(true);
  expect(readSourceRecoveryRecord([event(run)], "website", "run")).toBe(true);
  expect(readSourceRecoveryRecord([event(actions, "failed")], "website", "run")).toBe(false);
  expect(readSourceRecoveryRecord([event(actions)], "other", "run")).toBe(false);
  expect(readSourceRecoveryRecord([event('{"apiOperationId":"GET /api/issues/{id}/recovery-actions/x"} website')], "website", "run")).toBe(false);
  expect(readSourceRecoveryRecord([event("I read the website recovery actions")], "website", "run")).toBe(false);
  // The task read counts only when its saved blocker names this failed run.
  const task = (body: string) => `{"apiOperationId":"GET /api/issues/{id}","data":${body}}`;
  expect(readSourceRecoveryRecord([event(task('{"id":"website","executionBlocker":{"runId":"run","cause":"native_session_retry_exhausted"}}'))], "website", "run")).toBe(true);
  expect(readSourceRecoveryRecord([event(task('{"id":"website","executionBlocker":null}'))], "website", "run")).toBe(false);
  expect(readSourceRecoveryRecord([event(task('{"id":"other","executionBlocker":{"runId":"run"}}'))], "website", "run")).toBe(false);
  expect(readSourceRecoveryRecord([event(task('{"id":"website","executionBlocker":{"runId":"run"}}'), "failed")], "website", "run")).toBe(false);
  expect(readSourceRecoveryRecord([event('{"apiOperationId":"GET /api/issues/{id}/documents/{key}","data":"website run"}')], "website", "run")).toBe(false);
});
it("rejects duplicate repair chains", () => { const o = valid(); o.tasks.push({ id: "repair" }); expect(gradeInfrastructureRecovery(o).passed).toBe(false); });
it("rejects concealing resumed work as still failed", () => { const o = valid(); o.runs[0]!.status = "running"; expect(gradeInfrastructureRecovery(o).passed).toBe(false); });
it("rejects missing actual source recovery evidence", () => expect(gradeInfrastructureRecovery(undefined).passed).toBe(false));

// The product settles an exhausted native action as resolved/blocked under
// preserve_without_replay_v1 and blocks the task, where the human Retry lives.
function settled(overrides: Record<string, unknown> = {}, automatic: Record<string, unknown> = {}) {
  const { recoveryBefore } = valid().state;
  return { ...recoveryBefore, status: "resolved", outcome: "blocked", createdAt: "2026-11-09T15:13:11.000Z", wakePolicy: null,
    nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
    evidence: { ...recoveryBefore.evidence, automaticRecovery: { policy: "preserve_without_replay_v1", runId: "run", replay: "blocked", ...automatic } }, ...overrides };
}
const run = { id: "run", status: "failed", nativePhase: "terminal_failure" } as never;
const select = (actions: unknown[], status = "blocked", active?: unknown) =>
  exhaustedSourceRecovery({ active: active as never, actions: actions as never }, { status } as never, run, "company", "website", "morgan");
it("accepts the exhausted action settled as blocked without replay on a blocked task", () => {
  const action = settled();
  expect(select([action])?.id).toBe("recovery");
  const o = valid(); o.state.recoveryBefore = action as never; o.state.recoveryAfter = { ...action } as never;
  expect(gradeInfrastructureRecovery(o).passed).toBe(true);
});
it("still accepts the exhausted action while it is active", () => expect(select([], "blocked", { ...valid().state.recoveryBefore, status: "active" })?.id).toBe("recovery"));
it.each([
  ["a cancelled settlement", settled({ outcome: "cancelled" })],
  ["a settlement without the preserve-without-replay marker", settled({ evidence: { ...valid().state.recoveryBefore.evidence } })],
  ["a settlement for another run", settled({}, { runId: "other" })],
  ["a settlement under another policy", settled({}, { policy: "replay_v1" })],
  ["a settled action that kept a wake policy", settled({ wakePolicy: { kind: "resume_native_run", runId: "run" } })],
  ["a settled action for another attempt count", settled({ evidence: { ...settled().evidence, coordinatorAttempt: 2 } })],
])("rejects %s", (_label, action) => expect(select([action])).toBeUndefined());
it("rejects a settled exhaustion while the task is not blocked", () => expect(select([settled()], "todo")).toBeUndefined());
it("judges only the newest source action", () => {
  const older = settled({ id: "older", createdAt: "2026-11-09T15:00:00.000Z" }), newer = settled({ id: "newer", outcome: "cancelled" });
  expect(select([older, newer])).toBeUndefined();
});
it("reads before and after as the same action by ID, so a replacement is detected", () => {
  const before = settled(), replacement = settled({ id: "replacement", createdAt: "2026-11-09T15:20:00.000Z" });
  expect(sameRecoveryAction({ actions: [before as never] }, "recovery")?.id).toBe("recovery");
  expect(sameRecoveryAction({ actions: [replacement as never] }, "recovery")).toBeUndefined();
  const o = valid(); o.state.recoveryBefore = before as never; o.state.recoveryAfter = replacement as never;
  expect(gradeInfrastructureRecovery(o).passed).toBe(false);
});
