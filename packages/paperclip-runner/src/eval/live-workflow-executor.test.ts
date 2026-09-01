import { beforeEach, describe, expect, it, vi } from "vitest";

const liveSessionMocks = vi.hoisted(() => ({
  shutdown: vi.fn(),
}));

vi.mock("../live/live-session.js", () => ({
  InMemoryCapabilityLiveSessionStore: class {},
  CapabilityLiveSessionService: class {
    async create() {
      return {
        id: "session-shutdown-test",
        subscribe: () => () => undefined,
        sendMessage: async () => ({
          status: "completed",
          turnId: "turn-shutdown-test",
        }),
        pendingInteractions: () => [],
        snapshot: () => ({}),
      };
    }

    async shutdown(sessionId: string, reason: string) {
      return liveSessionMocks.shutdown(sessionId, reason);
    }
  },
}));

import { runnerWorkflowCase } from "./workflow-catalog.js";
import { executeLiveRunnerWorkflow } from "./live-workflow-executor.js";
import {
  RUNNER_LIVE_CANDIDATE_SLOTS,
  type RunnerLiveScheduleEntry,
} from "./live-workflow-matrix.js";

describe("live workflow executor infrastructure failures", () => {
  beforeEach(() => {
    liveSessionMocks.shutdown.mockReset();
  });

  it("classifies shutdown failures as retryable infrastructure errors and redacts them", async () => {
    const leakedSecret = "sk-shutdown-secret-value";
    liveSessionMocks.shutdown.mockRejectedValueOnce(
      new Error(`shutdown failed with ${leakedSecret}`),
    );
    const candidate = RUNNER_LIVE_CANDIDATE_SLOTS[0]!.candidates[0]!;
    const entry: RunnerLiveScheduleEntry = {
      executionId: "shutdown-failure",
      caseId: "final-response",
      candidateId: candidate.id,
      slotId: candidate.slotId,
      repetition: 1,
      providerTrace: "raw",
      budget: candidate.budget,
    };

    let thrown: unknown;
    try {
      await executeLiveRunnerWorkflow({
        entry,
        candidate,
        evalCase: runnerWorkflowCase(entry.caseId),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "RunnerWorkflowInfrastructureError",
      code: "live_provider_execution_failed",
      retryable: true,
      message: "shutdown failed with [REDACTED]",
    });
    expect(String((thrown as Error).message)).not.toContain(leakedSecret);
    expect(liveSessionMocks.shutdown).toHaveBeenCalledWith(
      "session-shutdown-test",
      "Runner live workflow eval complete",
    );
  });
});
