import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const liveSessionMocks = vi.hoisted(() => ({
  shutdown: vi.fn(),
  createOptions: [] as Array<{
    transportOptions?: { environment?: NodeJS.ProcessEnv };
  }>,
  sendMessage: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock("../live/live-session.js", () => ({
  InMemoryCapabilityLiveSessionStore: class {},
  CapabilityLiveSessionService: class {
    constructor(options: {
      transportOptions?: { environment?: NodeJS.ProcessEnv };
    }) {
      liveSessionMocks.createOptions.push(options);
    }

    async create() {
      return {
        id: "session-shutdown-test",
        subscribe: () => () => undefined,
        sendMessage: liveSessionMocks.sendMessage,
        pendingInteractions: () => [],
        snapshot: liveSessionMocks.snapshot,
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
    liveSessionMocks.createOptions.length = 0;
    liveSessionMocks.sendMessage.mockReset().mockResolvedValue({
      status: "completed",
      turnId: "turn-shutdown-test",
    });
    liveSessionMocks.snapshot.mockReset().mockReturnValue({
      sessionId: "session-shutdown-test",
      authority: {},
      mockState: JSON.stringify({ tasks: [] }),
      transcript: [],
      evidence: [],
      authorizationRecords: [],
      attempts: [],
      usageLedger: [],
      stateHistory: [],
      workspaceDiffs: [],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("passes only the selected candidate's required provider credential", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-candidate-secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-candidate-secret");
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-candidate-secret");
    vi.stubEnv("CODEX_API_KEY", "unqualified-codex-secret");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "unqualified-claude-secret");
    vi.stubEnv("GITHUB_TOKEN", "unrelated-host-secret");
    vi.stubEnv("PAPERCLIP_AUTH_HEADER", "Bearer unrelated-control-secret");
    vi.stubEnv("RUNNER_EVAL_CANARY", "preserved-nonsecret-value");
    const candidates = [
      RUNNER_LIVE_CANDIDATE_SLOTS[0]!.candidates[0]!,
      RUNNER_LIVE_CANDIDATE_SLOTS[1]!.candidates[0]!,
      RUNNER_LIVE_CANDIDATE_SLOTS[3]!.candidates[0]!,
    ];

    for (const candidate of candidates) {
      const entry: RunnerLiveScheduleEntry = {
        executionId: `credential-isolation-${candidate.id}`,
        caseId: "final-response",
        candidateId: candidate.id,
        slotId: candidate.slotId,
        repetition: 1,
        providerTrace: "raw",
        budget: candidate.budget,
      };
      await executeLiveRunnerWorkflow({
        entry,
        candidate,
        evalCase: runnerWorkflowCase(entry.caseId),
      });

      const environment =
        liveSessionMocks.createOptions.at(-1)?.transportOptions?.environment;
      expect(environment?.RUNNER_EVAL_CANARY).toBe("preserved-nonsecret-value");
      expect(environment?.PAPERCLIP_PROVIDER_TRACE_PATH).toMatch(
        /provider-trace\.ndjson$/,
      );
      for (const credential of [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENROUTER_API_KEY",
        "CODEX_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "GITHUB_TOKEN",
        "PAPERCLIP_AUTH_HEADER",
      ]) {
        if (candidate.qualification.requiredEnvironment.includes(credential)) {
          expect(environment?.[credential]).toBe(process.env[credential]);
        } else {
          expect(environment).not.toHaveProperty(credential);
        }
      }
    }
  });

  it("fails the candidate budget and stops before a paid continuation", async () => {
    liveSessionMocks.snapshot.mockReturnValue({
      sessionId: "session-budget-test",
      authority: {},
      mockState: JSON.stringify({ tasks: [] }),
      transcript: [],
      evidence: [],
      authorizationRecords: [],
      attempts: [],
      usageLedger: [
        {
          receiptId: "usage-budget-test",
          attemptId: "attempt-budget-test",
          providerResponseId: "response-budget-test",
          turnId: "turn-budget-test",
          providerCalls: 1,
          providerRequests: 1,
          inputTokens: 80,
          outputTokens: 40,
          cachedInputTokens: 0,
          reasoningTokens: 10,
          costNanodollars: 20_000_000,
          observedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      stateHistory: [],
      workspaceDiffs: [],
    });
    const source = RUNNER_LIVE_CANDIDATE_SLOTS[0]!.candidates[0]!;
    const candidate = {
      ...source,
      budget: {
        ...source.budget,
        maxTotalTokens: 100,
        maxCostUsd: 0.01,
      },
    };
    const entry: RunnerLiveScheduleEntry = {
      executionId: "candidate-budget-exceeded",
      caseId: "steering-causality",
      candidateId: candidate.id,
      slotId: candidate.slotId,
      repetition: 1,
      providerTrace: "raw",
      budget: candidate.budget,
    };

    const observation = await executeLiveRunnerWorkflow({
      entry,
      candidate,
      evalCase: runnerWorkflowCase(entry.caseId),
    });

    expect(liveSessionMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({
      classification: "candidate_failure",
      metrics: { totalTokens: 130, costUsd: 0.02 },
      failure: {
        code: "candidate_budget_exceeded",
        category: "candidate",
        retryable: false,
      },
    });
    expect(observation.lifecycle.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "token-budget", passed: false }),
        expect.objectContaining({ id: "cost-budget", passed: false }),
      ]),
    );
  });
});
