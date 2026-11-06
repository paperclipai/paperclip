import { expect, it } from "vitest";
import { gradeInfrastructureRecovery } from "./runtime-infrastructure.js";
function valid(id = "recovery.explain-stall") {
  const recovery = { id: "recovery", companyId: "company", sourceIssueId: "website", kind: "active_run_watchdog", cause: "native_session_retry_exhausted", ownerType: "board", ownerAgentId: null,
    returnOwnerAgentId: "morgan", recoveryIssueId: null, evidence: { runId: "run", coordinatorAttempt: 3, recoveryDisposition: "native_session_retry_exhausted" }, maxAttempts: 3, wakePolicy: null, nextAction: "Inspect the provider trace and explicitly choose a replacement run or provider configuration; automatic provider work is stopped." };
  return { scenarioId: id, companyId: "company", leadId: "ceo", agents: [], links: [], humanQueries: [], reply: "", tasks: [{ id: "website" }], activity: [],
    runs: [{ id: "run", agentId: "morgan", status: "failed" }, { id: "source", agentId: "ceo", status: "succeeded" }],
    state: { task: { id: "website" }, worker: { id: "morgan" }, failure: { id: "run", status: "failed", nativePhase: "terminal_failure" }, recoveryBefore: recovery, recoveryAfter: { ...recovery },
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
it("rejects falsely diagnosing a clear budget as the cause", () => { const o = valid(); o.state.queryReply += " Website stopped because the budget was exhausted."; expect(gradeInfrastructureRecovery(o).passed).toBe(false); });
it("rejects falsely calling a filed repair success", () => { const o = valid(); o.state.queryReply += " Website is now complete."; expect(gradeInfrastructureRecovery(o).passed).toBe(false); });
it("rejects duplicate repair chains", () => { const o = valid(); o.tasks.push({ id: "repair" }); expect(gradeInfrastructureRecovery(o).passed).toBe(false); });
it("rejects concealing resumed work as still failed", () => { const o = valid(); o.runs[0]!.status = "running"; expect(gradeInfrastructureRecovery(o).passed).toBe(false); });
it("rejects missing actual source recovery evidence", () => expect(gradeInfrastructureRecovery(undefined).passed).toBe(false));
