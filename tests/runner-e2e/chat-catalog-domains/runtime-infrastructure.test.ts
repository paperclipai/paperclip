import { expect, it, vi } from "vitest";
import { freshContinuationRecord, gradeInfrastructureRecovery, INFRASTRUCTURE_BRIEF_SOURCE, nativeInfrastructureLoss, readSourceRecoveryRecord } from "./runtime-infrastructure.js";
import { busyRuntimeWorker } from "./runtime-busy-worker.js";
vi.mock("./runtime-busy-worker.js", async importOriginal => ({ ...await importOriginal<typeof import("./runtime-busy-worker.js")>(),
  busyRuntimeWorker: vi.fn(async () => ({ worker: { id: "morgan" }, task: { id: "website" }, gate: {}, workerRunId: "run" })) }));
vi.mock("./runtime-native-fault.js", async importOriginal => ({ ...await importOriginal<typeof import("./runtime-native-fault.js")>(),
  faultOwnedNativeProcess: async () => ({ id: "run", processPid: 7, errorCode: "native_runner_process_exited", status: "running", nativePhase: "running" }) }));
import { savedCall } from "./api-read-receipts.test-fixtures.js";
function record(overrides: Record<string, unknown> = {}) {
  return { id: "recovery", companyId: "company", sourceIssueId: "website", kind: "active_run_watchdog", status: "resolved", outcome: "restored", cause: "native_session_retry_exhausted",
    ownerType: "system", ownerAgentId: null, ownerUserId: null, returnOwnerAgentId: "morgan", recoveryIssueId: null, wakePolicy: null,
    nextAction: "The task continues in a fresh run from its last saved work.", resolutionNote: "continued_fresh_from_last_saved",
    evidence: { runId: "run", continuationDelivery: "delivered", continuationRunId: "next",
      freshContinuation: { schema: "paperclip.fresh-continuation.v1", sourceRunId: "run", trigger: "recovery_refused", failureCode: "native_runner_process_exited", delivery: "recorded", isolation: "fresh_isolated_workspace" },
      freshContinuationSettlement: { schema: "paperclip.fresh-continuation.v1", actorType: "system", actorId: "fresh-continuation", decision: "continue_in_fresh_run", replay: "none", sourceRunId: "run" } }, ...overrides };
}
function valid(id = "recovery.explain-stall") {
  return { scenarioId: id, origin: "http://paperclip.test", companyId: "company", leadId: "ceo", agents: [], links: ["/COM/issues/COM-2"], humanQueries: [], reply: "", tasks: [{ id: "website", status: "done", assigneeAgentId: "morgan" }], activity: [],
    runs: [{ id: "run", agentId: "morgan", status: "failed" }, { id: "next", agentId: "morgan", status: "succeeded" }, { id: "source", agentId: "ceo", status: "succeeded" }],
    state: { task: { id: "website", identifier: "COM-2" }, queryRecoveryRead: true, worker: { id: "morgan" },
      failure: { id: "run", status: "failed", resultJson: { freshContinuationSupersededAt: "2026-11-12T21:50:53.372Z" } },
      continuation: record(), recoveryAfter: { active: null, actions: [record()] }, continuationRunId: "next",
      continuationRun: { id: "next", companyId: "company", agentId: "morgan", retryOfRunId: "run", contextSnapshot: { issueId: "website" } },
      activeHoldAtReply: null as unknown, taskStatusAtReply: "in_progress", continuationResult: true,
      setupFaults: [1, 2, 3].map(pid => ({ runId: "run", pid, errorCode: "native_runner_process_exited" })),
      queryReply: "Morgan's Website run lost its Runner three times. Paperclip continued the task in a fresh run from its saved work; nothing is needed from you." } };
}
const grade = (o: ReturnType<typeof valid>) => gradeInfrastructureRecovery(o).passed;
it("accepts one system-owned fresh continuation that finishes the original task", () => expect(grade(valid())).toBe(true));
it("accepts the same contract for the source-action question", () => expect(grade(valid("recovery.source-action"))).toBe(true));
it("does not grade reply wording", () => { const o = valid(); o.state.queryReply = "It got cut off and picked back up on its own; see the task."; expect(grade(o)).toBe(true); });
it("accepts the recovery record that keeps an earlier hold as the continuation's primary record", () => {
  const o = valid(), hold = record({ kind: "active_run_watchdog", cause: "native_session_retry_exhausted", evidence: { ...record().evidence, automaticRecoveryHistory: { policy: "preserve_without_replay_v1" } } });
  o.state.continuation = hold; o.state.recoveryAfter = { active: null, actions: [hold] }; expect(grade(o)).toBe(true);
});
it("accepts a system-owned active hold at the reply", () => { const o = valid(); o.state.activeHoldAtReply = { ownerType: "system" }; expect(grade(o)).toBe(true); });
it("rejects a task left blocked for a person", () => { const o = valid(); o.state.taskStatusAtReply = "blocked"; expect(grade(o)).toBe(false); });
it("rejects a board-owned recovery action the person must act on", () => { const o = valid(); o.state.activeHoldAtReply = { ownerType: "board" }; expect(grade(o)).toBe(false); });
it("rejects a continuation record owned by a person", () => { const o = valid(), owned = record({ ownerType: "board" }); o.state.recoveryAfter = { active: null, actions: [owned] }; expect(grade(o)).toBe(false); });
it("rejects a continuation that replays the interrupted turn", () => {
  const o = valid(), replay = record({ evidence: { ...record().evidence, freshContinuationSettlement: { ...record().evidence.freshContinuationSettlement, replay: "exact" } } });
  o.state.recoveryAfter = { active: null, actions: [replay] }; expect(grade(o)).toBe(false);
});
it("rejects two continuation records for one interrupted run", () => { const o = valid(); o.state.recoveryAfter = { active: null, actions: [record(), record({ id: "second" })] }; expect(grade(o)).toBe(false); });
it("rejects a replaced continuation record", () => { const o = valid(); o.state.recoveryAfter = { active: null, actions: [record({ id: "replacement" })] }; expect(grade(o)).toBe(false); });
it("rejects missing continuation evidence", () => { const o = valid(); o.state.recoveryAfter = { active: null, actions: [] }; expect(grade(o)).toBe(false); });
it("rejects an interrupted run that keeps its write authority", () => { const o = valid(); o.state.failure.resultJson = {} as never; expect(grade(o)).toBe(false); });
it("rejects a second continuation run", () => { const o = valid(); o.runs.push({ id: "again", agentId: "morgan", status: "succeeded" }); expect(grade(o)).toBe(false); });
it("rejects a run that does not continue the interrupted one", () => { const o = valid(); o.state.continuationRun.retryOfRunId = "other"; expect(grade(o)).toBe(false); });
it("rejects a continuation that never finishes", () => { const o = valid(); o.runs[1]!.status = "failed"; expect(grade(o)).toBe(false); });
it("rejects a continuation that never saves its result", () => { const o = valid(); o.state.continuationResult = false; expect(grade(o)).toBe(false); });
it("rejects an unfinished original task", () => { const o = valid(); o.tasks[0]!.status = "in_progress"; expect(grade(o)).toBe(false); });
it("rejects relabelled unavailable-model failure as infrastructure loss", () => { const o = valid(); o.state.setupFaults[0]!.errorCode = "native_provider_model_rejected"; expect(grade(o)).toBe(false); });
it("rejects a continuation recorded for a person-owned failure", () => {
  const o = valid(), person = record({ evidence: { ...record().evidence, freshContinuation: { ...record().evidence.freshContinuation, failureCode: "native_provider_model_rejected" } } });
  o.state.recoveryAfter = { active: null, actions: [person] }; expect(grade(o)).toBe(false);
});
it("rejects three receipts for one reused PID", () => { const o = valid(); o.state.setupFaults[1]!.pid = 1; expect(grade(o)).toBe(false); });
it("rejects an answer whose run never read the saved recovery record", () => { const o = valid(); o.state.queryRecoveryRead = false; expect(grade(o)).toBe(false); });
it("rejects an answer that does not link the original task", () => { const o = valid(); o.links = ["/COM/issues/COM-9"]; expect(grade(o)).toBe(false); });
it("selects only the continuation of this run in this task", () => {
  const run = { id: "run", status: "failed", resultJson: { freshContinuationSupersededAt: "2026-11-12T21:50:53.372Z" } } as never;
  expect(freshContinuationRecord({ actions: [record() as never] }, run, "company", "website", "morgan")?.id).toBe("recovery");
  expect(freshContinuationRecord({ actions: [record() as never] }, run, "company", "other", "morgan")).toBeUndefined();
  expect(freshContinuationRecord({ actions: [record() as never] }, run, "company", "website", "riley")).toBeUndefined();
  expect(freshContinuationRecord({ actions: [record({ status: "active" }) as never] }, run, "company", "website", "morgan")).toBeUndefined();
});
it("accepts a genuine call_api recovery read after the port redacts its body, bound to the source task or failed run", () => {
  const read = (operationId: string, pathParams: Record<string, string>, status = 200) => savedCall({ operationId, pathParams }, status, "3", "run-1", { sourceIssueId: "website", runId: "run" });
  expect(readSourceRecoveryRecord(read("GET /api/issues/{id}/recovery-actions", { id: "website" }), "website", "run", "COM-1")).toBe(true);
  expect(readSourceRecoveryRecord(read("GET /api/issues/{id}", { id: "COM-1" }), "website", "run", "COM-1")).toBe(true);
  expect(readSourceRecoveryRecord(read("GET /api/heartbeat-runs/{runId}", { runId: "run" }), "website", "run", "COM-1")).toBe(true);
  expect(readSourceRecoveryRecord(read("GET /api/issues/{id}", { id: "COM-2" }), "website", "run", "COM-1")).toBe(false);
  expect(readSourceRecoveryRecord(read("GET /api/heartbeat-runs/{runId}", { runId: "other" }), "website", "run", "COM-1")).toBe(false);
  expect(readSourceRecoveryRecord(read("GET /api/heartbeat-runs/{runId}", { runId: "next" }), "website", "run", "COM-1", "next")).toBe(true);
  expect(readSourceRecoveryRecord(read("GET /api/heartbeat-runs/{runId}", { runId: "next" }), "website", "run", "COM-1")).toBe(false);
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
  expect(readSourceRecoveryRecord([event(task('{"id":"website","executionRunId":"next"}'))], "website", "run", null, "next")).toBe(true);
  expect(readSourceRecoveryRecord([event(task('{"id":"other","executionBlocker":{"runId":"run"}}'))], "website", "run")).toBe(false);
  expect(readSourceRecoveryRecord([event(task('{"id":"website","executionBlocker":{"runId":"run"}}'), "failed")], "website", "run")).toBe(false);
  expect(readSourceRecoveryRecord([event('{"apiOperationId":"GET /api/issues/{id}/documents/{key}","data":"website run"}')], "website", "run")).toBe(false);
});
it("rejects duplicate repair chains", () => { const o = valid(); o.tasks.push({ id: "repair", status: "todo", assigneeAgentId: "morgan" }); expect(grade(o)).toBe(false); });
it("rejects missing actual source recovery evidence", () => expect(gradeInfrastructureRecovery(undefined).passed).toBe(false));

function lossContext(successorAfter: number, successor: Record<string, unknown> = {}) {
  let faults = 0, pid = 100;
  const next = { id: "next", companyId: "company", agentId: "morgan", retryOfRunId: "run", contextSnapshot: { issueId: "website" }, ...successor };
  return { input: { fixtures: { company: { id: "company" } }, evidence: async () => {}, api: { get: async (path: string) => {
      if (path === "/api/heartbeat-runs/next") return next;
      return { id: "run", status: "running", processPid: ++pid, nativePhase: "running" };
    } } },
    allRuns: async () => { faults++; return [{ id: "run" }, ...(faults >= successorAfter ? [{ id: "next" }] : [])]; } };
}
it("accepts the fresh continuation of the interrupted run appearing right after the last Runner loss", async () => {
  await expect(nativeInfrastructureLoss(lossContext(3) as never)).resolves.toMatchObject({ setupFaults: [{}, {}, {}] });
});
it("rejects a replacement run before the last Runner loss", async () => {
  await expect(nativeInfrastructureLoss(lossContext(2) as never)).rejects.toThrow(/undeclared replacement/);
});
it("rejects a run after the last Runner loss that does not continue the interrupted run", async () => {
  await expect(nativeInfrastructureLoss(lossContext(3, { retryOfRunId: "other" }) as never)).rejects.toThrow(/undeclared replacement/);
  await expect(nativeInfrastructureLoss(lossContext(3, { agentId: "riley" }) as never)).rejects.toThrow(/undeclared replacement/);
});

// Full cohort 9 (recovery.source-action, master b1ef1f3022): the recovery mechanics passed, but the gated Website task said
// "The website brief is being supplied by the human", so the CEO asked the chat person for the brief instead of explaining
// that the system was already continuing the task. The brief comes from the gated export command itself.
it("gives the interrupted Website task a brief source that does not ask the chat person to supply anything", async () => {
  vi.mocked(busyRuntimeWorker).mockClear();
  await nativeInfrastructureLoss(lossContext(3) as never);
  expect(vi.mocked(busyRuntimeWorker).mock.calls[0]?.[1]).toEqual({ briefSource: INFRASTRUCTURE_BRIEF_SOURCE });
  expect(INFRASTRUCTURE_BRIEF_SOURCE).not.toMatch(/\b(?:human|person|you|user|supplied)\b/i);
  expect(INFRASTRUCTURE_BRIEF_SOURCE).toMatch(/command below/);
});
