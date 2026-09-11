import { describe, expect, it } from "vitest";
import { executionFailureRetryCount } from "./execution-recovery-attempt.js";

describe("failure attempts across resource waits", () => {
  it("preserves prior failures through repeated workspace waits", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 12,
      contextSnapshot: { failureRetriesBeforeWorkspaceWait: 1 } })).toBe(1);
  });
  it("does not trust a caller-supplied count outside a server-created workspace retry", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2,
      contextSnapshot: { failureRetriesBeforeWorkspaceWait: 0 } })).toBe(2);
  });
  it("keeps ambiguous historical counts and starts a new incident after productive continuation", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 4 })).toBe(4);
    expect(executionFailureRetryCount({ scheduledRetryReason: "max_turns_continuation", scheduledRetryAttempt: 4 })).toBe(0);
  });
});
