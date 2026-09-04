import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockTurnEvent =
  | {
      seq: number;
      at: string;
      turnId: string;
      kind: "usage";
      usage: {
        providerRequests: number;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        reasoningTokens: number;
        costNanodollars: number;
      };
    }
  | {
      seq: number;
      at: string;
      turnId: string;
      kind: "activity";
      reason: string;
    };

const liveSessionMocks = vi.hoisted(() => ({
  shutdown: vi.fn(),
  createOptions: [] as Array<{
    transportOptions?: { environment?: NodeJS.ProcessEnv };
  }>,
  sendMessage: vi.fn(),
  snapshot: vi.fn(),
  interrupt: vi.fn(),
  suspend: vi.fn(),
  restore: vi.fn(),
  subscribedSessionIds: [] as string[],
  unsubscribedSessionIds: [] as string[],
  turnListener: null as null | ((event: MockTurnEvent) => void),
}));

vi.mock("../live/live-session.js", () => ({
  InMemoryCapabilityLiveSessionStore: class {},
  CapabilityLiveSessionService: class {
    constructor(options: {
      transportOptions?: { environment?: NodeJS.ProcessEnv };
    }) {
      liveSessionMocks.createOptions.push(options);
    }

    session(sessionId: string, subscriptionLabel: string) {
      return {
        id: sessionId,
        subscribe: (
          listener: NonNullable<typeof liveSessionMocks.turnListener>,
        ) => {
          liveSessionMocks.subscribedSessionIds.push(subscriptionLabel);
          liveSessionMocks.turnListener = listener;
          return () => {
            liveSessionMocks.unsubscribedSessionIds.push(subscriptionLabel);
            if (liveSessionMocks.turnListener === listener) {
              liveSessionMocks.turnListener = null;
            }
          };
        },
        sendMessage: liveSessionMocks.sendMessage,
        pendingInteractions: () => [],
        snapshot: liveSessionMocks.snapshot,
        interrupt: liveSessionMocks.interrupt,
        suspend: liveSessionMocks.suspend,
      };
    }

    async create() {
      return this.session("session-shutdown-test", "created");
    }

    async restore(sessionId: string) {
      liveSessionMocks.restore(sessionId);
      return this.session(sessionId, "restored");
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
    liveSessionMocks.subscribedSessionIds.length = 0;
    liveSessionMocks.unsubscribedSessionIds.length = 0;
    liveSessionMocks.turnListener = null;
    liveSessionMocks.sendMessage.mockReset().mockResolvedValue({
      status: "completed",
      turnId: "turn-shutdown-test",
    });
    liveSessionMocks.interrupt.mockReset().mockResolvedValue({});
    liveSessionMocks.suspend.mockReset().mockResolvedValue({});
    liveSessionMocks.restore.mockReset();
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

  it("keeps launch-only smoke exceptions explicit and rejects a wrong marker", async () => {
    liveSessionMocks.snapshot.mockReturnValue({
      sessionId: "session-smoke-marker",
      authority: {},
      mockState: JSON.stringify({ tasks: [] }),
      transcript: [
        {
          id: "assistant-smoke-marker",
          role: "assistant",
          text: "a different response",
        },
      ],
      evidence: [],
      authorizationRecords: [],
      attempts: [],
      usageLedger: [],
      stateHistory: [],
      workspaceDiffs: [],
    });
    const candidate = RUNNER_LIVE_CANDIDATE_SLOTS[0]!.candidates[0]!;
    const entry: RunnerLiveScheduleEntry = {
      executionId: "local-smoke-marker",
      caseId: "final-response",
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
      allowMissingUsage: true,
      expectedAssistantText: "PAPERCLIP_LOCAL_PROVIDER_SMOKE_OK",
      promptOverride: "Return the smoke marker.",
    });

    expect(liveSessionMocks.sendMessage).toHaveBeenCalledWith(
      "Return the smoke marker.",
      { allowMissingUsage: true },
    );
    expect(observation.presentation.checks).toContainEqual(
      expect.objectContaining({
        id: "expected-assistant-text",
        passed: false,
      }),
    );
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

  it("stops at an exact terminal budget before a paid continuation", async () => {
    liveSessionMocks.snapshot.mockReturnValue({
      sessionId: "session-budget-reached",
      authority: {},
      mockState: JSON.stringify({ tasks: [] }),
      transcript: [],
      evidence: [],
      authorizationRecords: [],
      attempts: [],
      usageLedger: [
        {
          receiptId: "usage-budget-reached",
          attemptId: "attempt-budget-reached",
          providerResponseId: "response-budget-reached",
          turnId: "turn-budget-reached",
          providerCalls: 1,
          providerRequests: 1,
          inputTokens: 70,
          outputTokens: 20,
          cachedInputTokens: 0,
          reasoningTokens: 10,
          costNanodollars: 10_000_000,
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
      executionId: "candidate-budget-reached",
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
      metrics: { totalTokens: 100, costUsd: 0.01 },
      failure: {
        code: "candidate_budget_reached",
        category: "candidate",
        retryable: false,
      },
    });
    expect(observation.lifecycle.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "token-budget", passed: true }),
        expect.objectContaining({ id: "cost-budget", passed: true }),
        expect.objectContaining({
          id: "candidate-budget-stop",
          passed: false,
        }),
      ]),
    );
  });

  it("interrupts an active paid turn as soon as live usage reaches its budget", async () => {
    const emptySnapshot = {
      sessionId: "session-live-budget-test",
      authority: {},
      mockState: JSON.stringify({ tasks: [] }),
      transcript: [],
      evidence: [],
      authorizationRecords: [],
      attempts: [],
      usageLedger: [],
      stateHistory: [],
      workspaceDiffs: [],
    };
    const exceededSnapshot = {
      ...emptySnapshot,
      usageLedger: [
        {
          receiptId: "usage-live-budget-test",
          attemptId: "attempt-live-budget-test",
          providerResponseId: "response-live-budget-test",
          turnId: "turn-live-budget-test",
          providerCalls: 1,
          providerRequests: 1,
          inputTokens: 80,
          outputTokens: 20,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          costNanodollars: 10_000_000,
          observedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };
    let interrupted = false;
    let turnResolved = false;
    let resolveTurn:
      ((value: { status: string; turnId: string }) => void) | null = null;
    liveSessionMocks.snapshot.mockImplementation(() =>
      interrupted ? exceededSnapshot : emptySnapshot,
    );
    liveSessionMocks.sendMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTurn = resolve;
          queueMicrotask(() => {
            const usageEvent = {
              seq: 1,
              at: "2026-09-01T00:00:00.000Z",
              turnId: "turn-live-budget-test",
              kind: "usage",
              usage: {
                providerRequests: 1,
                inputTokens: 80,
                outputTokens: 20,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                costNanodollars: 10_000_000,
              },
            } as const;
            liveSessionMocks.turnListener?.(usageEvent);
            liveSessionMocks.turnListener?.({ ...usageEvent, seq: 2 });
          });
        }),
    );
    liveSessionMocks.interrupt.mockImplementationOnce(async () => {
      expect(turnResolved).toBe(false);
      interrupted = true;
      turnResolved = true;
      resolveTurn?.({
        status: "interrupted",
        turnId: "turn-live-budget-test",
      });
      return exceededSnapshot;
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
      executionId: "candidate-live-budget-stop",
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

    expect(liveSessionMocks.interrupt).toHaveBeenCalledTimes(1);
    expect(liveSessionMocks.interrupt).toHaveBeenCalledWith(
      expect.stringContaining("candidate reported usage budget stop"),
    );
    expect(liveSessionMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({
      classification: "candidate_failure",
      metrics: { totalTokens: 100, costUsd: 0.01 },
      failure: {
        code: "candidate_budget_reached",
        category: "candidate",
        retryable: false,
      },
    });
  });

  it("reattaches the budget interrupt before a restored-session continuation", async () => {
    const emptySnapshot = {
      sessionId: "session-restored-budget-test",
      authority: {},
      mockState: JSON.stringify({ tasks: [] }),
      transcript: [],
      evidence: [],
      authorizationRecords: [],
      attempts: [],
      usageLedger: [],
      stateHistory: [],
      workspaceDiffs: [],
    };
    const reachedSnapshot = {
      ...emptySnapshot,
      usageLedger: [
        {
          receiptId: "usage-restored-budget-test",
          attemptId: "attempt-restored-budget-test",
          providerResponseId: "response-restored-budget-test",
          turnId: "turn-restored-budget-test",
          providerCalls: 1,
          providerRequests: 1,
          inputTokens: 70,
          outputTokens: 20,
          cachedInputTokens: 0,
          reasoningTokens: 10,
          costNanodollars: 10_000_000,
          observedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };
    let interrupted = false;
    let resolveRestoredTurn:
      ((value: { status: string; turnId: string }) => void) | null = null;
    liveSessionMocks.snapshot.mockImplementation(() =>
      interrupted ? reachedSnapshot : emptySnapshot,
    );
    liveSessionMocks.sendMessage
      .mockResolvedValueOnce({
        status: "completed",
        turnId: "turn-before-restore",
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRestoredTurn = resolve;
            queueMicrotask(() => {
              liveSessionMocks.turnListener?.({
                seq: 1,
                at: "2026-09-01T00:00:00.000Z",
                turnId: "turn-restored-budget-test",
                kind: "usage",
                usage: {
                  providerRequests: 1,
                  inputTokens: 70,
                  outputTokens: 20,
                  cachedInputTokens: 0,
                  reasoningTokens: 10,
                  costNanodollars: 10_000_000,
                },
              });
            });
          }),
      );
    liveSessionMocks.interrupt.mockImplementationOnce(async () => {
      interrupted = true;
      resolveRestoredTurn?.({
        status: "interrupted",
        turnId: "turn-restored-budget-test",
      });
      return reachedSnapshot;
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
      executionId: "restored-session-budget-stop",
      caseId: "restart-recovery",
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

    expect(liveSessionMocks.restore).toHaveBeenCalledWith(
      "session-shutdown-test",
    );
    expect(liveSessionMocks.subscribedSessionIds).toEqual([
      "created",
      "restored",
    ]);
    expect(liveSessionMocks.unsubscribedSessionIds).toEqual([
      "created",
      "restored",
    ]);
    expect(liveSessionMocks.interrupt).toHaveBeenCalledTimes(1);
    expect(liveSessionMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(observation).toMatchObject({
      classification: "candidate_failure",
      metrics: { totalTokens: 100, costUsd: 0.01 },
      failure: {
        code: "candidate_budget_reached",
        category: "candidate",
        retryable: false,
      },
    });
  });

  it("keeps an exact-cap provider-terminal race classified as a budget failure", async () => {
    const emptySnapshot = {
      sessionId: "session-exact-cap-race",
      authority: {},
      mockState: JSON.stringify({ tasks: [] }),
      transcript: [],
      evidence: [],
      authorizationRecords: [],
      attempts: [],
      usageLedger: [],
      stateHistory: [],
      workspaceDiffs: [],
    };
    const completedSnapshot = {
      ...emptySnapshot,
      mockState: JSON.stringify({ tasks: [{ id: "task-1", status: "done" }] }),
      transcript: [
        {
          role: "assistant",
          text: "The requested work is complete.",
        },
      ],
      evidence: [
        {
          id: "call-finish-task",
          kind: "tool_call",
          data: { operationId: "finish_task" },
        },
        {
          id: "result-finish-task",
          kind: "tool_result",
          data: { operationId: "finish_task", result: { ok: true } },
        },
      ],
      attempts: [{ attemptId: "attempt-exact-cap-race", status: "succeeded" }],
      usageLedger: [
        {
          receiptId: "usage-exact-cap-race",
          attemptId: "attempt-exact-cap-race",
          providerResponseId: "response-exact-cap-race",
          turnId: "turn-exact-cap-race",
          providerCalls: 1,
          providerRequests: 1,
          inputTokens: 70,
          outputTokens: 20,
          cachedInputTokens: 0,
          reasoningTokens: 10,
          costNanodollars: 10_000_000,
          observedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      stateHistory: [{ revision: 1 }, { revision: 2 }],
    };
    let providerCompleted = false;
    liveSessionMocks.snapshot.mockImplementation(() =>
      providerCompleted ? completedSnapshot : emptySnapshot,
    );
    liveSessionMocks.sendMessage.mockImplementationOnce(async () => {
      liveSessionMocks.turnListener?.({
        seq: 1,
        at: "2026-09-01T00:00:00.000Z",
        turnId: "turn-exact-cap-race",
        kind: "activity",
        reason: "turn_started",
      });
      liveSessionMocks.turnListener?.({
        seq: 2,
        at: "2026-09-01T00:00:00.001Z",
        turnId: "turn-exact-cap-race",
        kind: "usage",
        usage: {
          providerRequests: 1,
          inputTokens: 70,
          outputTokens: 20,
          cachedInputTokens: 0,
          reasoningTokens: 10,
          costNanodollars: 10_000_000,
        },
      });
      // The terminal wins the race with the best-effort interrupt, but the
      // already-observed exact-cap stop remains authoritative for scoring.
      providerCompleted = true;
      return { status: "completed", turnId: "turn-exact-cap-race" };
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
      executionId: "candidate-exact-cap-race",
      caseId: "final-response",
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

    expect(liveSessionMocks.interrupt).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({
      classification: "candidate_failure",
      metrics: { totalTokens: 100, costUsd: 0.01 },
      failure: {
        code: "candidate_budget_reached",
        category: "candidate",
        retryable: false,
      },
    });
    expect(observation.lifecycle.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "terminal-authority", passed: true }),
        expect.objectContaining({ id: "token-budget", passed: true }),
        expect.objectContaining({ id: "cost-budget", passed: true }),
        expect.objectContaining({ id: "candidate-budget-stop", passed: false }),
        expect.objectContaining({ id: "semantic-disposition", passed: true }),
      ]),
    );
  });
});
