import { expect, it } from "vitest";
import { chatCatalogEndedRunRejection } from "./chat-catalog-flow.js";
import { classifyFailure } from "./failure-classifier.js";

const classify = (run: Parameters<typeof chatCatalogEndedRunRejection>[0]) => classifyFailure(new Error(`Stopped waiting for tasks.assignment-conflict: ${chatCatalogEndedRunRejection(run)}`));
it("full cohort 6: a run cancelled for a reassignment is the candidate's outcome, not retryable infrastructure", () => {
  const reassigned = { status: "cancelled", errorCode: "issue_reassigned", resultJson: { cancellation: { reason: "Cancelled for task reassignment", source: "control_plane", expected: true } } };
  expect(chatCatalogEndedRunRejection(reassigned)).toBe("Observed run was cancelled by control_plane (issue_reassigned)");
  expect(classify(reassigned)).toBe("candidate_failure");
  expect(classify({ status: "cancelled", errorCode: "cancelled", resultJson: { cancellation: { source: "operator" } } })).toBe("candidate_failure");
  expect(classify({ status: "cancelled", errorCode: null, resultJson: null })).toBe("candidate_failure");
});
it("a provider run that failed or timed out keeps its retryable provider classification", () => {
  expect(classify({ status: "failed", errorCode: "adapter_failed" })).toBe("transient_infrastructure");
  expect(classify({ status: "timed_out", errorCode: "timeout" })).toBe("transient_infrastructure");
});
