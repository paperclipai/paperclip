import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "../services/recovery/service.js";

/**
 * TON-868: a context-window overflow carries its own error code
 * (`acpx_transient_upsert`) so the retry can re-seed with a bounded context.
 * The recovery service's infra-continuation ladder must still recognise it as
 * transient - otherwise the overflow falls into the default bucket and the
 * issue is abandoned instead of retried.
 */
describe("classifyContinuationFailure", () => {
  it("treats the context-overflow code as a transient infra failure", () => {
    const classification = classifyContinuationFailure({
      id: "run-1",
      agentId: "agent-1",
      status: "failed",
      error: "400 invalid params, context window exceeds limit (2013)",
      errorCode: "acpx_transient_upsert",
      contextSnapshot: null,
      livenessState: null,
    });
    expect(classification.kind).toBe("transient_infra");
    expect(classification.errorCode).toBe("acpx_transient_upsert");
  });

  it("still treats the plain transient-upstream code as transient infra", () => {
    const classification = classifyContinuationFailure({
      id: "run-1",
      agentId: "agent-1",
      status: "failed",
      error: "Connection closed mid-response",
      errorCode: "acpx_transient_upstream",
      contextSnapshot: null,
      livenessState: null,
    });
    expect(classification.kind).toBe("transient_infra");
  });

  it("keeps auth and budget failures non-retryable", () => {
    for (const errorCode of ["agent_not_invokable", "budget_exhausted", "issue_paused"]) {
      const classification = classifyContinuationFailure({
        id: "run-1",
        agentId: "agent-1",
        status: "failed",
        error: "boom",
        errorCode,
        contextSnapshot: null,
        livenessState: null,
      });
      expect(classification.kind).toBe("non_retryable");
    }
  });
});
