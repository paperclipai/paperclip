import { describe, expect, it, vi } from "vitest";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEX_BLOCK_RESULT_OUTPUT_SCHEMA,
  CODEX_RESULT_OUTPUT_SCHEMA,
  createCodexTaskEnvelope,
  isSkilllessCodexContext,
} from "../../contracts/codex.js";
import {
  HarnessCapabilityUnavailableError,
  HarnessOperationAlreadyTerminalError,
  HarnessReconciliationError,
  HarnessStaleTurnError,
  type HarnessRuntimeRequestResolution,
} from "../../contracts/harness-driver.js";
import {
  applyPrpEvent,
  createSessionSnapshotFromMetadata,
} from "../../reducer/session-reducer.js";
import {
  validatePrpEvent,
  type PrpCapabilities,
  type PrpEvent,
  type PrpStructuredRunResult,
} from "../../protocol/replay-contract.js";
import { loadLiveConsoleConformanceFixture } from "../../protocol/live-console-fixture.js";
import {
  CodexAppServerDriver,
  createIsolatedCodexAppServerArgs,
  parseCodexTurnDiff,
} from "./codex-app-server-driver.js";
import {
  runCodexCodexTracer,
  replayPersistedCodexEvents,
  validateCodexResultProposal,
} from "../../mock-core/codex-runner.js";
import {
  CODEX_INVALID_REQUEST,
  CODEX_METHOD_NOT_FOUND,
  CodexRpcError,
  type CodexAppServerTransport,
  type CodexRpcNotification,
  type CodexRpcServerRequest,
  type CodexServerRequestHandler,
  type CodexTraceInterpretation,
} from "./app-server-transport.js";

const TEST_WORKING_DIRECTORY = resolvePath(
  fileURLToPath(new URL("../../../", import.meta.url)),
);

class TestQueue<T> implements AsyncIterable<T> {
  values: T[] = [];
  waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  closed = false;
  error: Error | null = null;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter.resolve({ value: undefined, done: true });
  }

  fail(error: Error): void {
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { value, done: false };
        if (this.error) throw this.error;
        if (this.closed) return { value: undefined, done: true };
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

class FakeCodexTransport implements CodexAppServerTransport {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  readonly sentNotifications: Array<{
    method: string;
    params?: Record<string, unknown>;
  }> = [];
  readonly traceInterpretations: CodexTraceInterpretation[] = [];
  readonly queue = new TestQueue<CodexRpcNotification>();
  handler: CodexServerRequestHandler = async () => ({});
  rejectMethods = new Map<string, Error>();
  readResponse: Record<string, unknown> | null = null;
  turnStartResponse: Promise<Record<string, unknown>> | null = null;
  goalState: Record<string, unknown> | null = null;
  confirmCollaborationMode = true;
  runtimeRequestResolver: ((input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }) => Promise<void>) | null = null;

  constructor(
    readonly threadId = "thread-1",
    readonly providerSessionId = "provider-session-1",
  ) {}

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.calls.push({ method, params: structuredClone(params) });
    const rejection = this.rejectMethods.get(method);
    if (rejection) throw rejection;
    if (method === "initialize") {
      return {
        userAgent: "codex-cli/0.132.0",
        codexHome: "/isolated/codex",
        platformFamily: "unix",
        platformOs: "linux",
      };
    }
    if (method === "collaborationMode/list") {
      return this.confirmCollaborationMode
        ? {
            data: [
              {
                name: "Plan",
                mode: "plan",
                model: "gpt-test",
                reasoning_effort: "high",
              },
            ],
          }
        : { data: [{ name: "Default", mode: "default", model: "gpt-test" }] };
    }
    if (method === "thread/start" || method === "thread/resume") {
      const planMode =
        params.permissions === "paperclip-runner-workspace-read-only";
      return {
        thread: {
          id: this.threadId,
          sessionId: this.providerSessionId,
          modelProvider: "openai",
          cwd: TEST_WORKING_DIRECTORY,
          turns: [],
          activePermissionProfile: {
            id: planMode
              ? "paperclip-runner-workspace-read-only"
              : "paperclip-runner-workspace-only",
          },
        },
        model: "gpt-test",
        modelProvider: "openai",
        cwd: TEST_WORKING_DIRECTORY,
        sandbox: { type: "workspaceWrite" },
        approvalPolicy: params.approvalPolicy,
        instructionSources: [],
      };
    }
    if (method === "turn/start") {
      return (
        this.turnStartResponse ?? {
          turn: { id: "turn-1", status: "inProgress", items: [] },
        }
      );
    }
    if (method === "thread/goal/get") return { goal: this.goalState };
    if (method === "thread/goal/set") {
      this.goalState = {
        threadId: this.threadId,
        objective:
          typeof params.objective === "string"
            ? params.objective
            : String(
                this.goalState?.objective ?? "Ship the Live console tracer",
              ),
        status: params.status ?? this.goalState?.status ?? "active",
        tokenBudget: params.tokenBudget ?? this.goalState?.tokenBudget ?? null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 2,
      };
      return { goal: this.goalState };
    }
    if (method === "thread/goal/clear") {
      this.goalState = null;
      return {};
    }
    if (method === "thread/read") {
      return (
        this.readResponse ?? {
          thread: {
            id: this.threadId,
            sessionId: this.providerSessionId,
            cwd: TEST_WORKING_DIRECTORY,
            turns: [{ id: "turn-1", status: "inProgress", items: [] }],
          },
        }
      );
    }
    return {};
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.sentNotifications.push(
      params === undefined ? { method } : { method, params },
    );
  }

  notifications(): AsyncIterable<CodexRpcNotification> {
    return this.queue;
  }

  setServerRequestHandler(handler: CodexServerRequestHandler): void {
    this.handler = handler;
  }

  async resolveRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void> {
    await this.runtimeRequestResolver?.(input);
  }

  recordTraceInterpretation(input: CodexTraceInterpretation): void {
    this.traceInterpretations.push(structuredClone(input));
  }

  async close(): Promise<void> {
    this.queue.close();
  }

  push(method: string, params: Record<string, unknown>): void {
    this.queue.push({ method, params });
  }

  pushTraced(
    method: string,
    params: Record<string, unknown>,
    sourceEventId: string,
    sourceEventType: string,
  ): void {
    this.queue.push({
      method,
      params,
      paperclipTrace: { sourceEventId, sourceEventType },
    });
  }

  invoke(request: CodexRpcServerRequest): Promise<Record<string, unknown>> {
    return this.handler(request);
  }
}

const envelope = createCodexTaskEnvelope({
  objective: "Create hello.txt with the text hello.",
  criteria: [{ id: "file", requirement: "hello.txt contains hello" }],
});

const liveConsoleFixturePath = fileURLToPath(
  new URL(
    "../../../protocol/fixtures/codex-driver/driver-conformance.json",
    import.meta.url,
  ),
);

const result: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "Created hello.txt.",
  completionClaim: {
    contractRevision: "codex-demo-v1",
    objectiveSatisfied: true,
    criteria: [
      { criterionId: "file", status: "satisfied", evidenceRefs: ["hello.txt"] },
    ],
    remainingWork: [],
  },
  evidence: [{ ref: "hello.txt" }],
  verification: [{ commandOrCheck: "read hello.txt", status: "passed" }],
  attentionRequests: [],
  artifacts: [{ kind: "file", ref: "hello.txt" }],
};

function makeDriver(
  transports: FakeCodexTransport[],
  options: Record<string, unknown> = {},
) {
  let index = 0;
  return new CodexAppServerDriver({
    taskEnvelope: envelope,
    environment: {
      PATH: "/bin",
      HOME: "/isolated/home",
      CODEX_HOME: "/isolated/codex",
      LANG: "C.UTF-8",
      PAPERCLIP_API_KEY: "must-not-pass",
      RANDOM_SKILL_PATH: "/skills/unrelated",
    },
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    transportFactory: () => transports[index++]!,
    ...options,
  });
}

async function collectUntilTerminal(
  events: AsyncIterable<PrpEvent>,
): Promise<PrpEvent[]> {
  const collected: PrpEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (
      [
        "turn.completed",
        "turn.failed",
        "turn.interrupted",
        "turn.cancelled",
      ].includes(event.eventType)
    )
      break;
  }
  return collected;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
  );
}

async function traceCompletedProposal(
  proposal: PrpStructuredRunResult | null,
  options: {
    runId?: string;
    normalizedSessionId?: string;
    capabilities?: Record<string, boolean>;
    steer?: string;
    interrupt?: boolean;
  } = {},
) {
  const transport = new FakeCodexTransport();
  const driver = makeDriver([transport], {
    capabilities: options.capabilities,
  });
  const traced = runCodexCodexTracer({
    driver,
    taskEnvelope: envelope,
    workingDirectory: TEST_WORKING_DIRECTORY,
    runId: options.runId,
    normalizedSessionId: options.normalizedSessionId,
    steer: options.steer,
    interrupt: options.interrupt,
  });
  while (!transport.calls.some((call) => call.method === "turn/start")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  transport.push("turn/started", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "inProgress" },
  });
  if (proposal !== null) {
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "answer-1",
        type: "agentMessage",
        text: JSON.stringify(proposal),
      },
    });
  }
  transport.push("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed", items: [] },
  });
  return { trace: await traced, transport };
}

describe("Codex app-server Codex driver", () => {
  it("parses a complete Codex turn diff snapshot with bounded file statistics", () => {
    expect(parseCodexTurnDiff([
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 95%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1 +1,2 @@",
      "-old",
      "+new",
      "+another",
      "diff --git a/assets/image.png b/assets/image.png",
      "Binary files a/assets/image.png and b/assets/image.png differ",
    ].join("\n"))).toEqual([
      expect.objectContaining({
        path: "src/new.ts",
        previousPath: "src/old.ts",
        operation: "rename",
        additions: 2,
        deletions: 1,
        binary: false,
      }),
      expect.objectContaining({
        path: "assets/image.png",
        operation: "modify",
        additions: null,
        deletions: null,
        binary: true,
      }),
    ]);
  });

  it("bounds aggregate Codex diffs and rejects unsafe workspace paths", () => {
    const patches = Array.from({ length: 2_001 }, (_, index) => [
      `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
      `--- a/src/file-${index}.ts`,
      `+++ b/src/file-${index}.ts`,
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"));
    expect(parseCodexTurnDiff(patches.join("\n"))).toHaveLength(2_000);

    const oversized = parseCodexTurnDiff([
      "diff --git a/src/large.ts b/src/large.ts",
      "--- a/src/large.ts",
      "+++ b/src/large.ts",
      "@@ -0,0 +1 @@",
      `+${"x".repeat(300_000)}`,
    ].join("\n"));
    expect(oversized[0]?.diff).toHaveLength(256 * 1_024);

    expect(parseCodexTurnDiff([
      "diff --git a/../../secret.txt b/../../secret.txt",
      "--- a/../../secret.txt",
      "+++ b/../../secret.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"))).toEqual([]);
  });

  it("persists process ownership before sending provider requests", async () => {
    const transport = new FakeCodexTransport();
    Object.assign(transport, {
      processInfo: () => ({
        pid: 71_001,
        processGroupId: 71_001,
        startedAt: "2026-08-18T18:00:00.000Z",
        exited: false,
        exitCode: null,
        signal: null,
      }),
    });
    let releaseOwnership!: () => void;
    const ownershipPersisted = new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    });
    const onSpawn = vi.fn(() => ownershipPersisted);
    const driver = makeDriver([transport], { onSpawn });

    const opening = driver.openSession({
      runId: "run-owned",
      normalizedSessionId: "normalized-owned",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await vi.waitFor(() => expect(onSpawn).toHaveBeenCalledOnce());
    expect(transport.calls).toEqual([]);

    releaseOwnership();
    await opening;
    expect(onSpawn).toHaveBeenCalledWith({
      pid: 71_001,
      processGroupId: 71_001,
      startedAt: "2026-08-18T18:00:00.000Z",
    });
    expect(transport.calls[0]?.method).toBe("initialize");
  });

  it("sends direct chat as plain text and permits a follow-up turn", async () => {
    const transport = new FakeCodexTransport();
    const driver = makeDriver([transport], { conversationMode: "direct" });
    const session = await driver.openSession({
      runId: "run-chat",
      normalizedSessionId: "normalized-chat",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });

    const threadStart = transport.calls.find(
      (call) => call.method === "thread/start",
    );
    expect(threadStart?.params).not.toHaveProperty("baseInstructions");
    expect(threadStart?.params.dynamicTools).toEqual([]);

    const first = await session.startTurn({
      message: { role: "user", text: "Hello Codex" },
    });
    const firstStart = transport.calls.find(
      (call) => call.method === "turn/start",
    );
    expect(firstStart?.params).not.toHaveProperty("outputSchema");
    expect(firstStart?.params.input).toEqual([
      { type: "text", text: "Hello Codex", text_elements: [] },
    ]);
    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: first.turnId, status: "inProgress" },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: first.turnId, status: "completed", items: [] },
    });
    await collectUntilTerminal(session.events());

    transport.turnStartResponse = Promise.resolve({
      turn: { id: "turn-2", status: "inProgress", items: [] },
    });
    await expect(
      session.startTurn({ message: { role: "user", text: "And a follow-up" } }),
    ).resolves.toEqual({
      turnId: "turn-2",
      effectiveCollaborationMode: "default",
    });
  });

  it("forwards the persisted native model to the runner transport", async () => {
    const transport = new FakeCodexTransport();
    const driver = makeDriver([transport], { model: "qualified-provider-model" });

    await driver.openSession({
      runId: "run-qualified-model",
      normalizedSessionId: "normalized-qualified-model",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });

    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params,
    ).toMatchObject({
      model: "qualified-provider-model",
      completionContract: {
        revision: "codex-demo-v1",
        criterionIds: ["file"],
      },
    });
  });

  it("places Paperclip runtime instructions in Codex's system channel and enables only selected skill instructions", async () => {
    const transport = new FakeCodexTransport();
    const baseInstructions = [
      "You are running as a Paperclip agent.",
      "Follow the attached AGENTS.md instructions.",
      "Read-only instruction sibling root: /paperclip/context/instructions",
    ].join("\n\n");
    const driver = makeDriver([transport], {
      baseInstructions,
      includeSkillInstructions: true,
    });

    await driver.openSession({
      runId: "run-runtime-context",
      normalizedSessionId: "normalized-runtime-context",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });

    const threadStart = transport.calls.find((call) => call.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      baseInstructions,
      config: {
        "skills.include_instructions": true,
        include_apps_instructions: false,
      },
    });
    expect(JSON.stringify(threadStart?.params.input ?? null)).not.toContain(baseInstructions);
  });

  it("passes the common typed-event contract and reports one provider turn terminal", async () => {
    const transport = new FakeCodexTransport();
    const driver = makeDriver([transport]);
    const descriptor = await driver.descriptor();
    const session = await driver.openSession({
      runId: "run-1",
      normalizedSessionId: "normalized-1",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const turn = await session.startTurn({
      message: { role: "user", text: "Do the safe task." },
    });

    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "inProgress" },
    });
    transport.push("turn/plan/updated", {
      threadId: "thread-1",
      turnId: turn.turnId,
      revision: 1,
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "inProgress" },
      ],
    });
    transport.push("turn/diff/updated", {
      threadId: "thread-1",
      turnId: turn.turnId,
      revision: 1,
      diff: [
        "diff --git a/hello.txt b/hello.txt",
        "--- a/hello.txt",
        "+++ b/hello.txt",
        "@@ -1 +1,2 @@",
        "-hello",
        "+hello world",
        "+again",
      ].join("\n"),
    });
    transport.push("turn/plan/updated", {
      threadId: "thread-1",
      turnId: turn.turnId,
      revision: 2,
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "completed" },
      ],
    });
    transport.push("item/started", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: { id: "cmd-1", type: "commandExecution", command: "printf hello" },
    });
    transport.push("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: turn.turnId,
      itemId: "cmd-1",
      delta: "hello",
    });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "file-1",
        type: "fileChange",
        changes: [{ path: "hello.txt" }],
      },
    });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "reference-1",
        type: "agentMessage",
        text: "Open [hello.txt](hello.txt).",
      },
    });
    const requestResolution = transport.invoke({
      id: "request-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: turn.turnId,
        itemId: "question-1",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.pendingRuntimeRequests?.()).toHaveLength(1);
    await session.resolveRuntimeRequest?.({
      requestId: "request-1",
      turnId: turn.turnId,
      resolution: { action: "cancel" },
    });
    expect(await requestResolution).toEqual({ answers: {} });
    transport.push("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: turn.turnId,
      tokenUsage: {
        total: { inputTokens: 10, outputTokens: 4 },
        modelContextWindow: 128000,
      },
    });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "answer-1",
        type: "agentMessage",
        text: JSON.stringify(result),
      },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(events.every((event) => validatePrpEvent(event).ok)).toBe(true);
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === "turn.completed"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === "run.terminal"),
    ).toHaveLength(0);
    const workspaceEvents = events.filter((event) => event.eventType === "workspace.change.updated");
    expect(workspaceEvents[0]?.payload).toMatchObject({
      schema: "paperclip.workspace.diff.v1",
      changeSetId: `${turn.turnId}:workspace`,
      complete: false,
      totals: { files: 1, additions: 2, deletions: 1 },
    });
    expect(workspaceEvents.at(-1)?.payload).toMatchObject({
      schema: "paperclip.workspace.diff.v1",
      complete: true,
      totals: { files: 1 },
    });
    const planEvents = events.filter((event) => event.eventType === "plan.updated");
    expect(planEvents).toHaveLength(2);
    expect(new Set(planEvents.map((event) => event.itemId))).toEqual(new Set([turn.turnId]));
    expect(planEvents.at(-1)?.payload).toMatchObject({
      planId: turn.turnId,
      revision: 2,
      complete: true,
      syncStatus: "not_applicable",
    });
    expect(
      events.find((event) => event.eventType === "workspace.diff.recorded")
        ?.payload,
    ).toMatchObject({ schema: "paperclip.workspace.diff.v1", complete: true });
    expect(
      events.find((event) => event.eventType === "workspace.file.referenced")
        ?.payload,
    ).toMatchObject({
      schema: "paperclip.workspace.file_reference.v1",
      path: "hello.txt",
    });
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "session.started",
        "turn.started",
        "item.started",
        "item.delta",
        "item.completed",
        "run.result.proposed",
        "turn.completed",
        "runtime_request.created",
        "runtime_request.resolved",
        "workspace.change.updated",
        "workspace.diff.recorded",
      ]),
    );

    const capabilities: PrpCapabilities = {
      schema: "paperclip.prp.capabilities.v1",
      sessionReusePolicy: "reuse_per_issue",
      driver: { kind: descriptor.kind, version: descriptor.version },
      steer: true,
      interrupt: true,
      resume: true,
      runtimeRequests: true,
      structuredResult: true,
      typedEvents: true,
    };
    const metadata = {
      fixtureName: "codex-conformance",
      identity: {
        schema: "paperclip.prp.identity.v1" as const,
        companyId: "company-1",
        issueId: "issue-1",
        runId: "run-1",
        environmentLeaseId: "lease-1",
        runnerInstanceId: "runner-codex",
        normalizedSessionId: "normalized-1",
      },
      capabilities,
    };
    const live = events.reduce(
      applyPrpEvent,
      createSessionSnapshotFromMetadata(metadata),
    );
    const replay = events.reduce(
      applyPrpEvent,
      createSessionSnapshotFromMetadata(metadata),
    );
    expect(live).toEqual(replay);
    expect(live.integrity).toBe("complete");
    expect(await session.usage?.()).toMatchObject({
      modelContextWindow: 128000,
    });
  });

  it("admits a strictly bound semantic result from the durable runner", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-durable-result",
      normalizedSessionId: "normalized-durable-result",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const turn = await session.startTurn({
      message: { role: "user", text: "Finish through runnerd." },
    });
    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "inProgress" },
    });
    transport.push("paperclip/runResult", {
      threadId: "thread-1",
      turnId: turn.turnId,
      itemId: "semantic-result-1",
      result,
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(
      events.find((event) => event.eventType === "run.result.proposed"),
    ).toMatchObject({ turnId: turn.turnId, itemId: "semantic-result-1" });
  });

  it("correlates rehydrated notifications with the final canonical PRP event ids", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-traced",
      normalizedSessionId: "normalized-traced",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const turn = await session.startTurn({
      message: { role: "user", text: "Trace the response." },
    });

    transport.pushTraced(
      "turn/started",
      {
        threadId: "thread-1",
        turn: { id: turn.turnId, status: "inProgress" },
      },
      "event_runner_000001",
      "turn.started",
    );
    transport.pushTraced(
      "item/started",
      {
        threadId: "thread-1",
        turnId: turn.turnId,
        item: { id: "answer-1", type: "agentMessage", phase: "final_answer" },
      },
      "event_runner_000002",
      "item.started",
    );
    transport.pushTraced(
      "turn/completed",
      {
        threadId: "thread-1",
        turn: { id: turn.turnId, status: "completed", items: [] },
      },
      "event_runner_000003",
      "turn.completed",
    );

    const events = await collectUntilTerminal(session.events());
    const itemMapping = transport.traceInterpretations.find(
      (entry) => entry.providerMethod === "item/started",
    );
    expect(itemMapping).toMatchObject({
      sourceEventId: "event_runner_000002",
      sourceEventType: "item.started",
      disposition: "mapped",
    });
    expect(itemMapping?.emittedEventIds.length).toBeGreaterThan(0);
    expect(events.map((event) => event.sourceEventId)).toEqual(
      expect.arrayContaining(itemMapping?.emittedEventIds ?? []),
    );
    expect(JSON.stringify(events)).not.toContain("paperclipTrace");
  });

  it("maps canonical workspace snapshots with monotonic revisions and one terminal diff", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-canonical-workspace",
      normalizedSessionId: "normalized-canonical-workspace",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const turn = await session.startTurn({
      message: { role: "user", text: "Change the workspace." },
    });
    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "inProgress" },
    });
    const first = {
      schema: "paperclip.workspace.diff.v1",
      changeSetId: `${turn.turnId}:workspace`,
      revision: 1,
      source: "harness_reported",
      complete: false,
      files: [{
        path: "src/index.ts",
        operation: "modify",
        previousPath: null,
        additions: 1,
        deletions: 0,
        binary: false,
        diff: "+first\n",
      }],
      totals: { files: 1, additions: 1, deletions: 0 },
      patchArtifactRef: null,
    };
    const second = {
      ...first,
      revision: 1,
      files: [
        first.files[0],
        {
          path: "src/new-name.ts",
          operation: "rename",
          previousPath: "src/old-name.ts",
          additions: 0,
          deletions: 0,
          binary: false,
          diff: "rename from src/old-name.ts\nrename to src/new-name.ts\n",
        },
        {
          path: "public/image.png",
          operation: "modify",
          previousPath: null,
          additions: null,
          deletions: null,
          binary: true,
          diff: null,
        },
      ],
      totals: { files: 3, additions: null, deletions: null },
    };
    transport.pushTraced(
      "paperclip/workspaceChange/updated",
      { threadId: "thread-1", turnId: turn.turnId, workspaceChange: first },
      "event_workspace_1",
      "workspace.change.updated",
    );
    transport.pushTraced(
      "paperclip/workspaceChange/updated",
      { threadId: "thread-1", turnId: turn.turnId, workspaceChange: second },
      "event_workspace_2",
      "workspace.change.updated",
    );
    transport.push("paperclip/workspaceChange/updated", {
      threadId: "thread-1",
      turnId: turn.turnId,
      workspaceChange: second,
    });
    transport.push("paperclip/workspaceChange/updated", {
      threadId: "thread-1",
      turnId: turn.turnId,
      workspaceChange: {
        ...second,
        files: [{ ...second.files[0], path: "/absolute/not-allowed.ts" }],
      },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    const updates = events.filter(
      (event) => event.eventType === "workspace.change.updated",
    );
    expect(
      updates.map(
        (event) => (event.payload as Record<string, unknown>).revision,
      ),
    ).toEqual([1, 2]);
    expect(
      (updates[1]?.payload as Record<string, unknown>).files,
    ).toHaveLength(3);
    expect(events.filter((event) => event.eventType === "workspace.diff.recorded"))
      .toHaveLength(1);
    expect(
      events.find((event) => event.eventType === "workspace.diff.recorded")?.payload,
    ).toMatchObject({
      revision: 2,
      source: "runner_verified",
      complete: true,
      totals: { files: 3, additions: null, deletions: null },
    });
    expect(
      transport.traceInterpretations.filter((entry) =>
        entry.providerMethod === "paperclip/workspaceChange/updated"
      ).map((entry) => entry.disposition),
    ).toEqual(["mapped", "mapped"]);
  });

  it("finalizes an authoritative empty workspace snapshot when a turn is interrupted", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-empty-interrupted-workspace",
      normalizedSessionId: "normalized-empty-interrupted-workspace",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const turn = await session.startTurn({
      message: { role: "user", text: "Inspect without changing files." },
    });
    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "inProgress" },
    });
    transport.push("paperclip/workspaceChange/updated", {
      threadId: "thread-1",
      turnId: turn.turnId,
      workspaceChange: {
        schema: "paperclip.workspace.diff.v1",
        changeSetId: `${turn.turnId}:workspace`,
        revision: 1,
        source: "harness_reported",
        complete: false,
        files: [],
        totals: { files: 0, additions: 0, deletions: 0 },
        patchArtifactRef: null,
      },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "interrupted", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(events.find((event) => event.eventType === "workspace.change.updated")?.payload)
      .toMatchObject({ revision: 1, complete: false, totals: { files: 0 } });
    expect(events.filter((event) => event.eventType === "workspace.diff.recorded"))
      .toHaveLength(1);
    expect(events.find((event) => event.eventType === "workspace.diff.recorded")?.payload)
      .toMatchObject({ revision: 1, source: "runner_verified", complete: true, totals: { files: 0 } });
    expect(events.some((event) => event.eventType === "turn.interrupted")).toBe(true);
  });

  it("accepts a thread usage snapshot replayed before a resumed turn starts", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-usage-replay",
      normalizedSessionId: "normalized-usage-replay",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });

    transport.push("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "prior-turn",
      tokenUsage: { total: { inputTokens: 10, outputTokens: 4 } },
    });
    const turn = await session.startTurn({
      message: { role: "user", text: "Continue." },
    });
    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "inProgress" },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(events.some((event) => event.eventType === "session.failed")).toBe(
      false,
    );
    expect(await session.usage()).toMatchObject({
      total: { inputTokens: 10, outputTokens: 4 },
    });
  });

  it("normalizes provider message and reasoning phases onto every streamed item event", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-stream-channels",
      normalizedSessionId: "normalized-stream-channels",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const turn = await session.startTurn({
      message: { role: "user", text: "Stream progress." },
    });
    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "inProgress" },
    });
    transport.push("item/started", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "progress-1",
        type: "agentMessage",
        phase: "commentary",
        text: "",
      },
    });
    transport.push("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: turn.turnId,
      itemId: "progress-1",
      delta: "Running it now.",
    });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "progress-1",
        type: "agentMessage",
        phase: "commentary",
        text: "Running it now.",
      },
    });
    transport.push("item/started", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: { id: "reason-1", type: "reasoning", summary: [] },
    });
    transport.push("item/reasoning/summaryTextDelta", {
      threadId: "thread-1",
      turnId: turn.turnId,
      itemId: "reason-1",
      delta: "Summary",
    });
    transport.push("item/reasoning/textDelta", {
      threadId: "thread-1",
      turnId: turn.turnId,
      itemId: "reason-1",
      delta: "Detail",
    });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "reason-1",
        type: "reasoning",
        summary: [{ text: "Summary" }],
      },
    });
    transport.push("item/started", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "final-1",
        type: "agentMessage",
        phase: "final_answer",
        text: "",
      },
    });
    transport.push("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: turn.turnId,
      itemId: "final-1",
      delta: JSON.stringify(result),
    });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "final-1",
        type: "agentMessage",
        phase: "final_answer",
        text: JSON.stringify(result),
      },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    const pick = (kind: string, channel: string) =>
      events.find(
        (event) =>
          event.payload.kind === kind && event.payload.channel === channel,
      );
    expect(pick("agentMessage", "progress")?.payload).toMatchObject({
      providerPhase: "commentary",
    });
    expect(
      events.find(
        (event) =>
          event.eventType === "item.delta" &&
          event.payload.channel === "progress",
      )?.payload,
    ).toMatchObject({
      providerMethod: "item/agentMessage/delta",
      text: "Running it now.",
    });
    expect(
      events.find(
        (event) =>
          event.eventType === "item.delta" &&
          event.payload.channel === "summary",
      )?.payload,
    ).toMatchObject({ providerMethod: "item/reasoning/summaryTextDelta" });
    expect(
      events.find(
        (event) =>
          event.eventType === "item.delta" &&
          event.payload.channel === "detail",
      )?.payload,
    ).toMatchObject({ providerMethod: "item/reasoning/textDelta" });
    expect(pick("agentMessage", "final")?.payload).toMatchObject({
      providerPhase: "final_answer",
    });
  });

  it("captures an exact skillless model/environment snapshot with credentials absent", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-context",
      normalizedSessionId: "normalized-context",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    const first = await iterator.next();
    const context = first.value?.payload.context as Parameters<
      typeof isSkilllessCodexContext
    >[0];
    expect(context).toMatchObject({
      codexVersion: "codex-cli/0.132.0",
      model: "gpt-test",
      modelProvider: "openai",
      workingDirectory: TEST_WORKING_DIRECTORY,
      approvalPolicy: "never",
      instructionSources: [],
      instructionPolicy: {
        skillInstructions: false,
        appInstructions: false,
        collaborationInstructions: true,
      },
      environmentKeys: ["LANG", "PATH"],
      envelope,
    });
    expect(isSkilllessCodexContext(context)).toBe(true);
    expect(JSON.stringify(context)).not.toContain("must-not-pass");
    expect(JSON.stringify(transport.calls)).not.toContain("RANDOM_SKILL_PATH");
    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params,
    ).toMatchObject({
      approvalPolicy: "never",
      config: {
        "skills.include_instructions": false,
        include_apps_instructions: false,
        include_collaboration_mode_instructions: true,
        "features.image_generation": false,
      },
      permissions: "paperclip-runner-workspace-only",
      runtimeWorkspaceRoots: [TEST_WORKING_DIRECTORY],
      dynamicTools: [{ name: "paperclip_finish" }, { name: "paperclip_block" }],
    });
    const commandPolicy = transport.calls.find(
      (call) => call.method === "thread/start",
    )?.params.config as Record<string, unknown>;
    expect(JSON.stringify(commandPolicy)).not.toContain("/isolated/home");
    expect(JSON.stringify(commandPolicy)).not.toContain("/isolated/codex");
    expect(JSON.stringify(commandPolicy)).not.toContain("CODEX_HOME");
    const appServerArgs = createIsolatedCodexAppServerArgs({
      PATH: "/bin",
      LANG: "C.UTF-8",
      HOME: "/isolated/home",
      CODEX_HOME: "/isolated/codex",
    });
    expect(appServerArgs).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'default_permissions="paperclip-runner-workspace-only"',
        ),
        expect.stringContaining(
          "permissions.paperclip-runner-workspace-only.filesystem=",
        ),
        "permissions.paperclip-runner-workspace-only.network.enabled=false",
        'shell_environment_policy.inherit="none"',
        expect.stringContaining(
          'shell_environment_policy.set={PATH="/bin",LANG="C.UTF-8"}',
        ),
        "--disable",
        "image_generation",
      ]),
    );
    expect(
      appServerArgs.find((arg) => arg.startsWith("permissions.")),
    ).toContain('"/isolated/home"="none"');
    expect(
      appServerArgs.find((arg) => arg.startsWith("permissions.")),
    ).toContain('"/isolated/codex"="none"');
    expect(JSON.stringify(appServerArgs)).not.toContain("HOME=");
    expect(CODEX_RESULT_OUTPUT_SCHEMA.properties.schema).toEqual({
      type: "string",
      const: "paperclip.run_result.v1",
    });
    expect(
      CODEX_BLOCK_RESULT_OUTPUT_SCHEMA.properties.reportedWorkDisposition,
    ).toEqual({
      type: "string",
      const: "blocked",
    });
  });

  it.each(["never", "on-request", "untrusted"] as const)(
    "pins approval policy %s for both thread start and resume",
    async (approvalPolicy) => {
      const first = new FakeCodexTransport();
      const second = new FakeCodexTransport();
      const driver = makeDriver([first, second], { approvalPolicy });
      const original = await driver.openSession({
        runId: `run-policy-${approvalPolicy}`,
        normalizedSessionId: `normalized-policy-${approvalPolicy}`,
        workingDirectory: TEST_WORKING_DIRECTORY,
      });
      const started = await original.events()[Symbol.asyncIterator]().next();
      const snapshot = await original.snapshot();
      await original.close({ reason: "policy recovery test" });
      const recovered = await driver.recoverSession?.(snapshot);
      expect(recovered).toMatchObject({ recovered: true });
      const resumed = await recovered!.session!.events()[Symbol.asyncIterator]().next();
      expect(first.calls.find((call) => call.method === "thread/start")?.params)
        .toMatchObject({ approvalPolicy });
      expect(second.calls.find((call) => call.method === "thread/resume")?.params)
        .toMatchObject({ approvalPolicy });
      expect(started.value).toMatchObject({ eventType: "session.started", payload: { context: { approvalPolicy } } });
      expect(resumed.value).toMatchObject({ eventType: "session.resumed", payload: { context: { approvalPolicy } } });
      await recovered?.session?.close({ reason: "policy recovery complete" });
    },
  );

  it("allows eval fixtures to opt out of Codex collaboration instructions", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport], {
      includeCollaborationModeInstructions: false,
    }).openSession({
      runId: "run-no-collaboration-instructions",
      normalizedSessionId: "session-no-collaboration-instructions",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const first = await session.events()[Symbol.asyncIterator]().next();

    expect(first.value?.payload.context).toMatchObject({
      instructionPolicy: { collaborationInstructions: false },
    });
    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params,
    ).toMatchObject({
      config: { include_collaboration_mode_instructions: false },
    });
  });

  it("negotiates genuine plan mode with collaboration instructions and read-only workspace access", async () => {
    const transport = new FakeCodexTransport();
    const driver = makeDriver([transport], {
      requestedCollaborationMode: "plan",
    });
    const session = await driver.openSession({
      runId: "run-plan",
      normalizedSessionId: "session-plan",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params,
    ).toMatchObject({
      permissions: "paperclip-runner-workspace-read-only",
      config: { include_collaboration_mode_instructions: true },
    });
    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params,
    ).not.toHaveProperty("collaborationMode");
    expect(
      transport.calls.some((call) => call.method === "collaborationMode/list"),
    ).toBe(true);
    await expect(
      session.startTurn({
        message: { role: "user", text: "Author a plan." },
        requestedCollaborationMode: "plan",
      }),
    ).resolves.toMatchObject({ effectiveCollaborationMode: "plan" });
    expect(
      transport.calls.find((call) => call.method === "turn/start")?.params,
    ).toMatchObject({
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-test",
          reasoning_effort: "high",
          developer_instructions: null,
        },
      },
      permissions: "paperclip-runner-workspace-read-only",
    });
  });

  it("fails closed when the installed app-server does not confirm plan mode", async () => {
    const transport = new FakeCodexTransport();
    transport.confirmCollaborationMode = false;
    await expect(
      makeDriver([transport], {
        requestedCollaborationMode: "plan",
      }).openSession({
        runId: "run-plan-unsupported",
        normalizedSessionId: "session-plan-unsupported",
        workingDirectory: TEST_WORKING_DIRECTORY,
      }),
    ).rejects.toThrow("planning_mode_unsupported");
  });

  it("refuses to turn host credential roots into model-writable workspaces", async () => {
    await expect(
      makeDriver([], {
        environment: {
          PATH: "/bin",
          HOME: "/isolated/home",
          CODEX_HOME: TEST_WORKING_DIRECTORY,
        },
      }).openSession({
        runId: "run-codex-home",
        normalizedSessionId: "normalized-codex-home",
        workingDirectory: TEST_WORKING_DIRECTORY,
      }),
    ).rejects.toThrow("cannot overlap host CODEX_HOME");
    await expect(
      makeDriver([], {
        environment: {
          PATH: "/bin",
          HOME: TEST_WORKING_DIRECTORY,
          CODEX_HOME: "/isolated/codex",
        },
      }).openSession({
        runId: "run-host-home",
        normalizedSessionId: "normalized-host-home",
        workingDirectory: TEST_WORKING_DIRECTORY,
      }),
    ).rejects.toThrow("cannot contain the host HOME");
    await expect(
      makeDriver([]).openSession({
        runId: "run-root",
        normalizedSessionId: "normalized-root",
        workingDirectory: "/",
      }),
    ).rejects.toThrow("cannot be a filesystem root");
  });

  it("steers and interrupts an active turn without replacing the session", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-controls",
      normalizedSessionId: "normalized-controls",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Start." },
    });
    await session.steer?.({
      turnId,
      message: { role: "user", text: "Use a shorter answer." },
    });
    await session.interrupt?.({ turnId, reason: "operator requested" });
    expect(transport.calls.map((call) => call.method)).toEqual([
      "initialize",
      "thread/start",
      "thread/goal/get",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
    ]);
    expect(session.ids()).toEqual({
      driverSessionId: "thread-1",
      providerSessionId: "provider-session-1",
      displayId: "thread-1",
    });
  });

  it("loads the deterministic Live console wire fixture", async () => {
    const fixture = await loadLiveConsoleConformanceFixture(
      liveConsoleFixturePath,
    );
    expect(
      fixture.runtimeRequests.map(({ requestKind }) => requestKind),
    ).toEqual([
      "command_approval",
      "file_approval",
      "permission_approval",
      "user_input",
      "elicitation",
    ]);
    expect(fixture.goals.map(({ action }) => action)).toEqual([
      "get",
      "set",
      "pause",
      "resume",
      "clear",
    ]);
  });

  it("holds browser-resolved upstream requests and returns the exact fixture responses", async () => {
    const fixture = await loadLiveConsoleConformanceFixture(
      liveConsoleFixturePath,
    );
    for (const scenario of fixture.runtimeRequests) {
      const transport = new FakeCodexTransport();
      const session = await makeDriver([transport]).openSession({
        runId: `run-${scenario.id}`,
        normalizedSessionId: `normalized-${scenario.id}`,
        workingDirectory: TEST_WORKING_DIRECTORY,
      });
      const { turnId } = await session.startTurn({
        message: { role: "user", text: "Exercise request." },
      });
      const response = transport.invoke({
        id: scenario.id,
        method: scenario.method,
        params: {
          threadId: "thread-1",
          turnId,
          itemId: `item-${scenario.id}`,
          reason: `fixture ${scenario.id}`,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(session.pendingRuntimeRequests?.()).toEqual([
        expect.objectContaining({
          requestId: scenario.id,
          requestKind: scenario.requestKind,
          method: scenario.method,
          turnId,
        }),
      ]);
      await expect(
        session.resolveRuntimeRequest?.({
          requestId: scenario.id,
          turnId,
          resolution: {
            action: "forged",
          } as unknown as HarnessRuntimeRequestResolution,
        }),
      ).rejects.toThrow("unsupported action");
      expect(session.pendingRuntimeRequests?.()).toHaveLength(1);
      await session.resolveRuntimeRequest?.({
        requestId: scenario.id,
        turnId,
        resolution: scenario.resolution as HarnessRuntimeRequestResolution,
      });
      expect(await response).toEqual(scenario.expectedResponse);
      expect(session.pendingRuntimeRequests?.()).toEqual([]);
      await expect(
        session.resolveRuntimeRequest?.({
          requestId: scenario.id,
          turnId,
          resolution: { action: "cancel" },
        }),
      ).rejects.toBeInstanceOf(HarnessCapabilityUnavailableError);
      await session.close({ reason: "fixture complete" });
    }
  });

  it("acknowledges same-turn steering and rejects stale or child steering", async () => {
    const fixture = await loadLiveConsoleConformanceFixture(
      liveConsoleFixturePath,
    );
    const transport = new FakeCodexTransport("thread-root");
    const session = await makeDriver([transport]).openSession({
      runId: "run-live-console-controls",
      normalizedSessionId: "normalized-live-console-controls",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Start." },
    });
    await session.steer?.({
      turnId,
      message: { role: "user", text: "Stay concise." },
      correlationId: "queued-comment-1",
    });
    transport.push("item/completed", {
      kind: "steering_acknowledgement",
      status: "acknowledged",
      commandId: "runnerd-steer-command",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.steer?.({
      turnId,
      message: { role: "user", text: "Stay concise." },
      correlationId: "queued-comment-1",
    });
    expect(
      transport.calls.find((call) => call.method === "turn/steer")?.params,
    ).toMatchObject({ correlationId: "queued-comment-1" });
    expect(
      transport.calls.filter((call) => call.method === "turn/steer"),
    ).toHaveLength(1);
    transport.rejectMethods.set(
      "turn/steer",
      new Error("provider rejected steering"),
    );
    const rejectedSteering = await session
      .steer?.({
        turnId,
        message: { role: "user", text: "Try this again later." },
        correlationId: "queued-comment-2",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejectedSteering).toBeInstanceOf(Error);
    expect(rejectedSteering).not.toBeInstanceOf(
      HarnessCapabilityUnavailableError,
    );
    expect(String(rejectedSteering)).toContain("provider rejected steering");
    transport.rejectMethods.delete("turn/steer");
    await expect(
      session.steer?.({
        turnId: fixture.controls.staleTurnSteer.turnId!,
        message: { role: "user", text: "Stale." },
      }),
    ).rejects.toBeInstanceOf(HarnessStaleTurnError);
    transport.push("thread/started", { thread: fixture.lineage.childThread });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.lineage?.()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: "thread-root",
          parentThreadId: null,
          depth: 0,
        }),
        expect.objectContaining({
          threadId: "thread-child",
          parentThreadId: "thread-root",
          depth: 1,
          nickname: "Scout",
          role: "researcher",
        }),
      ]),
    );
    await expect(
      session.steer?.({
        turnId: "thread-child",
        message: { role: "user", text: "Do not emulate child steering." },
      }),
    ).rejects.toBeInstanceOf(HarnessStaleTurnError);
    const events = session.events()[Symbol.asyncIterator]();
    const observed: PrpEvent[] = [];
    for (let index = 0; index < 9; index += 1) {
      const next = await events.next();
      if (next.done) break;
      observed.push(next.value);
    }
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "item.completed",
          itemId: `${turnId}:steer:queued-comment-1`,
          payload: expect.objectContaining({
            kind: "steering_acknowledgement",
            status: "acknowledged",
          }),
        }),
        expect.objectContaining({
          eventType: "harness.diagnostic",
          payload: expect.objectContaining({ code: "stale_turn_rejected" }),
        }),
        expect.objectContaining({
          eventType: "item.started",
          payload: expect.objectContaining({ kind: "thread_lineage" }),
        }),
      ]),
    );
    expect(observed.some((event) => event.eventType === "session.failed"))
      .toBe(false);
    await session.close({ reason: "fixture complete" });
  });

  it("queues an interrupt before turn identity and reports a terminal race precisely", async () => {
    const transport = new FakeCodexTransport();
    let releaseStart!: (value: Record<string, unknown>) => void;
    transport.turnStartResponse = new Promise((resolve) => {
      releaseStart = resolve;
    });
    const session = await makeDriver([transport]).openSession({
      runId: "run-interrupt-races",
      normalizedSessionId: "normalized-interrupt-races",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const starting = session.startTurn({
      message: { role: "user", text: "Start slowly." },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.interrupt?.({ reason: "operator" });
    releaseStart({ turn: { id: "turn-1", status: "inProgress", items: [] } });
    await expect(starting).resolves.toEqual({
      turnId: "turn-1",
      effectiveCollaborationMode: "default",
    });
    expect(transport.calls.map(({ method }) => method)).toEqual(
      expect.arrayContaining(["turn/start", "turn/interrupt"]),
    );
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", items: [] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      session.interrupt?.({ turnId: "turn-1" }),
    ).rejects.toBeInstanceOf(HarnessOperationAlreadyTerminalError);
    await session.close({ reason: "fixture complete" });
  });

  it("maps all goal operations and advertises an exact unsupported state", async () => {
    const fixture = await loadLiveConsoleConformanceFixture(
      liveConsoleFixturePath,
    );
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-goals",
      normalizedSessionId: "normalized-goals",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await session.goal?.({ action: "get" });
    await session.goal?.({
      action: "set",
      objective: "Ship the Live console tracer",
      tokenBudget: 4096,
    });
    await session.goal?.({ action: "pause" });
    await session.goal?.({ action: "resume" });
    await session.goal?.({ action: "clear" });
    const goalCalls = transport.calls.filter(({ method }) =>
      method.startsWith("thread/goal/"),
    );
    expect(
      goalCalls.slice(1).map(({ method, params }) => ({
        method,
        params: Object.fromEntries(
          Object.entries(params).filter(([key]) => key !== "threadId"),
        ),
      })),
    ).toEqual(fixture.goals.map(({ method, params }) => ({ method, params })));

    expect(
      (await makeDriver([new FakeCodexTransport()]).descriptor()).capabilities,
    ).toMatchObject({ goals: true });

    // Both denials a real app-server sends: the method is absent, and the
    // build has the feature switched off.
    for (const denial of [
      new CodexRpcError(
        '{"code":-32601,"message":"method not found"}',
        CODEX_METHOD_NOT_FOUND,
      ),
      new CodexRpcError(
        '{"code":-32600,"message":"goals feature is disabled"}',
        CODEX_INVALID_REQUEST,
      ),
    ]) {
      const unsupportedTransport = new FakeCodexTransport();
      unsupportedTransport.rejectMethods.set("thread/goal/get", denial);
      const unsupportedDriver = makeDriver([unsupportedTransport]);
      const unsupported = await unsupportedDriver.openSession({
        runId: "run-goals-unsupported",
        normalizedSessionId: "normalized-goals-unsupported",
        workingDirectory: TEST_WORKING_DIRECTORY,
      });
      expect((await unsupportedDriver.descriptor()).capabilities).toMatchObject(
        { goals: false },
      );
      await expect(
        unsupported.goal?.({ action: "get" }),
      ).rejects.toBeInstanceOf(HarnessCapabilityUnavailableError);
      await unsupported.close({ reason: "fixture complete" });
    }
    await session.close({ reason: "fixture complete" });
  });

  it("keeps goal support advertised when the probe fails transiently", async () => {
    // A transport or protocol failure is evidence about this call, not about
    // what the provider implements, so it must not retire the capability.
    for (const failure of [
      new Error("codex app-server transport closed"),
      new CodexRpcError('{"code":-32603,"message":"internal error"}', -32_603),
    ]) {
      const transport = new FakeCodexTransport();
      transport.rejectMethods.set("thread/goal/get", failure);
      const driver = makeDriver([transport]);
      const session = await driver.openSession({
        runId: "run-goals-transient",
        normalizedSessionId: "normalized-goals-transient",
        workingDirectory: TEST_WORKING_DIRECTORY,
      });

      expect((await driver.descriptor()).capabilities).toMatchObject({
        goals: true,
      });
      // The capability survives, so the operation is still offered and the
      // next call reaches the provider instead of failing closed locally.
      transport.rejectMethods.delete("thread/goal/get");
      await expect(session.goal?.({ action: "get" })).resolves.toBeNull();
      expect(
        transport.calls.filter(({ method }) => method === "thread/goal/get"),
      ).toHaveLength(2);
      await session.close({ reason: "fixture complete" });
    }
  });

  it("validates runtime request resolutions against the kind of request they answer", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-resolution-shapes",
      normalizedSessionId: "normalized-resolution-shapes",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Ask me things." },
    });

    // Not `async`: an async function would flatten and await the pending
    // provider response, which only settles once the request is resolved.
    function open(
      id: string,
      method: string,
    ): Promise<Record<string, unknown>> {
      return transport.invoke({
        id,
        method,
        params: {
          threadId: "thread-1",
          turnId,
          itemId: `item-${id}`,
          reason: `fixture ${id}`,
        },
      });
    }
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

    const userInput = open("ask-input", "item/tool/requestUserInput");
    await settled();
    for (const resolution of [
      { action: "submit" },
      { action: "submit", answers: {} },
      { action: "submit", answers: { field: {} } },
      { action: "submit", answers: { field: { answers: [7] } } },
      { action: "submit", content: { answer: "wrong shape" } },
      { action: "accept" },
    ]) {
      await expect(
        session.resolveRuntimeRequest?.({
          requestId: "ask-input",
          turnId,
          resolution: resolution as unknown as HarnessRuntimeRequestResolution,
        }),
      ).rejects.toThrow(/user_input rejected its resolution/);
      // A rejected resolution must leave the request answerable.
      expect(session.pendingRuntimeRequests?.()).toHaveLength(1);
    }
    await session.resolveRuntimeRequest?.({
      requestId: "ask-input",
      turnId,
      resolution: {
        action: "submit",
        answers: { field: { answers: ["staging"] } },
      },
    });
    expect(await userInput).toEqual({
      answers: { field: { answers: ["staging"] } },
    });

    const elicitation = open(
      "ask-elicitation",
      "mcpServer/elicitation/request",
    );
    await settled();
    for (const resolution of [
      { action: "submit" },
      { action: "submit", content: {} },
      { action: "submit", answers: { field: { answers: ["wrong shape"] } } },
      { action: "accept_for_session" },
    ]) {
      await expect(
        session.resolveRuntimeRequest?.({
          requestId: "ask-elicitation",
          turnId,
          resolution: resolution as unknown as HarnessRuntimeRequestResolution,
        }),
      ).rejects.toThrow(/elicitation rejected its resolution/);
      expect(session.pendingRuntimeRequests?.()).toHaveLength(1);
    }
    await session.resolveRuntimeRequest?.({
      requestId: "ask-elicitation",
      turnId,
      resolution: { action: "submit", content: { answer: "green" } },
    });
    expect(await elicitation).toEqual({
      action: "accept",
      content: { answer: "green" },
      _meta: null,
    });

    const approval = open(
      "ask-approval",
      "item/commandExecution/requestApproval",
    );
    await settled();
    await expect(
      session.resolveRuntimeRequest?.({
        requestId: "ask-approval",
        turnId,
        resolution: {
          action: "submit",
          answers: { field: { answers: ["nope"] } },
        } as unknown as HarnessRuntimeRequestResolution,
      }),
    ).rejects.toThrow(/command_approval rejected its resolution/);
    await session.resolveRuntimeRequest?.({
      requestId: "ask-approval",
      turnId,
      resolution: { action: "accept" },
    });
    expect(await approval).toEqual({ decision: "accept" });
    await session.close({ reason: "fixture complete" });
  });

  it("replays the DOT-185 requestUserInput shape as one canonical three-question request", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-dot-185",
      normalizedSessionId: "normalized-dot-185",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Ask the deployment questions." },
    });
    const resolvedEvent = (async () => {
      for await (const event of session.events()) {
        if (event.eventType === "runtime_request.resolved"
          && event.payload.requestId === "dot-185-request") return event;
      }
      return null;
    })();
    const nativeResponse = transport.invoke({
      id: "dot-185-request",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "dot-185-item",
        questions: [
          {
            id: "environment",
            header: "Environment",
            question: "Where should we deploy?",
            options: [
              { label: "Staging", description: "Deploy to staging first." },
              { label: "Production", description: "Deploy directly to production." },
            ],
            isOther: true,
          },
          {
            id: "regions",
            header: "Regions",
            question: "Which regions should receive the release?",
            options: [{ label: "US" }, { label: "EU" }],
            multiSelect: true,
          },
          {
            id: "notes",
            header: "Notes",
            question: "Anything else we should know?",
            required: false,
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [pending] = session.pendingRuntimeRequests?.() ?? [];
    expect(pending?.input).toMatchObject({
      schema: "paperclip.question_set.v1",
      questions: [
        {
          id: "environment",
          required: false,
          answerMode: "single_select",
          customAnswer: { enabled: true },
          options: [
            { id: "option-1", label: "Staging", description: "Deploy to staging first." },
            { id: "option-2", label: "Production", description: "Deploy directly to production." },
          ],
        },
        { id: "regions", answerMode: "multi_select", required: false },
        { id: "notes", answerMode: "text", required: false },
      ],
    });
    await session.resolveRuntimeRequest?.({
      requestId: "dot-185-request",
      turnId,
      resolution: {
        action: "submit",
        response: {
          schema: "paperclip.question_response.v1",
          answers: {
            environment: { selectedOptionIds: ["option-1"] },
            regions: { selectedOptionIds: ["option-1", "option-2"] },
            notes: { text: "Ship during the maintenance window." },
          },
        },
      },
    });
    expect(await nativeResponse).toEqual({
      answers: {
        environment: { answers: ["Staging"] },
        regions: { answers: ["US", "EU"] },
        notes: { answers: ["Ship during the maintenance window."] },
      },
    });
    expect((await resolvedEvent)?.payload).toMatchObject({
      action: "submit",
      response: {
        schema: "paperclip.question_response.v1",
        answers: {
          environment: { selectedOptionIds: ["option-1"] },
          regions: { selectedOptionIds: ["option-1", "option-2"] },
          notes: { text: "Ship during the maintenance window." },
        },
      },
    });
    await session.close({ reason: "fixture complete" });
  });

  it("rejects an explicit malformed Codex form without falling back to v1", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-malformed-input",
      normalizedSessionId: "normalized-malformed-input",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Ask a malformed question." },
    });
    const diagnostic = (async () => {
      for await (const event of session.events()) {
        if (event.eventType === "harness.diagnostic" && event.payload.code === "runtime_input_rejected") {
          return event;
        }
      }
      return null;
    })();
    await expect(transport.invoke({
      id: "malformed-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "malformed-item",
        questions: [
          { id: "duplicate", question: "First?" },
          { id: "duplicate", question: "Second?" },
        ],
      },
    })).resolves.toEqual({ answers: {} });
    expect(session.pendingRuntimeRequests?.()).toEqual([]);
    expect(await diagnostic).toEqual(expect.objectContaining({
      eventType: "harness.diagnostic",
      payload: expect.objectContaining({
        code: "runtime_input_rejected",
        adapter: "codex-app-server",
      }),
    }));
    await session.close({ reason: "fixture complete" });
  });

  it("emits one canonical outcome payload for every terminal runtime request fact", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-outcome",
      normalizedSessionId: "normalized-outcome",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const events: PrpEvent[] = [];
    void (async () => {
      for await (const event of session.events()) events.push(event);
    })();
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Approve this." },
    });
    const resolved = transport.invoke({
      id: "outcome-resolved",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "item-resolved",
        reason: "approve",
      },
    });
    const cancelled = transport.invoke({
      id: "outcome-cancelled",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "item-cancelled",
        reason: "approve",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.resolveRuntimeRequest?.({
      requestId: "outcome-resolved",
      turnId,
      resolution: { action: "accept_for_session" },
    });
    await resolved;
    await session.close({ reason: "operator_closed" });
    await cancelled;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const terminal = events.filter(
      ({ eventType }) =>
        eventType === "runtime_request.resolved" ||
        eventType === "runtime_request.cancelled",
    );
    expect(
      terminal.map(({ eventType, turnId, itemId, payload }) => ({
        eventType,
        turnId,
        itemId,
        payload,
      })),
    ).toEqual([
      {
        eventType: "runtime_request.resolved",
        turnId,
        itemId: "item-resolved",
        payload: {
          requestId: "outcome-resolved",
          requestKind: "command_approval",
          turnId,
          itemId: "item-resolved",
          action: "accept_for_session",
        },
      },
      {
        eventType: "runtime_request.cancelled",
        turnId,
        itemId: "item-cancelled",
        payload: {
          requestId: "outcome-cancelled",
          requestKind: "command_approval",
          turnId,
          itemId: "item-cancelled",
          reason: "session_closed",
        },
      },
    ]);
    for (const event of terminal) expect(validatePrpEvent(event).ok).toBe(true);
  });

  it("expires a canonical input with its full question set when the provider transport is lost", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-provider-loss",
      normalizedSessionId: "normalized-provider-loss",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const events: PrpEvent[] = [];
    const consume = (async () => {
      for await (const event of session.events()) events.push(event);
    })();
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Ask before continuing." },
    });
    const pending = transport.invoke({
      id: "lost-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "lost-input-item",
        questions: [{
          id: "environment",
          header: "Environment",
          question: "Where should we deploy?",
          options: [{ label: "Staging" }, { label: "Production" }],
        }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    transport.queue.fail(new Error("provider exited"));
    expect(await pending).toEqual({ answers: {} });
    await consume;

    const expired = events.find((event) => event.eventType === "runtime_request.expired");
    expect(expired).toMatchObject({
      turnId,
      itemId: "lost-input-item",
      payload: {
        requestId: "lost-input",
        reason: "provider_process_lost",
        replayAllowed: false,
        requestType: "input",
        request: {
          schema: "paperclip.runtime_request.v2",
          requestKind: "runtime",
          requestId: "lost-input",
          type: "input",
          input: {
            schema: "paperclip.question_set.v1",
            questions: [expect.objectContaining({ id: "environment" })],
          },
        },
      },
    });
    expect(events.filter((event) => event.eventType === "runtime_request.cancelled")).toHaveLength(0);
    expect(validatePrpEvent(expired!)).toMatchObject({ ok: true });
  });

  it("hands a live canonical input off exactly once when the durable window expires", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-durable-handoff",
      normalizedSessionId: "normalized-durable-handoff",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Ask before continuing." },
    });
    const pending = transport.invoke({
      id: "handoff-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "handoff-input-item",
        questions: [{
          id: "environment",
          header: "Environment",
          question: "Where should we deploy?",
          options: [{ label: "Staging" }, { label: "Production" }],
        }],
      },
    });
    let created: PrpEvent | null = null;
    for (let count = 0; count < 20; count += 1) {
      const event = await iterator.next();
      if (event.done) break;
      if (event.value.eventType === "runtime_request.created") {
        created = event.value;
        break;
      }
    }
    expect(created).not.toBeNull();

    const firstHandoff = session.handoffRuntimeRequest!({
      requestId: "handoff-input",
      turnId,
      reason: "durable_handoff",
      signal: new AbortController().signal,
    });
    expect(firstHandoff.result).toBe("handed_off");
    await expect(firstHandoff.cleanup).resolves.toBeUndefined();
    const repeatedHandoff = session.handoffRuntimeRequest!({
      requestId: "handoff-input",
      turnId,
      reason: "durable_handoff",
      signal: new AbortController().signal,
    });
    expect(repeatedHandoff.result).toBe("already_settled");
    await expect(repeatedHandoff.cleanup).resolves.toBeUndefined();
    expect(await pending).toEqual({ answers: {} });

    let expired: PrpEvent | null = null;
    for (let count = 0; count < 20; count += 1) {
      const event = await iterator.next();
      if (event.done) break;
      if (event.value.eventType === "runtime_request.expired") {
        expired = event.value;
        break;
      }
    }
    expect(expired).toMatchObject({
      turnId,
      itemId: "handoff-input-item",
      payload: {
        requestId: "handoff-input",
        reason: "durable_handoff",
        replayAllowed: false,
        requestType: "input",
        request: {
          schema: "paperclip.runtime_request.v2",
          requestId: "handoff-input",
          type: "input",
        },
      },
    });
    await session.close({ reason: "test complete" });
  });

  it("lets an answer claimed before expiry win the terminal-event race", async () => {
    const transport = new FakeCodexTransport();
    let releaseResolution!: () => void;
    transport.runtimeRequestResolver = () => new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    const session = await makeDriver([transport]).openSession({
      runId: "run-answer-handoff-race",
      normalizedSessionId: "normalized-answer-handoff-race",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Ask before continuing." },
    });
    const providerRequest = transport.invoke({
      id: "race-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "race-input-item",
        questions: [{
          id: "environment",
          header: "Environment",
          question: "Where should we deploy?",
          options: [{ label: "Staging" }, { label: "Production" }],
        }],
      },
    });
    for (let count = 0; count < 20; count += 1) {
      const event = await iterator.next();
      if (event.done || event.value.eventType === "runtime_request.created") break;
    }
    const resolution = session.resolveRuntimeRequest!({
      requestId: "race-input",
      turnId,
      resolution: {
        action: "submit",
        response: {
          schema: "paperclip.question_response.v1",
          answers: { environment: { selectedOptionIds: ["option-1"] } },
        },
      },
    });
    await Promise.resolve();
    const handoff = session.handoffRuntimeRequest!({
      requestId: "race-input",
      turnId,
      reason: "durable_handoff",
      signal: new AbortController().signal,
    });
    expect(handoff.result).toBe("already_settled");
    await expect(handoff.cleanup).resolves.toBeUndefined();
    releaseResolution();
    await resolution;
    await providerRequest;

    let terminalEvent: PrpEvent | null = null;
    for (let count = 0; count < 20; count += 1) {
      const event = await iterator.next();
      if (event.done) break;
      if (
        event.value.payload.requestId === "race-input"
        && ["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(event.value.eventType)
      ) {
        terminalEvent = event.value;
        break;
      }
    }
    expect(terminalEvent?.eventType).toBe("runtime_request.resolved");
    expect(session.pendingRuntimeRequests?.()).toEqual([]);
    await session.close({ reason: "test complete" });
  });

  it("redacts browser-visible request details and diagnostics from the fixture markers", async () => {
    const fixture = await loadLiveConsoleConformanceFixture(
      liveConsoleFixturePath,
    );
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-redaction",
      normalizedSessionId: "normalized-redaction",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Request input." },
    });
    const pending = transport.invoke({
      id: "redacted-request",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "redacted-item",
        reason: fixture.redactionMarkers.join(" "),
        authorization: "Bearer browser-secret",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const serialized = JSON.stringify(session.pendingRuntimeRequests?.());
    for (const marker of fixture.redactionMarkers)
      expect(serialized).not.toContain(marker);
    expect(serialized).toContain("[REDACTED]");
    await session.resolveRuntimeRequest?.({
      requestId: "redacted-request",
      turnId,
      resolution: { action: "cancel" },
    });
    await pending;
    await session.close({ reason: "fixture complete" });
  });

  it("makes duplicate semantic completion idempotent and rejects changed payloads", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-result",
      normalizedSessionId: "normalized-result",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    const request = {
      id: 1,
      method: "item/tool/call",
      paperclipTrace: {
        sourceEventId: "event_runner_000101",
        sourceEventType: "semantic_tool.input",
      },
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        tool: "paperclip_finish",
        arguments: result,
      },
    };
    expect(await transport.invoke(request)).toMatchObject({ success: true });
    const resultMapping = transport.traceInterpretations.find(
      (entry) =>
        entry.sourceEventId === "event_runner_000101" &&
        entry.providerMethod === "item/tool/call",
    );
    expect(resultMapping).toMatchObject({
      sourceEventType: "semantic_tool.input",
      disposition: "mapped",
    });
    expect(resultMapping?.emittedEventIds).toHaveLength(2);
    expect(resultMapping?.emittedEventIds).toEqual(
      expect.arrayContaining([
        expect.stringContaining(":run-result:"),
      ]),
    );
    expect(
      await transport.invoke({
        ...request,
        id: 2,
        params: {
          ...request.params,
          callId: "call-2",
          arguments: reverseObjectKeys(result),
        },
      }),
    ).toMatchObject({ success: true });
    expect((await session.snapshot()).semanticResult?.callId).toBe("call-1");
    const changed = structuredClone(result);
    changed.summary = "Changed after commit.";
    expect(
      await transport.invoke({
        ...request,
        id: 3,
        params: { ...request.params, arguments: changed },
      }),
    ).toMatchObject({ success: false });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    const events = await collectUntilTerminal(session.events());
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === "turn.completed"),
    ).toHaveLength(1);
  });

  it("accepts a normalized runnerd echo of a tool-committed semantic result", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-result-normalized-echo",
      normalizedSessionId: "normalized-result-normalized-echo",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    const toolShaped = structuredClone(result) as unknown as Record<string, unknown>;
    toolShaped.verification = [{
      commandOrCheck: "read hello.txt",
      status: "passed",
      result: "hello",
    }];
    delete toolShaped.attentionRequests;
    expect(
      await transport.invoke({
        id: "tool-result",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "tool-result",
          tool: "paperclip_finish",
          arguments: toolShaped,
        },
      }),
    ).toMatchObject({ success: true });
    transport.push("paperclip/runResult", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "tool-result",
      result: {
        ...result,
        verification: [{
          commandOrCheck: "read hello.txt",
          status: "passed",
          detail: "hello",
        }],
      },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(events.some((event) => event.eventType === "session.failed")).toBe(
      false,
    );
  });

  it("advertises and dispatches run-authorized control-plane tools", async () => {
    const transport = new FakeCodexTransport();
    const handler = vi.fn(async (call) => ({
      task: { id: "issue-1" },
      callId: call.callId,
    }));
    const session = await makeDriver([transport], {
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the assigned task.",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
      dynamicToolHandler: handler,
    }).openSession({
      runId: "run-tools",
      normalizedSessionId: "normalized-tools",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await session.startTurn({
      message: { role: "user", text: "Inspect the task." },
    });

    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params
        .dynamicTools,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "get_task_context" }),
      ]),
    );
    const response = await transport.invoke({
      id: "rpc-tool",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-context",
        tool: "get_task_context",
        arguments: {},
      },
    });
    expect(response).toMatchObject({ success: true });
    expect(
      JSON.parse(
        String(
          (response.contentItems as Array<Record<string, unknown>>)[0]?.text,
        ),
      ),
    ).toEqual({ task: { id: "issue-1" }, callId: "call-context" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "get_task_context",
        callId: "call-context",
        arguments: {},
      }),
    );
  });

  it("fails closed when an agent message changes a tool-committed result", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-tool-then-message-conflict",
      normalizedSessionId: "normalized-tool-then-message-conflict",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    expect(
      await transport.invoke({
        id: "tool-result",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "tool-result",
          tool: "paperclip_finish",
          arguments: result,
        },
      }),
    ).toMatchObject({ success: true });
    const changed = structuredClone(result);
    changed.summary = "Conflicting agent-message result.";
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "message-result",
        type: "agentMessage",
        text: JSON.stringify(changed),
      },
    });

    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(
      events.find((event) => event.eventType === "session.failed")?.payload,
    ).toMatchObject({
      code: "conflicting_semantic_result",
      recoverable: false,
    });
    expect((await session.snapshot()).semanticResult?.result).toEqual(result);
  });

  it("rejects a tool result that changes an agent-message commitment", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-message-then-tool-conflict",
      normalizedSessionId: "normalized-message-then-tool-conflict",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "message-result",
        type: "agentMessage",
        text: JSON.stringify(result),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const changed = structuredClone(result);
    changed.summary = "Conflicting tool result.";
    expect(
      await transport.invoke({
        id: "tool-result",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "tool-result",
          tool: "paperclip_finish",
          arguments: changed,
        },
      }),
    ).toMatchObject({ success: false });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(events.some((event) => event.eventType === "session.failed")).toBe(
      false,
    );
    expect((await session.snapshot()).semanticResult).toMatchObject({
      callId: "message-result",
      result,
    });
  });

  it("treats a canonically identical cross-channel result as a no-op", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-identical-cross-channel",
      normalizedSessionId: "normalized-identical-cross-channel",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    expect(
      await transport.invoke({
        id: "tool-result",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "tool-result",
          tool: "paperclip_finish",
          arguments: result,
        },
      }),
    ).toMatchObject({ success: true });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "message-result",
        type: "agentMessage",
        text: JSON.stringify(reverseObjectKeys(result)),
      },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect((await session.snapshot()).semanticResult?.callId).toBe(
      "tool-result",
    );
  });

  it("fails closed when a live terminal embeds a changed semantic result", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-terminal-result-conflict",
      normalizedSessionId: "normalized-terminal-result-conflict",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    expect(
      await transport.invoke({
        id: "tool-result",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "tool-result",
          tool: "paperclip_finish",
          arguments: result,
        },
      }),
    ).toMatchObject({ success: true });
    const changed = structuredClone(result);
    changed.summary = "Conflicting terminal result.";
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [
          {
            id: "terminal-result",
            type: "agentMessage",
            text: JSON.stringify(changed),
          },
        ],
      },
    });

    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(
      events.find((event) => event.eventType === "session.failed")?.payload,
    ).toMatchObject({
      code: "conflicting_semantic_result",
      recoverable: false,
    });
    expect(events.some((event) => event.eventType === "turn.completed")).toBe(
      false,
    );
    expect((await session.snapshot()).semanticResult?.result).toEqual(result);
  });

  it.each([
    { threadId: "other-thread", turnId: "turn-1", label: "another thread" },
    { threadId: "thread-1", turnId: "other-turn", label: "another turn" },
  ])(
    "rejects a semantic result for $label without committing it",
    async ({ threadId, turnId }) => {
      const transport = new FakeCodexTransport();
      const session = await makeDriver([transport]).openSession({
        runId: "run-hostile-tool",
        normalizedSessionId: "normalized-hostile-tool",
        workingDirectory: TEST_WORKING_DIRECTORY,
      });
      await session.startTurn({ message: { role: "user", text: "Complete." } });
      expect(
        await transport.invoke({
          id: "hostile-call",
          method: "item/tool/call",
          params: {
            threadId,
            turnId,
            callId: "hostile-call",
            tool: "paperclip_finish",
            arguments: result,
          },
        }),
      ).toMatchObject({ success: false });
      const events = await collectUntilTerminal(session.events());
      expect(
        events.some((event) => event.eventType === "run.result.proposed"),
      ).toBe(false);
      expect(
        events.find((event) => event.eventType === "session.failed")?.payload,
      ).toMatchObject({ code: "tool_binding_mismatch", recoverable: false });
      expect(
        events.find((event) => event.eventType === "turn.failed")?.turnId,
      ).toBe("turn-1");
    },
  );

  it("rejects pre-turn, cross-thread, and post-terminal notifications", async () => {
    const preTurnTransport = new FakeCodexTransport();
    const preTurn = await makeDriver([preTurnTransport]).openSession({
      runId: "run-pre-turn",
      normalizedSessionId: "normalized-pre-turn",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    preTurnTransport.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "answer-pre",
        type: "agentMessage",
        text: JSON.stringify(result),
      },
    });
    const preTurnEvents: PrpEvent[] = [];
    for await (const event of preTurn.events()) preTurnEvents.push(event);
    expect(
      preTurnEvents.some((event) => event.eventType === "run.result.proposed"),
    ).toBe(false);
    expect(
      preTurnEvents.find((event) => event.eventType === "session.failed")
        ?.payload,
    ).toMatchObject({ code: "turn_binding_mismatch" });

    const crossThreadTransport = new FakeCodexTransport();
    const crossThread = await makeDriver([crossThreadTransport]).openSession({
      runId: "run-cross-thread",
      normalizedSessionId: "normalized-cross-thread",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await crossThread.startTurn({
      message: { role: "user", text: "Complete." },
    });
    crossThreadTransport.push("item/completed", {
      threadId: "other-thread",
      turnId: "turn-1",
      item: {
        id: "answer-other",
        type: "agentMessage",
        text: JSON.stringify(result),
      },
    });
    const crossThreadEvents = await collectUntilTerminal(crossThread.events());
    expect(
      crossThreadEvents.some(
        (event) => event.eventType === "run.result.proposed",
      ),
    ).toBe(false);
    expect(
      crossThreadEvents.find((event) => event.eventType === "session.failed")
        ?.payload,
    ).toMatchObject({ code: "thread_binding_mismatch" });

    const postTerminalTransport = new FakeCodexTransport();
    const postTerminal = await makeDriver([postTerminalTransport]).openSession({
      runId: "run-post-terminal",
      normalizedSessionId: "normalized-post-terminal",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await postTerminal.startTurn({
      message: { role: "user", text: "Complete." },
    });
    postTerminalTransport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(postTerminal.events());
    expect(
      await postTerminalTransport.invoke({
        id: "late-call",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "late-call",
          tool: "paperclip_finish",
          arguments: result,
        },
      }),
    ).toMatchObject({ success: false });
  });

  it("rejects duplicate and conflicting terminal facts", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-terminal-replay",
      normalizedSessionId: "normalized-terminal-replay",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "failed",
        error: { message: "changed" },
        items: [],
      },
    });
    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(
      events.filter((event) => event.eventType === "turn.completed"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === "turn.failed"),
    ).toHaveLength(0);
    expect(
      events.find((event) => event.eventType === "session.failed")?.payload,
    ).toMatchObject({ code: "conflicting_turn_terminal", recoverable: false });
  });

  it("rejects oversized semantic results without retaining provider payloads", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-large-result",
      normalizedSessionId: "normalized-large-result",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    expect(
      await transport.invoke({
        id: "large-call",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "large-call",
          tool: "paperclip_finish",
          arguments: { ...result, summary: "x".repeat(70 * 1024) },
        },
      }),
    ).toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "Semantic result exceeded the retained payload limit.",
        },
      ],
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    const events = await collectUntilTerminal(session.events());
    expect(
      events.some((event) => JSON.stringify(event).includes("x".repeat(1024))),
    ).toBe(false);
    expect(
      events.some((event) => event.eventType === "run.result.proposed"),
    ).toBe(false);
  });

  it("normalizes finish and block tools into one canonical result contract", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-tools",
      normalizedSessionId: "normalized-tools",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await session.startTurn({
      message: { role: "user", text: "Complete or block." },
    });
    const blocked: PrpStructuredRunResult = {
      ...structuredClone(result),
      reportedWorkDisposition: "blocked",
      summary: "Waiting on a fixture owner.",
      completionClaim: {
        ...structuredClone(result.completionClaim),
        objectiveSatisfied: false,
        criteria: [
          { criterionId: "file", status: "not_satisfied", evidenceRefs: [] },
        ],
        remainingWork: [
          {
            description: "Fixture owner must provide input.",
            blocksCompletion: true,
          },
        ],
      },
      blocker: {
        reasonCode: "fixture_input_missing",
        owner: { kind: "external", name: "fixture owner" },
        unblockAction: "Provide the fixture input.",
        scope: "task_wide",
      },
      artifacts: [],
    };
    const request = {
      id: 10,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-block",
        tool: "paperclip_block",
        arguments: blocked,
      },
    };
    expect(
      await transport.invoke({
        ...request,
        id: 9,
        params: { ...request.params, tool: "paperclip_finish" },
      }),
    ).toMatchObject({ success: false });
    expect(await transport.invoke(request)).toMatchObject({ success: true });
    expect(await transport.invoke({ ...request, id: 11 })).toMatchObject({
      success: true,
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    const events = await collectUntilTerminal(session.events());
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(
      events.find((event) => event.eventType === "run.result.proposed")
        ?.payload,
    ).toMatchObject({ reportedWorkDisposition: "blocked" });
  });

  it("resumes and reconciles the exact provider thread after transport loss", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-recover",
      normalizedSessionId: "normalized-recover",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await original.startTurn({ message: { role: "user", text: "Work." } });
    const snapshot = await original.snapshot();
    await original.close({ reason: "transport lost" });
    const recovery = await driver.recoverSession?.(snapshot);
    expect(recovery).toMatchObject({ recovered: true });
    expect(recovery?.session?.ids()).toEqual(original.ids());
    expect(await recovery?.session?.reconcile?.()).toMatchObject({
      thread: { id: "thread-1" },
    });
    expect(second.calls.map((call) => call.method)).toEqual([
      "initialize",
      "thread/read",
      "thread/resume",
      "thread/goal/get",
      "thread/read",
    ]);
    expect((await recovery?.session?.snapshot())?.activeTurnId).toBe("turn-1");
  });

  it("ignores an old terminal turn when the persisted active turn is still running", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: TEST_WORKING_DIRECTORY,
        turns: [
          { id: "turn-old", status: "completed", items: [] },
          { id: "turn-1", status: "inProgress", items: [] },
        ],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-history",
      normalizedSessionId: "normalized-history",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await original.startTurn({
      message: { role: "user", text: "Keep working." },
    });
    const snapshot = await original.snapshot();
    await original.close({ reason: "transport lost" });

    const recovery = await driver.recoverSession?.(snapshot);
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    await recovered!.reconcile?.();
    expect(await recovered!.snapshot()).toMatchObject({
      activeTurnId: "turn-1",
    });
    await recovered!.close({ reason: "test complete" });
    const events: PrpEvent[] = [];
    for await (const event of recovered!.events()) events.push(event);
    expect(events.some((event) => event.eventType === "turn.completed")).toBe(
      false,
    );
  });

  it("preserves proposal idempotency and rejects a changed result after transport loss", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-proposal-loss",
      normalizedSessionId: "normalized-proposal-loss",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await original.startTurn({ message: { role: "user", text: "Complete." } });
    expect(
      await first.invoke({
        id: "call-before-loss",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-before-loss",
          tool: "paperclip_finish",
          arguments: result,
        },
      }),
    ).toMatchObject({ success: true });
    const snapshot = await original.snapshot();
    expect(snapshot.semanticResult).toMatchObject({
      callId: "call-before-loss",
      turnId: "turn-1",
      result,
    });
    await original.close({ reason: "transport lost after proposal" });
    const originalEvents: PrpEvent[] = [];
    for await (const event of original.events()) originalEvents.push(event);
    expect(
      originalEvents.filter(
        (event) => event.eventType === "run.result.proposed",
      ),
    ).toHaveLength(1);

    const recovery = await driver.recoverSession?.(snapshot);
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    const collecting = collectUntilTerminal(recovered!.events());
    await recovered!.reconcile?.();
    expect(
      await second.invoke({
        id: "call-after-loss",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-after-loss",
          tool: "paperclip_finish",
          arguments: reverseObjectKeys(result),
        },
      }),
    ).toMatchObject({ success: true });
    const changed = structuredClone(result);
    changed.summary = "Changed after transport loss.";
    expect(
      await second.invoke({
        id: "changed-after-loss",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "changed-after-loss",
          tool: "paperclip_finish",
          arguments: changed,
        },
      }),
    ).toMatchObject({ success: false });
    second.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    const events = await collecting;
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(0);
    expect(
      events.filter((event) => event.eventType === "turn.completed"),
    ).toHaveLength(1);
  });

  it("rejects changed terminal result content discovered during recovery", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    const changed = structuredClone(result);
    changed.summary = "Conflicting recovered terminal result.";
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: TEST_WORKING_DIRECTORY,
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [
              {
                id: "terminal-result",
                type: "agentMessage",
                text: JSON.stringify(changed),
              },
            ],
          },
        ],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-recovered-result-conflict",
      normalizedSessionId: "normalized-recovered-result-conflict",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await original.startTurn({ message: { role: "user", text: "Complete." } });
    expect(
      await first.invoke({
        id: "tool-result",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "tool-result",
          tool: "paperclip_finish",
          arguments: result,
        },
      }),
    ).toMatchObject({ success: true });
    first.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(original.events());
    const snapshot = await original.snapshot();
    expect(snapshot.terminalTurns).toHaveLength(1);
    await original.close({ reason: "transport lost after terminal" });

    const recovery = await driver.recoverSession?.(snapshot);
    expect(recovery).toMatchObject({ recovered: true });
    await expect(
      recovery!.session!.reconcile!(),
    ).rejects.toMatchObject<HarnessReconciliationError>({
      name: "HarnessReconciliationError",
      recoverable: true,
      message: expect.stringContaining(
        "contains a conflicting semantic result",
      ),
    });
    expect(
      (await recovery!.session!.snapshot()).semanticResult?.result,
    ).toEqual(result);
    await recovery!.session!.close({ reason: "test complete" });
  });

  it("does not re-emit an already observed terminal after recovery", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: TEST_WORKING_DIRECTORY,
        turns: [{ id: "turn-1", status: "completed", items: [] }],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-terminal-loss",
      normalizedSessionId: "normalized-terminal-loss",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await original.startTurn({ message: { role: "user", text: "Complete." } });
    expect(
      await first.invoke({
        id: "terminal-call",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "terminal-call",
          tool: "paperclip_finish",
          arguments: result,
        },
      }),
    ).toMatchObject({ success: true });
    first.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(original.events());
    const snapshot = await original.snapshot();
    expect(snapshot.terminalTurns).toHaveLength(1);
    await original.close({ reason: "transport lost after terminal" });

    const recovery = await driver.recoverSession?.(snapshot);
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    await recovered!.reconcile?.();
    await recovered!.close({ reason: "test complete" });
    const events: PrpEvent[] = [];
    for await (const event of recovered!.events()) events.push(event);
    expect(events.some((event) => event.eventType.startsWith("turn."))).toBe(
      false,
    );
    expect(
      events.some((event) => event.eventType === "run.result.proposed"),
    ).toBe(false);
  });

  it("fails recovery explicitly when the persisted active turn is missing or replaced", async () => {
    for (const testCase of [
      {
        label: "missing",
        turns: [{ id: "turn-old", status: "completed", items: [] }],
        message: "persisted active turn turn-1 is missing",
      },
      {
        label: "replaced",
        turns: [{ id: "turn-2", status: "inProgress", items: [] }],
        message: "active turn turn-2 instead of persisted active turn turn-1",
      },
    ]) {
      const first = new FakeCodexTransport();
      const second = new FakeCodexTransport();
      second.readResponse = {
        thread: {
          id: "thread-1",
          sessionId: "provider-session-1",
          cwd: TEST_WORKING_DIRECTORY,
          turns: testCase.turns,
        },
      };
      const driver = makeDriver([first, second]);
      const original = await driver.openSession({
        runId: `run-${testCase.label}-turn`,
        normalizedSessionId: `normalized-${testCase.label}-turn`,
        workingDirectory: TEST_WORKING_DIRECTORY,
      });
      await original.startTurn({ message: { role: "user", text: "Work." } });
      const snapshot = await original.snapshot();
      await original.close({ reason: "transport lost" });
      const recovery = await driver.recoverSession?.(snapshot);
      expect(recovery?.session).toBeDefined();
      await expect(
        recovery!.session!.reconcile!(),
      ).rejects.toMatchObject<HarnessReconciliationError>({
        name: "HarnessReconciliationError",
        recoverable: true,
        message: expect.stringContaining(testCase.message),
      });
      await recovery!.session!.close({ reason: "test complete" });
    }
  });

  it("reconciles a turn completed during transport loss without replacing either session identity", async () => {
    const first = new FakeCodexTransport(
      "driver-thread-loss",
      "provider-session-loss",
    );
    const second = new FakeCodexTransport(
      "driver-thread-loss",
      "provider-session-loss",
    );
    second.readResponse = {
      thread: {
        id: "driver-thread-loss",
        sessionId: "provider-session-loss",
        cwd: TEST_WORKING_DIRECTORY,
        tokenUsage: { total: { inputTokens: 21, outputTokens: 8 } },
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [
              {
                id: "answer-loss",
                type: "agentMessage",
                text: JSON.stringify(result),
              },
            ],
          },
        ],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "runtime-run-loss",
      normalizedSessionId: "controller-session-loss",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await original.startTurn({
      message: { role: "user", text: "Work through loss." },
    });
    const snapshot = await original.snapshot();
    await original.close({ reason: "transport lost before terminal delivery" });

    const recovery = await driver.recoverSession?.(snapshot);
    expect(recovery).toMatchObject({ recovered: true });
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    const collecting = collectUntilTerminal(recovered!.events());
    await recovered!.reconcile?.();
    const events = await collecting;

    expect(recovered!.ids()).toEqual({
      driverSessionId: "driver-thread-loss",
      providerSessionId: "provider-session-loss",
      displayId: "driver-thread-loss",
    });
    expect(await recovered!.snapshot()).toMatchObject({
      runId: "runtime-run-loss",
      normalizedSessionId: "controller-session-loss",
      driverSessionId: "driver-thread-loss",
      providerSessionId: "provider-session-loss",
    });
    expect(
      events.filter((event) => event.eventType === "turn.completed"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(
      events.every(
        (event, index) =>
          event.sourceSeq === snapshot.lastSourceSequence! + index + 1,
      ),
    ).toBe(true);
    expect(await recovered!.usage?.()).toEqual({
      total: { inputTokens: 21, outputTokens: 8 },
    });
  });

  it("degrades unsupported operations with explicit redacted diagnostics", async () => {
    const transport = new FakeCodexTransport();
    transport.rejectMethods.set(
      "turn/steer",
      new Error("method not found Bearer super-secret api_key=also-secret"),
    );
    const session = await makeDriver([transport]).openSession({
      runId: "run-degrade",
      normalizedSessionId: "normalized-degrade",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Start." },
    });
    await expect(
      session.steer?.({ turnId, message: { role: "user", text: "Steer." } }),
    ).rejects.toBeInstanceOf(HarnessCapabilityUnavailableError);
    const iterator = session.events()[Symbol.asyncIterator]();
    const events: PrpEvent[] = [];
    for (let index = 0; index < 6; index += 1) {
      const next = await iterator.next();
      if (next.value) events.push(next.value);
    }
    const diagnostic = events.find(
      (event) => event.eventType === "harness.diagnostic",
    );
    expect(diagnostic?.payload).toMatchObject({
      code: "unsupported_operation",
      operation: "steering",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("super-secret");
    expect(JSON.stringify(diagnostic)).not.toContain("also-secret");
  });

  it("rejects proposals that do not match the exact task envelope", () => {
    const wrongRevision = structuredClone(result);
    wrongRevision.completionClaim.contractRevision = "codex-demo-v0";
    expect(validateCodexResultProposal(wrongRevision, envelope)).toMatchObject({
      status: "rejected",
      issues: [{ code: "contract_revision_mismatch" }],
    });

    const unknownCriterion = structuredClone(result);
    unknownCriterion.completionClaim.criteria = [
      {
        criterionId: "not-in-envelope",
        status: "satisfied",
        evidenceRefs: [],
      },
    ];
    const criterionDecision = validateCodexResultProposal(
      unknownCriterion,
      envelope,
    );
    expect(criterionDecision).toMatchObject({ status: "rejected" });
    if (criterionDecision.status === "rejected") {
      expect(criterionDecision.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["unknown_criterion", "missing_criterion"]),
      );
    }

    const invalidDone = structuredClone(result);
    invalidDone.completionClaim.objectiveSatisfied = false;
    expect(validateCodexResultProposal(invalidDone, envelope)).toMatchObject({
      status: "rejected",
      issues: [{ code: "invalid_disposition" }],
    });
  });

  it.each(["needs_review", "blocked"] as const)(
    "keeps a completed runtime successful for an accepted %s advisory proposal",
    async (disposition) => {
      const proposal: PrpStructuredRunResult =
        disposition === "needs_review"
          ? {
              ...structuredClone(result),
              reportedWorkDisposition: "needs_review",
              attentionRequests: [
                { kind: "review", summary: "Review the completed artifact." },
              ],
            }
          : {
              ...structuredClone(result),
              reportedWorkDisposition: "blocked",
              summary: "Waiting on fixture input.",
              completionClaim: {
                ...structuredClone(result.completionClaim),
                objectiveSatisfied: false,
                criteria: [
                  {
                    criterionId: "file",
                    status: "not_satisfied",
                    evidenceRefs: [],
                  },
                ],
                remainingWork: [
                  {
                    description: "Provide fixture input.",
                    blocksCompletion: true,
                  },
                ],
              },
              blocker: {
                reasonCode: "fixture_input_missing",
                owner: { kind: "external", name: "fixture owner" },
                unblockAction: "Provide fixture input.",
                scope: "task_wide",
              },
              artifacts: [],
            };
      const { trace } = await traceCompletedProposal(proposal);
      expect(trace.resultDecision.status).toBe("accepted");
      expect(
        trace.events.find((event) => event.eventType === "run.terminal")
          ?.payload,
      ).toMatchObject({
        turnTerminalState: "completed",
        runTerminalState: "succeeded",
        reportedWorkDisposition: disposition,
      });
    },
  );

  it("records rejected and missing proposals as recovery evidence instead of review status", async () => {
    const wrongRevision = structuredClone(result);
    wrongRevision.completionClaim.contractRevision = "wrong-revision";
    const rejected = await traceCompletedProposal(wrongRevision);
    expect(rejected.trace.result).toBeNull();
    expect(rejected.trace.proposedResult).toMatchObject({
      reportedWorkDisposition: "done",
    });
    expect(
      rejected.trace.events.find(
        (event) => event.eventType === "run.result.rejected",
      )?.payload,
    ).toMatchObject({ recovery: { required: true, recoverable: true } });
    expect(
      rejected.trace.events.find((event) => event.eventType === "run.terminal")
        ?.payload,
    ).toMatchObject({
      runTerminalState: "failed",
      reportedWorkDisposition: "yielded",
    });

    const missing = await traceCompletedProposal(null);
    expect(missing.trace.resultDecision).toMatchObject({ status: "rejected" });
    expect(
      missing.trace.events.some(
        (event) =>
          event.eventType === "run.result.proposed" &&
          event.payload.reportedWorkDisposition === "needs_review",
      ),
    ).toBe(false);
  });

  it("preserves four independent stable identities under controller ownership", async () => {
    const { trace } = await traceCompletedProposal(result, {
      runId: "runtime-run-identity",
      normalizedSessionId: "controller-session-identity",
    });
    expect(trace.assertions.stableIdentity).toBe(true);
    expect(trace.metadata.identity).toMatchObject({
      runId: "runtime-run-identity",
      normalizedSessionId: "controller-session-identity",
      driverSessionId: "thread-1",
      providerSessionId: "provider-session-1",
    });
    expect(
      trace.events.every(
        (event) =>
          event.runId === "runtime-run-identity" &&
          event.normalizedSessionId === "controller-session-identity",
      ),
    ).toBe(true);
  });

  it("validates persisted identity, uniqueness, terminals, and line bounds before replay", async () => {
    const { trace } = await traceCompletedProposal(result, {
      runId: "runtime-run-persisted",
      normalizedSessionId: "controller-session-persisted",
    });
    const serialize = (events: PrpEvent[]) =>
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    expect(
      replayPersistedCodexEvents(serialize(trace.events), trace.metadata),
    ).toEqual(trace.replaySnapshot);

    const mismatched = structuredClone(trace.events);
    mismatched[0]!.normalizedSessionId = "another-session";
    expect(() =>
      replayPersistedCodexEvents(serialize(mismatched), trace.metadata),
    ).toThrow("identity did not match");

    const terminalIndex = trace.events.findIndex(
      (event) => event.eventType === "run.terminal",
    );
    const duplicated = trace.events.toSpliced(
      terminalIndex,
      0,
      structuredClone(trace.events[0]!),
    );
    expect(() =>
      replayPersistedCodexEvents(serialize(duplicated), trace.metadata),
    ).toThrow("event id was duplicated");

    const terminal = structuredClone(trace.events[terminalIndex]!);
    terminal.sourceEventId = `${terminal.sourceEventId}:conflict`;
    terminal.sourceSeq += 1;
    expect(() =>
      replayPersistedCodexEvents(
        serialize([...trace.events, terminal]),
        trace.metadata,
      ),
    ).toThrow("after the run terminal");
    expect(() =>
      replayPersistedCodexEvents(
        `{\"payload\":\"${"x".repeat(300 * 1024)}\"}\n`,
        trace.metadata,
      ),
    ).toThrow("line was empty or oversized");
    expect(() =>
      replayPersistedCodexEvents("{not-json}\n", trace.metadata),
    ).toThrow("malformed JSON");
  });

  it("degrades declared unsupported capabilities without Codex-specific core branches", async () => {
    const capabilities = {
      resume: false,
      read: false,
      steering: false,
      interruption: false,
      usage: false,
      reconciliation: false,
      dynamicTools: false,
    };
    const { trace, transport } = await traceCompletedProposal(result, {
      capabilities,
      steer: "Do not call this unsupported path.",
      interrupt: true,
    });
    expect(trace.resultDecision.status).toBe("accepted");
    expect(trace.assertions.contextIsSkillless).toBe(true);
    expect(trace.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("steering is unavailable"),
        expect.stringContaining("interruption is unavailable"),
      ]),
    );
    expect(transport.calls.map((call) => call.method)).not.toEqual(
      expect.arrayContaining(["turn/steer", "turn/interrupt", "thread/read"]),
    );
    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params
        .dynamicTools,
    ).toEqual([]);

    const directTransport = new FakeCodexTransport();
    const driver = makeDriver([directTransport], { capabilities });
    const session = await driver.openSession({
      runId: "run-no-capabilities",
      normalizedSessionId: "normalized-no-capabilities",
      workingDirectory: TEST_WORKING_DIRECTORY,
    });
    await expect(session.read?.()).rejects.toBeInstanceOf(
      HarnessCapabilityUnavailableError,
    );
    await expect(session.usage?.()).rejects.toBeInstanceOf(
      HarnessCapabilityUnavailableError,
    );
    const snapshot = await session.snapshot();
    expect(await driver.recoverSession?.(snapshot)).toMatchObject({
      recovered: false,
      reason: "resume capability is unavailable",
    });
  });
});
