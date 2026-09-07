import { realpathSync } from "node:fs";
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

export const WORKSPACE = realpathSync.native(process.cwd());

export class TestQueue<T> implements AsyncIterable<T> {
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

export class FakeCodexTransport implements CodexAppServerTransport {
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
    readonly providerIdentity?: Record<string, unknown>,
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
          ...(this.providerIdentity === undefined
            ? {}
            : { providerIdentity: structuredClone(this.providerIdentity) }),
          modelProvider: "openai",
          cwd: WORKSPACE,
          turns: [],
          activePermissionProfile: {
            id: planMode
              ? "paperclip-runner-workspace-read-only"
              : "paperclip-runner-workspace-only",
          },
        },
        model: "gpt-test",
        modelProvider: "openai",
        cwd: WORKSPACE,
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
            cwd: WORKSPACE,
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

export const envelope = createCodexTaskEnvelope({
  objective: "Create hello.txt with the text hello.",
  criteria: [{ id: "file", requirement: "hello.txt contains hello" }],
});

export const liveConsoleFixturePath = fileURLToPath(
  new URL(
    "../../../protocol/fixtures/codex-driver/driver-conformance.json",
    import.meta.url,
  ),
);

export const result: PrpStructuredRunResult = {
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

export function makeDriver(
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

export async function collectUntilTerminal(
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

export function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
  );
}

export async function traceCompletedProposal(
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
    workingDirectory: WORKSPACE,
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


export { describe, expect, it, vi } from "vitest";
export {
  CODEX_BLOCK_RESULT_OUTPUT_SCHEMA,
  CODEX_RESULT_OUTPUT_SCHEMA,
  createCodexTaskEnvelope,
  isSkilllessCodexContext,
  HarnessCapabilityUnavailableError,
  HarnessOperationAlreadyTerminalError,
  HarnessReconciliationError,
  HarnessStaleTurnError,
  applyPrpEvent,
  createSessionSnapshotFromMetadata,
  validatePrpEvent,
  loadLiveConsoleConformanceFixture,
  CodexAppServerDriver,
  createIsolatedCodexAppServerArgs,
  runCodexCodexTracer,
  replayPersistedCodexEvents,
  validateCodexResultProposal,
  CODEX_INVALID_REQUEST,
  CODEX_METHOD_NOT_FOUND,
  CodexRpcError,
};
export type {
  HarnessRuntimeRequestResolution,
  PrpCapabilities,
  PrpEvent,
  PrpStructuredRunResult,
  CodexAppServerTransport,
  CodexRpcNotification,
  CodexRpcServerRequest,
  CodexServerRequestHandler,
  CodexTraceInterpretation,
};
