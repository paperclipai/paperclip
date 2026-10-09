import { expect, it } from "vitest";
import { assertProviderLossSettlement } from "./native-provider-loss-flow.js";
import { bootstrapReadExecutionId } from "./native-bootstrap-read-proof.js";
import type { ActiveStopPending } from "./native-active-stop-evidence.js";
import { buildRunnerE2EProcessEnvironment } from "./harness-env.js";
import { runnerMatrix } from "./catalog.js";

it("runs qualified Cursor loss cells without qualification overrides", () => {
  const execution = runnerMatrix.find(row => row.suite.id === "native-provider-loss" && row.environment.id === "local")!;
  expect(buildRunnerE2EProcessEnvironment({}, [execution]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION)
    .toBeUndefined();
  expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...execution, profile: { ...execution.profile, qualificationCandidate: "copilot" } }])).toThrow("explicit provider qualification suite");
});

function fixture() {
  const pending = { scope: { runId: "run", companyId: "company", issueId: "issue" }, requestId: "permission", turnId: "turn", toolCallId: "mutation" } as ActiveStopPending;
  const run = { id: "run", companyId: "company", nativeIssueId: "issue", runtimeMode: "native", status: "failed", error: "provider_transport_failed", resultJson: {} };
  const issue = { id: "issue", companyId: "company", status: "blocked" };
  const events = [{ payload: { prpEvent: { eventType: "runtime_request.expired", payload: { requestId: "permission", turnId: "turn", requestKind: "permission_approval" } } } }];
  return { pending, run, issue, events };
}
it("allows completed bootstrap reads while fencing the unanswered mutation", () => {
  const f = fixture();
  f.events.push({ payload: { prpEvent: { eventType: "tool.execution.completed", payload: { executionId: "bootstrap-read", status: "completed" } } } } as any);
  expect(assertProviderLossSettlement(f.run, f.issue, f.events, f.pending)).toMatchObject({ failedRun: true, replayAllowed: false });
});
it.each(["succeeded", "cancelled", "timed_out"])("does not certify %s as provider loss", status => {
  const f = fixture(); f.run.status = status;
  expect(() => assertProviderLossSettlement(f.run, f.issue, f.events, f.pending)).toThrow("failure must leave");
});
it("rejects accepting the stale permission", () => {
  const f = fixture(); f.events[0]!.payload.prpEvent.eventType = "runtime_request.resolved";
  expect(() => assertProviderLossSettlement(f.run, f.issue, f.events, f.pending)).toThrow("must close");
});
it("rejects a completed mutation even when the final run failed", () => {
  const f = fixture();
  f.events.push({ payload: { prpEvent: { eventType: "tool.execution.completed", payload: { executionId: bootstrapReadExecutionId(f.pending.toolCallId), status: "completed" } } } } as any);
  expect(() => assertProviderLossSettlement(f.run, f.issue, f.events, f.pending)).toThrow("completed mutation");
});
