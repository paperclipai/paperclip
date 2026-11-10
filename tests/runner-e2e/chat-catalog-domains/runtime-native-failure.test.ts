import { it, expect } from "vitest";
import { admittedModelFailure, unavailableNativeModel } from "./runtime-native-failure.js";
function valid() { return { companyId: "company", agentId: "morgan", issueId: "website", model: "unavailable",
  run: { id: "actual", companyId: "company", agentId: "morgan", runtimeMode: "native", status: "failed", startedAt: "2026-10-26T00:00:00Z",
    errorCode: "native_provider_model_rejected", error: "The selected model was rejected", nativeIssueId: "website",
    runnerProfileJson: { nativeExecutionInput: { provider: { kind: "codex", model: "unavailable" } } } },
  events: [{ seq: 1, eventType: "run.terminal" }] }; }
it("accepts only admitted native failed evidence bound to the actual unavailable model and task", () => expect(admittedModelFailure(valid())).toBe(true));
it("rejects cancellation relabeled as a failure fixture", () => { const o = valid(); o.run.status = "cancelled"; expect(admittedModelFailure(o)).toBe(false); });
it("rejects a failed tool command in a successful native turn", () => { const o = valid(); o.run.status = "succeeded"; expect(admittedModelFailure(o)).toBe(false); });
it("rejects configuration rejection before native admission", () => { const o = valid(); o.run.startedAt = ""; expect(admittedModelFailure(o)).toBe(false); });
it("rejects an unrelated prior failure", () => { const o = valid(); o.run.nativeIssueId = "other"; expect(admittedModelFailure(o)).toBe(false); });
it("rejects a changed or substituted provider model", () => { const o = valid(); o.run.runnerProfileJson.nativeExecutionInput.provider.model = "supported"; expect(admittedModelFailure(o)).toBe(false); });
it("rejects absent durable terminal events", () => { const o = valid(); o.events = []; expect(admittedModelFailure(o)).toBe(false); });

it("uses an explicit unavailable OpenRouter ID and requires actual OpenCode admission, never a Codex failure", () => {
  const model = unavailableNativeModel("opencode", "owned-nonce");
  expect(model).toBe("openrouter/paperclip-eval/paperclip-eval-unavailable-owned-nonce");
  const o = { ...valid(), provider: "opencode" as const, model };
  o.run.runnerProfileJson.nativeExecutionInput.provider = { kind: "opencode", model };
  expect(admittedModelFailure(o)).toBe(true);
  o.run.runnerProfileJson.nativeExecutionInput.provider.kind = "codex";
  expect(admittedModelFailure(o)).toBe(false);
});
