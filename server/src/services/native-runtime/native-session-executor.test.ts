import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import type {
  NativeExecutionInputV1,
  PrpEvent,
} from "@paperclipai/paperclip-runner";
import { createHash } from "node:crypto";

type BackendFactoryOptions = {
  runnerInstanceId?: string;
  codexTransportFactory?: () => unknown;
  dynamicToolHandler?: (call: unknown) => Promise<unknown>;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
};

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  createTransport: vi.fn(
    (_options: { stateDirectory?: string; runnerBinary?: string }) => ({
      transport: {},
    }),
  ),
  createBackend: vi.fn(
    (_input: NativeExecutionInputV1, _options: BackendFactoryOptions) => ({
      kind: "test",
    }),
  ),
  cancel: vi.fn(),
  toolAuthorityExecute: vi.fn(),
  persistActivity: vi.fn(
    async (_db: unknown, input: { action: string }) => ({
      activity: {
        id:
          input.action === "native.cancellation_intent_recorded"
            ? "native-cancellation-audit"
            : "native-cancellation-ack-audit",
      },
      publication: {
        companyId: "company",
        payload: { action: input.action },
        pluginEvent: null,
      },
    }),
  ),
  publishActivity: vi.fn(),
  resolveRunnerBinary: vi.fn(() => "/tmp/paperclip-runnerd"),
  release: null as null | (() => void),
}));

vi.mock(
  "../../vendor/paperclip-runner/index.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../vendor/paperclip-runner/index.js")
    >()),
    createNativeSessionBackend: state.createBackend,
    createRunnerdCodexTransport: state.createTransport,
    executeNativeSession: state.execute,
    parsePaperclipQuestionSet: (value: unknown) => value,
  }),
);

vi.mock("./paperclip-runner-tool-authority.js", () => ({
  PaperclipRunnerToolAuthority: class {
    readonly binding: Record<string, unknown>;

    constructor(_db: unknown, binding: Record<string, unknown>) {
      this.binding = binding;
    }

    async definitions() {
      return [];
    }

    async execute(call: unknown) {
      return state.toolAuthorityExecute(this.binding, call);
    }
  },
}));

vi.mock("../activity-log.js", () => ({
  persistActivity: state.persistActivity,
  publishActivity: state.publishActivity,
}));

vi.mock("./native-codex-runner.js", () => ({
  resolvePaperclipRunnerBinary: state.resolveRunnerBinary,
}));

import {
  continuingPendingInteractionIds,
  buildNativeProviderEnvironment,
  cancelNativeSession,
  createGovernedWaitEventObservation,
  createRunnerdBackend,
  executePaperclipNativeSession,
  getNativeSessionSteeringState,
  NativeSessionSteeringError,
  nativeSessionFailureDisposition,
  nativeSessionFailureSourceCode,
  nativeSessionRecoveryProjection,
  nativeGovernedWaitResult,
  providerPlanMarkdown,
  renewNativeSessionExecutionLease,
  runtimeInputLifecycleMetric,
  runtimeQuestionFallbackFromEvent,
  resolveNativeRuntimeRequest,
  semanticProviderPlanMarkdown,
  steerNativeSession,
} from "./native-session-executor.js";

describe("runtime question fallback", () => {
  const questionSet = {
    schema: "paperclip.question_set.v1" as const,
    title: "Configure deployment",
    description: "These answers are required before work can continue.",
    submitLabel: "Continue",
    questions: [
      {
        id: "region",
        prompt: "Which region?",
        required: true,
        answerMode: "single_select" as const,
        options: [
          { id: "us", label: "US" },
          { id: "eu", label: "Europe" },
        ],
      },
      {
        id: "replicas",
        prompt: "How many replicas?",
        required: true,
        answerMode: "text" as const,
        textValidation: { inputType: "integer" as const, minimum: 1 },
      },
    ],
  };

  it.each(["provider_process_lost", "durable_handoff"])(
    "materializes one idempotent durable interaction after %s",
    (reason) => {
      const fallback = runtimeQuestionFallbackFromEvent({
        eventType: "runtime_request.expired",
        runId: "00000000-0000-4000-8000-000000000001",
        payload: {
          requestId: "elicitation-1",
          requestKind: "runtime",
          requestType: "input",
          reason,
          replayAllowed: false,
          request: {
            schema: "paperclip.runtime_request.v2",
            requestKind: "runtime",
            requestId: "elicitation-1",
            type: "input",
            status: "pending",
            prompt: "Configure deployment",
            turnId: "turn-1",
            itemId: "item-1",
            input: questionSet,
          },
        },
      });
      expect(fallback).toMatchObject({
        kind: "ask_user_questions",
        idempotencyKey:
          "runtime-input-durable:v1:00000000-0000-4000-8000-000000000001:elicitation-1",
        sourceRunId: "00000000-0000-4000-8000-000000000001",
        continuationPolicy: "wake_assignee",
        payload: {
          runtimeRequestId: "elicitation-1",
          questionSet,
          supersedeOnUserComment: false,
          questions: [
            {
              id: "region",
              selectionMode: "single",
              options: [
                { id: "us", label: "US" },
                { id: "eu", label: "Europe" },
              ],
            },
            {
              id: "replicas",
              selectionMode: "single",
              options: [{ id: "__paperclip_text__", freeText: true }],
            },
          ],
        },
      });
    },
  );

  it.each([
    ["runtime_request.resolved", "provider_process_lost", false],
    ["runtime_request.cancelled", "provider_process_lost", false],
    ["runtime_request.expired", "explicit_cancellation", false],
    ["runtime_request.expired", "provider_process_lost", true],
  ])(
    "does not fall back for %s / %s / replay=%s",
    (eventType, reason, replayAllowed) => {
      expect(
        runtimeQuestionFallbackFromEvent({
          eventType: eventType as never,
          runId: "00000000-0000-4000-8000-000000000001",
          payload: {
            reason,
            replayAllowed,
            request: {
              schema: "paperclip.runtime_request.v2",
              requestKind: "runtime",
              requestId: "elicitation-1",
              type: "input",
              status: "pending",
              turnId: "turn-1",
              itemId: "item-1",
              input: questionSet,
            },
          },
        }),
      ).toBeNull();
    },
  );

  it("emits content-free lifecycle metric dimensions", () => {
    expect(
      runtimeInputLifecycleMetric({
        eventType: "runtime_request.created",
        payload: {
          request: {
            type: "input",
            requestId: "input-1",
            origin: { adapter: "codex-app-server" },
            input: questionSet,
          },
        },
      }),
    ).toEqual({
      outcome: "normalized",
      adapter: "codex-app-server",
      requestId: "input-1",
    });
    expect(
      runtimeInputLifecycleMetric({
        eventType: "runtime_request.expired",
        payload: {
          requestId: "input-1",
          requestType: "input",
          reason: "durable_handoff",
          adapter: "codex-app-server",
        },
      }),
    ).toEqual({
      outcome: "durable_handoff",
      adapter: "codex-app-server",
      requestId: "input-1",
    });
    expect(
      runtimeInputLifecycleMetric({
        eventType: "runtime_request.expired",
        payload: {
          requestId: "input-1",
          requestType: "input",
          reason: "provider_process_lost",
          adapter: "codex-app-server",
        },
      }),
    ).toEqual({
      outcome: "provider_loss_handoff",
      adapter: "codex-app-server",
      requestId: "input-1",
    });
  });
});

describe("native provider bootstrap environment", () => {
  it("inherits the host executable and credential-home context", () => {
    expect(
      buildNativeProviderEnvironment(
        {},
        {
          PATH: "/opt/homebrew/bin:/usr/bin",
          HOME: "/Users/runner",
          CODEX_HOME: "/Users/runner/.codex",
          PAPERCLIP_INTERNAL_SECRET: "must-not-leak",
        },
      ),
    ).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/runner",
      CODEX_HOME: "/Users/runner/.codex",
    });
  });

  it("lets explicitly configured agent env override host defaults", () => {
    expect(
      buildNativeProviderEnvironment(
        {
          PATH: "/agent/bin",
          OPENAI_API_KEY: "configured-provider-key",
        },
        {
          PATH: "/host/bin",
          HOME: "/Users/runner",
        },
      ),
    ).toEqual({
      PATH: "/agent/bin",
      HOME: "/Users/runner",
      OPENAI_API_KEY: "configured-provider-key",
    });
  });
});

const execution = {
  schema: "paperclip.native-execution-input.v1",
  provider: { kind: "codex", model: null },
  binding: {
    companyId: "company",
    runId: "run-native-cancel",
    issueId: "issue",
    agentId: "agent",
    executionWorkspaceId: "workspace",
  },
  task: {
    identifier: "PAP-NATIVE",
    title: "Exercise the native session",
    description: null,
    prompt: "Complete the native session test task.",
    workMode: "standard",
  },
  workspace: {
    cwd: "/tmp/paperclip-native-session-test",
    repoUrl: null,
    repoRef: null,
    branchName: null,
  },
  session: {
    normalizedSessionId: "session-native-cancel",
    driverKind: "codex_app_server",
    protocolVersion: 1,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
  },
  completionContract: {
    id: "contract",
    sha256: "sha",
    schemaVersion: "paperclip.completion-contract.v1",
    contract: {
      revision: "1",
      objective: "Exercise the native session.",
      criteria: [{ id: "objective", requirement: "The session completes." }],
    },
  },
  interactionResponses: [],
  credentialBindings: [],
} as NativeExecutionInputV1;

describe("provider plan synchronization", () => {
  it("prefers the provider's completed Markdown when it is available", () => {
    expect(
      providerPlanMarkdown({
        markdown: "# Release plan\n\n1. Prepare\n2. Deploy",
        explanation: "This fallback must not replace the completed plan.",
        steps: [{ body: "Fallback", status: "pending" }],
      }),
    ).toBe("# Release plan\n\n1. Prepare\n2. Deploy");
  });

  it("extracts a completed plan from the semantic result artifact", () => {
    expect(
      semanticProviderPlanMarkdown({
        artifacts: [
          {
            kind: "native_provider_plan",
            ref: "<proposed_plan>\n# Health check\n\n1. Add endpoint\n2. Verify it\n</proposed_plan>",
          },
        ],
      }),
    ).toBe("# Health check\n\n1. Add endpoint\n2. Verify it");
  });

  it("decodes the native provider's compact plan reference into readable Markdown", () => {
    expect(
      semanticProviderPlanMarkdown({
        artifacts: [
          {
            kind: "native_provider_plan",
            ref: "native-provider-plan:health-check-endpoint-v1#1-register-GET-health-return-200-json-status-ok;2-add-API-tests",
          },
        ],
      }),
    ).toBe(
      [
        "# Health check endpoint",
        "",
        "1. Register GET /health return 200 JSON status ok",
        "2. Add API tests",
      ].join("\n"),
    );
  });

  it("decodes a task-scoped native plan URI", () => {
    expect(
      semanticProviderPlanMarkdown({
        artifacts: [
          {
            kind: "native_provider_plan",
            ref: "native-plan://DOT-13/health-check#1-add-GET-health;2-add-tests",
          },
        ],
      }),
    ).toBe("# Health check\n\n1. Add GET /health\n2. Add tests");
  });

  it("retains readable Markdown embedded after a native provider plan reference", () => {
    expect(
      semanticProviderPlanMarkdown({
        artifacts: [
          {
            kind: "native_provider_plan",
            ref: "native-provider-plan:DOT-14-health-check-v1\n1. Add `GET /health`.\n2. Add tests.",
          },
        ],
      }),
    ).toBe("# Health check\n\n1. Add `GET /health`.\n2. Add tests.");
  });

  it("normalizes a plain numbered native provider plan", () => {
    expect(
      semanticProviderPlanMarkdown({
        artifacts: [
          {
            kind: "native_provider_plan",
            ref: "1. Add GET /health. | 2. Add tests. | 3. Document it.",
          },
        ],
      }),
    ).toBe("# Plan\n\n1. Add GET /health.\n2. Add tests.\n3. Document it.");
  });

  it("normalizes a task-labelled inline numbered plan", () => {
    expect(
      semanticProviderPlanMarkdown({
        artifacts: [
          {
            kind: "native_provider_plan",
            ref: "DOT-16 plan: (1) add GET /health; (2) add tests; (3) document it.",
          },
        ],
      }),
    ).toBe("# Plan\n\n1. add GET /health\n2. add tests\n3. document it.");
  });

  it("uses an explicitly numbered semantic summary when the artifact is opaque", () => {
    expect(
      semanticProviderPlanMarkdown({
        summary:
          "Native provider plan completed: 1) add GET /health; 2) add tests; 3) document it.",
        artifacts: [
          {
            kind: "native_provider_plan",
            ref: "native-provider-plan:DOT-18:health-check",
          },
        ],
      }),
    ).toBe("# Plan\n\n1. add GET /health\n2. add tests\n3. document it.");
  });

  it("renders a bounded Markdown checklist without embedding provenance", () => {
    const markdown = providerPlanMarkdown({
      explanation: "Release safely",
      steps: [
        { body: "Prepare", status: "completed" },
        { body: "Deploy", status: "in_progress" },
        { body: "Verify", status: "blocked" },
      ],
      runId: "must-not-appear",
      providerThreadId: "native-secret",
    });
    expect(markdown).toBe(
      [
        "Release safely",
        "",
        "- [x] Prepare",
        "- [ ] Deploy _(in progress)_",
        "- [ ] Verify _(blocked)_",
      ].join("\n"),
    );
    expect(markdown).not.toContain("must-not-appear");
    expect(markdown).not.toContain("native-secret");
  });
});

describe("native governed waits", () => {
  it("turns a durable pending interaction into a response-wake result", () => {
    expect(
      nativeGovernedWaitResult({
        interaction: {
          id: "interaction-1",
          title: "Choose an output format",
          summary: null,
        },
        completionContract: {
          revision: "contract-v3",
          objective: "Create the requested output",
          criteria: [{ id: "objective", requirement: "The output is created" }],
        },
      }),
    ).toEqual(
      expect.objectContaining({
        schema: "paperclip.run_result.v1",
        reportedWorkDisposition: "yielded",
        summary: "Waiting for Choose an output format.",
        completionClaim: expect.objectContaining({
          contractRevision: "contract-v3",
          objectiveSatisfied: false,
          criteria: [
            {
              criterionId: "objective",
              status: "unknown",
              evidenceRefs: ["interaction:interaction-1"],
            },
          ],
        }),
        evidence: [{ ref: "interaction:interaction-1" }],
        attentionRequests: [],
        continuation: {
          kind: "response_wake",
          summary:
            "Resume from the resolved interaction response without repeating prior work.",
          idempotencyKey: "interaction-response:interaction-1",
        },
      }),
    );
  });

  it("keeps an authority-checked partial item-verdict interaction as the wait target", () => {
    const partial = structuredClone(execution);
    partial.interactionResponses = [
      {
        interactionId: "interaction-partial",
        kind: "request_item_verdicts",
        response: {
          status: "pending",
          result: {
            version: 1,
            complete: false,
            items: [{ id: "alpha", verdict: "approve" }],
          },
        },
      },
    ];
    expect(continuingPendingInteractionIds(partial)).toEqual([
      "interaction-partial",
    ]);

    partial.interactionResponses[0]!.response.status = "answered";
    expect(continuingPendingInteractionIds(partial)).toEqual([]);
  });

  it("consumes an exact replay observation once without leaking stale state", async () => {
    const waitResult = nativeGovernedWaitResult({
      interaction: {
        id: "interaction-replayed",
        title: "Approve the replayed operation",
        summary: null,
      },
      completionContract: {
        revision: "contract-v3",
        objective: "Complete the approved operation",
        criteria: [{ id: "objective", requirement: "Complete it" }],
      },
    });
    const observation = createGovernedWaitEventObservation(
      async () => waitResult,
    );
    const replayedEvent: PrpEvent = {
      schema: "paperclip.prp.event.v1" as const,
      sourceInstanceId: "runner-recovered",
      sourceEventId: "runner-recovered:item:7",
      sourceSeq: 7,
      sourceKind: "runner" as const,
      runId: "run-recovered",
      normalizedSessionId: "session-recovered",
      turnId: "turn-recovered",
      eventType: "item.completed" as const,
      schemaVersion: 1,
      priority: 0 as const,
      emittedAt: "2026-08-31T00:00:00.000Z",
      payload: {},
    };

    await observation.observe(replayedEvent, true);
    expect(observation.consume(replayedEvent)).toEqual(waitResult);
    expect(observation.consume(replayedEvent)).toBeNull();

    await observation.observe(replayedEvent, true);
    expect(
      observation.consume({
        ...replayedEvent,
        sourceEventId: "runner-recovered:item:8",
        sourceSeq: 8,
      }),
    ).toBeNull();
    expect(observation.consume(replayedEvent)).toBeNull();

    let resolveLookup!: (value: typeof waitResult) => void;
    const delayedObservation = createGovernedWaitEventObservation(
      () =>
        new Promise<typeof waitResult>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const observing = delayedObservation.observe(replayedEvent, true);
    expect(delayedObservation.consume(replayedEvent)).toBeNull();
    resolveLookup(waitResult);
    await observing;
    expect(delayedObservation.consume(replayedEvent)).toBeNull();
  });
});

type LeaseCoordinator = {
  runId: string;
  companyId: string;
  issueId: string;
  phase: string;
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  resultId: string | null;
};

function leaseDb(
  boundExecution: NativeExecutionInputV1 = execution,
  coordinatorOverrides: Partial<LeaseCoordinator> = {},
  runResultJson: Record<string, unknown> = {},
): Db {
  const coordinator: LeaseCoordinator = {
    runId: boundExecution.binding.runId,
    companyId: boundExecution.binding.companyId,
    issueId: boundExecution.binding.issueId,
    phase: "observed",
    attempt: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    resultId: null,
    ...coordinatorOverrides,
  };
  const update = () => ({
    set: () => ({
      where: () => {
        const result = Promise.resolve([]) as unknown as Promise<unknown[]> & {
          returning: () => Promise<Array<{ runId: string }>>;
        };
        result.returning = () => Promise.resolve([{ runId: coordinator.runId }]);
        return result;
      },
    }),
  });
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          for: () => ({
            limit: () =>
              Promise.resolve([
                table === nativeRunFinalizations
                  ? coordinator
                  : {
                      agentId: boundExecution.binding.agentId,
                      companyId: boundExecution.binding.companyId,
                      nativeIssueId: boundExecution.binding.issueId,
                      resultJson: runResultJson,
                      runtimeMode: "native",
                    },
              ]),
          }),
        }),
      }),
    }),
    update,
  };
  return {
    transaction: async (operation: (transaction: Db) => Promise<unknown>) =>
      operation(tx as unknown as Db),
    update,
  } as unknown as Db;
}

function cancellationDb(options?: {
  coordinator?: {
    runId: string;
    assessmentId: string | null;
    decisionId?: string | null;
  } | null;
  failResultJsonUpdateAt?: number;
}) {
  const initialRun = {
    id: execution.binding.runId,
    agentId: execution.binding.agentId,
    companyId: execution.binding.companyId,
    nativeIssueId: execution.binding.issueId,
    runtimeMode: "native",
    contextSnapshot: { issueId: "untrusted-context-issue" },
    resultJson: { staleSnapshot: true },
  };
  let currentResultJson: Record<string, unknown> = {
    durableReceipt: { operationId: "operation-1" },
  };
  const issue = {
    status: "in_progress",
    statusVersion: 3,
    lastStatusDecisionId: null,
  };
  const coordinator =
    options && "coordinator" in options
      ? options.coordinator
      : { runId: execution.binding.runId, assessmentId: null };
  let forUpdateCount = 0;
  let resultJsonUpdateCount = 0;
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const select = vi.fn(() => ({
    from: (table: unknown) => {
      const rows =
        table === heartbeatRuns
          ? [{ ...initialRun, resultJson: currentResultJson }]
          : table === issues
            ? [issue]
            : table === nativeRunFinalizations && coordinator
              ? [coordinator]
              : [];
      const result = Promise.resolve(rows);
      type Query = {
        where: () => Query;
        for: () => Query;
        limit: () => Promise<typeof rows>;
      };
      const query = {} as Query;
      Object.assign(query, {
        where: () => query,
        for: () => {
          forUpdateCount += 1;
          return query;
        },
        limit: () => result,
      });
      return query;
    },
  }));
  const update = vi.fn((table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        updates.push({ table, values });
        const updatesResultJson = "resultJson" in values;
        if (updatesResultJson) resultJsonUpdateCount += 1;
        const shouldFail =
          updatesResultJson &&
          resultJsonUpdateCount === options?.failResultJsonUpdateAt;
        if (updatesResultJson && !shouldFail) {
          currentResultJson = values.resultJson as Record<string, unknown>;
        }
        const result = Promise.resolve([]) as unknown as Promise<unknown[]> & {
          returning: () => Promise<Array<{ id: string }>>;
        };
        result.returning = () =>
          shouldFail
            ? Promise.reject(new Error("post_dispatch_db_failure"))
            : Promise.resolve([{ id: execution.binding.runId }]);
        return result;
      },
    }),
  }));
  const tx = { select, update };
  const db = {
    select,
    update,
    transaction: async (operation: (transaction: Db) => Promise<unknown>) =>
      operation(tx as unknown as Db),
  } as unknown as Db;
  return {
    db,
    updates,
    getForUpdateCount: () => forUpdateCount,
    getResultJson: () => currentResultJson,
    getResultJsonUpdateCount: () => resultJsonUpdateCount,
    tx,
  };
}

describe("native session cancellation", () => {
  beforeEach(() => {
    state.cancel.mockReset().mockReturnValue({ cleanup: Promise.resolve() });
    state.persistActivity.mockClear();
    state.publishActivity.mockClear();
    state.release = null;
    state.execute.mockReset().mockImplementation(async (options) => {
      options.onSession?.({ cancel: state.cancel });
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
      options.onSession?.(null);
      return {
        result: { summary: "cancelled" },
        terminal: { runTerminalState: "cancelled" },
        turnId: "turn",
        normalizedSessionId: "session",
        providerSessionId: null,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      };
    });
  });

  it("routes control-plane cancellation to the active normalized session and removes the handle", async () => {
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));

    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop"),
    ).resolves.toBe(true);
    await expect(
      cancelNativeSession(execution.binding.runId, "duplicate budget stop"),
    ).resolves.toBe(true);
    expect(state.cancel).toHaveBeenCalledWith({
      reason: "budget hard stop",
      signal: expect.any(AbortSignal),
    });
    expect(state.cancel).toHaveBeenCalledTimes(1);

    state.release?.();
    await running;
    await expect(
      cancelNativeSession(execution.binding.runId, "late cancel"),
    ).resolves.toBe(false);
  });

  it("allows cancellation to be retried when the session dispatch fails", async () => {
    state.cancel.mockImplementationOnce(() => {
      throw new Error("transport unavailable");
    });
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));

    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop"),
    ).rejects.toThrow("transport unavailable");
    await expect(
      cancelNativeSession(execution.binding.runId, "retry budget stop"),
    ).resolves.toBe(true);
    expect(state.cancel).toHaveBeenNthCalledWith(2, {
      reason: "retry budget stop",
      signal: expect.any(AbortSignal),
    });

    state.release?.();
    await running;
  });

  it("observes cleanup failure after cancellation authority is committed", async () => {
    state.cancel.mockImplementationOnce(() => ({
      cleanup: Promise.reject(new Error("provider cleanup failed")),
    }));
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));

    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop"),
    ).resolves.toBe(true);

    state.release?.();
    await running;
  });

  it("binds cancellation to nativeIssueId and merges metadata under a row lock", async () => {
    const persistence = cancellationDb();

    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop", {
        db: persistence.db,
        scope: "run",
      }),
    ).resolves.toMatchObject({
      dispatched: false,
      decision: expect.any(Object),
      auditId: "native-cancellation-audit",
    });

    expect(persistence.getForUpdateCount()).toBe(2);
    const cancellationUpdate = persistence.updates
      .filter((entry) => "resultJson" in entry.values)
      .at(-1);
    expect(cancellationUpdate?.values.resultJson).toMatchObject({
      durableReceipt: { operationId: "operation-1" },
      nativeCancellation: {
        schema: "paperclip.native-cancellation.v1",
        dispatchState: "acknowledged",
        scope: "run",
        dispatched: false,
        intentAuditId: "native-cancellation-audit",
        acknowledgementAuditId: "native-cancellation-ack-audit",
      },
    });
    expect(state.persistActivity).toHaveBeenCalledWith(
      persistence.tx,
      expect.objectContaining({
        companyId: execution.binding.companyId,
        issueId: execution.binding.issueId,
        runId: execution.binding.runId,
      }),
    );
    expect(state.publishActivity).toHaveBeenCalledTimes(2);
  });

  it("recovers a post-dispatch persistence failure without cancelling the provider twice", async () => {
    const persistence = cancellationDb({ failResultJsonUpdateAt: 2 });
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));

    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop", {
        db: persistence.db,
        scope: "run",
      }),
    ).rejects.toThrow("post_dispatch_db_failure");
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(persistence.getResultJson()).toMatchObject({
      nativeCancellation: {
        dispatchState: "pending",
        dispatched: false,
        intentAuditId: "native-cancellation-audit",
      },
    });

    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop", {
        db: persistence.db,
        scope: "run",
      }),
    ).resolves.toMatchObject({
      dispatched: true,
      auditId: "native-cancellation-audit",
    });
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(persistence.getResultJsonUpdateCount()).toBe(3);
    expect(persistence.getResultJson()).toMatchObject({
      nativeCancellation: {
        dispatchState: "acknowledged",
        dispatched: true,
        intentAuditId: "native-cancellation-audit",
        acknowledgementAuditId: "native-cancellation-ack-audit",
      },
    });
    expect(
      state.persistActivity.mock.calls.filter(
        ([, input]) =>
          (input as { action?: string }).action ===
          "native.cancellation_intent_recorded",
      ),
    ).toHaveLength(1);
    const persistedActivities = state.persistActivity.mock.calls.length;
    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop", {
        db: persistence.db,
        scope: "run",
      }),
    ).resolves.toMatchObject({
      dispatched: true,
      auditId: "native-cancellation-audit",
    });
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(persistence.getResultJsonUpdateCount()).toBe(3);
    expect(state.persistActivity).toHaveBeenCalledTimes(persistedActivities);

    state.release?.();
    await running;
  });

  it("fails closed when the persisted native binding has no coordinator", async () => {
    const persistence = cancellationDb({ coordinator: null });

    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop", {
        db: persistence.db,
        scope: "run",
      }),
    ).rejects.toThrow("native_cancellation_coordinator_missing");
    expect(persistence.updates).toEqual([]);
    expect(state.persistActivity).not.toHaveBeenCalled();
  });
});

describe("native session execution lease fencing", () => {
  it("renews only when the exact fenced owner remains current", async () => {
    const returning = vi
      .fn()
      .mockResolvedValueOnce([{ runId: "run-lease" }])
      .mockResolvedValueOnce([]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) } as unknown as Db;
    const input = {
      db,
      runId: "run-lease",
      companyId: "company-lease",
      issueId: "issue-lease",
      leaseOwner: "owner-lease",
      attempt: 4,
      leaseTtlMs: 60_000,
    };

    await expect(
      renewNativeSessionExecutionLease(input),
    ).resolves.toBeUndefined();
    await expect(renewNativeSessionExecutionLease(input)).rejects.toThrow(
      "native_session_lease_lost",
    );
    expect(returning).toHaveBeenCalledTimes(2);
  });

  it("does not reacquire a provider after a durable result exists", async () => {
    state.execute.mockClear();
    state.createBackend.mockClear();
    state.createTransport.mockClear();

    await expect(
      executePaperclipNativeSession({
        db: leaseDb(execution, {
          phase: "workspace_finalizing",
          resultId: "native-result-1",
        }),
        execution,
        runnerInstanceId: "runner",
      }),
    ).rejects.toThrow("native_result_pending_finalization");
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.createBackend).not.toHaveBeenCalled();
    expect(state.createTransport).not.toHaveBeenCalled();
  });

  it.each(["pending", "acknowledged"] as const)(
    "does not reacquire a provider while durable cancellation is %s",
    async (dispatchState) => {
      state.execute.mockClear();
      state.createBackend.mockClear();
      state.createTransport.mockClear();

      await expect(
        executePaperclipNativeSession({
          db: leaseDb(
            execution,
            {},
            {
              nativeCancellation: {
                schema: "paperclip.native-cancellation.v1",
                intentId: "native-cancellation:intent-1",
                intentAuditId: "native-cancellation-audit",
                companyId: execution.binding.companyId,
                runId: execution.binding.runId,
                issueId: execution.binding.issueId,
                scope: "run",
                reasonCode: "cancellation_run_only",
                effects: ["release_run_resources"],
                dispatchState,
                dispatched: dispatchState === "acknowledged",
                decisionId: null,
              },
            },
          ),
          execution,
          runnerInstanceId: "runner",
        }),
      ).rejects.toThrow("native_cancellation_pending_recovery");
      expect(state.execute).not.toHaveBeenCalled();
      expect(state.createBackend).not.toHaveBeenCalled();
      expect(state.createTransport).not.toHaveBeenCalled();
    },
  );
});

describe("native runtime request resolution", () => {
  const capabilities = vi.fn();
  const snapshot = vi.fn();
  const resolveRuntimeRequest = vi.fn();

  beforeEach(() => {
    state.release = null;
    capabilities.mockReset().mockResolvedValue({
      runtimeRequestResolution: true,
    });
    snapshot.mockReset().mockResolvedValue({ activeTurnId: "provider-turn-1" });
    resolveRuntimeRequest.mockReset().mockResolvedValue(undefined);
    state.execute.mockReset().mockImplementation(async (options) => {
      options.onSession?.({
        capabilities,
        snapshot,
        resolveRuntimeRequest,
        cancel: vi.fn(),
      });
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
      options.onSession?.(null);
      return {
        result: { summary: "completed" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "provider-turn-1",
        normalizedSessionId: "session",
        providerSessionId: null,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      };
    });
  });

  it("revalidates lifecycle after provider reads and blocks stale dispatch", async () => {
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
    const authorizeBeforeDispatch = vi.fn(async () => {
      expect(capabilities).toHaveBeenCalledTimes(1);
      expect(snapshot).toHaveBeenCalledTimes(1);
      throw new Error("runtime_request_no_longer_pending");
    });

    await expect(
      resolveNativeRuntimeRequest({
        runId: execution.binding.runId,
        requestId: "runtime-request-1",
        turnId: "provider-turn-1",
        resolution: { action: "decline" },
        authorizeBeforeDispatch,
      }),
    ).rejects.toThrow("runtime_request_no_longer_pending");
    expect(authorizeBeforeDispatch).toHaveBeenCalledTimes(1);
    expect(resolveRuntimeRequest).not.toHaveBeenCalled();

    state.release?.();
    await running;
  });

  it("atomically joins duplicate responses and rejects a concurrent conflict", async () => {
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
    let releaseAuthorization!: () => void;
    const authorization = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const authorizeBeforeDispatch = vi.fn(() => authorization);
    const first = resolveNativeRuntimeRequest({
      runId: execution.binding.runId,
      requestId: "runtime-request-concurrent",
      turnId: "provider-turn-1",
      resolution: { action: "decline" },
      authorizeBeforeDispatch,
    });
    await vi.waitFor(() =>
      expect(authorizeBeforeDispatch).toHaveBeenCalledTimes(1),
    );
    const duplicate = resolveNativeRuntimeRequest({
      runId: execution.binding.runId,
      requestId: "runtime-request-concurrent",
      turnId: "provider-turn-1",
      resolution: { action: "decline" },
      authorizeBeforeDispatch,
    });
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));

    await expect(
      resolveNativeRuntimeRequest({
        runId: execution.binding.runId,
        requestId: "runtime-request-concurrent",
        turnId: "provider-turn-1",
        resolution: { action: "cancel" },
        authorizeBeforeDispatch,
      }),
    ).rejects.toMatchObject({
      code: "runtime_request_resolution_conflict",
    });
    expect(authorizeBeforeDispatch).toHaveBeenCalledTimes(1);
    expect(resolveRuntimeRequest).not.toHaveBeenCalled();

    releaseAuthorization();
    const [firstResult, duplicateResult] = await Promise.all([
      first,
      duplicate,
    ]);
    expect(duplicateResult.commandId).toBe(firstResult.commandId);
    expect(resolveRuntimeRequest).toHaveBeenCalledTimes(1);

    state.release?.();
    await running;
  });

  it("clears completed response reservations when the session tears down", async () => {
    const firstSession = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
    const first = await resolveNativeRuntimeRequest({
      runId: execution.binding.runId,
      requestId: "runtime-request-reused",
      turnId: "provider-turn-1",
      resolution: { action: "decline" },
      authorizeBeforeDispatch: vi.fn().mockResolvedValue(undefined),
    });
    state.release?.();
    await firstSession;

    state.release = null;
    const secondSession = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
    const second = await resolveNativeRuntimeRequest({
      runId: execution.binding.runId,
      requestId: "runtime-request-reused",
      turnId: "provider-turn-1",
      resolution: { action: "decline" },
      authorizeBeforeDispatch: vi.fn().mockResolvedValue(undefined),
    });

    expect(second.commandId).not.toBe(first.commandId);
    expect(resolveRuntimeRequest).toHaveBeenCalledTimes(2);
    (state.release as (() => void) | null)?.();
    await secondSession;
  });
});

describe("native session same-turn steering", () => {
  const capabilities = vi.fn();
  const snapshot = vi.fn();
  const steer = vi.fn();

  beforeEach(() => {
    state.release = null;
    capabilities.mockReset().mockResolvedValue({ steering: true });
    snapshot.mockReset().mockResolvedValue({ activeTurnId: "provider-turn-1" });
    steer.mockReset().mockResolvedValue(undefined);
    state.execute.mockReset().mockImplementation(async (options) => {
      options.onSession?.({ capabilities, snapshot, steer, cancel: vi.fn() });
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
      options.onSession?.(null);
      return {
        result: { summary: "completed" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "provider-turn-1",
        normalizedSessionId: "session",
        providerSessionId: null,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      };
    });
  });

  async function startActiveSession() {
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
    return { running };
  }

  it("correlates the queued comment with the active provider turn acknowledgement", async () => {
    const { running } = await startActiveSession();

    await expect(
      getNativeSessionSteeringState(execution.binding.runId),
    ).resolves.toEqual({
      disposition: "available",
      activeTurnId: "provider-turn-1",
    });
    await expect(
      steerNativeSession({
        runId: execution.binding.runId,
        message: "Check mobile overflow first.",
        correlationId: "queued-comment-1",
      }),
    ).resolves.toEqual({ turnId: "provider-turn-1" });
    expect(steer).toHaveBeenCalledWith({
      turnId: "provider-turn-1",
      message: { role: "user", text: "Check mobile overflow first." },
      correlationId: "queued-comment-1",
    });

    state.release?.();
    await running;
  });

  it.each([
    {
      label: "unsupported provider",
      prepare: () => capabilities.mockResolvedValue({ steering: false }),
      code: "steering_unsupported",
    },
    {
      label: "stale turn",
      prepare: () => snapshot.mockResolvedValue({ activeTurnId: null }),
      code: "steering_stale_turn",
    },
    {
      label: "provider rejection",
      prepare: () => steer.mockRejectedValue(new Error("request rejected")),
      code: "steering_rejected",
    },
  ])("keeps $label retryable with a stable code", async ({ prepare, code }) => {
    prepare();
    const { running } = await startActiveSession();

    const error = await steerNativeSession({
      runId: execution.binding.runId,
      message: "Retryable steering",
      correlationId: "queued-comment-error",
    }).catch((value) => value);
    expect(error).toBeInstanceOf(NativeSessionSteeringError);
    expect(error.code).toBe(code);

    state.release?.();
    await running;
  });

  it("bounds the provider acknowledgement wait", async () => {
    steer.mockReturnValue(new Promise(() => undefined));
    const { running } = await startActiveSession();

    const error = await steerNativeSession({
      runId: execution.binding.runId,
      message: "Do not wait forever",
      correlationId: "queued-comment-timeout",
      timeoutMs: 5,
    }).catch((value) => value);
    expect(error).toBeInstanceOf(NativeSessionSteeringError);
    expect(error.code).toBe("steering_timeout");

    state.release?.();
    await running;
  });
});

describe("native warm session supervision", () => {
  it("reuses one session across distinct governed runs and closes it after idle expiry", async () => {
    const close = vi.fn(async () => undefined);
    const sharedSession = { close };
    const base = {
      ...execution,
      binding: {
        ...execution.binding,
        executionWorkspaceId: "workspace",
      },
      workspace: {
        cwd: "/tmp/warm-native",
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      session: {
        normalizedSessionId: "session-warm-native",
        driverKind: "codex_app_server" as const,
        protocolVersion: 1 as const,
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 20 },
      },
    } as NativeExecutionInputV1;
    const second = {
      ...base,
      binding: { ...base.binding, runId: "run-native-warm-second" },
    };
    const result = {
      result: { summary: "completed" },
      terminal: { runTerminalState: "succeeded" },
      turnId: "turn",
      normalizedSessionId: "session-warm-native",
      providerSessionId: "provider-warm-native",
      driverKind: "test",
      driverVersion: "1",
      nativeEventCount: 1,
      highestContiguousSourceSeq: 1,
      usage: null,
    };
    state.execute
      .mockReset()
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBeUndefined();
        options.onSession?.(sharedSession);
        return result;
      })
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBe(sharedSession);
        return result;
      });

    await executePaperclipNativeSession({
      db: leaseDb(base),
      execution: base,
      runnerInstanceId: "runner",
    });
    await executePaperclipNativeSession({
      db: leaseDb(second),
      execution: second,
      runnerInstanceId: "runner",
    });
    expect(close).not.toHaveBeenCalled();
    await vi.waitFor(
      () =>
        expect(close).toHaveBeenCalledWith({
          reason: "warm native session idle timeout",
        }),
      { timeout: 500 },
    );
  });

  it("does not replace a different company's warm session with the same normalized id", async () => {
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    const base = {
      ...execution,
      binding: {
        ...execution.binding,
        companyId: "company-warm-first",
        runId: "run-warm-first",
        executionWorkspaceId: "workspace",
      },
      workspace: {
        cwd: "/tmp/warm-native-company-isolation",
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      session: {
        normalizedSessionId: "shared-company-warm-session",
        driverKind: "codex_app_server" as const,
        protocolVersion: 1 as const,
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 20 },
      },
    } as NativeExecutionInputV1;
    const second = {
      ...base,
      binding: {
        ...base.binding,
        companyId: "company-warm-second",
        runId: "run-warm-second",
      },
    };
    const result = {
      result: { summary: "completed" },
      terminal: { runTerminalState: "succeeded" },
      turnId: "turn",
      normalizedSessionId: "shared-company-warm-session",
      providerSessionId: "provider-warm-native",
      driverKind: "test",
      driverVersion: "1",
      nativeEventCount: 1,
      highestContiguousSourceSeq: 1,
      usage: null,
    };
    state.execute
      .mockReset()
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBeUndefined();
        options.onSession?.({ close: firstClose });
        return result;
      })
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBeUndefined();
        options.onSession?.({ close: secondClose });
        return result;
      });

    await executePaperclipNativeSession({
      db: leaseDb(base),
      execution: base,
      runnerInstanceId: "runner-first",
    });
    await executePaperclipNativeSession({
      db: leaseDb(second),
      execution: second,
      runnerInstanceId: "runner-second",
    });
    await vi.waitFor(() => expect(firstClose).toHaveBeenCalled(), {
      timeout: 500,
    });
    await vi.waitFor(() => expect(secondClose).toHaveBeenCalled(), {
      timeout: 500,
    });
    expect(firstClose).toHaveBeenCalledWith({
      reason: "warm native session idle timeout",
    });
    expect(secondClose).toHaveBeenCalledWith({
      reason: "warm native session idle timeout",
    });
  });

  it("replaces an idle warm provider session when its pinned permission mode changes", async () => {
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    const firstSession = { close: firstClose };
    const secondSession = { close: secondClose };
    const base = {
      ...execution,
      schema: "paperclip.native-execution-input.v4",
      provider: { kind: "codex", model: null, approvalPolicy: "never" },
      binding: {
        ...execution.binding,
        runId: "run-permission-never",
        executionWorkspaceId: "workspace",
      },
      workspace: {
        cwd: "/tmp/warm-native-permission",
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      session: {
        normalizedSessionId: "session-warm-permission",
        driverKind: "codex_app_server" as const,
        protocolVersion: 1 as const,
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 20 },
      },
      runtimeContext: { aggregateDigest: "runtime-context" },
    } as unknown as NativeExecutionInputV1;
    const lowered = {
      ...base,
      provider: { kind: "codex", model: null, approvalPolicy: "on-request" },
      binding: { ...base.binding, runId: "run-permission-on-request" },
    } as NativeExecutionInputV1;
    const result = {
      result: { summary: "completed" },
      terminal: { runTerminalState: "succeeded" },
      turnId: "turn",
      normalizedSessionId: "session-warm-permission",
      providerSessionId: "provider-warm-permission",
      driverKind: "test",
      driverVersion: "1",
      nativeEventCount: 1,
      highestContiguousSourceSeq: 1,
      usage: null,
    };
    state.execute
      .mockReset()
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBeUndefined();
        options.onSession?.(firstSession);
        return result;
      })
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBeUndefined();
        options.onSession?.(secondSession);
        return result;
      });

    await executePaperclipNativeSession({
      db: leaseDb(base),
      execution: base,
      runnerInstanceId: "runner",
    });
    await executePaperclipNativeSession({
      db: leaseDb(lowered),
      execution: lowered,
      runnerInstanceId: "runner",
    });
    expect(firstClose).toHaveBeenCalledWith({
      reason: "warm native session configuration changed",
    });
    await vi.waitFor(
      () =>
        expect(secondClose).toHaveBeenCalledWith({
          reason: "warm native session idle timeout",
        }),
      { timeout: 500 },
    );
  });
});

describe("native session bounded recovery", () => {
  it("preserves stable provider and runner failure causes", () => {
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "provider_frame_too_large: harness stdout frame exceeded 4194304 bytes",
        ),
      ),
    ).toBe("provider_frame_too_large");
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "native_runner_process_exited: runnerd exited unexpectedly with code 1",
        ),
      ),
    ).toBe("native_runner_process_exited");
    expect(
      nativeSessionFailureSourceCode(
        new Error("provider_transport_failed: invalid JSON-RPC"),
      ),
    ).toBe("provider_transport_failed");
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "planning_mode_unsupported: installed Codex app-server did not confirm plan mode",
        ),
      ),
    ).toBe("planning_mode_unsupported");
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "native_event_replay_conflict: source sequence 41 contained different bytes",
        ),
      ),
    ).toBe("native_event_replay_conflict");
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "provider_process_exited: provider=codex stage=initialize exitCode=1",
        ),
      ),
    ).toBe("provider_process_exited");
    expect(
      nativeSessionFailureSourceCode(
        new Error("provider_stdout_closed: provider=codex stage=initialize"),
      ),
    ).toBe("provider_stdout_closed");
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "provider_process_status_failed: provider=codex stage=session.open",
        ),
      ),
    ).toBe("provider_process_status_failed");
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "provider_initialize_timeout: provider=codex stage=initialize",
        ),
      ),
    ).toBe("provider_initialize_timeout");
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "provider_initialize_protocol_error: provider=codex stage=initialize",
        ),
      ),
    ).toBe("provider_initialize_protocol_error");
    expect(
      nativeSessionFailureSourceCode(
        new Error("provider_request_timeout: provider=codex stage=turn.start"),
      ),
    ).toBe("provider_request_timeout");
  });

  it("retries the same run twice and stops at the third failed attempt", () => {
    const now = new Date("2026-08-09T00:00:00.000Z");
    expect(nativeSessionFailureDisposition(1, now)).toEqual({
      phase: "retryable_failure",
      failureCode: "native_session_interrupted",
      nextAttemptAt: new Date("2026-08-09T00:00:30.000Z"),
    });
    expect(nativeSessionFailureDisposition(2, now)).toEqual({
      phase: "retryable_failure",
      failureCode: "native_session_interrupted",
      nextAttemptAt: new Date("2026-08-09T00:00:30.000Z"),
    });
    expect(nativeSessionFailureDisposition(3, now)).toEqual({
      phase: "terminal_failure",
      failureCode: "native_session_retry_exhausted",
      nextAttemptAt: null,
    });
    expect(
      nativeSessionFailureDisposition(1, now, "native_event_replay_conflict"),
    ).toEqual({
      phase: "terminal_failure",
      failureCode: "native_event_replay_conflict",
      nextAttemptAt: null,
    });
  });

  it("escalates exhausted result-less sessions to board review instead of leaving the provider as its own owner", () => {
    expect(
      nativeSessionRecoveryProjection({
        phase: "retryable_failure",
        failureCode: "native_session_interrupted",
        agentId: "agent-low-capability",
      }),
    ).toEqual({
      exhausted: false,
      issueStatus: null,
      recoveryOwner: { kind: "agent", agentId: "agent-low-capability" },
      recoveryActionOwnerType: "agent",
      recoveryActionOwnerAgentId: "agent-low-capability",
      recoveryActionCause: "native_session_interrupted",
      supersedeOnIdentityChange: true,
    });
    expect(
      nativeSessionRecoveryProjection({
        phase: "terminal_failure",
        failureCode: "native_session_retry_exhausted",
        agentId: "agent-low-capability",
      }),
    ).toEqual({
      exhausted: true,
      issueStatus: "in_review",
      recoveryOwner: { kind: "board" },
      recoveryActionOwnerType: "board",
      recoveryActionOwnerAgentId: null,
      recoveryActionCause: "native_session_retry_exhausted",
      supersedeOnIdentityChange: true,
    });
  });
});

describe("native process ownership", () => {
  it("forwards the app-server PID and process group through the production backend seam", async () => {
    const processMetadata = {
      pid: 42_001,
      processGroupId: 42_001,
      startedAt: "2026-08-18T18:00:00.000Z",
    };
    const onSpawn = vi.fn(async () => undefined);
    state.createBackend.mockClear();
    state.execute.mockReset().mockImplementation(async (options) => {
      await options.backend.onSpawn(processMetadata);
      return {
        result: { summary: "completed" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "turn",
        normalizedSessionId: "session",
        providerSessionId: null,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      };
    });
    state.createBackend.mockImplementationOnce((_input, options) => ({
      kind: "test",
      onSpawn: options.onSpawn,
    }));

    await executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
      onSpawn,
    });

    expect(state.createBackend).toHaveBeenCalledWith(
      execution,
      expect.objectContaining({
        runnerInstanceId: "runner",
        onSpawn,
      }),
    );
    expect(onSpawn).toHaveBeenCalledWith(processMetadata);
  });
});

describe("runnerd provider runtime wiring", () => {
  it("reuses legacy unscoped state only for its exact durable run identity", async () => {
    const stateBase = await mkdtemp(join(tmpdir(), "paperclip-legacy-runner-state-"));
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const legacyExecution = {
      ...execution,
      binding: {
        ...execution.binding,
        companyId: "company-legacy-state",
        runId: "run-legacy-state",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-legacy-state",
      },
    } as NativeExecutionInputV1;
    const legacyRoot = join(
      stateBase,
      createHash("sha256").update("session-legacy-state").digest("hex"),
    );
    try {
      await mkdir(join(legacyRoot, "control-plane"), { recursive: true });
      await writeFile(
        join(legacyRoot, "control-plane", "mock-core-state.json"),
        JSON.stringify({
          identity: {
            runId: "run-legacy-state",
            normalizedSessionId: "session-legacy-state",
            runnerInstanceId: "runner-legacy-state",
            environmentLeaseId: "lease-legacy-state",
          },
        }),
      );
      state.createBackend.mockClear();
      await createRunnerdBackend({
        db: leaseDb(legacyExecution),
        execution: legacyExecution,
        runnerInstanceId: "runner-legacy-state",
      });
      state.createTransport.mockClear();
      state.createBackend.mock.calls[0]![1].codexTransportFactory!();
      expect(state.createTransport.mock.calls[0]![0].stateDirectory).toBe(
        legacyRoot,
      );
      expect(state.createTransport.mock.calls[0]![0].runnerBinary).toBe(
        "/tmp/paperclip-runnerd",
      );
      expect(state.resolveRunnerBinary).toHaveBeenCalled();

      const unrelatedExecution = {
        ...legacyExecution,
        binding: {
          ...legacyExecution.binding,
          companyId: "company-unrelated-state",
          runId: "run-unrelated-state",
        },
      } as NativeExecutionInputV1;
      await createRunnerdBackend({
        db: leaseDb(unrelatedExecution),
        execution: unrelatedExecution,
        runnerInstanceId: "runner-unrelated-state",
      });
      state.createBackend.mock.calls[1]![1].codexTransportFactory!();
      expect(state.createTransport.mock.calls[1]![0].stateDirectory).not.toBe(
        legacyRoot,
      );
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it("isolates durable state and tool authority for equal session ids in different companies", async () => {
    const scopedExecution = (companyId: string, runId: string) =>
      ({
        ...execution,
        schema: "paperclip.native-execution-input.v4",
        binding: {
          ...execution.binding,
          companyId,
          runId,
          executionWorkspaceId: "workspace",
        },
        task: {
          identifier: "DOT-ISOLATION",
          title: "Isolation test",
          description: null,
          prompt: "Verify session isolation.",
          workMode: "standard",
        },
        workspace: {
          cwd: "/tmp/native-session-isolation",
          repoUrl: null,
          repoRef: null,
          branchName: null,
        },
        session: {
          normalizedSessionId: "shared-normalized-session",
          driverKind: "codex_app_server",
          protocolVersion: 1,
          lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        },
        provider: { kind: "codex", model: null, approvalPolicy: "never" },
        executionMode: "default",
        planningContext: null,
        interactionResponses: [],
        credentialBindings: [],
        runtimeContext: {},
      }) as unknown as NativeExecutionInputV1;
    const firstExecution = scopedExecution("company-first", "run-first");
    const secondExecution = scopedExecution("company-second", "run-second");
    state.createBackend.mockClear();
    state.toolAuthorityExecute
      .mockReset()
      .mockImplementation((binding: Record<string, unknown>) =>
        Promise.resolve({ runId: binding.runId }),
      );

    await createRunnerdBackend({
      db: leaseDb(firstExecution),
      execution: firstExecution,
      runnerInstanceId: "runner-first",
    });
    await createRunnerdBackend({
      db: leaseDb(secondExecution),
      execution: secondExecution,
      runnerInstanceId: "runner-second",
    });

    const firstOptions = state.createBackend.mock.calls[0]![1];
    const secondOptions = state.createBackend.mock.calls[1]![1];
    state.createTransport.mockClear();
    firstOptions.codexTransportFactory!();
    secondOptions.codexTransportFactory!();
    expect(state.createTransport.mock.calls[0]![0].stateDirectory).not.toBe(
      state.createTransport.mock.calls[1]![0].stateDirectory,
    );
    await expect(firstOptions.dynamicToolHandler!({})).resolves.toEqual({
      runId: "run-first",
    });
    await expect(secondOptions.dynamicToolHandler!({})).resolves.toEqual({
      runId: "run-second",
    });
  });

});
